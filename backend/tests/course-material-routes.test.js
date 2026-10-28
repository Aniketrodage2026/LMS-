const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const fs = require('node:fs/promises');
const { createApp } = require('../app');
const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const Material = require('../models/course-material.schema');
const Chunk = require('../models/course-material-chunk.schema');
const AuditLog = require('../models/audit-log.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

let serial = 0;
let calls = [];
let ingestResult;
const app = createApp({ security: { enabled: false }, materials: { ingest: async (input) => {
  calls.push(input);
  if (ingestResult) return ingestResult(input);
  const material = await createMaterial(input.courseId, input.uploadedBy, { title: input.title, lecture: input.lectureId });
  return { status: 'READY', materialId: material.id, failureCode: null };
} } });

const pathFor = (course, suffix = '') => `/api/v1/instructor/courses/${course._id || course}/materials${suffix}`;
async function user(role) {
  return User.create({ fullName: 'Material manager', email: `material-${++serial}@example.com`, password: 'password123', role });
}
async function agentFor(account) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email: account.email, password: 'password123' }).expect(200);
  return agent;
}
async function course(owner) {
  return Course.create({ title: `Material course ${++serial}`, description: 'Material course test description.', category: 'Programming',
    instructor: owner._id, thumbnail: { public_id: 'test', secure_url: 'https://example.com/test.jpg' },
    lectures: [{ title: 'Introduction', lecture: { public_id: 'test', secure_url: 'https://example.com/test.mp4' } }] });
}
async function createMaterial(courseId, uploadedBy, overrides = {}) {
  const material = await Material.create({ course: courseId, uploadedBy, title: 'Safe study notes', originalFilename: 'notes.pdf',
    storage: { provider: 'R2', key: `materials/${++serial}/source.pdf`, contentType: 'application/pdf', size: 20 },
    contentType: 'application/pdf', size: 20, contentHash: (++serial).toString(16).padStart(64, '0'),
    pageCount: 2, extractedCharacterCount: 40, status: 'PROCESSING', ...overrides });
  material.status = 'READY';
  await material.save();
  return material;
}
function upload(agent, courseId, fields = {}, filename = 'notes.pdf') {
  let pending = agent.post(pathFor(courseId));
  for (const [name, value] of Object.entries({ title: 'Course notes', ...fields })) pending = pending.field(name, value);
  return pending.attach('file', Buffer.from('%PDF- test-only source'), { filename, contentType: 'application/pdf' });
}
function assertSafe(material) {
  assert.deepEqual(Object.keys(material).sort(), ['chunkCount', 'courseId', 'createdAt', 'failureCode', 'failureMessage', 'id',
    'lectureId', 'originalFilename', 'pageCount', 'size', 'status', 'title', 'updatedAt'].sort());
  const serialized = JSON.stringify(material);
  for (const prohibited of ['materials/', 'provider', 'storage', 'secure_url', 'embedding', 'sourceText', 'signedUrl']) {
    assert.ok(!serialized.includes(prohibited), `DTO leaked ${prohibited}`);
  }
}

test.before(async () => {
  process.env.JWT_SECRET = 'material-route-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
  await Promise.all([Material.init(), Chunk.init()]);
});
test.beforeEach(() => { calls = []; ingestResult = null; });
test.after(async () => { await disconnectTestDb(); });

test('guest, student and unrelated instructor are rejected before upload parsing or ingestion', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner);
  await upload(request(app), target, {}, 'bad.exe').expect(401);
  for (const role of ['STUDENT', 'INSTRUCTOR']) {
    await upload(await agentFor(await user(role)), target, {}, 'bad.exe').expect(403);
  }
  assert.equal(calls.length, 0);
  assert.equal(await Material.countDocuments({ course: target._id }), 0);
});

test('owner and admin upload course or owned-lecture PDFs with authenticated uploader identity', async () => {
  const owner = await user('INSTRUCTOR'); const admin = await user('ADMIN'); const target = await course(owner);
  for (const [account, fields] of [[owner, {}], [admin, { lectureId: target.lectures[0].id }]]) {
    const response = await upload(await agentFor(account), target, fields).expect(201);
    assertSafe(response.body.material);
    assert.equal(response.body.material.status, 'READY');
    const last = calls.at(-1);
    assert.equal(String(last.uploadedBy), account.id);
    assert.equal(String(last.courseId), target.id);
    assert.equal(last.lectureId, fields.lectureId || null);
    await assert.rejects(fs.stat(last.localPath), { code: 'ENOENT' });
  }
  const logs = await AuditLog.find({ action: 'MATERIAL_UPLOADED', 'target.id': { $in: (await Material.find({ course: target._id })).map(m => m._id) } }).lean();
  assert.equal(logs.length, 2);
  for (const log of logs) { assert.equal(log.target.type, 'MATERIAL'); assert.equal(log.summary, undefined); }
});

