const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const cloudinary = require('cloudinary');
const fs = require('fs/promises');

const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const Enrollment = require('../models/enrollment.schema');
const upload = require('../middleware/multer.middleware');
process.env.FRONTEND_URL ??= 'http://lms-frontend.test';
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

const app = createTestApp();

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUser(role = 'STUDENT') {
  const id = unique('course-access');
  return User.create({
    fullName: 'Course Access User',
    email: `${id}@example.com`,
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

function lecture(title, overrides = {}) {
  return {
    title,
    description: `${title} description`,
    lecture: {
      public_id: unique('video'),
      secure_url: `https://video.example/${unique('video')}.mp4`
    },
    ...overrides
  };
}

async function createCourse(instructor, overrides = {}) {
  return Course.create({
    title: unique('A public course title').slice(0, 45),
    description: 'A course description for protected access testing.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: unique('thumbnail'),
      secure_url: 'https://image.example/thumbnail.jpg'
    },
    ...overrides
  });
}

test.before(async () => {
  process.env.JWT_SECRET = 'course-access-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
});

test('visitor catalogue exposes published cards only and applies exact public filters', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const publishedFree = await createCourse(instructor, {
    category: 'Catalogue-A',
    accessType: 'FREE',
    lectures: [lecture('Hidden catalogue lecture')]
  });
  await createCourse(instructor, { category: 'Catalogue-A', status: 'UNPUBLISHED' });
  await createCourse(instructor, { category: 'Catalogue-B', accessType: 'PAID', price: 500 });

  const catalogue = await request(app).get('/api/v1/courses');
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.body.courses.some((course) => course._id === publishedFree.id), true);
  assert.equal(catalogue.body.courses.some((course) => course.status === 'UNPUBLISHED'), false);
  assert.equal(catalogue.body.courses.every((course) => !Object.hasOwn(course, 'lectures')), true);

  const filtered = await request(app)
    .get('/api/v1/courses')
    .query({ accessType: 'FREE', category: 'Catalogue-A' });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.courses.length, 1);
  assert.equal(filtered.body.courses[0]._id, publishedFree.id);

  const invalid = await request(app).get('/api/v1/courses').query({ accessType: 'free' });
  assert.equal(invalid.status, 400);
});

