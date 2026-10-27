const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const AIUsageLog = require('../models/ai-usage-log.schema');
const AIUsageBudget = require('../models/ai-usage-budget.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LearningProfile = require('../models/learning-profile.schema');
const { createGeminiProvider } = require('../services/ai/providers/gemini.provider');
const { createAssistantService, respondToStudent } = require('../services/ai/assistant.service');
const { getRecommendations } = require('../services/ai/recommendation.service');

const id = () => new mongoose.Types.ObjectId();
const config = (changes = {}) => ({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'SERVER_ONLY_TEST_KEY',
  GEMINI_MODEL: 'gemini-test-model', AI_MAX_OUTPUT_TOKENS: '500', AI_DAILY_REQUEST_LIMIT: '20',
  AI_REQUEST_TIMEOUT_MS: '1000', ...changes });
const input = (changes = {}) => ({ systemInstruction: 'Use only supplied facts.', userMessage: 'Help me choose.',
  context: { profile: null, activeCourses: [], recommendations: [] }, maxOutputTokens: 300, ...changes });
const envelope = (replyKey = 'CATALOG', referencedCourseIds = []) => JSON.stringify({ replyKey, referencedCourseIds });
const legacyEnvelope = (message, referencedCourseIds = []) => JSON.stringify({ message, referencedCourseIds });
const reply = (text = envelope(), changes = {}) => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 8 }, ...changes
}), { status: 200, headers: { 'content-type': 'application/json' } });
const service = (fetchImpl = async () => reply(), options = {}) => createAssistantService({ config: config(), fetchImpl, ...options });
async function course(changes = {}) {
  return Course.create({ title: 'JavaScript foundations', description: 'Learn JavaScript', category: 'Programming',
    instructor: id(), thumbnail: { public_id: 'PRIVATE_MEDIA', secure_url: 'https://example.com/image.png' }, ...changes });
}
async function profile(student) {
  await LearningProfile.create({ student, careerGoal: 'Developer', interests: ['programming'], selfReportedSkills: [],
    experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 });
}
async function usage(student, changes = {}) {
  return AIUsageLog.create({ student, feature: 'DISCOVERY', provider: 'GEMINI', modelAlias: 'gemini',
    outcome: 'SUCCESS', ...changes });
}
const safeError = (code) => (error) => {
  assert.equal(error.code, code);
  assert.doesNotMatch(JSON.stringify(error) + error.message, /SERVER_ONLY|RAW_PROVIDER|password|secret-value/);
  return true;
};

test.before(async () => { await connectTestDb(); await Promise.all([AIUsageLog.init(), AIUsageBudget.init(), Enrollment.init(), LearningProfile.init()]); });
test.beforeEach(async () => {
  await Promise.all([Course.deleteMany({}), Enrollment.deleteMany({}), LearningProfile.deleteMany({}),
    AIUsageBudget.deleteMany({}), AIUsageLog.collection.deleteMany({})]);
});
test.after(disconnectTestDb);

