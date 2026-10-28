const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Course = require('../models/course.schema');
const CourseMaterial = require('../models/course-material.schema');
const CourseMaterialChunk = require('../models/course-material-chunk.schema');
const RagUsageBudget = require('../models/rag-usage-budget.schema');
const RagUsageLog = require('../models/rag-usage-log.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

let course;
let otherCourse;
const id = () => new mongoose.Types.ObjectId();
function material(overrides = {}) {
  const materialId = id();
  const size = 200;
  return {
    _id: materialId, course: course._id, title: '  Course   notes  ',
    originalFilename: ' C:\\fakepath\\Course notes.pdf ',
    storage: { provider: 'R2', key: `materials/${course._id}/${materialId}/source.pdf`, contentType: 'application/pdf', size },
    contentType: 'application/pdf', size, contentHash: new mongoose.Types.ObjectId().toString().padEnd(64, 'a'),
    uploadedBy: id(), ...overrides
  };
}
function chunk(parent, overrides = {}) {
  return {
    material: parent._id, course: parent.course, lecture: parent.lecture,
    ordinal: 0, pageStart: 1, pageEnd: 2, text: '  Bounded source excerpt.  ',
    embedding: Array(768).fill(0.25), embeddingModel: 'gemini-embedding-2', embeddingDimension: 768,
    ...overrides
  };
}
function log(overrides = {}) {
  return { student: id(), course: course._id, provider: 'GEMINI', modelAlias: 'course-tutor',
    outcome: 'SUCCESS', sourceCount: 2, inputTokens: 25, outputTokens: 10, ...overrides };
}
async function readyMaterial(overrides = {}) {
  const saved = await CourseMaterial.create(material({ status: 'PROCESSING', ...overrides }));
  saved.pageCount = 2;
  saved.extractedCharacterCount = 100;
  saved.status = 'READY';
  return saved.save();
}
test.before(async () => {
  await connectTestDb();
  await Promise.all([CourseMaterial.init(), CourseMaterialChunk.init(), RagUsageBudget.init(), RagUsageLog.init()]);
  const fixture = () => ({ title: 'Course materials', description: 'Course notes', category: 'Programming',
    instructor: id(), thumbnail: { public_id: 'thumbnail', secure_url: 'https://example.com/image.png' },
    lectures: [{ title: 'Introduction', lecture: { public_id: 'lecture', secure_url: 'https://example.com/lecture.mp4' } }] });
  course = await Course.create(fixture());
  otherCourse = await Course.create(fixture());
});
test.after(disconnectTestDb);

test('material normalizes bounded display metadata and indexes live source duplicates by course and lecture', async () => {
  const input = material();
  const saved = await CourseMaterial.create(input);
  assert.equal(saved.title, 'Course notes');
  assert.equal(saved.originalFilename, 'Course notes.pdf');
  assert.equal(saved.lecture, null);
  assert.equal(saved.status, 'DRAFT');
  assert.equal(saved.failureCode, null);
  assert.ok(saved.createdAt instanceof Date);
  await assert.rejects(CourseMaterial.create({ ...input, _id: id() }), (error) => error.code === 11000);
  await CourseMaterial.create(material({ contentHash: input.contentHash, lecture: course.lectures[0]._id }));
  const indexes = await CourseMaterial.collection.indexes();
  assert.ok(indexes.some(({ key }) => key.course === 1 && key.lecture === 1 && key.status === 1));
  assert.ok(indexes.some(({ key }) => key.course === 1 && key.createdAt === 1));
  assert.ok(indexes.some(({ key, unique, partialFilterExpression }) =>
    unique && key.contentHash === 1 && key.course === 1 && key.lecture === 1 && partialFilterExpression));
});

test('material requires an existing course and an optional lecture belonging to that course', async () => {
  await new CourseMaterial(material({ lecture: course.lectures[0]._id })).validate();
  for (const overrides of [{ course: undefined }, { course: id() }, { lecture: otherCourse.lectures[0]._id }, { lecture: id() }]) {
    await assert.rejects(new CourseMaterial(material(overrides)).validate(), mongoose.Error.ValidationError);
  }
});

test('material rejects unsafe names, non-PDF or non-private storage, mismatched and unbounded metadata', async () => {
  for (const overrides of [
    { title: ' ' }, { title: 'a'.repeat(121) }, { title: 42 }, { title: 'secret\u0000title' },
    { originalFilename: '' }, { originalFilename: 'x'.repeat(252) + '.pdf' }, { originalFilename: 'file.exe' },
    { originalFilename: 'bad\nname.pdf' }, { contentType: 'text/plain' }, { contentHash: 'not-a-hash' },
    { uploadedBy: undefined }, { size: 0 }, { size: 10485761 }, { size: '200' }, { size: 1.5 },
    { pageCount: 101 }, { pageCount: -1 }, { pageCount: 1.5 }, { extractedCharacterCount: '100' },
    { extractedCharacterCount: -1 }, { extractedCharacterCount: 1000001 },
    { storage: undefined }, { storage: { provider: 'CLOUDINARY', key: 'public', contentType: 'application/pdf', size: 200 } },
    { storage: { provider: 'R2', key: 'https://bucket.example/source.pdf', contentType: 'application/pdf', size: 200 } },
    { storage: { provider: 'R2', key: '../source.pdf', contentType: 'application/pdf', size: 200 } },
    { storage: { provider: 'R2', key: 'materials/source.pdf', contentType: 'text/plain', size: 200 } },
    { storage: { provider: 'R2', key: 'materials/source.pdf', contentType: 'application/pdf', size: 201 } }
  ]) await assert.rejects(new CourseMaterial(material(overrides)).validate(), mongoose.Error.ValidationError);
});

test('material lifecycle allows processing, publication, unpublication and failed retry with safe metadata', async () => {
  const saved = await CourseMaterial.create(material());
  saved.status = 'PROCESSING'; await saved.save();
  saved.status = 'FAILED'; saved.failureCode = 'EMBEDDING_FAILED'; await saved.save();
  saved.status = 'PROCESSING'; saved.failureCode = null; await saved.save();
  saved.status = 'READY'; saved.pageCount = 2; saved.extractedCharacterCount = 100; await saved.save();
  saved.status = 'PUBLISHED'; await saved.save();
  saved.status = 'READY'; await saved.save();
  assert.equal((await CourseMaterial.findById(saved._id)).status, 'READY');
  for (const overrides of [
    { status: 'DELETED' }, { status: 'PUBLISHED', pageCount: 2, extractedCharacterCount: 100 },
    { status: 'READY', pageCount: 2, extractedCharacterCount: 100 }, { failureCode: 'raw provider response' }
  ]) await assert.rejects(new CourseMaterial(material(overrides)).validate(), mongoose.Error.ValidationError);
  const draft = await CourseMaterial.create(material());
  draft.status = 'PUBLISHED'; draft.pageCount = 2; draft.extractedCharacterCount = 100;
  await assert.rejects(draft.save(), /transition/i);
  const processing = await CourseMaterial.create(material({ status: 'PROCESSING' }));
  processing.status = 'READY';
  await assert.rejects(processing.save(), /pageCount|extractedCharacterCount/i);
  processing.status = 'FAILED';
  await assert.rejects(processing.save(), /failureCode/i);
});

test('material and chunk query, replacement, pipeline and bulk updates cannot bypass document validation', async () => {
  const parent = await readyMaterial();
  const savedChunk = await CourseMaterialChunk.create(chunk(parent));
  for (const [Model, saved] of [[CourseMaterial, parent], [CourseMaterialChunk, savedChunk]]) {
    const filter = { _id: saved._id };
    for (const operation of [
      () => Model.updateOne(filter, { $set: { status: 'PUBLISHED' } }),
      () => Model.updateMany(filter, { $set: { pageEnd: 101 } }, { runValidators: true }),
      () => Model.findOneAndUpdate(filter, [{ $set: { status: 'PUBLISHED' } }]),
      () => Model.replaceOne(filter, {}, { runValidators: false }),
      () => Model.findOneAndReplace(filter, {}, { upsert: true }),
      () => Model.bulkWrite([{ updateOne: { filter, update: { $set: { text: 'unsafe' } } } }])
    ]) await assert.rejects(operation(), /document.*save/i);
  }
  parent.title = ' Updated notes '; await parent.save();
  assert.equal((await CourseMaterial.findById(parent._id)).title, 'Updated notes');
  parent.course = otherCourse._id;
  await assert.rejects(parent.save(), /immutable/i);
});

test('chunks persist bounded page-aware source vectors and prevent duplicate ordinals', async () => {
  const parent = await readyMaterial({ lecture: course.lectures[0]._id });
  const saved = await CourseMaterialChunk.create(chunk(parent));
  assert.equal(saved.text, 'Bounded source excerpt.');
  assert.equal(saved.embedding.length, 768);
  assert.ok(saved.createdAt instanceof Date);
  await assert.rejects(CourseMaterialChunk.create(chunk(parent)), (error) => error.code === 11000);
  await CourseMaterialChunk.create(chunk(parent, { ordinal: 1 }));
  saved.material = id();
  await assert.rejects(saved.save(), /immutable/i);
});

test('chunks require matching material ownership, strict integer page and ordinal bounds, and bounded text', async () => {
  const parent = await readyMaterial();
  for (const overrides of [
    { material: undefined }, { material: id() }, { course: otherCourse._id }, { lecture: course.lectures[0]._id },
    { ordinal: -1 }, { ordinal: 0.5 }, { ordinal: '0' }, { ordinal: Number.MAX_SAFE_INTEGER + 1 },
    { pageStart: 0 }, { pageEnd: 101 }, { pageStart: 2, pageEnd: 1 }, { pageEnd: 3 },
    { pageStart: '1' }, { pageEnd: 1.5 }, { text: ' ' }, { text: 'a'.repeat(12001) }, { text: 42 }
  ]) await assert.rejects(new CourseMaterialChunk(chunk(parent, overrides)).validate(), mongoose.Error.ValidationError);
});

test('chunks reject wrong model, dimension, non-arrays, nonnumbers and nonfinite vectors', async () => {
  const parent = await readyMaterial();
  for (const overrides of [
    { embeddingModel: 'text-embedding-004' }, { embeddingDimension: 767 }, { embeddingDimension: '768' },
    { embedding: undefined }, { embedding: null }, { embedding: 0.25 },
    { embedding: Array(767).fill(0) }, { embedding: Array(769).fill(0) },
    ...[NaN, Infinity, -Infinity, '0.25', null, undefined].map((value) => ({ embedding: [value, ...Array(767).fill(0)] }))
  ]) await assert.rejects(new CourseMaterialChunk(chunk(parent, overrides)).validate(), mongoose.Error.ValidationError);
});

test('RAG budget is separate, unique by student and actual UTC calendar day, with strict safe counters', async () => {
  const input = { student: id(), dayKey: '2026-10-28' };
  const saved = await RagUsageBudget.create(input);
  assert.equal(saved.used, 0);
  assert.equal(RagUsageBudget.modelName, 'RagUsageBudget');
  await assert.rejects(RagUsageBudget.create(input), (error) => error.code === 11000);
  await RagUsageBudget.create({ ...input, dayKey: '2026-10-29' });
  await new RagUsageBudget({ ...input, dayKey: '2024-02-29' }).validate();
  for (const overrides of [
    { student: undefined }, { dayKey: '2026-02-29' }, { dayKey: '2026-13-01' }, { dayKey: '2026-10-28T00:00:00Z' },
    { used: -1 }, { used: 1.5 }, { used: '1' }, { used: Infinity }, { used: Number.MAX_SAFE_INTEGER + 1 }
  ]) await assert.rejects(new RagUsageBudget({ ...input, ...overrides }).validate(), mongoose.Error.ValidationError);
  saved.dayKey = '2026-10-29';
  await assert.rejects(saved.save(), /immutable/i);
});

test('RAG budget supports race-safe conditional reservation and bounded initialization without unsafe query mutations', async () => {
  const identity = { student: id(), dayKey: '2026-10-28' };
  await RagUsageBudget.findOneAndUpdate(identity, { $max: { used: 0 }, $setOnInsert: identity },
    { upsert: true, setDefaultsOnInsert: false });
  const results = await Promise.all(Array.from({ length: 8 }, () => RagUsageBudget.findOneAndUpdate(
    { ...identity, used: { $lt: 3 } }, { $inc: { used: 1 } }, { new: true })));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal((await RagUsageBudget.findOne(identity)).used, 3);
  for (const operation of [
    () => RagUsageBudget.updateOne(identity, { $inc: { used: -1 } }),
    () => RagUsageBudget.findOneAndUpdate(identity, { $inc: { used: 1 } }),
    () => RagUsageBudget.findOneAndUpdate({ ...identity, used: { $lt: Infinity } }, { $inc: { used: 1 } }),
    () => RagUsageBudget.findOneAndUpdate(identity, { $max: { used: '3' } }),
    () => RagUsageBudget.updateMany(identity, { $set: { used: -1 } }),
    () => RagUsageBudget.findOneAndUpdate(identity, [{ $set: { used: -1 } }]),
    () => RagUsageBudget.replaceOne(identity, { ...identity, used: -1 }),
    () => RagUsageBudget.findOneAndReplace(identity, { ...identity, used: -1 }),
    () => RagUsageBudget.bulkWrite([{ updateOne: { filter: identity, update: { $inc: { used: -1 } } } }])
  ]) await assert.rejects(operation(), /budget.*mutation/i);
});

test('RAG logs accept only minimized operational fields and safe bounded categories and counts', async () => {
  const saved = await RagUsageLog.create(log());
  assert.deepEqual(Object.keys(saved.toObject()).sort(), [
    '_id', 'course', 'createdAt', 'inputTokens', 'modelAlias', 'outcome', 'outputTokens', 'provider', 'sourceCount', 'student'
  ]);
  await new RagUsageLog(log({ provider: 'NONE', modelAlias: 'none', outcome: 'NO_RELEVANT_SOURCE', sourceCount: 0,
    inputTokens: undefined, outputTokens: undefined })).validate();
  for (const overrides of [
    { student: undefined }, { course: undefined }, { provider: 'OTHER' }, { modelAlias: 'raw provider body with spaces' },
    { outcome: 'raw-provider-error' }, { sourceCount: -1 }, { sourceCount: 6 }, { sourceCount: '1' },
    { inputTokens: -1 }, { outputTokens: 0.5 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 }
  ]) await assert.rejects(new RagUsageLog(log(overrides)).validate(), mongoose.Error.ValidationError);
  for (const field of ['question', 'answer', 'text', 'embedding', 'objectKey', 'signedUrl', 'prompt', 'response', 'apiKey', 'email', 'jwt', 'payment']) {
    assert.throws(() => new RagUsageLog(log({ [field]: 'private' })), mongoose.Error.StrictModeError);
  }
  assert.throws(() => new CourseMaterial(material({ signedUrl: 'private' })), mongoose.Error.StrictModeError);
});

test('RAG logs are append-only through document, query, replacement, deletion and bulk APIs', async () => {
  const saved = await RagUsageLog.create(log());
  const filter = { _id: saved._id };
  for (const operation of [
    () => saved.save(), () => saved.deleteOne(),
    () => RagUsageLog.updateOne(filter, { $set: { outcome: 'ERROR' } }),
    () => RagUsageLog.updateMany(filter, { $set: { outcome: 'ERROR' } }),
    () => RagUsageLog.findOneAndUpdate(filter, { $set: { outcome: 'ERROR' } }),
    () => RagUsageLog.replaceOne(filter, log()), () => RagUsageLog.findOneAndReplace(filter, log()),
    () => RagUsageLog.deleteOne(filter), () => RagUsageLog.deleteMany(filter), () => RagUsageLog.findOneAndDelete(filter),
    () => RagUsageLog.bulkWrite([{ deleteOne: { filter } }])
  ]) await assert.rejects(operation(), /append-only/i);
  saved.sourceCount = 5;
  await assert.rejects(saved.save(), /immutable/i);
  assert.equal((await RagUsageLog.findById(saved._id)).sourceCount, 2);
});

test('nested material source metadata cannot be redirected', async () => {
  const parent = await CourseMaterial.create(material());
  parent.storage.key = 'materials/another/source.pdf';
  await assert.rejects(parent.save(), /immutable/i);
});

test('budget document saves cannot reset durable reservations', async () => {
  const budget = await RagUsageBudget.create({ student: id(), dayKey: '2026-10-28', used: 3 });
  budget.used = 0;
  await assert.rejects(budget.save(), /budget.*mutation/i);
  assert.equal((await RagUsageBudget.findById(budget._id)).used, 3);
});

for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'document.deleteOne']) {
  test(`RAG budget ${operation} cannot erase reserved same-day usage`, async () => {
    const identity = { student: id(), dayKey: '2026-10-28' };
    const budget = await RagUsageBudget.create(identity);
    await RagUsageBudget.findOneAndUpdate({ ...identity, used: { $lt: 1 } }, { $inc: { used: 1 } });
    const deletion = operation === 'document.deleteOne'
      ? () => budget.deleteOne()
      : () => RagUsageBudget[operation](identity);
    await assert.rejects(deletion(), /budget.*mutation/i);
    assert.equal((await RagUsageBudget.findOne(identity)).used, 1);
    await RagUsageBudget.findOneAndUpdate(identity, { $max: { used: 0 }, $setOnInsert: identity },
      { upsert: true, setDefaultsOnInsert: false });
    assert.equal((await RagUsageBudget.findOne(identity)).used, 1);
    assert.equal(await RagUsageBudget.findOneAndUpdate({ ...identity, used: { $lt: 1 } }, { $inc: { used: 1 } }), null);
  });
}
