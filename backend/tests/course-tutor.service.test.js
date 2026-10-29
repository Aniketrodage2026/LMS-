const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createApp } = require('../app');
const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Material = require('../models/course-material.schema');
const Chunk = require('../models/course-material-chunk.schema');
const Budget = require('../models/rag-usage-budget.schema');
const Log = require('../models/rag-usage-log.schema');
const AiBudget = require('../models/ai-usage-budget.schema');

const config = { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'SERVER_ONLY_KEY', GEMINI_MODEL: 'gemini-test',
  RAG_REQUEST_TIMEOUT_MS: '1000', RAG_DAILY_REQUEST_LIMIT: '10' };
const now = () => new Date('2026-10-29T10:00:00.000Z');
const vector = Array(768).fill(0.25);
let serial = 0;
let learner, other, instructor, admin, course, calls, rows, generated, onSearch, onGenerate;
const newId = () => new mongoose.Types.ObjectId();

function options(extra = {}) {
  return { config, now, embedQuery: async question => { calls.embed.push(question); return [...vector]; },
    vectorSearch: async pipeline => { calls.search.push(pipeline); if (onSearch) await onSearch(); return rows; },
    generate: async input => { calls.generate.push(input); if (onGenerate) await onGenerate(); return generated; },
    storage: { signedReadUrl: async material => { calls.sign.push(material); return 'https://private.example/document?signature=SECRET'; } }, ...extra };
}
function service(extra = {}) { return require('../services/course-tutor.service').createCourseTutorService(options(extra)); }
function question(extra = {}) { return { studentId: learner._id, courseId: course.id, question: 'What is a variable?', ...extra }; }
function call(app, method, path, user = learner) {
  const req = request(app)[method](path);
  if (user) req.set('Cookie', `token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
  return req;
}
async function fixtureMaterial({ target = course, lecture = null, status = 'PUBLISHED', text = 'A variable stores a value.', ordinal = 0 } = {}) {
  const material = await Material.create({ course: target._id, lecture, title: `Notes ${++serial}`, originalFilename: 'notes.pdf',
    storage: { provider: 'R2', key: `materials/${serial}/source.pdf`, contentType: 'application/pdf', size: 20 },
    contentType: 'application/pdf', size: 20, contentHash: serial.toString(16).padStart(64, '0'),
    status: 'PROCESSING', pageCount: 3, extractedCharacterCount: text.length, uploadedBy: instructor._id });
  const chunk = await Chunk.create({ material: material._id, course: target._id, lecture, ordinal,
    pageStart: 1, pageEnd: 2, text, embedding: vector, embeddingModel: 'gemini-embedding-2', embeddingDimension: 768 });
  material.status = 'READY'; await material.save();
  if (status === 'PUBLISHED') { material.status = status; await material.save(); }
  return { material, chunk };
}
function hit(chunk, score = 0.9) { return { _id: chunk._id, score }; }
function providerBody(value) {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }), { status: 200 });
}

test.before(async () => {
  process.env.JWT_SECRET = 'course-tutor-test-secret';
  await connectTestDb();
  await Promise.all([Material.init(), Chunk.init(), Budget.init(), Enrollment.init()]);
  [learner, other, instructor, admin] = await Promise.all(['STUDENT', 'STUDENT', 'INSTRUCTOR', 'ADMIN'].map((role, n) =>
    User.create({ fullName: `Tutor user ${n}`, email: `tutor-${n}@example.com`, password: 'password123', role })));
});
test.beforeEach(async () => {
  await Promise.all([Course.deleteMany({}), Enrollment.deleteMany({}), Material.deleteMany({}), Chunk.deleteMany({}),
    Budget.collection.deleteMany({}), Log.collection.deleteMany({}), AiBudget.deleteMany({})]);
  course = await Course.create({ title: 'Programming course', description: 'Learn programming', category: 'Programming',
    instructor: instructor._id, thumbnail: { public_id: 'RAW_KEY', secure_url: 'https://example.com/image.png' },
    lectures: [{ title: 'Variables', lecture: { public_id: 'RAW_VIDEO', secure_url: 'https://example.com/video.mp4' } },
      { title: 'Functions', lecture: { public_id: 'RAW_VIDEO2', secure_url: 'https://example.com/video2.mp4' } }] });
  await Enrollment.create({ student: learner._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });
  calls = { embed: [], search: [], generate: [], sign: [] }; rows = []; onSearch = null; onGenerate = null;
  generated = { text: JSON.stringify({ answer: 'A variable stores a value.', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 2 }] }) };
});
test.after(disconnectTestDb);

test('student material and tutor routes deny roles and absent enrollment before private or provider work', async () => {
  const app = createApp({ security: { enabled: false }, tutor: options() });
  for (const user of [null, instructor, admin, other]) {
    const expected = user ? 403 : 401;
    assert.equal((await call(app, 'get', `/api/v1/courses/${course.id}/materials`, user)).status, expected);
    assert.equal((await call(app, 'get', `/api/v1/courses/${course.id}/materials/${newId()}/download`, user)).status, expected);
    assert.equal((await call(app, 'post', '/api/v1/ai/course-tutor', user).send({ courseId: course.id, question: 'Explain variables.' })).status, expected);
  }
  assert.deepEqual(calls, { embed: [], search: [], generate: [], sign: [] });
  assert.equal(await Budget.countDocuments(), 0); assert.equal(await Log.countDocuments(), 0);
});

test('service independently rejects invalid ids, non-students, revoked and unpublished access before material queries', async t => {
  const materialFind = t.mock.method(Material, 'find', () => { throw new Error('Material query must not run'); });
  for (const studentId of [instructor._id, admin._id, other._id, newId()]) await assert.rejects(service().answerCourseQuestion(question({ studentId })), error => error.statusCode === 403);
  for (const patch of [{ courseId: 'bad' }, { lectureId: 'bad' }, { question: '' }, { question: 'x'.repeat(2001) }]) {
    await assert.rejects(service().answerCourseQuestion(question(patch)), error => error.statusCode === 400);
  }
  await Enrollment.updateOne({ student: learner._id }, { status: 'REVOKED' });
  await assert.rejects(service().answerCourseQuestion(question()), error => error.statusCode === 403);
  await Enrollment.updateOne({ student: learner._id }, { status: 'ACTIVE' });
  await Course.updateOne({ _id: course._id }, { status: 'UNPUBLISHED' });
  await assert.rejects(service().answerCourseQuestion(question()), error => error.statusCode === 403);
  assert.equal(materialFind.mock.callCount(), 0); assert.equal(calls.embed.length, 0);
});

test('published material list and download expose only safe fields and authorize every new URL', async () => {
  const { material } = await fixtureMaterial(); const hidden = await fixtureMaterial({ status: 'READY' });
  const app = createApp({ security: { enabled: false }, tutor: options() });
  const base = `/api/v1/courses/${course.id}/materials`;
  const listed = await call(app, 'get', base);
  assert.equal(listed.status, 200); assert.equal(listed.body.materials.length, 1);
  assert.deepEqual(Object.keys(listed.body.materials[0]).sort(), ['downloadEndpoint', 'id', 'lectureId', 'pageCount', 'title']);
  assert.equal(listed.body.materials[0].downloadEndpoint, `${base}/${material.id}/download`);
  assert.doesNotMatch(JSON.stringify(listed.body), /storage|provider|source\.pdf|embedding|contentHash|signature|SECRET/);
  const downloaded = await call(app, 'get', `${base}/${material.id}/download`);
  assert.equal(downloaded.status, 302); assert.equal(downloaded.text, '');
  assert.equal(downloaded.headers['cache-control'], 'no-store'); assert.equal(downloaded.headers['referrer-policy'], 'no-referrer');
  assert.match(downloaded.headers.location, /signature=SECRET/);
  assert.equal((await call(app, 'get', `${base}/${hidden.material.id}/download`)).status, 404);
  material.status = 'READY'; await material.save();
  assert.equal((await call(app, 'get', `${base}/${material.id}/download`)).status, 404);
  assert.equal(calls.sign.length, 1); assert.equal((await call(app, 'get', base)).body.materials.length, 0);
});

test('course tutor rehydrates authorized vector hits and returns only verified material page citations', async () => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const result = await service().answerCourseQuestion(question());
  assert.deepEqual(result, { answer: 'A variable stores a value.', outcome: 'ANSWERED',
    citations: [{ materialId: material.id, title: material.title, pageStart: 1, pageEnd: 2 }] });
  const pipeline = calls.search[0];
  assert.deepEqual(Object.keys(pipeline[0]), ['$vectorSearch']);
  assert.equal(pipeline[0].$vectorSearch.path, 'embedding');
  assert.equal(pipeline[0].$vectorSearch.queryVector.length, 768);
  assert.equal(String(pipeline[0].$vectorSearch.filter.course), course.id);
  assert.equal(pipeline[0].$vectorSearch.filter.embeddingModel, 'gemini-embedding-2');
  assert.equal(pipeline[0].$vectorSearch.filter.embeddingDimension, 768);
  assert.deepEqual(pipeline[0].$vectorSearch.filter.material.$in.map(String), [material.id]);
  assert.equal(await Budget.countDocuments({ student: learner._id, dayKey: '2026-10-29', used: 1 }), 1);
  assert.equal(await AiBudget.countDocuments(), 0);
  const log = (await Log.findOne().lean()); assert.equal(log.outcome, 'SUCCESS'); assert.equal(log.sourceCount, 1);
  assert.doesNotMatch(JSON.stringify(log), /What is|stores a value|source\.pdf|embedding|signature/);
});

test('lecture scope includes course-wide and chosen lecture but excludes other lectures and foreign vector hits', async () => {
  const shared = await fixtureMaterial(); const selected = await fixtureMaterial({ lecture: course.lectures[0]._id });
  const wrong = await fixtureMaterial({ lecture: course.lectures[1]._id });
  rows = [hit(wrong.chunk), hit(shared.chunk), hit(selected.chunk)];
  const result = await service().answerCourseQuestion(question({ lectureId: String(course.lectures[0]._id) }));
  assert.equal(result.outcome, 'ANSWERED');
  const filter = calls.search[0][0].$vectorSearch.filter;
  assert.deepEqual(filter.material.$in.map(String).sort(), [shared.material.id, selected.material.id].sort());
  assert.equal(String(filter.$or[0].lecture), String(course.lectures[0]._id));
  assert.deepEqual(filter.$or[1].material.$in.map(String), [shared.material.id]);
  assert.equal(calls.generate[0].sources.length, 2);
  await assert.rejects(service().answerCourseQuestion(question({ lectureId: String(newId()) })), error => error.statusCode === 400);
});

test('missing sources, irrelevant hits, unknown hits and missing index never generate an answer', async () => {
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'NO_RELEVANT_SOURCE');
  assert.equal(calls.embed.length, 0);
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk, 0.1), hit({ _id: newId() })];
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'NO_RELEVANT_SOURCE');
  const unavailable = service({ vectorSearch: async () => { throw new Error('Mongo secret index details'); } });
  const fallback = await unavailable.answerCourseQuestion(question());
  assert.equal(fallback.outcome, 'RAG_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(fallback), /Mongo|secret|index/);
  assert.equal(calls.generate.length, 0); assert.equal(await Budget.countDocuments(), 0);
  assert.equal(await Log.countDocuments(), 3);
});

test('strict grounded output rejects fabricated pages, citations, extra fields and unsafe answer text', async () => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const invalid = [
    { answer: 'Invented', citations: [{ sourceId: 'S99', pageStart: 1, pageEnd: 2 }] },
    { answer: 'Invented', citations: [{ sourceId: 'S1', pageStart: 2, pageEnd: 3 }] },
    { answer: 'Invented', citations: [] },
    { answer: 'Invented', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 2 }, { sourceId: 'S1', pageStart: 1, pageEnd: 2 }] },
    { answer: '<script>alert(1)</script>', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 2 }] },
    { answer: 'password=SECRET', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 2 }] },
    { answer: 'Visit https://evil.example', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 2 }] },
    { answer: 'Valid text', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 2 }], extra: 'wrong' }
  ];
  for (const value of invalid) {
    generated = { text: JSON.stringify(value) };
    const result = await service().answerCourseQuestion(question());
    assert.equal(result.outcome, 'RAG_UNAVAILABLE'); assert.deepEqual(result.citations, []);
    assert.doesNotMatch(result.answer, /SECRET|script|evil/);
  }
});

test('durable RAG daily budget admits only two concurrent generations across service instances', async () => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const results = await Promise.all(Array.from({ length: 6 }, () => service({ config: { ...config, RAG_DAILY_REQUEST_LIMIT: '2' } }).answerCourseQuestion(question())));
  assert.equal(results.filter(value => value.outcome === 'ANSWERED').length, 2);
  assert.equal(results.filter(value => value.outcome === 'RAG_LIMIT_REACHED').length, 4);
  assert.equal(calls.generate.length, 2); assert.equal((await Budget.findOne()).used, 2);
  assert.equal(await Log.countDocuments(), 6);
});

test('revocation and unpublication during vector retrieval or generation suppress source delivery', async () => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  onSearch = async () => { material.status = 'READY'; await material.save(); };
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'NO_RELEVANT_SOURCE');
  assert.equal(calls.generate.length, 0);
  onSearch = null; material.status = 'PUBLISHED'; await material.save();
  onGenerate = async () => { await Enrollment.updateOne({ student: learner._id }, { status: 'REVOKED' }); };
  await assert.rejects(service().answerCourseQuestion(question()), error => error.statusCode === 403);
});

test('provider transport receives only redacted question and bounded authorized source handles', async () => {
  const { chunk } = await fixtureMaterial({ text: 'Variable text owner@example.com password=SECRET https://private.example/source materials/private/source.pdf' });
  rows = [hit(chunk)]; let body;
  const opts = options(); delete opts.generate;
  opts.fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return providerBody(JSON.parse(generated.text)); };
  const result = await require('../services/course-tutor.service').createCourseTutorService(opts).answerCourseQuestion(question({ question: 'Explain variables user@example.com cookie=SECRET' }));
  assert.equal(result.outcome, 'ANSWERED');
  assert.doesNotMatch(JSON.stringify(body), /SERVER_ONLY_KEY|SECRET|@example|private\.example|materials\/private|student|embedding|storage/);
  assert.doesNotMatch(calls.embed[0], /SECRET|@example/);
  const userPayload = JSON.parse(body.contents[0].parts[0].text);
  assert.deepEqual(Object.keys(userPayload).sort(), ['question', 'sources']);
  assert.deepEqual(Object.keys(userPayload.sources[0]).sort(), ['pageEnd', 'pageStart', 'sourceId', 'text']);
});

test('embedding and generation failures safely fall back and never refund consumed generation budget', async () => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const embeddingFailure = service({ embedQuery: async () => { throw new Error('SERVER_ONLY_KEY raw provider body'); } });
  assert.equal((await embeddingFailure.answerCourseQuestion(question())).outcome, 'RAG_UNAVAILABLE');
  assert.equal(await Budget.countDocuments(), 0);
  for (const code of ['TIMEOUT', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'INVALID_OUTPUT']) {
    const result = await service({ generate: async () => { throw Object.assign(new Error('SERVER_ONLY_KEY provider body'), { code }); } }).answerCourseQuestion(question());
    assert.equal(result.outcome, 'RAG_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(result), /SERVER_ONLY|provider body/);
  }
  assert.equal((await Budget.findOne()).used, 4);
});

test('tutor route validates exact fields and uses the authenticated student with safe success envelope', async () => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const app = createApp({ security: { enabled: false }, tutor: options() });
  for (const body of [{}, { courseId: course.id, question: '' }, { courseId: course.id, question: 'Explain', studentId: other.id },
    { courseId: course.id, question: 'x'.repeat(2001) }, { courseId: course.id, question: 'Explain', lectureId: 'bad' }]) {
    assert.equal((await call(app, 'post', '/api/v1/ai/course-tutor').send(body)).status, 400);
  }
  const response = await call(app, 'post', '/api/v1/ai/course-tutor').send({ courseId: course.id, question: 'What is a variable?' });
  assert.equal(response.status, 200); assert.equal(response.body.tutor.outcome, 'ANSWERED');
  assert.equal(response.body.tutor.citations[0].materialId, material.id);
  assert.deepEqual(Object.keys(response.body).sort(), ['success', 'tutor']);
  assert.doesNotMatch(JSON.stringify(response.body), /storage|embedding|source\.pdf|SERVER_ONLY_KEY/);
});

test('provider can explicitly decline an unsupported question without a generative answer', async () => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  generated = { text: JSON.stringify({ answer: '', citations: [] }) };
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'NO_RELEVANT_SOURCE');
  assert.equal((await Log.findOne()).outcome, 'NO_RELEVANT_SOURCE');
});

test('unpublication while the embedding call runs prevents any vector search from starting', async () => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const result = await service({ embedQuery: async () => { material.status = 'READY'; await material.save(); return vector; } }).answerCourseQuestion(question());
  assert.equal(result.outcome, 'NO_RELEVANT_SOURCE'); assert.equal(calls.search.length, 0); assert.equal(calls.generate.length, 0);
});

test('publication change during the budget reservation prevents excerpts from reaching generation', async t => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const original = Budget.findOneAndUpdate.bind(Budget);
  t.mock.method(Budget, 'findOneAndUpdate', async (...args) => {
    const result = await original(...args);
    if (args[1].$inc) { material.status = 'READY'; await material.save(); }
    return result;
  });
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'NO_RELEVANT_SOURCE');
  assert.equal(calls.generate.length, 0);
});

test('cross-course hits and unpublished chunks cannot be injected through a faulty vector result', async () => {
  const foreignCourse = await Course.create({ title: 'Other course', description: 'Other private course', category: 'Programming',
    instructor: instructor._id, thumbnail: { public_id: 'private', secure_url: 'https://example.com/private.png' } });
  const foreign = await fixtureMaterial({ target: foreignCourse, text: 'Foreign secret content' });
  const hidden = await fixtureMaterial({ status: 'READY', text: 'Hidden secret content' });
  await fixtureMaterial(); rows = [hit(foreign.chunk), hit(hidden.chunk)];
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'NO_RELEVANT_SOURCE');
  assert.equal(calls.generate.length, 0);
});

test('unpublication or deletion during generation discards the generated answer and citations', async () => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  onGenerate = async () => { await Material.deleteOne({ _id: material._id }); };
  const result = await service().answerCourseQuestion(question());
  assert.equal(result.outcome, 'NO_RELEVANT_SOURCE'); assert.deepEqual(result.citations, []);
});

test('invalid vectors and durable log failure cannot produce a successful answer', async t => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  assert.equal((await service({ embedQuery: async () => [0.1] }).answerCourseQuestion(question())).outcome, 'RAG_UNAVAILABLE');
  assert.equal(calls.search.length, 0);
  t.mock.method(Log, 'create', async () => { throw new Error('PRIVATE_DATABASE_ERROR'); });
  const result = await service().answerCourseQuestion(question());
  assert.equal(result.outcome, 'RAG_UNAVAILABLE'); assert.deepEqual(result.citations, []);
});

test('enrollment revocation during the audit write suppresses the generated answer and citations', async t => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const original = Log.create.bind(Log);
  t.mock.method(Log, 'create', async (...args) => {
    const log = await original(...args);
    await Enrollment.updateOne({ student: learner._id, course: course._id }, { status: 'REVOKED' });
    return log;
  });
  const app = createApp({ security: { enabled: false }, tutor: options() });
  const response = await call(app, 'post', '/api/v1/ai/course-tutor').send({ courseId: course.id, question: 'What is a variable?' });
  assert.equal(response.status, 403);
  assert.doesNotMatch(JSON.stringify(response.body), /A variable stores a value|materialId|citations/);
  assert.equal(calls.generate.length, 1); assert.equal(await Log.countDocuments(), 1);
  assert.equal((await Budget.findOne()).used, 1);
});

test('material unpublication during the audit write suppresses the generated answer and citations', async t => {
  const { material, chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  const original = Log.create.bind(Log);
  t.mock.method(Log, 'create', async (...args) => {
    const log = await original(...args);
    material.status = 'READY'; await material.save();
    return log;
  });
  const app = createApp({ security: { enabled: false }, tutor: options() });
  const response = await call(app, 'post', '/api/v1/ai/course-tutor').send({ courseId: course.id, question: 'What is a variable?' });
  assert.equal(response.status, 200); assert.equal(response.body.tutor.outcome, 'NO_RELEVANT_SOURCE');
  assert.deepEqual(response.body.tutor.citations, []);
  assert.doesNotMatch(JSON.stringify(response.body), /A variable stores a value|materialId/);
  assert.equal(calls.generate.length, 1); assert.equal(await Log.countDocuments(), 1);
  assert.equal((await Budget.findOne()).used, 1);
});

test('download rechecks revoked enrollment after signing and suppresses new capability delivery', async () => {
  const { material } = await fixtureMaterial();
  const app = createApp({ security: { enabled: false }, tutor: options({ storage: { signedReadUrl: async () => {
    await Enrollment.updateOne({ student: learner._id }, { status: 'REVOKED' }); return 'https://private.example/?signature=SECRET';
  } } }) });
  const response = await call(app, 'get', `/api/v1/courses/${course.id}/materials/${material.id}/download`);
  assert.equal(response.status, 403); assert.equal(response.headers.location, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /signature|SECRET/);
});

test('RAG provider times out fetch and response-body stalls and never exposes HTTP error bodies', async () => {
  const { chunk } = await fixtureMaterial(); rows = [hit(chunk)];
  for (const fetchImpl of [async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    async () => new Response(JSON.stringify({ error: { message: 'SERVER_ONLY_KEY SECRET' } }), { status: 429 })]) {
    const opts = options({ fetchImpl }); delete opts.generate;
    const result = await require('../services/course-tutor.service').createCourseTutorService(opts).answerCourseQuestion(question());
    assert.equal(result.outcome, 'RAG_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(result), /SERVER_ONLY_KEY|SECRET/);
  }
});

test('retrieval bounds provider context and rejects more than three or duplicate page citations', async () => {
  const fixtures = await Promise.all(Array.from({ length: 6 }, () => fixtureMaterial({ text: 'Bounded lesson content. '.repeat(500) })));
  rows = fixtures.map(({ chunk }) => hit(chunk));
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'ANSWERED');
  assert.equal(calls.generate[0].sources.length, 5);
  assert.ok(calls.generate[0].sources.every(source => source.text.length <= 2400));
  generated = { text: JSON.stringify({ answer: 'Answer', citations: Array.from({ length: 4 }, (_, index) => ({ sourceId: `S${index + 1}`, pageStart: 1, pageEnd: 2 })) }) };
  assert.equal((await service().answerCourseQuestion(question())).outcome, 'RAG_UNAVAILABLE');
});

test('invalid tutor configuration and bad signing response are safe and never leak raw details', async () => {
  const { material } = await fixtureMaterial();
  for (const settings of [{ RAG_EMBEDDING_DIMENSION: '1536' }, { RAG_DAILY_REQUEST_LIMIT: '0' },
    { ATLAS_VECTOR_INDEX: 'secret index invalid' }, { GEMINI_EMBEDDING_MODEL: 'another-model' }]) {
    const result = await service({ config: { ...config, ...settings } }).answerCourseQuestion(question());
    assert.equal(result.outcome, 'RAG_UNAVAILABLE');
  }
  assert.equal(calls.embed.length, 0);
  const app = createApp({ security: { enabled: false }, tutor: options({ storage: { signedReadUrl: async () => { throw new Error('R2 SECRET_SOURCE_KEY'); } } }) });
  const response = await call(app, 'get', `/api/v1/courses/${course.id}/materials/${material.id}/download`);
  assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(response.body), /R2|SECRET|stack/);
});