test('provider rejects missing/unsafe configuration without issuing HTTP requests', async () => {
  let calls = 0;
  const invalid = [{ GEMINI_API_KEY: '' }, { GEMINI_MODEL: '' }, { GEMINI_MODEL: '../models/escape?key=x' },
    { AI_PROVIDER: 'other' }, { GEMINI_API_KEY: 'bad\nkey' }, { GEMINI_MODEL: 'x'.repeat(81) }];
  for (const [name, values] of Object.entries({ AI_MAX_OUTPUT_TOKENS: [0, 1001, '1.2', '1e2', ' 5 '],
    AI_DAILY_REQUEST_LIMIT: [0, 101, true], AI_REQUEST_TIMEOUT_MS: [999, 30001, 'NaN'] })) {
    invalid.push(...values.map((value) => ({ [name]: value })));
  }
  for (const values of invalid) {
    await assert.rejects(async () => createGeminiProvider(config(values), async () => { calls++; return reply(); }).generate(input()),
      safeError('PROVIDER_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
});

test('provider sends one bounded safe DTO without credentials, history, storage or private records', async () => {
  let request;
  const result = await createGeminiProvider(config(), async (url, options) => { request = { url, options }; return reply(); })
    .generate(input({ userMessage: 'Help me me@example.com "password":"secret-value" Cookie: session=COOKIE_VALUE\ncard=4111111111111111',
      context: { profile: { careerGoal: 'Developer', email: 'other@example.com', password: 'PROFILE_SECRET' },
        activeCourses: [], recommendations: [{ course: { id: String(id()), title: 'JavaScript foundations',
          description: 'Learn', category: 'Programming', accessType: 'FREE', price: 0, currency: 'INR',
          thumbnailUrl: 'https://example.com/PRIVATE_MEDIA', storage: { key: 'STORAGE_KEY' } }, score: 50,
          signals: { levelFit: 15 }, unmetPrerequisites: [] }], history: ['RAW_HISTORY'], student: 'PRIVATE_STUDENT',
        assignment: { content: 'RAW_ASSIGNMENT' } } }));
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], 'SERVER_ONLY_TEST_KEY');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  const body = JSON.parse(request.options.body);
  assert.equal(body.contents.length, 1);
  assert.equal(body.generationConfig.maxOutputTokens, 300);
  assert.equal(body.generationConfig.candidateCount, 1);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema.required, ['replyKey', 'referencedCourseIds']);
  assert.deepEqual(body.generationConfig.responseSchema.properties.replyKey.enum, ['PROFILE', 'CATALOG', 'PROGRESS', 'CONTENT_LIMIT']);
  assert.doesNotMatch(request.options.body, /SERVER_ONLY|secret-value|COOKIE_VALUE|4111111111111111|@|PRIVATE_|PROFILE_SECRET|STORAGE_KEY|RAW_/);
  assert.match(request.options.body, /JavaScript foundations/);
  assert.deepEqual(result, { text: envelope(), usage: { inputTokens: 25, outputTokens: 8 } });
});

test('provider honors configured output cap and accepts numeric configuration boundaries', async () => {
  for (const values of [{ AI_MAX_OUTPUT_TOKENS: 1, AI_DAILY_REQUEST_LIMIT: 1, AI_REQUEST_TIMEOUT_MS: 1000 },
    { AI_MAX_OUTPUT_TOKENS: 1000, AI_DAILY_REQUEST_LIMIT: 100, AI_REQUEST_TIMEOUT_MS: 30000 }]) {
    let body;
    await createGeminiProvider(config(values), async (_url, options) => { body = JSON.parse(options.body); return reply(); })
      .generate(input({ maxOutputTokens: 1000 }));
    assert.equal(body.generationConfig.maxOutputTokens, values.AI_MAX_OUTPUT_TOKENS);
  }
});

test('provider aborts a stalled network request and a stalled response body', async () => {
  for (const stallBody of [false, true]) {
    let signal;
    const fetchImpl = async (_url, options) => {
      signal = options.signal;
      if (stallBody) return new Response(new ReadableStream({ start() {} }), { status: 200 });
      return new Promise(() => {});
    };
    await assert.rejects(createGeminiProvider(config(), fetchImpl).generate(input()), safeError('TIMEOUT'));
    assert.equal(signal.aborted, true);
  }
});

test('provider maps rate, quota, HTTP, and network errors to safe categories', async () => {
  const cases = [
    [429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'RAW_PROVIDER secret-value' } }, 'RATE_LIMIT'],
    [429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } }, 'QUOTA_EXCEEDED'],
    [402, { error: { message: 'RAW_PROVIDER secret-value' } }, 'QUOTA_EXCEEDED'],
    [503, { error: { message: 'RAW_PROVIDER secret-value' } }, 'PROVIDER_UNAVAILABLE'],
    [403, { error: { message: 'RAW_PROVIDER secret-value' } }, 'PROVIDER_UNAVAILABLE']
  ];
  for (const [status, body, code] of cases) {
    await assert.rejects(createGeminiProvider(config(), async () => new Response(JSON.stringify(body), { status })).generate(input()), safeError(code));
  }
  await assert.rejects(createGeminiProvider(config(), async () => { throw new Error('RAW_PROVIDER secret-value'); }).generate(input()),
    safeError('PROVIDER_UNAVAILABLE'));
});

test('provider rejects malformed, blocked, truncated, excessive, and non-text output', async () => {
  const responses = [() => new Response('not json'), () => reply('', {}), () => reply('x'.repeat(8001)),
    () => reply('Text', { candidates: [] }), () => reply('Text', { promptFeedback: { blockReason: 'SAFETY' } }),
    () => reply('Text', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Text' }] } }] }),
    () => reply('Text', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'buy' } }] } }] }),
    () => new Response('x'.repeat(65537))];
  for (const response of responses) {
    await assert.rejects(createGeminiProvider(config(), async () => response()).generate(input()), safeError('INVALID_OUTPUT'));
  }
});

