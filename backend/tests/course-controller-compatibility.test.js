const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const cloudinary = require('cloudinary');

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

test('a failed thumbnail update preserves the old asset and cleans the uploaded replacement', async () => {
  const admin = await createUser('ADMIN');
  const agent = await login(admin);
  const course = await createCourse(admin, { accessType: 'PAID', price: 49900 });
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyedAssets = [];

  cloudinary.v2.uploader.upload = async () => ({
    public_id: 'new-thumbnail-id',
    secure_url: 'https://example.com/new-thumbnail.jpg'
  });
  cloudinary.v2.uploader.destroy = async (publicId) => {
    destroyedAssets.push(publicId);
  };

  try {
    const response = await agent
      .put(`/api/v1/courses/${course._id}`)
      .field('accessType', 'FREE')
      .attach('thumbnail', Buffer.from('thumbnail bytes'), 'thumbnail.jpg');

    assert.equal(destroyedAssets.includes('thumbnail-id'), false);
    assert.deepEqual(destroyedAssets, ['new-thumbnail-id']);
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
