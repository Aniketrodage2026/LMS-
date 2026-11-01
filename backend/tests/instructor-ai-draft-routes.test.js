const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const Material = require('../models/course-material.schema');
const Chunk = require('../models/course-material-chunk.schema');
const Budget = require('../models/instructor-ai-draft-budget.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

let sequence = 0;
const pathFor = (course, suffix = '') => `/api/v1/instructor/courses/${course._id || course}/ai-drafts${suffix}`;
async function user(role) {
  return User.create({ fullName: `Draft User ${++sequence}`, email: `draft-${sequence}@example.com`, password: 'password123', role });
}
async function course(owner) {
  return Course.create({ title: `Course Draft ${++sequence}`, description: 'A course description for testing AI drafts.',
    category: 'Programming', instructor: owner._id,
    thumbnail: { public_id: 'test', secure_url: 'https://example.com/course.png' },
    learningMetadata: { level: 'BEGINNER', skills: ['javascript'] },
    lectures: [{ title: 'Variables', lecture: { public_id: 'test', secure_url: 'https://example.com/lesson.mp4' } }] });
}
async function publishedMaterial(target, owner, finalStatus = 'PUBLISHED') {
  const material = await Material.create({ course: target._id, uploadedBy: owner._id, title: 'Published notes', originalFilename: 'notes.pdf',
    storage: { provider: 'R2', key: `materials/${++sequence}/source.pdf`, contentType: 'application/pdf', size: 20 },
    contentType: 'application/pdf', size: 20, contentHash: sequence.toString(16).padStart(64, '0'),
    pageCount: 2, extractedCharacterCount: 70, status: 'PROCESSING' });
  material.status = 'READY';
  await material.save();
  if (finalStatus !== 'READY') {
    material.status = finalStatus;
    await material.save();
  }
  await Chunk.create({ material: material._id, course: target._id, lecture: null, ordinal: 0, pageStart: 1, pageEnd: 1,
    text: 'Variables store values that a program can use.', embedding: Array(768).fill(0.1),
    embeddingModel: 'gemini-embedding-2', embeddingDimension: 768 });
  return material;
}
async function agentFor(app, account) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email: account.email, password: 'password123' }).expect(200);
  return agent;
}
function makeApp(generateDraft, dailyLimit = '5') {
  return createApp({ security: { enabled: false }, instructorDrafts: {
    config: { AI_INSTRUCTOR_DRAFT_DAILY_LIMIT: dailyLimit },
    generateDraft
  } });
}

test.before(async () => {
  process.env.JWT_SECRET = 'instructor-ai-draft-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
  await Promise.all([Material.init(), Chunk.init(), Budget.init()]);
});
test.beforeEach(async () => {
  await Promise.all([Course.deleteMany({}), Material.deleteMany({}), Chunk.deleteMany({}), Budget.deleteMany({})]);
});
test.after(disconnectTestDb);

test('only the owning instructor can generate a bounded draft from their published materials', async () => {
  const owner = await user('INSTRUCTOR'); const otherInstructor = await user('INSTRUCTOR');
  const target = await course(owner); const foreign = await course(otherInstructor);
  const published = await publishedMaterial(target, owner);
  await publishedMaterial(target, owner, 'READY');
  await publishedMaterial(foreign, otherInstructor);
  const received = [];
  const app = makeApp(async (input) => {
    received.push(input);
    return { text: JSON.stringify({ title: 'Variable lesson', items: [
      { heading: 'Introduce variables', content: 'Explain how variables store values.', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 1 }] },
      { heading: 'Trace assignments', content: 'Ask learners to trace a reassignment.', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 1 }] },
      { heading: 'Apply the concept', content: 'Have learners use a variable in a short program.', citations: [{ sourceId: 'S1', pageStart: 1, pageEnd: 1 }] }
    ] }) };
  });
  const response = await (await agentFor(app, owner)).post(pathFor(target)).send({ kind: 'OUTLINE', focus: 'Variables in JavaScript' }).expect(200);
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, 'OUTLINE');
  assert.equal(received[0].focus, 'Variables in JavaScript');
  assert.equal(received[0].sources.length, 1);
  assert.equal(received[0].sources[0].title, 'Published notes');
  assert.equal(response.body.sourceMode, 'PUBLISHED_MATERIALS');
  assert.equal(response.body.draft.items[0].citations[0].materialId, String(published._id));
  assert.deepEqual(Object.keys(response.body.draft).sort(), ['items', 'kind', 'title']);
  assert.equal(await Course.countDocuments({ _id: target._id }), 1);
  assert.equal(await Chunk.countDocuments({ course: target._id }), 2);
  assert.equal(await Material.countDocuments({ course: target._id }), 2);
  assert.equal(await Budget.countDocuments({ instructor: owner._id }), 1);
  await (await agentFor(app, otherInstructor)).post(pathFor(target)).send({ kind: 'OUTLINE', focus: 'Not authorized' }).expect(403);
  assert.equal(received.length, 1);
});