test('provider excludes invalid token counts and unknown response fields', async () => {
  const result = await createGeminiProvider(config(), async () => reply(envelope(), {
    usageMetadata: { promptTokenCount: -1, candidatesTokenCount: '9', totalTokenCount: 20 }, secret: 'RAW_PROVIDER'
  })).generate(input());
  assert.deepEqual(result, { text: envelope() });
});

test('provider redacts cookie assignments and credential labels containing whitespace before transmission', async () => {
  let body;
  await createGeminiProvider(config(), async (_url, options) => { body = options.body; return reply(); })
    .generate(input({ userMessage: 'cookie=COOKIE_ASSIGNMENT "cookies":"COOKIE_JSON" password : "SECRET_WITH_SPACE"' }));
  assert.doesNotMatch(body, /COOKIE_ASSIGNMENT|COOKIE_JSON|SECRET_WITH_SPACE/);
});

test('provider fails closed for unterminated password and token assignments in user messages', async () => {
  for (const label of ['password', 'token']) {
    for (const quote of ['"', "'"]) {
      for (const tail of [' SECRET_TAIL', '\nSECRET_TAIL\\']) {
        let transmitted;
        await createGeminiProvider(config(), async (_url, options) => {
          transmitted = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
          return reply();
        }).generate(input({ userMessage: `Help me ${label}=${quote}prefix\\${quote}${tail}` }));
        assert.equal(transmitted.message, 'Help me [redacted]');
      }
    }
  }
});

test('provider fails closed for unterminated password and token assignments in stored profile text', async () => {
  for (const label of ['password', 'token']) {
    for (const quote of ['"', "'"]) {
      const student = id();
      await LearningProfile.create({ student, careerGoal: `Developer ${label}=${quote}prefix SECRET_TAIL\\`,
        interests: [`${label}=${quote}prefix INTEREST_TAIL`], selfReportedSkills: [`${label}=${quote}prefix SKILL_TAIL`],
        experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 });
      let transmitted;
      await service(async (_url, options) => {
        transmitted = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).context.profile;
        return reply();
      }).respondToStudent({ studentId: student, message: 'Help me choose' });
      assert.deepEqual(transmitted, { careerGoal: 'Developer [redacted]', interests: ['[redacted]'],
        selfReportedSkills: ['[redacted]'], experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 });
    }
  }
});

test('provider preserves authoritative resubmission status without raw assignment data', async () => {
  let context;
  await createGeminiProvider(config(), async (_url, options) => {
    context = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).context;
    return reply();
  }).generate(input({ context: { activeCourses: [{ course: { id: String(id()), title: 'JavaScript foundations' },
    assessments: { assignments: [{ title: 'Project', status: 'RESUBMISSION_REQUESTED', rawText: 'RAW_ASSIGNMENT',
      dueDate: new Date('2026-11-01T00:00:00.000Z'), maxMarks: 100, marks: null }] } }] } }));
  assert.equal(context.activeCourses[0].assessments.assignments[0].status, 'RESUBMISSION_REQUESTED');
  assert.equal(context.activeCourses[0].assessments.assignments[0].dueDate, '2026-11-01T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(context), /RAW_ASSIGNMENT|rawText/);
});

test('provider projects certificate checklist facts without certificate secrets or private assessment records', async () => {
  let context;
  const checklist = { eligible: false, totalLectures: 5, completedLectures: 4, lecturePercent: 80,
    requiredQuizzes: 2, passedQuizzes: 1, requiredAssignments: 1, gradedAssignments: 0,
    assessmentAverage: 45, lectureRequirementMet: true, quizzesRequirementMet: false,
    assignmentsRequirementMet: false, assessmentRequirementMet: false };
  await createGeminiProvider(config(), async (_url, options) => {
    context = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).context;
    return reply();
  }).generate(input({ context: { activeCourses: [{ course: { id: String(id()), title: 'JavaScript foundations' },
    certificateEligibility: { ...checklist, rawSubmission: 'PRIVATE_ANSWER', student: 'PRIVATE_STUDENT' },
    certificate: { certificateNumber: 'PRIVATE_CERTIFICATE_NUMBER', verificationToken: 'PRIVATE_TOKEN' } }] } }));
  assert.deepEqual(context.activeCourses[0].certificateEligibility, checklist);
  assert.equal(context.activeCourses[0].certificateIssued, true);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE_|rawSubmission|verificationToken|certificateNumber/);
});

