const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const LearningProfile = require('../models/learning-profile.schema');
const AIUsageLog = require('../models/ai-usage-log.schema');
const AIUsageBudget = require('../models/ai-usage-budget.schema');

const base = '/api/v1/ai';
const id = () => new mongoose.Types.ObjectId();
const profileInput = (changes = {}) => ({ careerGoal: 'Developer', interests: ['programming'],
  selfReportedSkills: ['javascript'], experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4, ...changes });
const missingFields = ['careerGoal', 'interests', 'experienceLevel', 'weeklyAvailabilityHours'];
let student;
let other;
let instructor;
let admin;
let providerCalls;
let app;

function providerReply(replyKey = 'CATALOG', referencedCourseIds = []) {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: {
    role: 'model', parts: [{ text: JSON.stringify({ replyKey, referencedCourseIds }) }]
  } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } }), { status: 200 });
}

function makeApp(changes = {}, fetchImpl = async () => { providerCalls++; return providerReply(); }) {
  return createTestApp({ ai: { config: { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'SERVER_ONLY_ROUTE_KEY',
    GEMINI_MODEL: 'gemini-route-test', AI_MAX_OUTPUT_TOKENS: '500', AI_DAILY_REQUEST_LIMIT: '20',
    AI_REQUEST_TIMEOUT_MS: '1000', ...changes }, fetchImpl } });
}

