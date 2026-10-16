const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const cloudinary = require('cloudinary');
const { S3Client } = require('@aws-sdk/client-s3');

const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

const app = createTestApp();

function validLecture(overrides = {}) {
  return {
    title: 'Lecture title',
    description: 'Lecture description',
    lecture: {
      public_id: 'lecture-id',
      secure_url: 'https://example.com/lecture.mp4'
    },
    ...overrides
  };
}

async function createUser(role) {
  const suffix = `${Date.now()}-${Math.random()}`;
  return User.create({
    fullName: 'Course Test User',
    email: `course-${suffix}@example.com`,
    password: 'password123',
    role
  });
}

async function login(user) {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: 'password123' });

  assert.equal(response.status, 200);
  return agent;
}

async function createCourse(instructor, overrides = {}) {
  return Course.create({
    title: 'A valid controller course',
    description: 'A valid controller course description',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: 'thumbnail-id',
      secure_url: 'https://example.com/thumbnail.jpg'
    },
    ...overrides
  });
}

function pngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32)
  ]);
}

async function drainReadableBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return 0;
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.length;
  return bytes;
}

test.before(async () => {
  process.env.JWT_SECRET = 'course-controller-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
});

test('an authenticated instructor creates a course owned by the authenticated user', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const attacker = await createUser('STUDENT');
  const agent = await login(instructor);

  const response = await agent
    .post('/api/v1/courses')
    .send({
      title: 'An instructor owned course',
      description: 'Course creation must use the authenticated instructor.',
      category: 'Programming',
      instructor: attacker._id.toString(),
      createdBy: 'client controlled legacy value'
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.course.instructor, instructor._id.toString());

  const stored = await Course.findById(response.body.course._id).lean();
  assert.equal(stored.instructor.toString(), instructor._id.toString());
});

test('course updates preserve pricing validation and ignore body curriculum replacements', async () => {
  const admin = await createUser('ADMIN');
  const agent = await login(admin);

  const paidCourse = await createCourse(admin, { accessType: 'PAID', price: 49900 });
  const pricingResponse = await agent
    .put(`/api/v1/courses/${paidCourse._id}`)
    .send({ accessType: 'FREE' });

  assert.equal(pricingResponse.status, 422);
  assert.equal(pricingResponse.body.success, false);
  assert.match(pricingResponse.body.message, /Free courses must have a price of 0/);
  assert.equal((await Course.findById(paidCourse._id)).accessType, 'PAID');

  const previewCourse = await createCourse(admin, { lectures: [validLecture({ isPreview: true })] });
  const previewResponse = await agent
    .put(`/api/v1/courses/${previewCourse._id}`)
    .send({ lectures: [validLecture({ isPreview: true }), validLecture({ isPreview: true })] });

  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.success, true);
  const persistedPreviewCourse = await Course.findById(previewCourse._id);
  assert.equal(persistedPreviewCourse.lectures.length, 1);
  assert.equal(persistedPreviewCourse.lectures[0].title, 'Lecture title');
  assert.equal(persistedPreviewCourse.lectures[0].isPreview, true);
});

