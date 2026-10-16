const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Course = require('../models/course.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { PUBLIC, AUTHENTICATED } = require('../services/video-delivery.service');
const {
  migratePremiumVideoDelivery,
  runCli,
  createCloudinaryVideoDelivery
} = require('../scripts/migrate-premium-video-delivery');

function courseData(overrides = {}) {
  return {
    title: 'Premium video migration course',
    description: 'A course used to exercise the legacy video migration.',
    category: 'Programming',
    instructor: new mongoose.Types.ObjectId(),
    thumbnail: { public_id: 'thumbnail', secure_url: 'https://example.test/thumbnail.jpg' },
    accessType: 'PAID',
    price: 500,
    lectures: [],
    ...overrides
  };
}

function lecture(publicId, overrides = {}) {
  const { lecture: mediaOverrides = {}, ...lectureOverrides } = overrides;
  return {
    title: `Lecture ${publicId}`,
    description: 'Legacy video lecture',
    lecture: {
      public_id: publicId,
      secure_url: `https://example.test/${publicId}.mp4`,
      deliveryType: PUBLIC,
      ...mediaOverrides
    },
    ...lectureOverrides
  };
}

function logger() {
  const entries = { info: [], error: [] };
  return {
    entries,
    info(message) { entries.info.push(message); },
    error(message) { entries.error.push(message); }
  };
}

test.before(async () => { await connectTestDb(); });
test.after(async () => { await disconnectTestDb(); });
test.afterEach(async () => { await Course.deleteMany({}); });

test('migrates only a paid non-preview public lecture with a targeted database update', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('legacy-public')] }));
  const calls = [];
  const originalUpdateOne = Course.updateOne;
  Course.updateOne = async (...args) => {
    calls.push(args);
    return originalUpdateOne.apply(Course, args);
  };
  const deliveryCalls = [];

  try {
    const report = await migratePremiumVideoDelivery({
      Course,
      videoDelivery: { isAuthenticated: async () => false, renameDelivery: async (input) => deliveryCalls.push(input) },
      dryRun: false,
      logger: logger()
    });

    assert.deepEqual(report, { scanned: 1, migrated: 1, skipped: 0, failed: 0 });
    assert.deepEqual(deliveryCalls, [{ publicId: 'legacy-public', from: PUBLIC, to: AUTHENTICATED }]);
    assert.deepEqual(calls[0][0], {
      _id: course._id,
      lectures: {
        $elemMatch: {
          _id: course.lectures[0]._id,
          $or: [
            { 'lecture.deliveryType': PUBLIC },
            { 'lecture.deliveryType': { $exists: false } }
          ]
        }
      }
    });
    assert.deepEqual(calls[0][1], { $set: { 'lectures.$.lecture.deliveryType': AUTHENTICATED } });
    const stored = await Course.findById(course._id).lean();
    assert.equal(stored.lectures[0].lecture.deliveryType, AUTHENTICATED);
  } finally {
    Course.updateOne = originalUpdateOne;
  }
});

test('migrates paid non-preview legacy media with missing delivery metadata', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('legacy-missing-delivery-type')] }));
  await Course.collection.updateOne(
    { _id: course._id },
    { $unset: { 'lectures.0.lecture.deliveryType': '' } }
  );
  const rawBeforeMigration = await Course.collection.findOne({ _id: course._id });
  assert.equal(Object.hasOwn(rawBeforeMigration.lectures[0].lecture, 'deliveryType'), false);
  const calls = [];

  const report = await migratePremiumVideoDelivery({
    Course,
    videoDelivery: { isAuthenticated: async () => false, renameDelivery: async (input) => calls.push(input) },
    dryRun: false,
    logger: logger()
  });

  assert.deepEqual(report, { scanned: 1, migrated: 1, skipped: 0, failed: 0 });
  assert.deepEqual(calls, [{ publicId: 'legacy-missing-delivery-type', from: PUBLIC, to: AUTHENTICATED }]);
  assert.equal((await Course.findById(course._id)).lectures[0].lecture.deliveryType, AUTHENTICATED);
});

test('skips paid non-preview media with an explicit null delivery type', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('explicit-null-delivery-type')] }));
  await Course.collection.updateOne(
    { _id: course._id },
    { $set: { 'lectures.0.lecture.deliveryType': null } }
  );
  let inspectionCalls = 0;
  let renameCalls = 0;
  let updateCalls = 0;
  const originalUpdateOne = Course.updateOne;
  Course.updateOne = async (...args) => { updateCalls += 1; return originalUpdateOne.apply(Course, args); };

  try {
    const report = await migratePremiumVideoDelivery({
      Course,
      videoDelivery: {
        isAuthenticated: async () => { inspectionCalls += 1; return false; },
        renameDelivery: async () => { renameCalls += 1; }
      },
      dryRun: false,
      logger: logger()
    });

    assert.deepEqual(report, { scanned: 1, migrated: 0, skipped: 1, failed: 0 });
    assert.equal(inspectionCalls, 0);
    assert.equal(renameCalls, 0);
    assert.equal(updateCalls, 0);
  } finally {
    Course.updateOne = originalUpdateOne;
  }
});