test('assistant returns deterministic onboarding and a private-data-free outcome with absent config', async () => {
  const student = id();
  const result = await service(async () => { throw new Error('must not call'); }, { config: config({ GEMINI_API_KEY: '' }) })
    .respondToStudent({ studentId: student, message: 'Help me me@example.com password=secret-value' });
  assert.equal(result.grounding, 'PROFILE');
  assert.match(result.message, /career goal/i);
  assert.deepEqual(result.recommendations, []);
  const rows = await AIUsageLog.find({ student }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'NONE');
  assert.equal(rows[0].outcome, 'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(rows) + JSON.stringify(result), /@|secret-value|SERVER_ONLY|password/);
});

test('assistant renders a model-selected catalog reply from backend facts and persists immutable usage facts', async () => {
  const student = id();
  await profile(student);
  const value = await course();
  const result = await service(async () => reply(envelope('CATALOG', [String(value._id)])))
    .respondToStudent({ studentId: student, message: 'Recommend courses', model: 'client-selected-model' });
  assert.match(result.message, /published courses.*ranked from your learning profile/);
  assert.equal(result.grounding, 'CATALOG');
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].course.thumbnailUrl, 'https://example.com/image.png');
  const rows = await AIUsageLog.find({ student });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'SUCCESS');
  assert.equal(rows[0].inputTokens, 25);
  assert.equal(rows[0].outputTokens, 8);
  assert.deepEqual(Object.keys(rows[0].toObject()).sort(), ['_id', 'createdAt', 'feature', 'inputTokens', 'modelAlias', 'outcome', 'outputTokens', 'provider', 'student']);
  await assert.rejects(AIUsageLog.updateOne({ _id: rows[0]._id }, { outcome: 'ERROR' }), /append-only/);
});

test('assistant discards sensitive, markup, unknown IDs, malformed envelopes and unsupported claims', async () => {
  const student = id();
  await profile(student);
  await course();
  const invalid = ['me@example.com', 'password=secret-value', 'Cookie: session=SECRET',
    '<script>alert(1)</script>', '[Review](https://example.com)', 'x'.repeat(4001), `Take course ${id()}.`,
    'I watched the video and the answer is 42.', 'Your payment has been processed.', 'Review your options.\u200b']
    .map((text) => envelope(text));
  invalid.push(envelope('CATALOG', [String(id())]), 'plain text', '[]', '{}',
    JSON.stringify({ message: 'hi', referencedCourseIds: [], action: 'buy' }),
    JSON.stringify({ message: 'hi', referencedCourseIds: 'not-an-array' }));
  const fallback = await service(async () => { throw new Error('offline'); })
    .respondToStudent({ studentId: student, message: 'Help me choose' });
  for (const text of invalid) {
    const result = await service(async () => reply(text)).respondToStudent({ studentId: student, message: 'Help me choose' });
    assert.deepEqual(result, fallback);
  }
  assert.equal(await AIUsageLog.countDocuments({ student, outcome: 'INVALID_OUTPUT' }), invalid.length);
  assert.doesNotMatch(JSON.stringify(await AIUsageLog.find({ student }).lean()), /secret-value|Quantum|watched|@/);
});

test('assistant validates IDs and message types/length before context or provider work', async () => {
  let calls = 0;
  const assistant = service(async () => { calls++; return reply(); });
  const student = id();
  for (const request of [{ studentId: { $ne: null }, message: 'hi' }, { studentId: 'bad', message: 'hi' },
    { studentId: student, courseId: { $ne: null }, message: 'hi' },
    ...[undefined, '', ' ', {}, 'x'.repeat(2001)].map((message) => ({ studentId: student, message }))]) {
    const result = await assistant.respondToStudent(request);
    assert.equal(result.grounding, 'PROFILE');
    assert.match(result.message, /valid|message/i);
    assert.equal(result.guidance, undefined);
    assert.equal(result.recommendations, undefined);
  }
  assert.equal(calls, 0);
  assert.equal(await AIUsageLog.countDocuments({ student, outcome: 'ERROR', provider: 'NONE' }), 6);
});