test('an invalid thumbnail update preserves the old asset without uploading a replacement', async () => {
  const admin = await createUser('ADMIN');
  const agent = await login(admin);
  const course = await createCourse(admin, { accessType: 'PAID', price: 49900 });
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const uploadedAssets = [];
  const destroyedAssets = [];

  cloudinary.v2.uploader.upload = async () => {
    uploadedAssets.push('new-thumbnail-id');
    return {
      public_id: 'new-thumbnail-id',
      secure_url: 'https://example.com/new-thumbnail.jpg'
    };
  };
  cloudinary.v2.uploader.destroy = async (publicId) => {
    destroyedAssets.push(publicId);
  };

  try {
    const response = await agent
      .put(`/api/v1/courses/${course._id}`)
      .field('accessType', 'FREE')
      .attach('thumbnail', Buffer.from('thumbnail bytes'), 'thumbnail.jpg');

    assert.equal(destroyedAssets.includes('thumbnail-id'), false);
    assert.deepEqual(uploadedAssets, []);
    assert.deepEqual(destroyedAssets, []);
    assert.equal(response.status, 422);

    const persisted = await Course.findById(course._id).lean();
    assert.equal(persisted.thumbnail.public_id, 'thumbnail-id');
    assert.equal(persisted.thumbnail.secure_url, 'https://example.com/thumbnail.jpg');
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('a legacy stored course without instructor can save a lecture mutation', async () => {
  const legacyId = new mongoose.Types.ObjectId();
  await Course.collection.insertOne({
    _id: legacyId,
    title: 'A legacy course title',
    description: 'A legacy course description',
    category: 'Programming',
    createdBy: 'legacy owner',
    thumbnail: {
      public_id: 'legacy-thumbnail',
      secure_url: 'https://example.com/legacy-thumbnail.jpg'
    },
    lectures: [],
    numberOflectures: 0
  });

  const legacyCourse = await Course.findById(legacyId);
  legacyCourse.lectures.push(validLecture());
  legacyCourse.numberOflectures = legacyCourse.lectures.length;
  await legacyCourse.save();

  const saved = await Course.findById(legacyId).lean();
  assert.equal(saved.instructor, undefined);
  assert.equal(saved.lectures.length, 1);
});

test('removes a new R2 thumbnail when its MongoDB save fails', async (t) => {
  const previousEnvironment = Object.fromEntries([
    'R2_ENABLED', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    R2_ENABLED: 'true',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'lms-test-media',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const operations = [];
  const uploadedBytes = [];
  t.mock.method(S3Client.prototype, 'send', async (command) => {
    operations.push(command.constructor.name);
    if (command.constructor.name === 'PutObjectCommand') {
      uploadedBytes.push(await drainReadableBody(command.input.Body));
    }
    return {};
  });
  t.mock.method(Course.prototype, 'save', async function rejectCourseSave() {
    throw new Error('database save unavailable');
  });

  const response = await agent
    .post('/api/v1/courses')
    .field('title', 'R2 cleanup course')
    .field('description', 'The object must be removed when the course cannot be saved.')
    .field('category', 'Programming')
    .attach('thumbnail', pngBytes(), { filename: 'thumbnail.png', contentType: 'image/png' });

  assert.equal(response.status, 500);
  assert.deepEqual(operations, ['PutObjectCommand', 'DeleteObjectCommand']);
  assert.deepEqual(uploadedBytes, [pngBytes().length]);
});

test('public course responses sign R2 thumbnails without exposing storage metadata', async (t) => {
  const previousEnvironment = Object.fromEntries([
    'R2_ENABLED', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    R2_ENABLED: 'true',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'lms-test-media',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor, {
    thumbnail: { storage: { provider: 'R2', key: 'thumbnails/private.png', contentType: 'image/png', size: 12 } }
  });
  const response = await request(app).get(`/api/v1/courses/${course._id}`);

  assert.equal(response.status, 200);
  assert.match(response.body.course.thumbnail.secure_url, /X-Amz-Signature/);
  assert.equal(Object.hasOwn(response.body.course.thumbnail, 'storage'), false);
  assert.equal(Object.hasOwn(response.body.course.thumbnail, 'provider'), false);
});

test('course deletion removes its R2 thumbnail after the MongoDB record is deleted', async (t) => {
  const previousEnvironment = Object.fromEntries([
    'R2_ENABLED', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    R2_ENABLED: 'true',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'lms-test-media',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key'
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    thumbnail: { storage: { provider: 'R2', key: 'thumbnails/to-delete.png', contentType: 'image/png', size: 12 } }
  });
  const operations = [];
  t.mock.method(S3Client.prototype, 'send', async (command) => {
    operations.push(command.constructor.name);
    return {};
  });

  const response = await agent.delete(`/api/v1/courses/${course._id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(operations, ['DeleteObjectCommand']);
});