test('public preview selects explicit then fallback lecture while individual media remains protected', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const first = lecture('First lesson');
  const explicitPreview = lecture('Explicit preview', { isPreview: true });
  const course = await createCourse(instructor, { lectures: [first, explicitPreview] });
  const fallback = await createCourse(instructor, { lectures: [lecture('Fallback first'), lecture('Fallback second')] });

  const details = await request(app).get(`/api/v1/courses/${course.id}`);
  assert.equal(details.status, 200);
  assert.equal(Object.hasOwn(details.body.course, 'lectures'), false);

  const preview = await request(app).get(`/api/v1/courses/${course.id}/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.lecture.title, 'Explicit preview');
  assert.deepEqual(Object.keys(preview.body.lecture).sort(), ['description', 'durationSeconds', 'id', 'isPreview', 'secureUrl', 'title']);
  assert.equal(preview.body.lecture.secureUrl, explicitPreview.lecture.secure_url);
  assert.equal(preview.body.lecture.public_id, undefined);
  assert.equal(preview.body.lecture.lecture, undefined);

  const fallbackPreview = await request(app).get(`/api/v1/courses/${fallback.id}/preview`);
  assert.equal(fallbackPreview.status, 200);
  assert.equal(fallbackPreview.body.lecture.title, 'Fallback first');

  const firstLectureId = course.lectures[0]._id;
  const unauthenticated = await request(app).get(`/api/v1/courses/${course.id}/lectures/${firstLectureId}`);
  assert.equal(unauthenticated.status, 401);

  const student = await createUser();
  const studentAgent = await login(student);
  const blocked = await studentAgent.get(`/api/v1/courses/${course.id}/lectures/${firstLectureId}`);
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.body, {
    success: false,
    message: 'Purchase or enrol in this course to access this lesson',
    stack: blocked.body.stack
  });
});

test('only an active enrollment for the requested course retrieves an individual lesson', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const otherStudent = await createUser();
  const course = await createCourse(instructor, { lectures: [lecture('Enrolled lesson')] });
  const otherCourse = await createCourse(instructor, { lectures: [lecture('Other course lesson')] });
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE' });
  await Enrollment.create({ student: otherStudent._id, course: otherCourse._id, source: 'PURCHASE' });

  const enrolled = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.body.lecture.title, 'Enrolled lesson');

  const wrongCourse = await (await login(otherStudent)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(wrongCourse.status, 403);
  assert.equal(wrongCourse.body.message, 'Purchase or enrol in this course to access this lesson');
});

test('course owners can retrieve their protected lesson before publication', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor, {
    status: 'UNPUBLISHED',
    lectures: [lecture('Draft owner lesson')]
  });

  const response = await (await login(instructor))
    .get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.lecture.title, 'Draft owner lesson');
});

test('instructors cannot mutate another instructor course while an admin can', async () => {
  const owner = await createUser('INSTRUCTOR');
  const intruder = await createUser('INSTRUCTOR');
  const admin = await createUser('ADMIN');
  const course = await createCourse(owner, { lectures: [lecture('Existing lesson')] });
  const intruderAgent = await login(intruder);

  const patch = await intruderAgent.patch(`/api/v1/instructor/courses/${course.id}`).send({ category: 'Nope' });
  assert.equal(patch.status, 403);
  const add = await intruderAgent
    .post(`/api/v1/instructor/courses/${course.id}/lectures`)
    .field('title', 'Unauthorised lesson')
    .field('description', 'Must not upload')
    .attach('video', Buffer.from('video'), 'lesson.mp4');
  assert.equal(add.status, 403);
  const remove = await intruderAgent.delete(`/api/v1/instructor/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(remove.status, 403);

  const adminUpdate = await (await login(admin))
    .patch(`/api/v1/instructor/courses/${course.id}`)
    .send({ category: 'Admin managed' });
  assert.equal(adminUpdate.status, 200);
  assert.equal(adminUpdate.body.course.category, 'Admin managed');
});

test('new instructor route pins ownership to the authenticated user', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const attacker = await createUser('INSTRUCTOR');
  const response = await (await login(instructor))
    .post('/api/v1/instructor/courses')
    .send({
      title: 'Pinned instructor course',
      description: 'The server must choose the course owner.',
      category: 'Programming',
      instructor: attacker.id,
      createdBy: attacker.id
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.course.instructor, instructor.id);
  assert.equal((await Course.findById(response.body.course._id)).instructor.toString(), instructor.id);
});

test('instructor course creation persists validated FREE and PAID pricing', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);

  const paid = await agent.post('/api/v1/instructor/courses').send({
    title: 'Paid instructor course',
    description: 'A paid course must retain its paise price.',
    category: 'Programming',
    accessType: 'PAID',
    price: 500
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.course.accessType, 'PAID');
  assert.equal(paid.body.course.price, 500);
  const storedPaid = await Course.findById(paid.body.course._id).lean();
  assert.equal(storedPaid.accessType, 'PAID');
  assert.equal(storedPaid.price, 500);

  const free = await agent.post('/api/v1/instructor/courses').send({
    title: 'Free instructor course',
    description: 'A free course must retain a zero paise price.',
    category: 'Programming',
    accessType: 'FREE',
    price: 0
  });
  assert.equal(free.status, 200);
  assert.equal(free.body.course.accessType, 'FREE');
  assert.equal(free.body.course.price, 0);
  const storedFree = await Course.findById(free.body.course._id).lean();
  assert.equal(storedFree.accessType, 'FREE');
  assert.equal(storedFree.price, 0);

  const invalid = await agent.post('/api/v1/instructor/courses').send({
    title: 'Invalid price course',
    description: 'Invalid prices must never silently become free.',
    category: 'Programming',
    accessType: 'PAID',
    price: 'not-a-paise-value'
  });
  assert.equal([400, 422].includes(invalid.status), true);
  assert.equal(invalid.body.success, false);
});