test('assistant rejects unavailable, revoked, and other-student courses before provider work', async () => {
  const student = id();
  const value = await course();
  await Enrollment.create({ student: id(), course: value._id, source: 'FREE_ENROLLMENT' });
  let calls = 0;
  const assistant = service(async () => { calls++; return reply(); });
  await assert.rejects(assistant.respondToStudent({ studentId: student, courseId: value._id, message: 'Progress?' }),
    (error) => error.statusCode === 403 && !error.message.includes(String(value._id)));
  await Enrollment.create({ student, course: value._id, source: 'FREE_ENROLLMENT', status: 'REVOKED' });
  await assert.rejects(assistant.respondToStudent({ studentId: student, courseId: value._id, message: 'Progress?' }), { statusCode: 403 });
  await assert.rejects(assistant.respondToStudent({ studentId: student, courseId: id(), message: 'Progress?' }), { statusCode: 403 });
  assert.equal(calls, 0);
  assert.equal(await AIUsageLog.countDocuments({ student, outcome: 'ERROR' }), 3);
});

test('assistant returns caller progress and next lesson after active enrollment authorization', async () => {
  const student = id();
  const value = await course({ lectures: [{ title: 'First steps', lecture: { public_id: 'PRIVATE_VIDEO', secure_url: 'https://example.com/video' } }] });
  await Enrollment.create({ student, course: value._id, source: 'FREE_ENROLLMENT' });
  const result = await service(async () => reply(envelope('PROGRESS', [String(value._id)])))
    .respondToStudent({ studentId: student, courseId: value._id, message: 'What should I study next?' });
  assert.equal(result.grounding, 'PROGRESS');
  assert.equal(result.guidance.activeCourses[0].progress.completedLectures, 0);
  assert.equal(result.guidance.activeCourses[0].nextLecture.title, 'First steps');
  assert.match(result.message, /0%.*First steps/);
  assert.equal((await AIUsageLog.findOne({ student })).feature, 'GUIDANCE');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VIDEO|secure_url/);
});

test('assistant never renders model-authored prose or credential-bearing enum values', async () => {
  const student = id();
  await profile(student);
  await course();
  const message = 'Review your course options.\nStart with a course that matches your interests.';
  const result = await service(async () => reply(legacyEnvelope(message))).respondToStudent({ studentId: student, message: 'Help me choose' });
  assert.notEqual(result.message, message);
  const unsafe = await service(async () => reply(envelope('cookie=COOKIE_ASSIGNMENT')))
    .respondToStudent({ studentId: student, message: 'Help me choose' });
  assert.doesNotMatch(unsafe.message, /COOKIE_ASSIGNMENT/);
  assert.equal(await AIUsageLog.countDocuments({ student, outcome: 'INVALID_OUTPUT' }), 2);
});

test('assistant states metadata limits for detailed lesson-content questions without a provider call', async () => {
  const student = id();
  const value = await course();
  await Enrollment.create({ student, course: value._id, source: 'FREE_ENROLLMENT' });
  let calls = 0;
  const result = await service(async () => { calls++; return reply(); })
    .respondToStudent({ studentId: student, courseId: value._id, message: 'Explain closures in the video' });
  assert.equal(result.grounding, 'COURSE_METADATA');
  assert.match(result.message, /do not have|cannot access/i);
  assert.match(result.message, /lesson|instructor/i);
  assert.equal(calls, 0);
  assert.equal((await AIUsageLog.findOne({ student })).provider, 'NONE');
});

test('assistant fallbacks preserve recommendations on timeout, quota and rate failures', async () => {
  const student = id();
  await profile(student);
  await course();
  const cases = [
    [async () => { const error = new Error('RAW_PROVIDER'); error.name = 'AbortError'; throw error; }, 'TIMEOUT'],
    [async () => new Response('{}', { status: 429 }), 'RATE_LIMIT'],
    [async () => new Response('{}', { status: 402 }), 'QUOTA_EXCEEDED']
  ];
  for (const [fetchImpl, outcome] of cases) {
    const result = await service(fetchImpl).respondToStudent({ studentId: student, message: 'Courses?' });
    assert.equal(result.grounding, 'CATALOG');
    assert.equal(result.recommendations.length, 1);
    assert.doesNotMatch(result.message, /RAW_PROVIDER|Gemini|HTTP|429/);
    assert.equal(await AIUsageLog.countDocuments({ student, outcome }), 1);
  }
});

