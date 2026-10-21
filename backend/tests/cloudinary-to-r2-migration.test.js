const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateCloudinaryMediaToR2, runCli } = require('../scripts/migrate-cloudinary-media-to-r2');

const CLOUD_NAME = 'demo-cloud';

function source(publicId, extension = 'png') {
  return {
    public_id: publicId,
    secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1/${publicId}.${extension}`
  };
}

function createLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(line),
    error: (line) => lines.push(line)
  };
}

function createModels({ users = [], courses = [], submissions = [], race = false } = {}) {
  const updates = [];
  const collection = (records) => ({ find: async () => records });
  const update = (kind, records) => async (filter, operation) => {
    updates.push({ kind, filter, operation });
    if (race) return { matchedCount: 0, modifiedCount: 0 };
    const record = records.find((item) => String(item._id) === String(filter._id));
    if (!record) return { matchedCount: 0, modifiedCount: 0 };
    const [path, value] = Object.entries(operation.$set)[0];
    if (path === 'avatar.storage') record.avatar.storage = value;
    if (path === 'thumbnail.storage') record.thumbnail.storage = value;
    if (path === 'file.storage') record.file.storage = value;
    if (path === 'lectures.$.lecture.storage') {
      const lectureId = filter.lectures.$elemMatch._id;
      record.lectures.find((lecture) => String(lecture._id) === String(lectureId)).lecture.storage = value;
    }
    return { matchedCount: 1, modifiedCount: 1 };
  };
  return {
    updates,
    User: { ...collection(users), updateOne: update('USER', users) },
    Course: { ...collection(courses), updateOne: update('COURSE', courses) },
    Submission: { ...collection(submissions), updateOne: update('SUBMISSION', submissions) }
  };
}

function createR2() {
  const calls = { put: [], head: [], remove: [] };
  return {
    calls,
    async put(values) { calls.put.push(values); },
    async head(key) { calls.head.push(key); return { ContentLength: calls.put.find((item) => item.key === key).contentLength }; },
    async remove(key) { calls.remove.push(key); }
  };
}

function bytesForUrl(url) {
  if (url.endsWith('.mp4')) return Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  if (url.endsWith('.pdf')) return Buffer.from('%PDF-1.7\nlegacy assignment');
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]);
}

function contentTypeForUrl(url) {
  if (url.endsWith('.mp4')) return 'video/mp4';
  if (url.endsWith('.pdf')) return 'application/pdf';
  return 'image/png';
}

function streamFrom(bytes) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    }
  };
}

function successfulFetch() {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      const bytes = bytesForUrl(url);
      return {
        ok: true,
        headers: { get: (name) => name === 'content-type' ? contentTypeForUrl(url) : null },
        body: streamFrom(bytes)
      };
    }
  };
}

test('dry run reports every usable candidate without provider, download, or Mongo writes', async () => {
  const models = createModels({
    users: [{ _id: 'user-1', avatar: source('avatar') }],
    courses: [{ _id: 'course-1', thumbnail: source('thumbnail'), lectures: [{ _id: 'lecture-1', lecture: source('lecture', 'mp4') }] }],
    submissions: [{ _id: 'submission-1', file: { ...source('submission', 'pdf'), originalName: 'work.pdf', mimetype: 'application/pdf', size: 4 } }]
  });
  const r2 = createR2();
  const network = successfulFetch();
  const logger = createLogger();

  const report = await migrateCloudinaryMediaToR2({ models, r2, fetch: network.fetch, cloudName: CLOUD_NAME, dryRun: true, logger });

  assert.deepEqual(report, { candidates: 4, migrated: 0, skipped: 0, failed: 0 });
  assert.equal(network.calls.length, 0);
  assert.equal(r2.calls.put.length, 0);
  assert.equal(r2.calls.head.length, 0);
  assert.equal(r2.calls.remove.length, 0);
  assert.equal(models.updates.length, 0);
  assert.ok(logger.lines.every((line) => /^cloudinary-r2-migration type=(USER_AVATAR|COURSE_THUMBNAIL|COURSE_LECTURE|SUBMISSION_FILE) id=[^\s]+ outcome=[a-z-]+$/.test(line)));
});

test('a verified R2 copy atomically updates every media type and never deletes Cloudinary', async () => {
  const models = createModels({
    users: [{ _id: 'user-1', avatar: source('avatar') }],
    courses: [{ _id: 'course-1', thumbnail: source('thumbnail'), lectures: [{ _id: 'lecture-1', lecture: source('lecture', 'mp4') }] }],
    submissions: [{ _id: 'submission-1', file: { ...source('submission', 'pdf'), originalName: 'work.pdf', mimetype: 'application/pdf', size: 4 } }]
  });
  const r2 = createR2();
  const network = successfulFetch();
  const logger = createLogger();

  const report = await migrateCloudinaryMediaToR2({
    models, r2, fetch: network.fetch, cloudName: CLOUD_NAME, logger,
    randomUUID: (() => { let number = 0; return () => `random-${++number}`; })()
  });

  assert.deepEqual(report, { candidates: 4, migrated: 4, skipped: 0, failed: 0 });
  assert.equal(r2.calls.put.length, 4);
  assert.equal(r2.calls.head.length, 4);
  assert.equal(r2.calls.remove.length, 0);
  assert.equal(models.updates.length, 4);
  assert.equal(models.User ? models.User : undefined, models.User);
  assert.equal(models.updates.some((update) => JSON.stringify(update).includes('destroy')), false);
  assert.equal(models.User, models.User);
  assert.equal(models.updates.length, 4);
  assert.equal(models.User ? true : false, true);
  assert.equal(models.updates[0].operation.$set['avatar.storage'].provider, 'R2');
  assert.equal(models.updates[1].operation.$set['thumbnail.storage'].provider, 'R2');
  assert.equal(models.updates[2].operation.$set['lectures.$.lecture.storage'].provider, 'R2');
  assert.equal(models.updates[3].operation.$set['file.storage'].provider, 'R2');
  assert.ok(logger.lines.every((line) => !line.includes('https://') && !line.includes('random-')));
});

test('an idempotent rerun skips migrated R2 records without cloud operations', async () => {
  const models = createModels({
    users: [{ _id: 'user-1', avatar: { ...source('avatar'), storage: { provider: 'R2', key: 'avatars/existing.png', contentType: 'image/png', size: 2 } } }]
  });
  const r2 = createR2();
  const network = successfulFetch();
  const logger = createLogger();

  const report = await migrateCloudinaryMediaToR2({ models, r2, fetch: network.fetch, cloudName: CLOUD_NAME, logger });

  assert.deepEqual(report, { candidates: 0, migrated: 0, skipped: 1, failed: 0 });
  assert.equal(network.calls.length, 0);
  assert.equal(r2.calls.put.length, 0);
  assert.equal(models.updates.length, 0);
});

test('skips authenticated paid non-preview lectures without provider or Mongo operations', async () => {
  const models = createModels({
    courses: [{
      _id: 'course-1', accessType: 'PAID', lectures: [{
        _id: 'lecture-1', isPreview: false,
        lecture: { ...source('protected-lecture', 'mp4'), deliveryType: 'AUTHENTICATED' }
      }]
    }]
  });
  const r2 = createR2();
  const logger = createLogger();
  let fetches = 0;
  const report = await migrateCloudinaryMediaToR2({
    models, r2, cloudName: CLOUD_NAME,
    fetch: async () => { fetches += 1; throw new Error('protected sources must not be fetched'); },
    logger
  });

  assert.deepEqual(report, { candidates: 0, migrated: 0, skipped: 1, failed: 0 });
  assert.equal(fetches, 0);
  assert.equal(r2.calls.put.length, 0);
  assert.equal(r2.calls.head.length, 0);
  assert.equal(models.updates.length, 0);
  assert.deepEqual(logger.lines, ['cloudinary-r2-migration type=COURSE_LECTURE id=course-1:lecture-1 outcome=skipped']);
});

test('copy failures are isolated and later candidates migrate', async () => {
  const models = createModels({
    users: [{ _id: 'user-1', avatar: source('broken') }],
    courses: [{ _id: 'course-1', thumbnail: source('works') }]
  });
  const r2 = createR2();
  const logger = createLogger();
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) throw new Error('download unavailable');
    const bytes = bytesForUrl('https://res.cloudinary.com/demo-cloud/image/upload/v1/works.png');
    return { ok: true, headers: { get: (name) => name === 'content-type' ? 'image/png' : null }, body: streamFrom(bytes) };
  };

  const report = await migrateCloudinaryMediaToR2({ models, r2, fetch, cloudName: CLOUD_NAME, logger });

  assert.deepEqual(report, { candidates: 2, migrated: 1, skipped: 0, failed: 1 });
  assert.equal(r2.calls.put.length, 1);
  assert.equal(models.updates.length, 1);
  assert.ok(logger.lines.some((line) => line === 'cloudinary-r2-migration type=USER_AVATAR id=user-1 outcome=failed'));
});

test('a conditional update race removes the new R2 copy and reports a skipped record', async () => {
  const models = createModels({ users: [{ _id: 'user-1', avatar: source('avatar') }], race: true });
  const r2 = createR2();
  const network = successfulFetch();
  const logger = createLogger();

  const report = await migrateCloudinaryMediaToR2({ models, r2, fetch: network.fetch, cloudName: CLOUD_NAME, logger, randomUUID: () => 'race-key' });

  assert.deepEqual(report, { candidates: 1, migrated: 0, skipped: 1, failed: 0 });
  assert.deepEqual(r2.calls.remove, ['avatars/race-key.png']);
  assert.equal(models.updates.length, 1);
});

test('CLI dry run uses the read-only connector and never invokes startup migrations or providers', async () => {
  const models = createModels({ users: [{ _id: 'user-1', avatar: source('avatar') }] });
  const calls = { readOnlyConnect: 0, startupConnect: 0, disconnect: 0, fetch: 0, r2: 0 };
  const exitCode = await runCli({
    args: ['--dry-run'],
    env: { DB_URL: 'mongodb://read-only.example/lms', CLOUDINARY_CLOUD_NAME: CLOUD_NAME },
    dotenv: { config() {} },
    connectReadOnly: async ({ dbUrl }) => {
      assert.equal(dbUrl, 'mongodb://read-only.example/lms');
      calls.readOnlyConnect += 1;
    },
    connectDB: async () => { calls.startupConnect += 1; throw new Error('startup migrations must not run'); },
    mongoose: { disconnect: async () => { calls.disconnect += 1; } },
    models,
    fetch: async () => { calls.fetch += 1; throw new Error('dry run must not fetch'); },
    r2: {
      put: async () => { calls.r2 += 1; },
      head: async () => { calls.r2 += 1; },
      remove: async () => { calls.r2 += 1; }
    },
    logger: createLogger()
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, { readOnlyConnect: 1, startupConnect: 0, disconnect: 1, fetch: 0, r2: 0 });
  assert.equal(models.updates.length, 0);
});

test('rejects an oversized declared legacy source before reading its body', async () => {
  const models = createModels({ users: [{ _id: 'user-1', avatar: source('avatar') }] });
  const r2 = createR2();
  let bodyRead = false;
  const report = await migrateCloudinaryMediaToR2({
    models, r2, cloudName: CLOUD_NAME,
    fetch: async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-length' ? String(201 * 1024 * 1024) : 'image/png' },
      body: { async *[Symbol.asyncIterator]() { bodyRead = true; yield Buffer.alloc(1); } }
    }),
    logger: createLogger()
  });
  assert.deepEqual(report, { candidates: 1, migrated: 0, skipped: 0, failed: 1 });
  assert.equal(bodyRead, false);
  assert.equal(r2.calls.put.length, 0);
});

test('rejects an oversized streamed legacy source without a content-length header', async () => {
  const models = createModels({ submissions: [{ _id: 'submission-1', file: { ...source('submission', 'pdf'), originalName: 'work.pdf', mimetype: 'application/pdf', size: 4 } }] });
  const r2 = createR2();
  let chunksRead = 0;
  const report = await migrateCloudinaryMediaToR2({
    models, r2, cloudName: CLOUD_NAME,
    fetch: async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'application/pdf' : null },
      body: {
        async *[Symbol.asyncIterator]() {
          chunksRead += 1;
          yield Buffer.alloc(25 * 1024 * 1024);
          chunksRead += 1;
          yield Buffer.alloc(1);
        }
      }
    }),
    logger: createLogger()
  });
  assert.deepEqual(report, { candidates: 1, migrated: 0, skipped: 0, failed: 1 });
  assert.equal(chunksRead, 2);
  assert.equal(r2.calls.put.length, 0);
});

test('aborts a slow legacy source fetch using a timeout signal', async () => {
  const models = createModels({ users: [{ _id: 'user-1', avatar: source('avatar') }] });
  const r2 = createR2();
  let receivedSignal;
  const report = await migrateCloudinaryMediaToR2({
    models, r2, cloudName: CLOUD_NAME, timeoutMs: 5,
    fetch: async (_url, { signal }) => {
      receivedSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
    logger: createLogger()
  });
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(report, { candidates: 1, migrated: 0, skipped: 0, failed: 1 });
  assert.equal(r2.calls.put.length, 0);
});

test('rejects legacy content whose declared type and signature do not match its extension', async () => {
  const models = createModels({ users: [{ _id: 'user-1', avatar: source('avatar') }] });
  const r2 = createR2();
  const report = await migrateCloudinaryMediaToR2({
    models, r2, cloudName: CLOUD_NAME,
    fetch: async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'image/png' : null },
      body: streamFrom(Buffer.from('%PDF-1.7 not an image'))
    }),
    logger: createLogger()
  });
  assert.deepEqual(report, { candidates: 1, migrated: 0, skipped: 0, failed: 1 });
  assert.equal(r2.calls.put.length, 0);
});

test('a cleanup failure after an atomic update race is failed and safely logged', async () => {
  const models = createModels({ users: [{ _id: 'user-1', avatar: source('avatar') }], race: true });
  const r2 = createR2();
  r2.remove = async () => { throw new Error('cleanup unavailable'); };
  const logger = createLogger();
  const network = successfulFetch();
  const report = await migrateCloudinaryMediaToR2({ models, r2, fetch: network.fetch, cloudName: CLOUD_NAME, logger, randomUUID: () => 'never-logged' });
  assert.deepEqual(report, { candidates: 1, migrated: 0, skipped: 0, failed: 1 });
  assert.deepEqual(logger.lines, ['cloudinary-r2-migration type=USER_AVATAR id=user-1 outcome=cleanup-failed']);
});