test('invalid lecture, foreign lecture, title and forged uploader are rejected before ingestion and local files removed', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner); const foreign = await course(owner);
  const agent = await agentFor(owner);
  const before = (await fs.readdir('uploads')).filter(name => name.startsWith('material-')).sort();
  for (const fields of [{ lectureId: 'invalid' }, { lectureId: foreign.lectures[0].id }, { title: '' },
    { title: 'x'.repeat(121) }, { uploadedBy: new mongoose.Types.ObjectId().toString() }]) {
    const response = await upload(agent, target, fields).expect(400);
    assert.equal(response.body.success, false);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual((await fs.readdir('uploads')).filter(name => name.startsWith('material-')).sort(), before);
});

test('manager list is course scoped and exposes safe metadata with actual chunk count', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner); const foreign = await course(owner);
  const selected = await createMaterial(target._id, owner._id);
  await createMaterial(foreign._id, owner._id);
  await Chunk.create({ material: selected._id, course: target._id, lecture: null, ordinal: 0, pageStart: 1, pageEnd: 1,
    text: 'Never expose extracted PDF text.', embedding: Array(768).fill(0.1), embeddingModel: 'gemini-embedding-2', embeddingDimension: 768 });
  const response = await (await agentFor(owner)).get(pathFor(target)).expect(200);
  assert.equal(response.body.materials.length, 1);
  assertSafe(response.body.materials[0]);
  assert.equal(response.body.materials[0].id, selected.id);
  assert.equal(response.body.materials[0].chunkCount, 1);
  assert.ok(!JSON.stringify(response.body).includes('Never expose'));
});

test('manager can publish READY and unpublish PUBLISHED with minimized audit records', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner); const material = await createMaterial(target._id, owner._id);
  const agent = await agentFor(owner); const route = pathFor(target, `/${material.id}/status`);
  for (const status of ['PUBLISHED', 'READY']) {
    const response = await agent.patch(route).send({ status }).expect(200);
    assertSafe(response.body.material);
    assert.equal(response.body.material.status, status);
    assert.equal((await Material.findById(material._id)).status, status);
  }
  const logs = await AuditLog.find({ 'target.id': material._id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(logs.map(log => log.action), ['MATERIAL_PUBLISHED', 'MATERIAL_UNPUBLISHED']);
  for (const log of logs) { assert.equal(log.actor.toString(), owner.id); assert.equal(log.summary, undefined); }
});

test('status mutation denies strangers and cross-course ids and rejects unsupported transitions', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner); const foreign = await course(owner);
  const material = await createMaterial(target._id, owner._id); const agent = await agentFor(owner);
  const route = pathFor(target, `/${material.id}/status`);
  await request(app).patch(route).send({ status: 'PUBLISHED' }).expect(401);
  for (const role of ['STUDENT', 'INSTRUCTOR']) await (await agentFor(await user(role))).patch(route).send({ status: 'PUBLISHED' }).expect(403);
  await agent.patch(pathFor(foreign, `/${material.id}/status`)).send({ status: 'PUBLISHED' }).expect(404);
  await agent.patch(pathFor(target, '/invalid/status')).send({ status: 'PUBLISHED' }).expect(400);
  for (const body of [{ status: 'PROCESSING' }, { status: 'PUBLISHED', uploadedBy: owner.id }, {}, { status: 'READY' }]) {
    await agent.patch(route).send(body).expect(body.status === 'READY' ? 409 : 400);
  }
  material.status = 'PROCESSING'; await material.save();
  await agent.patch(route).send({ status: 'PUBLISHED' }).expect(409);
  material.status = 'FAILED'; material.failureCode = 'EMBEDDING_FAILED'; await material.save();
  await agent.patch(route).send({ status: 'PUBLISHED' }).expect(409);
  assert.equal(await AuditLog.countDocuments({ 'target.id': material._id }), 0);
});