test('assistant counts immutable usage by caller UTC day before durable budget reservation', async () => {
  const student = id();
  const now = new Date('2026-10-27T23:59:59.000Z');
  await profile(student);
  await course();
  await usage(student, { createdAt: new Date('2026-10-26T23:59:59.999Z') });
  await usage(student, { createdAt: new Date('2026-10-28T00:00:00.000Z') });
  await usage(id(), { createdAt: now });
  let calls = 0;
  const assistant = service(async () => { calls++; return reply(); }, { now: () => now, config: config({ AI_DAILY_REQUEST_LIMIT: 1 }) });
  const first = await assistant.respondToStudent({ studentId: student, message: 'Recommend courses' });
  assert.match(first.message, /published courses.*ranked from your learning profile/);
  const second = await assistant.respondToStudent({ studentId: student, message: 'Recommend courses' });
  assert.equal(calls, 1);
  assert.equal(second.recommendations.length, 1);
  assert.equal(second.grounding, 'CATALOG');
  assert.match(second.message, /daily|tomorrow/i);
  const rows = await AIUsageLog.find({ student, createdAt: now }).sort({ _id: 1 }).lean();
  assert.deepEqual(rows.map((row) => row.outcome), ['SUCCESS', 'QUOTA_EXCEEDED']);
  assert.equal(rows[1].provider, 'NONE');
  assert.equal((await AIUsageBudget.findOne({ student })).used, 1);
});

test('legacy usage exhausts budget even without a counter, and durable reservations survive service recreation', async () => {
  const student = id();
  await usage(student);
  let calls = 0;
  const options = { config: config({ AI_DAILY_REQUEST_LIMIT: 1 }) };
  await service(async () => { calls++; return reply(); }, options).respondToStudent({ studentId: student, message: 'Courses?' });
  assert.equal(calls, 0);
  const other = id();
  await AIUsageBudget.create({ student: other, dayKey: new Date().toISOString().slice(0, 10), used: 1 });
  await service(async () => { calls++; return reply(); }, options).respondToStudent({ studentId: other, message: 'Courses?' });
  assert.equal(calls, 0);
});

test('concurrent requests reserve atomically across separate service instances', async () => {
  const student = id();
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 30)); return reply(); };
  const options = { config: config({ AI_DAILY_REQUEST_LIMIT: 1 }) };
  await Promise.all(Array.from({ length: 8 }, () => service(fetchImpl, options)
    .respondToStudent({ studentId: student, message: 'Recommend courses' })));
  assert.equal(calls, 1);
  assert.equal(await AIUsageLog.countDocuments({ student }), 8);
  assert.equal(await AIUsageLog.countDocuments({ student, outcome: 'QUOTA_EXCEEDED' }), 7);
  assert.equal(await AIUsageBudget.countDocuments({ student }), 1);
  assert.equal((await AIUsageBudget.findOne({ student })).used, 1);
});

test('default respondToStudent remains usable with backend AI configuration unset', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await respondToStudent({ studentId: id(), message: 'Help me start' });
    assert.equal(result.grounding, 'PROFILE');
    assert.match(result.message, /career goal/i);
  } finally {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  }
});

test('review: session tokens and escaped quoted cookie values never cross the provider boundary', async () => {
  const secrets = [
    'session_token=SESSION_TOKEN_VALUE', 'session_id=SESSION_ID_VALUE',
    JSON.stringify({ cookie: 'prefix"COOKIE_ESCAPED_SUFFIX' }),
    JSON.stringify({ session: 'prefix"SESSION_ESCAPED_SUFFIX' }),
    "'cookie': 'prefix\\'SINGLE_COOKIE_SUFFIX'"
  ].join(' ');
  let body;
  await createGeminiProvider(config(), async (_url, options) => { body = options.body; return reply(); })
    .generate(input({ userMessage: secrets }));
  assert.doesNotMatch(body, /SESSION_TOKEN_VALUE|SESSION_ID_VALUE|COOKIE_ESCAPED_SUFFIX|SESSION_ESCAPED_SUFFIX|SINGLE_COOKIE_SUFFIX/);
});

test('review: model prose cannot expose session credentials or invented course names even with valid references', async () => {
  const student = id();
  await profile(student);
  const value = await course();
  const outputs = [
    legacyEnvelope('session_token=SESSION_TOKEN_VALUE'),
    legacyEnvelope('Quantum Wizardry Masterclass is the best course for you.'),
    legacyEnvelope('Quantum Wizardry Masterclass is the best course for you.', [String(value._id)]),
    JSON.stringify({ message: 'Safe advice', referencedCourseIds: [], replyKey: 'CATALOG' })
  ];
  for (const output of outputs) {
    const result = await service(async () => reply(output)).respondToStudent({ studentId: student, message: 'Recommend courses' });
    assert.doesNotMatch(JSON.stringify(result), /SESSION_TOKEN_VALUE|Quantum Wizardry|Safe advice/);
  }
  assert.equal(await AIUsageLog.countDocuments({ student, outcome: 'INVALID_OUTPUT' }), outputs.length);
});