function call(method, path, user = student, target = app) {
  const req = request(target)[method](`${base}${path}`);
  if (user) req.set('Cookie', `token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
  return req;
}

function safeError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'message', 'success']);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.message, response.body.message);
  assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
  if (code) assert.equal(response.body.error.code, code);
  assert.doesNotMatch(JSON.stringify(response.body), /RAW_|SERVER_ONLY|gemini|Mongo|node_modules|password123|@example|stack/i);
}

async function course(changes = {}) {
  return Course.create({ title: 'JavaScript foundations', description: 'Learn JavaScript', category: 'Programming',
    instructor: instructor._id, thumbnail: { public_id: 'RAW_STORAGE_KEY', secure_url: 'https://image.example/course.png' }, ...changes });
}

async function enroll(user, item, status = 'ACTIVE') {
  return Enrollment.create({ student: user._id, course: item._id, source: 'FREE_ENROLLMENT', status });
}

test.before(async () => {
  process.env.JWT_SECRET = 'ai-route-test-secret';
  process.env.FRONTEND_URL = 'http://lms-frontend.test';
  await connectTestDb();
  await Promise.all([LearningProfile.init(), Enrollment.init(), LectureProgress.init(), AIUsageLog.init(), AIUsageBudget.init()]);
  [student, other, instructor, admin] = await Promise.all(['STUDENT', 'STUDENT', 'INSTRUCTOR', 'ADMIN'].map((role, index) =>
    User.create({ fullName: `Route User ${index}`, email: `ai-route-${index}@example.com`, password: 'password123', role })));
});

test.beforeEach(async () => {
  await Promise.all([Course.deleteMany({}), Enrollment.deleteMany({}), LectureProgress.deleteMany({}),
    LearningProfile.deleteMany({}), AIUsageBudget.deleteMany({}), AIUsageLog.collection.deleteMany({})]);
  providerCalls = 0;
  app = makeApp();
});

test.after(disconnectTestDb);

test('all AI endpoints require the existing cookie authentication and STUDENT role', async () => {
  for (const [method, path, body] of [['get', '/profile'], ['put', '/profile', profileInput()],
    ['get', '/recommendations'], ['get', '/guidance'], ['post', '/chat', { message: 'Help me choose.' }],
    ['post', '/course-tutor', { courseId: String(id()), question: 'Explain variables.' }]]) {
    for (const user of [null, instructor, admin]) {
      safeError(await call(method, path, user).send(body), user ? 403 : 401, user ? 'AUTH_ROLE_FORBIDDEN' : undefined);
    }
  }
  safeError(await request(app).get(`${base}/profile`).set('Cookie', 'token=invalid'), 401);
  safeError(await call('get', '/profile', { _id: id() }), 401);
  assert.equal(providerCalls, 0);
  assert.equal(await LearningProfile.countDocuments(), 0);
  assert.equal(await AIUsageLog.countDocuments(), 0);
});

test('new learner profile is null with actionable missing fields and common CORS/request headers', async () => {
  const response = await call('get', '/profile').set('Origin', 'http://lms-frontend.test');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, profile: null, missingFields });
  assert.equal(response.headers['access-control-allow-origin'], 'http://lms-frontend.test');
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.ok(response.headers['x-request-id']);
  assert.equal(await LearningProfile.countDocuments(), 0);
  assert.equal(providerCalls, 0);
});

test('profile saves normalized safe fields for the cookie owner and reports missing interests', async () => {
  const saved = await call('put', '/profile').send(profileInput({ interests: [], experienceLevel: 'beginner',
    careerGoal: 'Developer owner@example.com password=RAW_CREDENTIAL', selfReportedSkills: [' JavaScript ', 'javascript'] }));
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.missingFields, ['interests']);
  assert.deepEqual(Object.keys(saved.body.profile).sort(), Object.keys(profileInput()).sort());
  assert.deepEqual(saved.body.profile.selfReportedSkills, ['javascript']);
  assert.equal(saved.body.profile.experienceLevel, 'BEGINNER');
  assert.doesNotMatch(JSON.stringify(saved.body), /RAW_|@|student|createdAt|updatedAt|__v|_id/);
  assert.deepEqual((await call('get', '/profile')).body, saved.body);
  assert.equal(String((await LearningProfile.findOne()).student), String(student._id));
  const updated = await call('put', '/profile').send({ interests: ['Programming'] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.missingFields, []);
  assert.equal(updated.body.profile.weeklyAvailabilityHours, 4);
  assert.equal((await call('get', '/profile', other)).body.profile, null);
});

test('forged student fields and unknown profile fields never select or modify another learner', async () => {
  await LearningProfile.create({ student: other._id, ...profileInput({ careerGoal: 'Other learner private goal' }) });
  for (const field of ['student', 'studentId', '_id', 'userId', 'password']) {
    safeError(await call('put', '/profile').send({ ...profileInput(), [field]: String(other._id) }), 400, 'AI_PROFILE_INVALID');
  }
  safeError(await call('put', `/profile?studentId=${other._id}`).send(profileInput()), 400, 'AI_REQUEST_INVALID');
  safeError(await call('get', `/profile?studentId=${other._id}`), 400, 'AI_REQUEST_INVALID');
  assert.equal(await LearningProfile.countDocuments({ student: student._id }), 0);
  assert.equal((await LearningProfile.findOne({ student: other._id })).careerGoal, 'Other learner private goal');
});

test('profile rejects wrong field types and schema bounds without echoing submitted values', async () => {
  const invalid = [{ careerGoal: 7 }, { careerGoal: '' }, { careerGoal: 'x'.repeat(501) },
    { interests: 'Programming' }, { interests: [7] }, { interests: [''] }, { interests: ['x'.repeat(81)] },
    { interests: Array.from({ length: 21 }, (_, n) => `topic${n}`) }, { selfReportedSkills: null },
    { experienceLevel: ['BEGINNER'] }, { experienceLevel: 'RAW_BAD_LEVEL' }, { weeklyAvailabilityHours: '4' },
    { weeklyAvailabilityHours: 0 }, { weeklyAvailabilityHours: 81 }, { weeklyAvailabilityHours: 1.5 }];
  for (const fields of invalid) safeError(await call('put', '/profile').send(profileInput(fields)), 400, 'AI_PROFILE_INVALID');
  for (const body of [[], {}, { careerGoal: 'Developer' }]) {
    safeError(await call('put', '/profile').send(body), 400, 'AI_PROFILE_INVALID');
  }
  assert.equal(await LearningProfile.countDocuments(), 0);
});

test('recommendations use the authenticated learner and expose only published unowned safe cards', async () => {
  const owned = await course({ title: 'Owned course' });
  const hidden = await course({ title: 'Unpublished course', status: 'UNPUBLISHED' });
  const available = await course({ title: 'Available course' });
  const otherOwned = await course({ title: 'Other learner course' });
  await enroll(student, owned);
  await enroll(other, otherOwned);
  const response = await call('get', '/recommendations');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['recommendations', 'success']);
  assert.deepEqual(response.body.recommendations.map((entry) => entry.course.id).sort(), [String(available._id), String(otherOwned._id)].sort());
  assert.doesNotMatch(JSON.stringify(response.body), /RAW_|instructor|public_id|secure_url|email|student|subscription|password|__v/);
  assert.ok(!response.body.recommendations.some((entry) => [String(owned._id), String(hidden._id)].includes(entry.course.id)));
  const otherResponse = await call('get', '/recommendations', other);
  assert.ok(otherResponse.body.recommendations.some((entry) => entry.course.id === String(owned._id)));
  assert.ok(!otherResponse.body.recommendations.some((entry) => entry.course.id === String(otherOwned._id)));
  assert.equal(providerCalls, 0);
});

test('recommendation limits default to five and accept only one integer from 1 through 20', async () => {
  await Promise.all(Array.from({ length: 6 }, (_, n) => course({ title: `Catalog course ${n}` })));
  for (const [query, count] of [['', 5], ['?limit=1', 1], ['?limit=20', 6]]) {
    const response = await call('get', `/recommendations${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.recommendations.length, count);
  }
  for (const query of ['limit=', 'limit=0', 'limit=21', 'limit=-1', 'limit=1.5', 'limit=1e1', 'limit=true',
    'limit=%202', 'limit=1&limit=2', 'limit[value]=2', `studentId=${other._id}`]) {
    safeError(await call('get', `/recommendations?${query}`), 400, 'AI_REQUEST_INVALID');
  }
});