test('upload failures return actionable safe errors and retained failed metadata without provider details', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner); const agent = await agentFor(owner);
  ingestResult = async () => ({ status: 'FAILED', materialId: null, failureCode: 'NO_READABLE_TEXT' });
  const empty = await upload(agent, target).expect(422);
  assert.equal(empty.body.error.code, 'MATERIAL_NO_READABLE_TEXT');
  assert.match(empty.body.message, /text/i);
  ingestResult = async () => {
    const material = await createMaterial(target._id, owner._id);
    material.status = 'PROCESSING'; await material.save();
    material.status = 'FAILED'; material.failureCode = 'EMBEDDING_FAILED'; await material.save();
    return { status: 'FAILED', materialId: material.id, failureCode: 'EMBEDDING_FAILED' };
  };
  const failed = await upload(agent, target).expect(502);
  assertSafe(failed.body.material);
  assert.equal(failed.body.material.status, 'FAILED');
  assert.equal(await AuditLog.countDocuments({ 'target.id': failed.body.material.id }), 0);
  ingestResult = async () => { throw new Error('SECRET provider output materials/private/source.pdf'); };
  const unexpected = await upload(agent, target).expect(500);
  assert.ok(!JSON.stringify(unexpected.body).includes('SECRET'));
});

test('list access and invalid course ids use the existing manager authorization rules', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner);
  await request(app).get(pathFor(target)).expect(401);
  for (const role of ['STUDENT', 'INSTRUCTOR']) await (await agentFor(await user(role))).get(pathFor(target)).expect(403);
  const admin = await agentFor(await user('ADMIN'));
  await admin.get(pathFor(target)).expect(200);
  await admin.get(pathFor('invalid')).expect(400);
  await admin.get(pathFor(new mongoose.Types.ObjectId())).expect(404);
});

test('missing and unsupported files are rejected before ingestion without leftover local material files', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner); const agent = await agentFor(owner);
  const before = (await fs.readdir('uploads')).filter(name => name.startsWith('material-')).sort();
  await agent.post(pathFor(target)).field('title', 'Missing file').expect(400);
  await upload(agent, target, {}, 'notes.exe').expect(400);
  await agent.post(pathFor(target)).field('title', 'Wrong MIME').attach('file', Buffer.from('%PDF- source'),
    { filename: 'notes.pdf', contentType: 'image/png' }).expect(400);
  await agent.post(pathFor(target)).field('title', 'Too large').attach('file', Buffer.alloc(10485761),
    { filename: 'notes.pdf', contentType: 'application/pdf' }).expect(400);
  assert.equal(calls.length, 0);
  assert.deepEqual((await fs.readdir('uploads')).filter(name => name.startsWith('material-')).sort(), before);
});

test('manager listing includes processing, failed, draft and published metadata without making them public', async () => {
  const owner = await user('INSTRUCTOR'); const target = await course(owner);
  const ready = await createMaterial(target._id, owner._id);
  const processing = await createMaterial(target._id, owner._id); processing.status = 'PROCESSING'; await processing.save();
  const failed = await createMaterial(target._id, owner._id); failed.status = 'PROCESSING'; await failed.save();
  failed.status = 'FAILED'; failed.failureCode = 'NO_READABLE_TEXT'; await failed.save();
  const published = await createMaterial(target._id, owner._id); published.status = 'PUBLISHED'; await published.save();
  const draft = await Material.create({ course: target._id, uploadedBy: owner._id, title: 'Draft notes', originalFilename: 'draft.pdf',
    storage: { provider: 'R2', key: `materials/${++serial}/draft.pdf`, contentType: 'application/pdf', size: 20 }, contentType: 'application/pdf',
    size: 20, contentHash: (++serial).toString(16).padStart(64, '0') });
  const agent = await agentFor(owner);
  const response = await agent.get(pathFor(target)).expect(200);
  assert.deepEqual(response.body.materials.map(m => m.status).sort(), ['DRAFT', 'FAILED', 'PROCESSING', 'PUBLISHED', 'READY']);
  response.body.materials.forEach(assertSafe);
  assert.match(response.body.materials.find(m => m.id === failed.id).failureMessage, /selectable text/i);
  await agent.patch(pathFor(target, `/${draft.id}/status`)).send({ status: 'PUBLISHED' }).expect(409);
  assert.equal((await Material.findById(ready._id)).status, 'READY');
});