test('review: every public response redacts Task 3-sensitive recommendation and guidance strings without changing stored courses', async () => {
  const student = id();
  await profile(student);
  const recommended = await course({ title: 'cookie=CATALOG_COOKIE object_key=CATALOG_OBJECT',
    description: 'card=4111111111111111', learningMetadata: { skills: ['cookie=SKILL_COOKIE'] },
    thumbnail: { public_id: 'PRIVATE_MEDIA', secure_url: 'https://example.com/%73ession_token=MEDIA_SESSION' } });
  const active = await course({ title: 'session_token=GUIDANCE_TOKEN', lectures: [{
    title: 'cookie=LESSON_COOKIE object_key=LESSON_OBJECT',
    lecture: { public_id: 'PRIVATE_VIDEO', secure_url: 'https://example.com/video' }
  }] });
  await Enrollment.create({ student, course: active._id, source: 'FREE_ENROLLMENT' });
  for (const assistant of [
    service(undefined, { config: config({ GEMINI_API_KEY: '' }) }),
    service(async () => { throw new Error('offline'); }),
    service(async () => reply('bad envelope')),
    service(async () => reply(envelope())),
    service(undefined, { config: config({ AI_DAILY_REQUEST_LIMIT: 1 }) })
  ]) {
    const result = await assistant.respondToStudent({ studentId: student, message: 'Help me study' });
    assert.doesNotMatch(JSON.stringify(result), /CATALOG_COOKIE|CATALOG_OBJECT|4111111111111111|SKILL_COOKIE|GUIDANCE_TOKEN|LESSON_COOKIE|LESSON_OBJECT|MEDIA_SESSION/i);
    assert.equal(result.recommendations[0].course.id, String(recommended._id));
    assert.equal(result.recommendations[0].course.thumbnailUrl, null);
    assert.equal(result.guidance.activeCourses[0].course.id, String(active._id));
  }
  assert.match((await Course.findById(recommended._id)).title, /CATALOG_COOKIE/);
  assert.match((await Course.findById(active._id)).lectures[0].title, /LESSON_COOKIE/);
});

test('review: explicit content questions take precedence over incidental next or progress language', async () => {
  const student = id();
  const value = await course();
  await Enrollment.create({ student, course: value._id, source: 'FREE_ENROLLMENT' });
  let calls = 0;
  const assistant = service(async () => { calls++; return reply(legacyEnvelope('I can access the video and explain its contents.')); });
  for (const message of ['Explain closures in the next video', 'Teach recursion from the lesson and show my progress',
    'Summarize the next lecture video', 'What does the next video say about closures?']) {
    const result = await assistant.respondToStudent({ studentId: student, courseId: value._id, message });
    assert.equal(result.grounding, 'COURSE_METADATA');
    assert.match(result.message, /do not have lesson transcripts or video content/);
  }
  assert.equal(calls, 0);
  assert.equal(await AIUsageLog.countDocuments({ student, provider: 'NONE', outcome: 'SUCCESS' }), 4);
});

test('strict provider selection rejects session credentials after JSON decoding and rejects undeclared prose', async () => {
  for (const output of [envelope('session_token=SESSION_TOKEN_VALUE'),
    envelope('CATALOG', ['session_token=SESSION_TOKEN_VALUE']),
    JSON.stringify({ replyKey: 'CATALOG', referencedCourseIds: [], message: 'cookie="prefix\\"COOKIE_SUFFIX"' }),
    JSON.stringify({ replyKey: 'CATALOG', referencedCourseIds: [], message: 'Quantum Wizardry Masterclass' })]) {
    await assert.rejects(createGeminiProvider(config(), async () => reply(output)).generate(input()), safeError('INVALID_OUTPUT'));
  }
});