test('guests, students, admins, and unrelated instructors cannot invoke the generator', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner);
  const student = await user('STUDENT'); const admin = await user('ADMIN'); const other = await user('INSTRUCTOR');
  let calls = 0;
  const app = makeApp(async () => { calls += 1; return { text: '{}' }; });
  await request(app).post(pathFor(target)).send({ kind: 'OUTLINE', focus: 'A focus' }).expect(401);
  for (const account of [student, admin, other]) {
    await (await agentFor(app, account)).post(pathFor(target)).send({ kind: 'OUTLINE', focus: 'A focus' }).expect(403);
  }
  assert.equal(calls, 0);
});

test('invalid request fields and invented citations fail without storing generated content', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner);
  await publishedMaterial(target, owner);
  let calls = 0;
  const app = makeApp(async () => {
    calls += 1;
    return { text: JSON.stringify({ title: 'Bad draft', items: [
      { heading: 'One', content: 'Content', citations: [{ sourceId: 'S9', pageStart: 99, pageEnd: 99 }] },
      { heading: 'Two', content: 'Content', citations: [{ sourceId: 'S9', pageStart: 99, pageEnd: 99 }] },
      { heading: 'Three', content: 'Content', citations: [{ sourceId: 'S9', pageStart: 99, pageEnd: 99 }] }
    ] }) };
  });
  const agent = await agentFor(app, owner);
  await agent.post(pathFor(target)).send({ kind: 'OUTLINE', focus: 'Topic', courseId: String(target._id) }).expect(400);
  await agent.post(pathFor(target)).send({ kind: 'OUTLINE', focus: 'Topic' }).expect(503);
  assert.equal(calls, 1);
  assert.equal(await Course.countDocuments({ _id: target._id }), 1);
  assert.equal(await Material.countDocuments({ course: target._id }), 1);
  assert.equal(await Budget.countDocuments({ instructor: owner._id }), 1);
});

test('draft requests consume a bounded per-instructor daily budget', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner);
  let calls = 0;
  const app = makeApp(async () => {
    calls += 1;
    return { text: JSON.stringify({ title: 'Metadata draft', items: [
      { heading: 'One', content: 'Use the course metadata.', citations: [] },
      { heading: 'Two', content: 'Connect to course skills.', citations: [] },
      { heading: 'Three', content: 'Review the lesson sequence.', citations: [] }
    ] }) };
  }, '1');
  const agent = await agentFor(app, owner);
  await agent.post(pathFor(target)).send({ kind: 'PRACTICE_PROMPTS', focus: 'Beginner variables' }).expect(200);
  const limited = await agent.post(pathFor(target)).send({ kind: 'PRACTICE_PROMPTS', focus: 'Beginner variables' }).expect(429);
  assert.equal(limited.body.error.code, 'AI_DRAFT_LIMIT_REACHED');
  assert.equal(calls, 1);
  assert.equal(await Budget.findOne({ instructor: owner._id }).then((entry) => entry.used), 1);
});