test('guidance returns only the caller active course progress and never invokes the provider', async () => {
  const first = id();
  const second = id();
  const ownCourse = await course({ lectures: [
    { _id: first, title: 'First lesson', lecture: { public_id: 'RAW_VIDEO_ONE', secure_url: 'https://video.example/one.mp4' } },
    { _id: second, title: 'Second lesson', lecture: { public_id: 'RAW_VIDEO_TWO', secure_url: 'https://video.example/two.mp4' } }
  ] });
  const otherCourse = await course({ title: 'Other learner private course' });
  await enroll(student, ownCourse);
  await enroll(other, otherCourse);
  await LectureProgress.create({ student: other._id, course: ownCourse._id, lectureId: first, completed: true });
  const response = await call('get', `/guidance?courseId=${ownCourse._id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body), ['success', 'guidance']);
  assert.deepEqual(Object.keys(response.body.guidance), ['activeCourses']);
  assert.equal(response.body.guidance.activeCourses.length, 1);
  const facts = response.body.guidance.activeCourses[0];
  assert.equal(facts.course.id, String(ownCourse._id));
  assert.deepEqual(facts.progress, { totalLectures: 2, completedLectures: 0, completionPercent: 0 });
  assert.deepEqual(facts.nextLecture, { id: String(first), title: 'First lesson' });
  assert.doesNotMatch(JSON.stringify(response.body), /RAW_|Other learner|student|public_id|secure_url|email|password|__v/);
  const otherResponse = await call('get', '/guidance', other);
  assert.deepEqual(otherResponse.body.guidance.activeCourses.map((entry) => entry.course.id), [String(otherCourse._id)]);
  assert.equal(providerCalls, 0);
  assert.equal(await AIUsageLog.countDocuments(), 0);
});

test('unavailable course guidance and chat deny access before provider calls or budget reservations', async () => {
  const unowned = await course();
  const revoked = await course({ title: 'Revoked course' });
  const unpublished = await course({ title: 'Hidden course', status: 'UNPUBLISHED' });
  await enroll(other, unowned);
  await enroll(student, revoked, 'REVOKED');
  await enroll(student, unpublished);
  for (const courseId of [unowned._id, revoked._id, unpublished._id, id()]) {
    safeError(await call('get', `/guidance?courseId=${courseId}`), 403, 'AI_ENROLLMENT_REQUIRED');
    safeError(await call('post', '/chat').send({ message: 'Show my progress.', courseId: String(courseId) }), 403, 'AI_ENROLLMENT_REQUIRED');
  }
  assert.equal(providerCalls, 0);
  assert.equal(await AIUsageBudget.countDocuments(), 0);
});

test('guidance rejects malformed, repeated, and unknown query fields', async () => {
  for (const query of ['courseId=', 'courseId=invalid', 'courseId[bad]=x', `courseId=${id()}&courseId=${id()}`,
    `studentId=${other._id}`, 'message=Help', `courseId=${id()}&model=RAW_OVERRIDE`]) {
    safeError(await call('get', `/guidance?${query}`), 400, 'AI_REQUEST_INVALID');
  }
  assert.equal(providerCalls, 0);
});

test('chat validates exact body fields, types, question size, and course IDs before assistant side effects', async () => {
  const invalid = [[], {}, { message: null }, { message: 1 }, { message: true }, { message: [] }, { message: {} },
    { message: '' }, { message: ' \n\t ' }, { message: 'x'.repeat(2001) }, { message: 'Help', courseId: '' },
    { message: 'Help', courseId: 123 }, { message: 'Help', courseId: null }, { message: 'Help', courseId: {} },
    { message: 'Help', courseId: [] }, { message: 'Help', courseId: 'bad' },
    { message: 'Help', studentId: String(other._id) }, { message: 'Help', model: 'RAW_OVERRIDE' },
    { message: 'Help', history: [] }, { message: 'Help', extra: true }];
  for (const body of invalid) safeError(await call('post', '/chat').send(body), 400, 'AI_CHAT_INVALID');
  safeError(await call('post', `/chat?studentId=${other._id}`).send({ message: 'Help' }), 400, 'AI_REQUEST_INVALID');
  assert.equal(await AIUsageLog.countDocuments(), 0);
  assert.equal(await AIUsageBudget.countDocuments(), 0);
  assert.equal(providerCalls, 0);
});

test('chat accepts the maximum message length and returns only the safe Task 3 envelope', async () => {
  await LearningProfile.create({ student: student._id, ...profileInput() });
  const item = await course();
  const response = await call('post', '/chat').send({ message: 'x'.repeat(2000) });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body), ['success', 'assistant']);
  assert.equal(response.body.assistant.grounding, 'CATALOG');
  assert.equal(response.body.assistant.recommendations[0].course.id, String(item._id));
  assert.doesNotMatch(JSON.stringify(response.body), /RAW_|SERVER_ONLY|gemini|usage|replyKey|referencedCourseIds|inputTokens|student|_id/);
  assert.equal(providerCalls, 1);
  const log = await AIUsageLog.findOne();
  assert.equal(String(log.student), String(student._id));
  assert.equal(log.outcome, 'SUCCESS');
  assert.equal((await AIUsageBudget.findOne()).used, 1);
});

test('missing provider configuration preserves deterministic profile and recommendation fallback', async () => {
  app = makeApp({ GEMINI_API_KEY: '' });
  const item = await course();
  const response = await call('post', '/chat').send({ message: 'Help me choose.' });
  assert.equal(response.status, 200);
  assert.equal(response.body.assistant.grounding, 'PROFILE');
  assert.match(response.body.assistant.message, /career goal/i);
  assert.equal(response.body.assistant.recommendations[0].course.id, String(item._id));
  assert.doesNotMatch(JSON.stringify(response.body), /SERVER_ONLY|gemini|PROVIDER_UNAVAILABLE|api.key|usage/i);
  assert.equal(providerCalls, 0);
  assert.equal((await AIUsageLog.findOne()).outcome, 'PROVIDER_UNAVAILABLE');
});

test('chat preserves the durable daily limit with safe fallback and caller-isolated budgets', async () => {
  app = makeApp({ AI_DAILY_REQUEST_LIMIT: '1' });
  assert.equal((await call('post', '/chat').send({ message: 'Help me choose.' })).status, 200);
  const denied = await call('post', '/chat').send({ message: 'Help me choose.' });
  assert.equal(denied.status, 200);
  assert.match(denied.body.assistant.message, /tomorrow/i);
  assert.equal(providerCalls, 1);
  assert.equal((await call('post', '/chat', other).send({ message: 'Help me choose.' })).status, 200);
  assert.equal(providerCalls, 2);
  assert.equal(await AIUsageLog.countDocuments({ student: student._id, outcome: 'QUOTA_EXCEEDED' }), 1);
  assert.equal((await AIUsageBudget.findOne({ student: student._id })).used, 1);
});

test('provider failures and malicious output stay inside the safe fallback envelope', async () => {
  for (const fetchImpl of [async () => { throw new Error('RAW_PROVIDER SERVER_ONLY_ROUTE_KEY'); },
    async () => new Response(JSON.stringify({ error: { message: 'RAW_PROVIDER SERVER_ONLY_ROUTE_KEY' } }), { status: 429 }),
    async () => providerReply('RAW_PROVIDER')]) {
    app = makeApp({}, fetchImpl);
    const response = await call('post', '/chat').send({ message: 'Help me choose.' });
    assert.equal(response.status, 200);
    assert.equal(response.body.assistant.grounding, 'PROFILE');
    assert.doesNotMatch(JSON.stringify(response.body), /RAW_|SERVER_ONLY|gemini|stack|provider|usage/i);
  }
});

test('database errors and failed usage writes use safe errors in development as well as production', async () => {
  const originalFind = LearningProfile.findOne;
  const originalCreate = AIUsageLog.create;
  const originalEnv = process.env.NODE_ENV;
  try {
    for (const mode of ['test', 'production']) {
      process.env.NODE_ENV = mode;
      LearningProfile.findOne = () => { throw new Error('RAW_DATABASE student@example.com password123'); };
      safeError(await call('get', '/profile'), 503, 'AI_UNAVAILABLE');
      LearningProfile.findOne = originalFind;
      AIUsageLog.create = async () => { throw new Error('RAW_AUDIT SERVER_ONLY_ROUTE_KEY'); };
      safeError(await call('post', '/chat').send({ message: 'Help me choose.' }), 503, 'AI_UNAVAILABLE');
      AIUsageLog.create = originalCreate;
    }
  } finally {
    LearningProfile.findOne = originalFind;
    AIUsageLog.create = originalCreate;
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

test('malformed JSON and oversized payloads retain standard safe errors without body or stack disclosure', async () => {
  safeError(await call('post', '/chat').set('Content-Type', 'application/json').send('{"message":"RAW_INPUT"'), 400, 'REQUEST_INVALID_JSON');
  safeError(await call('post', '/chat').send({ message: 'x'.repeat(1024 * 1024) }), 413, 'REQUEST_TOO_LARGE');
  assert.equal(await AIUsageLog.countDocuments(), 0);
  assert.equal(providerCalls, 0);
});

test('review: profile GET and PUT redact recognizable session credentials from every public text field', async () => {
  const saved = await call('put', '/profile').send(profileInput({
    careerGoal: 'Developer session_id=PROFILE_SESSION_VALUE',
    interests: ['programming', 'cookie="PROFILE_COOKIE_VALUE"'],
    selfReportedSkills: ['javascript', 'session_id=PROFILE_SKILL_VALUE']
  }));
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body), /PROFILE_SESSION_VALUE|profile_cookie_value|profile_skill_value/i);
  assert.deepEqual(saved.body.profile, { careerGoal: 'Developer [redacted]', interests: ['programming', '[redacted]'],
    selfReportedSkills: ['javascript', '[redacted]'], experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4 });
  assert.deepEqual(saved.body.missingFields, []);
  assert.deepEqual((await call('get', '/profile')).body, saved.body);

  await LearningProfile.create({ student: other._id, ...profileInput({ careerGoal: 'Legacy session_id=LEGACY_SESSION_VALUE' }) });
  const legacy = await call('get', '/profile', other);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.profile.careerGoal, 'Legacy [redacted]');
  assert.equal((await LearningProfile.findOne({ student: other._id })).careerGoal, 'Legacy session_id=LEGACY_SESSION_VALUE');
  assert.equal(providerCalls, 0);
});

test('review: recommendation descriptions apply the same session redaction as successful chat and provider context', async () => {
  let outbound;
  app = makeApp({}, async (_url, options) => { providerCalls++; outbound = options.body; return providerReply(); });
  await LearningProfile.create({ student: student._id, ...profileInput() });
  const item = await course({ description: 'Learn JavaScript session_id=RECOMMENDATION_SESSION_VALUE' });
  const direct = await call('get', '/recommendations');
  assert.equal(direct.status, 200);
  assert.equal(direct.body.recommendations[0].course.description, 'Learn JavaScript [redacted]');
  assert.equal(direct.body.recommendations[0].course.id, String(item._id));
  assert.equal(direct.body.recommendations[0].course.thumbnailUrl, 'https://image.example/course.png');
  assert.equal(typeof direct.body.recommendations[0].score, 'number');
  assert.equal(providerCalls, 0);

  const chat = await call('post', '/chat').send({ message: 'Help me choose.' });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.assistant.grounding, 'CATALOG');
  assert.deepEqual(chat.body.assistant.recommendations, direct.body.recommendations);
  assert.doesNotMatch(outbound, /RECOMMENDATION_SESSION_VALUE/);
  assert.equal(providerCalls, 1);
  assert.equal((await AIUsageLog.findOne()).outcome, 'SUCCESS');
  assert.equal((await Course.findById(item._id)).description, 'Learn JavaScript session_id=RECOMMENDATION_SESSION_VALUE');
});

test('review: recommendation thumbnails reject session credentials while preserving safe ordinary HTTPS URLs', async () => {
  const cases = [
    ['https://image.example/session_id=THUMBNAIL_SESSION_VALUE.png', null],
    ['https://image.example/%73ession_id%3DENCODED_SESSION_VALUE.png', null],
    ['https://image.example/%2573ession_id%253DTWICE_ENCODED_SESSION_VALUE.png', null],
    ['https://image.example/normal-image.png', 'https://image.example/normal-image.png'],
    ['https://image.example/normal%20image.png', 'https://image.example/normal%20image.png']
  ];
  const expected = new Map();
  for (const [url, thumbnailUrl] of cases) {
    const item = await course({ title: `Thumbnail case ${expected.size}`, thumbnail: { public_id: 'RAW_STORAGE_KEY', secure_url: url } });
    expected.set(String(item._id), thumbnailUrl);
  }
  const direct = await call('get', '/recommendations');
  assert.equal(direct.status, 200);
  assert.equal(direct.body.recommendations.length, 5);
  for (const entry of direct.body.recommendations) assert.equal(entry.course.thumbnailUrl, expected.get(entry.course.id));
  assert.doesNotMatch(JSON.stringify(direct.body), /THUMBNAIL_SESSION_VALUE|ENCODED_SESSION_VALUE/);
  assert.equal(providerCalls, 0);
  const chat = await call('post', '/chat').send({ message: 'Help me choose.' });
  assert.equal(chat.status, 200);
  assert.deepEqual(chat.body.assistant.recommendations, direct.body.recommendations);
});

test('review: guidance sanitizes nested course and next-lecture text while preserving progress facts', async () => {
  const lectureId = id();
  const item = await course({ title: 'Course session_id=GUIDANCE_SESSION_VALUE', lectures: [{
    _id: lectureId, title: 'Next session_id=LECTURE_SESSION_VALUE',
    lecture: { public_id: 'RAW_VIDEO_KEY', secure_url: 'https://video.example/lesson.mp4' }
  }] });
  await enroll(student, item);
  for (const suffix of ['', `?courseId=${item._id}`]) {
    const response = await call('get', `/guidance${suffix}`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /GUIDANCE_SESSION_VALUE|LECTURE_SESSION_VALUE/);
    const facts = response.body.guidance.activeCourses[0];
    assert.deepEqual(facts.course, { id: String(item._id), title: 'Course [redacted]', category: 'Programming' });
    assert.deepEqual(facts.nextLecture, { id: String(lectureId), title: 'Next [redacted]' });
    assert.deepEqual(facts.progress, { totalLectures: 1, completedLectures: 0, completionPercent: 0 });
    assert.deepEqual(facts.assessments, { totalQuizzes: 0, totalAssignments: 0, quizzes: [], assignments: [] });
    assert.equal(facts.certificate, null);
  }
  assert.equal(providerCalls, 0);
  assert.equal(await AIUsageLog.countDocuments(), 0);
});

test('review: enabled common security limiter retains its safe 429 contract on AI routes', async () => {
  app = createTestApp({ security: { enabled: true, publicMax: 1, windowMs: 60_000 } });
  assert.equal((await call('get', '/profile')).status, 200);
  const response = await call('get', '/profile');
  safeError(response, 429, 'SECURITY_RATE_LIMITED');
  assert.equal(response.body.message, 'Too many requests. Please wait a few minutes and try again.');
  assert.equal(response.headers['retry-after'], '60');
  assert.ok(response.headers.ratelimit);
  assert.ok(response.headers['x-request-id']);
  assert.equal(await AIUsageLog.countDocuments(), 0);
});