test('instructor lecture multipart route rejects unsupported videos and accepts each supported type', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor);
  const originalUpload = cloudinary.v2.uploader.upload;
  const uploaded = [];
  cloudinary.v2.uploader.upload = async () => {
    const publicId = unique('cloud-video');
    uploaded.push(publicId);
    return { public_id: publicId, secure_url: `https://video.example/${publicId}` };
  };

  try {
    for (const extension of ['mkv', 'avi', 'vlc']) {
      const rejected = await agent
        .post(`/api/v1/instructor/courses/${course.id}/lectures`)
        .field('title', `Rejected ${extension}`)
        .field('description', 'This format must not reach the lecture handler.')
        .attach('video', Buffer.from('video'), `lesson.${extension}`);
      assert.equal(rejected.status, 400);
    }
    assert.equal(uploaded.length, 0);

    for (const extension of ['mp4', 'webm', 'mov']) {
      const accepted = await agent
        .post(`/api/v1/instructor/courses/${course.id}/lectures`)
        .field('title', `Allowed ${extension}`)
        .field('description', 'This format must reach the lecture handler.')
        .attach('video', Buffer.from('video'), `lesson.${extension}`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.lecture.title, `Allowed ${extension}`);
    }
    assert.equal(uploaded.length, 3);
    assert.equal((await Course.findById(course._id)).lectures.length, 3);

    const legacy = await agent
      .post(`/api/v1/courses/${course.id}`)
      .field('title', 'Legacy lecture field')
      .field('description', 'The legacy lecture field remains explicitly supported.')
      .attach('lecture', Buffer.from('video'), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.lecture.title, 'Legacy lecture field');
    assert.equal(uploaded.length, 4);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
  }
});

test('course updates ignore forged thumbnail fields and only destroy the actual old thumbnail after a replacement', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    thumbnail: { public_id: 'actual-thumbnail', secure_url: 'https://image.example/actual.jpg' }
  });
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyed = [];
  cloudinary.v2.uploader.upload = async () => ({ public_id: 'replacement-thumbnail', secure_url: 'https://image.example/replacement.png' });
  cloudinary.v2.uploader.destroy = async (publicId) => { destroyed.push(publicId); };

  try {
    const forged = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({
      thumbnail: { public_id: 'victim-thumbnail', secure_url: 'https://attacker.example/victim.png' }
    });
    assert.equal(forged.status, 200);
    assert.equal((await Course.findById(course.id)).thumbnail.public_id, 'actual-thumbnail');
    assert.deepEqual(destroyed, []);

    const replaced = await agent
      .patch(`/api/v1/instructor/courses/${course.id}`)
      .field('thumbnail[public_id]', 'victim-thumbnail')
      .attach('thumbnail', Buffer.from('image'), { filename: 'thumbnail.png', contentType: 'image/png' });
    assert.equal(replaced.status, 200);
    assert.equal((await Course.findById(course.id)).thumbnail.public_id, 'replacement-thumbnail');
    assert.deepEqual(destroyed, ['actual-thumbnail']);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('dedicated instructor course updates cannot replace curriculum media from the request body', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, { lectures: [lecture('Original protected lecture')] });

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({
    lectures: [lecture('Forged body lecture', {
      lecture: { public_id: 'forged-video', secure_url: 'https://attacker.example/video' }
    })]
  });
  assert.equal(response.status, 200);
  const stored = await Course.findById(course.id);
  assert.equal(stored.lectures.length, 1);
  assert.equal(stored.lectures[0].title, 'Original protected lecture');
  assert.notEqual(stored.lectures[0].lecture.public_id, 'forged-video');
});