test('skips previews, authenticated media, unusable media, and every lecture on free courses', async () => {
  const paid = await Course.create(courseData({ lectures: [
    lecture('preview', { isPreview: true }),
    lecture('already-authenticated', { lecture: { deliveryType: AUTHENTICATED } }),
    lecture('unusable'),
    lecture('unsupported')
  ] }));
  await Course.collection.updateOne(
    { _id: paid._id },
    {
      $unset: { 'lectures.2.lecture.public_id': '' },
      $set: { 'lectures.3.lecture.deliveryType': 'LEGACY' }
    }
  );
  await Course.create(courseData({ accessType: 'FREE', price: 0, lectures: [lecture('free-public')] }));
  const calls = [];

  const report = await migratePremiumVideoDelivery({
    Course,
    videoDelivery: { isAuthenticated: async () => false, renameDelivery: async (input) => calls.push(input) },
    dryRun: false,
    logger: logger()
  });

  assert.deepEqual(report, { scanned: 3, migrated: 0, skipped: 4, failed: 0 });
  assert.deepEqual(calls, []);
  const courses = await Course.find({}).lean();
  assert.ok(courses.flatMap((item) => item.lectures).every((item) => item.lecture.deliveryType !== AUTHENTICATED || item.lecture.public_id === 'already-authenticated'));
});

test('dry run only reports eligible assets and never calls the provider or updates Mongo', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('would-migrate')] }));
  const log = logger();
  let renameCalls = 0;
  let updateCalls = 0;
  const originalUpdateOne = Course.updateOne;
  Course.updateOne = async (...args) => { updateCalls += 1; return originalUpdateOne.apply(Course, args); };

  try {
    const report = await migratePremiumVideoDelivery({
      Course,
      videoDelivery: { isAuthenticated: async () => false, renameDelivery: async () => { renameCalls += 1; } },
      dryRun: true,
      logger: log
    });
    assert.deepEqual(report, { scanned: 1, migrated: 0, skipped: 0, failed: 0 });
    assert.equal(renameCalls, 0);
    assert.equal(updateCalls, 0);
    assert.match(log.entries.info.join('\n'), /DRY-RUN/);
    assert.equal((await Course.findById(course._id)).lectures[0].lecture.deliveryType, PUBLIC);
  } finally {
    Course.updateOne = originalUpdateOne;
  }
});

test('continues after a provider failure without leaking provider error text', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('bad'), lecture('good')] }));
  const log = logger();
  const deliveryCalls = [];
  const report = await migratePremiumVideoDelivery({
    Course,
    videoDelivery: {
      isAuthenticated: async () => false,
      renameDelivery: async ({ publicId }) => {
        deliveryCalls.push(publicId);
        if (publicId === 'bad') throw new Error('provider-secret-value');
      }
    },
    dryRun: false,
    logger: log
  });

  assert.deepEqual(report, { scanned: 2, migrated: 1, skipped: 0, failed: 1 });
  assert.deepEqual(deliveryCalls, ['bad', 'good']);
  const stored = await Course.findById(course._id).lean();
  assert.equal(stored.lectures[0].lecture.deliveryType, PUBLIC);
  assert.equal(stored.lectures[1].lecture.deliveryType, AUTHENTICATED);
  assert.doesNotMatch(log.entries.error.join('\n'), /provider-secret-value/);
  assert.match(log.entries.error.join('\n'), new RegExp(String(course._id)));
});

test('treats an unsuccessful database update as failed and leaves the lecture public', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('db-fail')] }));
  const originalUpdateOne = Course.updateOne;
  Course.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });

  try {
    const report = await migratePremiumVideoDelivery({
      Course,
      videoDelivery: { isAuthenticated: async () => false, renameDelivery: async () => undefined },
      dryRun: false,
      logger: logger()
    });
    assert.deepEqual(report, { scanned: 1, migrated: 0, skipped: 0, failed: 1 });
    assert.equal((await Course.findById(course._id)).lectures[0].lecture.deliveryType, PUBLIC);
  } finally {
    Course.updateOne = originalUpdateOne;
  }
});

test('treats a matched but unmodified database update as failed and leaves the lecture public', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('db-unmodified')] }));
  const originalUpdateOne = Course.updateOne;
  Course.updateOne = async () => ({ matchedCount: 1, modifiedCount: 0 });

  try {
    const report = await migratePremiumVideoDelivery({
      Course,
      videoDelivery: { isAuthenticated: async () => false, renameDelivery: async () => undefined },
      dryRun: false,
      logger: logger()
    });
    assert.deepEqual(report, { scanned: 1, migrated: 0, skipped: 0, failed: 1 });
    assert.equal((await Course.findById(course._id)).lectures[0].lecture.deliveryType, PUBLIC);
  } finally {
    Course.updateOne = originalUpdateOne;
  }
});