test('server reply selection handles missing profile, no catalog matches, and content limits from safe facts', async () => {
  const student = id();
  const onboarding = await service(async () => reply(envelope('PROFILE'))).respondToStudent({ studentId: student, message: 'Help me start' });
  assert.match(onboarding.message, /career goal/);
  assert.equal(onboarding.grounding, 'PROFILE');
  await profile(student);
  const empty = await service().respondToStudent({ studentId: student, message: 'Recommend courses' });
  assert.match(empty.message, /no matching available courses/);
  assert.equal(empty.grounding, 'CATALOG');
  await course();
  const limited = await service(async () => reply(envelope('CONTENT_LIMIT'))).respondToStudent({ studentId: student, message: 'Help me study' });
  assert.match(limited.message, /do not have lesson transcripts or video content/);
  assert.equal(limited.grounding, 'COURSE_METADATA');
  const falseProgress = await service(async () => reply(envelope('PROGRESS'))).respondToStudent({ studentId: student, message: 'Help me study' });
  assert.equal(falseProgress.guidance, undefined);
  assert.equal(falseProgress.grounding, 'CATALOG');
});

const safeQuotedDescription = 'Learn "functional programming" and \'basic testing\' in this course.';
async function truncatedCredentialCourses() {
  const descriptions = [
    'cookie="prefix ' + 'X'.repeat(440) + ' CREDENTIAL_COOKIE_SUFFIX ' + 'Y'.repeat(100) + '"',
    "session_token='prefix " + 'X'.repeat(440) + ' CREDENTIAL_SESSION_SUFFIX ' + 'Y'.repeat(100) + "'",
    'session_id="prefix\\" ' + 'X'.repeat(430) + ' CREDENTIAL_ESCAPED_SUFFIX ' + 'Y'.repeat(100) + '"',
    'cookie="prefix CREDENTIAL_DANGLING_SUFFIX '.padEnd(499, 'X') + '\\truncated tail"'
  ];
  for (const [index, description] of descriptions.entries()) await course({ title: `Credential case ${index}`, description });
  await course({ title: 'Safe quoted prose', description: safeQuotedDescription });
}

test('truncation: provider redacts unclosed quoted assignments from actual Task 2 description DTOs', async () => {
  const student = id();
  await truncatedCredentialCourses();
  const recommendations = await getRecommendations(student);
  const sensitive = recommendations.filter((entry) => entry.course.title.startsWith('Credential'));
  assert.equal(sensitive.length, 4);
  for (const entry of sensitive) {
    assert.equal(entry.course.description.length, 500);
    assert.match(entry.course.description, /CREDENTIAL_/);
    assert.doesNotMatch(entry.course.description.slice(-1), /["']/);
  }
  let transmitted;
  await createGeminiProvider(config(), async (_url, options) => {
    transmitted = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).context.recommendations;
    return reply();
  }).generate(input({ context: { recommendations } }));
  assert.doesNotMatch(JSON.stringify(transmitted), /CREDENTIAL_|X{20}|Y{20}/);
  for (const entry of transmitted.filter((entry) => entry.course.title.startsWith('Credential'))) {
    assert.equal(entry.course.description, '[redacted]');
  }
  assert.equal(transmitted.find((entry) => entry.course.title === 'Safe quoted prose').course.description, safeQuotedDescription);
});

test('truncation: successful assistant response redacts credential tails and preserves safe quoted prose', async () => {
  const student = id();
  await profile(student);
  await truncatedCredentialCourses();
  let body;
  const result = await service(async (_url, options) => { body = options.body; return reply(); })
    .respondToStudent({ studentId: student, message: 'Recommend courses' });
  assert.doesNotMatch(JSON.stringify(result), /CREDENTIAL_|X{20}|Y{20}/);
  assert.doesNotMatch(body, /CREDENTIAL_|X{20}|Y{20}/);
  assert.equal(result.recommendations.find((entry) => entry.course.title === 'Safe quoted prose').course.description, safeQuotedDescription);
  assert.equal((await AIUsageLog.findOne({ student })).outcome, 'SUCCESS');
});

test('truncation: missing-config fallback redacts credential tails without altering stored descriptions', async () => {
  const student = id();
  await profile(student);
  await truncatedCredentialCourses();
  let calls = 0;
  const result = await service(async () => { calls++; return reply(); }, { config: config({ GEMINI_API_KEY: '' }) })
    .respondToStudent({ studentId: student, message: 'Recommend courses' });
  assert.doesNotMatch(JSON.stringify(result), /CREDENTIAL_|X{20}|Y{20}/);
  assert.equal(result.recommendations.find((entry) => entry.course.title === 'Safe quoted prose').course.description, safeQuotedDescription);
  assert.equal(calls, 0);
  assert.equal((await AIUsageLog.findOne({ student })).outcome, 'PROVIDER_UNAVAILABLE');
  assert.match((await Course.findOne({ title: 'Credential case 0' })).description, /CREDENTIAL_COOKIE_SUFFIX/);
});