test('legacy course updates ignore forged lecture media and never destroy its asset later', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    thumbnail: { public_id: 'legacy-thumbnail', secure_url: 'https://image.example/legacy.png' },
    lectures: [lecture('Legacy original lecture', {
      lecture: { public_id: 'legacy-original-video', secure_url: 'https://video.example/original' }
    })]
  });
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyed = [];
  cloudinary.v2.uploader.destroy = async (publicId) => { destroyed.push(publicId); };

  try {
    const update = await agent.put(`/api/v1/courses/${course.id}`).send({
      category: 'Updated metadata',
      lectures: [lecture('Forged legacy lecture', {
        lecture: { public_id: 'forged-legacy-video', secure_url: 'https://attacker.example/video' }
      })]
    });
    assert.equal(update.status, 200);
    const stored = await Course.findById(course.id);
    assert.equal(stored.category, 'Updated metadata');
    assert.equal(stored.lectures.length, 1);
    assert.equal(stored.lectures[0].lecture.public_id, 'legacy-original-video');

    const deletion = await agent.delete(`/api/v1/instructor/courses/${course.id}`);
    assert.equal(deletion.status, 200);
    assert.equal(destroyed.includes('legacy-thumbnail'), true);
    assert.equal(destroyed.includes('legacy-original-video'), true);
    assert.equal(destroyed.includes('forged-legacy-video'), false);
  } finally {
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('failed course creation cleans the uploaded thumbnail asset and its temporary file', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyed = [];
  let uploadedPath;
  cloudinary.v2.uploader.upload = async (filePath) => {
    uploadedPath = filePath;
    return { public_id: 'failed-create-thumbnail', secure_url: 'https://image.example/new.png' };
  };
  cloudinary.v2.uploader.destroy = async (publicId) => { destroyed.push(publicId); };

  try {
    const response = await agent
      .post('/api/v1/instructor/courses')
      .field('title', 'short')
      .field('description', 'Validation fails after the thumbnail upload.')
      .field('category', 'Programming')
      .attach('thumbnail', Buffer.from('image'), { filename: 'thumbnail.png', contentType: 'image/png' });
    assert.equal(response.status, 422);
    assert.deepEqual(destroyed, ['failed-create-thumbnail']);
    await assert.rejects(() => fs.access(uploadedPath));
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('course deletion removes thumbnail and every lecture asset after a successful versioned delete', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    thumbnail: { public_id: 'delete-thumbnail', secure_url: 'https://image.example/delete.png' },
    lectures: [
      lecture('Delete first', { lecture: { public_id: 'delete-video-one', secure_url: 'https://video.example/one' } }),
      lecture('Delete second', { lecture: { public_id: 'delete-video-two', secure_url: 'https://video.example/two' } })
    ]
  });
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyed = [];
  cloudinary.v2.uploader.destroy = async (publicId) => { destroyed.push(publicId); };

  try {
    const response = await agent.delete(`/api/v1/instructor/courses/${course.id}`);
    assert.equal(response.status, 200);
    assert.equal(await Course.exists({ _id: course._id }), null);
    assert.deepEqual(new Set(destroyed), new Set(['delete-thumbnail', 'delete-video-one', 'delete-video-two']));
  } finally {
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('a stale course delete leaves the current course and all media intact', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, { thumbnail: { public_id: 'stale-thumbnail', secure_url: 'https://image.example/stale.png' } });
  const originalDeleteOne = Course.deleteOne;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyed = [];
  Course.deleteOne = async () => ({ deletedCount: 0 });
  cloudinary.v2.uploader.destroy = async (publicId) => { destroyed.push(publicId); };

  try {
    const response = await agent.delete(`/api/v1/instructor/courses/${course.id}`);
    assert.equal(response.status, 409);
    assert.ok(await Course.exists({ _id: course._id }));
    assert.deepEqual(destroyed, []);
  } finally {
    Course.deleteOne = originalDeleteOne;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('lecture deletion saves before media destruction and leaves media intact on a VersionError', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    lectures: [lecture('Versioned lesson', { lecture: { public_id: 'versioned-video', secure_url: 'https://video.example/versioned' } })]
  });
  const originalSave = Course.prototype.save;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const destroyed = [];
  Course.prototype.save = async function saveWithConflict() {
    throw new mongoose.Error.VersionError(this, this.__v, []);
  };
  cloudinary.v2.uploader.destroy = async (publicId) => { destroyed.push(publicId); };

  try {
    const response = await agent.delete(`/api/v1/instructor/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(response.status, 500);
    assert.deepEqual(destroyed, []);
    assert.equal((await Course.findById(course.id)).lectures.length, 1);
  } finally {
    Course.prototype.save = originalSave;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('video and thumbnail middleware require matching MIME types as well as allowed extensions', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor);
  const originalUpload = cloudinary.v2.uploader.upload;
  cloudinary.v2.uploader.upload = async () => ({ public_id: unique('mime-video'), secure_url: 'https://video.example/mime' });

  try {
    const wrongVideoMime = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Wrong video MIME')
      .field('description', 'The extension alone must not be accepted.')
      .attach('video', Buffer.from('video'), { filename: 'lesson.mp4', contentType: 'image/png' });
    assert.equal(wrongVideoMime.status, 400);

    const wrongImageMime = await agent
      .post('/api/v1/instructor/courses')
      .field('title', 'Wrong thumbnail MIME course')
      .field('description', 'The image extension alone must not be accepted.')
      .field('category', 'Programming')
      .attach('thumbnail', Buffer.from('image'), { filename: 'thumbnail.png', contentType: 'video/mp4' });
    assert.equal(wrongImageMime.status, 400);

    const matchingVideoMime = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Matching video MIME')
      .field('description', 'Matching extension and MIME reach the handler.')
      .attach('video', Buffer.from('video'), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(matchingVideoMime.status, 200);

    const matchingImageMime = await agent
      .post('/api/v1/instructor/courses')
      .field('title', 'Matching thumbnail MIME course')
      .field('description', 'Matching extension and MIME reach the handler.')
      .field('category', 'Programming')
      .attach('thumbnail', Buffer.from('image'), { filename: 'thumbnail.png', contentType: 'image/png' });
    assert.equal(matchingImageMime.status, 200);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
  }
});

test('malformed and absent ids return 400 or 404 without a CastError response', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor, { lectures: [lecture('ID validation lesson')] });
  const agent = await login(instructor);

  for (const response of [
    await request(app).get('/api/v1/courses/not-an-id'),
    await request(app).get('/api/v1/courses/not-an-id/preview'),
    await agent.get('/api/v1/courses/not-an-id/lectures/not-an-id'),
    await request(app).get(`/api/v1/courses/${new mongoose.Types.ObjectId()}`),
    await agent.get(`/api/v1/courses/${course.id}/lectures/${new mongoose.Types.ObjectId()}`)
  ]) {
    assert.equal([400, 404].includes(response.status), true);
    assert.equal(/CastError/.test(response.body.message), false);
  }
});

test('multer rejects unsupported video extensions and generates collision-resistant filenames', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);

  for (const extension of ['mkv', 'avi', 'vlc']) {
    const response = await agent
      .post('/api/v1/instructor/courses')
      .field('title', 'Rejected upload course')
      .field('description', 'Unsupported video must be rejected.')
      .field('category', 'Programming')
      .attach('thumbnail', Buffer.from('not-an-image'), `thumbnail.${extension}`);
    assert.equal(response.status, 400);
  }

  const first = upload.createFilename('same-name.mp4');
  const second = upload.createFilename('same-name.mp4');
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f-]+\.mp4$/);
});

test('a student can idempotently enroll in a free published course and then access its lesson', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, { lectures: [lecture('Free enrolled lesson')] });

  const unauthenticated = await request(app).post(`/api/v1/courses/${course.id}/enroll`);
  assert.equal(unauthenticated.status, 401);

  const agent = await login(student);
  const first = await agent.post(`/api/v1/courses/${course.id}/enroll`);
  assert.equal(first.status, 201);
  assert.equal(first.body.enrollment.source, 'FREE_ENROLLMENT');
  assert.equal(first.body.enrollment.status, 'ACTIVE');
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 1);

  const repeated = await agent.post(`/api/v1/courses/${course.id}/enroll`);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.enrollment.source, 'FREE_ENROLLMENT');
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 1);

  const lesson = await agent.get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(lesson.status, 200);
});

test('free enrollment keeps paid, unpublished, malformed, and missing courses unavailable', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const paid = await createCourse(instructor, { accessType: 'PAID', price: 500, lectures: [lecture('Paid lesson')] });
  const unpublished = await createCourse(instructor, { status: 'UNPUBLISHED', lectures: [lecture('Draft lesson')] });
  const agent = await login(student);

  const paidResponse = await agent.post(`/api/v1/courses/${paid.id}/enroll`);
  assert.deepEqual(paidResponse.body, { success: false, message: 'This course requires payment' });
  assert.equal(paidResponse.status, 400);

  const unpublishedResponse = await agent.post(`/api/v1/courses/${unpublished.id}/enroll`);
  assert.equal(unpublishedResponse.status, 404);
  assert.equal(unpublishedResponse.body.message, 'Course not found');

  const malformed = await agent.post('/api/v1/courses/not-an-id/enroll');
  assert.equal(malformed.status, 400);
  const missing = await agent.post(`/api/v1/courses/${new mongoose.Types.ObjectId()}/enroll`);
  assert.equal(missing.status, 404);

  const deniedLesson = await agent.get(`/api/v1/courses/${paid.id}/lectures/${paid.lectures[0]._id}`);
  assert.equal(deniedLesson.status, 403);
  assert.equal(deniedLesson.body.message, 'Purchase or enrol in this course to access this lesson');
});

test('free enrollment preserves revoked and purchased memberships and requires the student role', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const admin = await createUser('ADMIN');
  const student = await createUser();
  const revokedStudent = await createUser();
  const purchasedStudent = await createUser();
  const course = await createCourse(instructor);
  await Enrollment.create({ student: revokedStudent._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'REVOKED' });
  await Enrollment.create({ student: purchasedStudent._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' });

  for (const user of [instructor, admin]) {
    const response = await (await login(user)).post(`/api/v1/courses/${course.id}/enroll`);
    assert.equal(response.status, 403);
    assert.equal(response.body.message, 'You do not have access to this route');
  }

  const revoked = await (await login(revokedStudent)).post(`/api/v1/courses/${course.id}/enroll`);
  assert.deepEqual(revoked.body, { success: false, message: 'Your access to this course has been revoked' });
  assert.equal(revoked.status, 403);
  assert.equal((await Enrollment.findOne({ student: revokedStudent._id, course: course._id })).status, 'REVOKED');

  const purchased = await (await login(purchasedStudent)).post(`/api/v1/courses/${course.id}/enroll`);
  assert.equal(purchased.status, 200);
  const storedPurchase = await Enrollment.findOne({ student: purchasedStudent._id, course: course._id });
  assert.equal(storedPurchase.source, 'PURCHASE');
  assert.equal(storedPurchase.status, 'ACTIVE');

  const studentResponse = await (await login(student)).post(`/api/v1/courses/${course.id}/enroll`);
  assert.equal(studentResponse.status, 201);
});

test('CORS only allows FRONTEND_URL, preflight succeeds, and unmatched routes have the final JSON 404', async () => {
  const allowed = process.env.FRONTEND_URL;
  const allowedOrigin = await request(app).get('/health').set('Origin', allowed);
  assert.equal(allowedOrigin.headers['access-control-allow-origin'], allowed);
  assert.equal(allowedOrigin.headers['access-control-allow-credentials'], 'true');

  const wrongOrigin = await request(app).get('/health').set('Origin', 'http://untrusted.test');
  assert.equal(wrongOrigin.headers['access-control-allow-origin'], undefined);

  const preflight = await request(app)
    .options('/api/v1/courses/anything/enroll')
    .set('Origin', allowed)
    .set('Access-Control-Request-Method', 'POST');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], allowed);
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');

  const unknown = await request(app).get('/api/v1/unknown-route');
  assert.deepEqual(unknown.body, { success: false, message: 'Route not found' });
  assert.equal(unknown.status, 404);

  const malformedCourse = await request(app).get('/api/v1/courses/not-an-id');
  assert.equal(malformedCourse.status, 400);
  assert.equal(malformedCourse.body.message, 'Invalid courseId format');
});