test('retries a provider-renamed lecture by finalising Mongo without a second rename', async () => {
  const course = await Course.create(courseData({ lectures: [lecture('provider-renamed')] }));
  const originalUpdateOne = Course.updateOne;
  let updateAttempts = 0;
  let providerAuthenticated = false;
  let renameCalls = 0;
  Course.updateOne = async (...args) => {
    updateAttempts += 1;
    if (updateAttempts === 1) return { matchedCount: 1, modifiedCount: 0 };
    return originalUpdateOne.apply(Course, args);
  };
  const videoDelivery = {
    isAuthenticated: async () => providerAuthenticated,
    renameDelivery: async () => { renameCalls += 1; providerAuthenticated = true; }
  };

  try {
    const first = await migratePremiumVideoDelivery({ Course, videoDelivery, dryRun: false, logger: logger() });
    const afterFirst = await Course.findById(course._id).lean();
    const second = await migratePremiumVideoDelivery({ Course, videoDelivery, dryRun: false, logger: logger() });

    assert.deepEqual(first, { scanned: 1, migrated: 0, skipped: 0, failed: 1 });
    assert.equal(afterFirst.lectures[0].lecture.deliveryType, PUBLIC);
    assert.deepEqual(second, { scanned: 1, migrated: 1, skipped: 0, failed: 0 });
    assert.equal(renameCalls, 1);
    assert.equal((await Course.findById(course._id)).lectures[0].lecture.deliveryType, AUTHENTICATED);
  } finally {
    Course.updateOne = originalUpdateOne;
  }
});

test('safely fails when authenticated delivery inspection has an unexpected provider error', async () => {
  await Course.create(courseData({ lectures: [lecture('inspection-failure')] }));
  const log = logger();
  let renameCalls = 0;

  const report = await migratePremiumVideoDelivery({
    Course,
    videoDelivery: {
      isAuthenticated: async () => { throw new Error('provider-inspection-secret'); },
      renameDelivery: async () => { renameCalls += 1; }
    },
    dryRun: false,
    logger: log
  });

  assert.deepEqual(report, { scanned: 1, migrated: 0, skipped: 0, failed: 1 });
  assert.equal(renameCalls, 0);
  assert.doesNotMatch(log.entries.error.join('\n'), /provider-inspection-secret/);
});

test('returns a safe nonzero result when CLI disconnect fails', async () => {
  const log = logger();
  const code = await runCli({
    args: [],
    dotenv: { config() {} },
    loadEnv: () => ({ dbUrl: 'mongodb://test', cloudinaryAuthTokenDurationSeconds: 600 }),
    cloudinary: { config() {}, api: { resource: async () => ({}) } },
    connectDB: async () => undefined,
    mongoose: { disconnect: async () => { throw new Error('disconnect-secret'); } },
    Course: { find: async () => [] },
    createVideoDeliveryService: () => ({
      isAuthenticated: async () => false,
      renameDelivery: async () => undefined
    }),
    env: {
      CLOUDINARY_CLOUD_NAME: 'cloud',
      CLOUDINARY_CLOUD_API_KEY: 'key',
      CLOUDINARY_CLOUD_API_SECRET: 'secret'
    },
    logger: log
  });

  assert.equal(code, 1);
  assert.doesNotMatch(log.entries.error.join('\n'), /disconnect-secret/);
});

test('Cloudinary adapter treats only a 404 authenticated resource lookup as absent', async () => {
  const resourceCalls = [];
  const cloudinary = {
    api: {
      resource: async (...args) => { resourceCalls.push(args); return { public_id: 'present' }; }
    }
  };
  const delivery = createCloudinaryVideoDelivery({ cloudinary });

  assert.equal(await delivery.isAuthenticated('present'), true);
  assert.deepEqual(resourceCalls[0], ['present', { resource_type: 'video', type: 'authenticated' }]);

  cloudinary.api.resource = async () => { throw { http_code: 404 }; };
  assert.equal(await delivery.isAuthenticated('absent'), false);

  cloudinary.api.resource = async () => { throw new Error('unexpected-provider-error'); };
  await assert.rejects(() => delivery.isAuthenticated('broken'), /unexpected-provider-error/);
});

test('is idempotent after a successful run', async () => {
  await Course.create(courseData({ lectures: [lecture('once')] }));
  let calls = 0;
  const videoDelivery = { isAuthenticated: async () => false, renameDelivery: async () => { calls += 1; } };
  const first = await migratePremiumVideoDelivery({ Course, videoDelivery, dryRun: false, logger: logger() });
  const second = await migratePremiumVideoDelivery({ Course, videoDelivery, dryRun: false, logger: logger() });

  assert.deepEqual(first, { scanned: 1, migrated: 1, skipped: 0, failed: 0 });
  assert.deepEqual(second, { scanned: 1, migrated: 0, skipped: 1, failed: 0 });
  assert.equal(calls, 1);
});
