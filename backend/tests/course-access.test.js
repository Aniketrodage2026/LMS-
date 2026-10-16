const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const cloudinary = require('cloudinary');
const fs = require('fs/promises');

const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const Enrollment = require('../models/enrollment.schema');
const AuditLog = require('../models/audit-log.schema');
const upload = require('../middleware/multer.middleware');
const multer = require('multer');
const errorMiddleware = require('../middleware/error.middleware');
const courseController = require('../controller/course.controller');
const { createMediaStorage } = require('../services/media-storage.service');
process.env.FRONTEND_URL ??= 'http://lms-frontend.test';
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

const app = createTestApp();

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32)
  ]);
}

function videoBytes(extension = 'mp4') {
  if (extension === 'webm') return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
  const brand = extension === 'mov' ? 'qt  ' : 'isom';
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(32)]);
}

function withR2Enabled() {
  const original = Object.fromEntries(['R2_ENABLED'].map((name) => [name, process.env[name]]));
  process.env.R2_ENABLED = 'true';
  return () => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function drainReadableBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return 0;
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.length;
  return bytes;
}

function fakeR2MediaStorage(calls) {
  return createMediaStorage({
    r2: {
      put: async (values) => calls.push(['put', { ...values, consumedBytes: await drainReadableBody(values.body) }]),
      remove: async (key) => calls.push(['remove', key]),
      getSignedUrl: async (key) => {
        calls.push(['sign', key]);
        return `https://r2.example/signed/${key}`;
      }
    }
  });
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

test.afterEach(async () => {
  await AuditLog.collection.deleteMany({});
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
    error: { code: 'COURSE_ENROLLMENT_REQUIRED', message: 'Purchase or enrol in this course to access this lesson' },
    stack: blocked.body.stack
  });
});

test('only an active enrollment for the requested course retrieves an individual lesson', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const otherStudent = await createUser();
  const storedUrl = 'https://video.example/permanent-paid-video.mp4';
  const publicId = 'paid-private-video-id';
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Enrolled lesson', {
      lecture: { public_id: publicId, secure_url: storedUrl, deliveryType: 'AUTHENTICATED' }
    })]
  });
  const otherCourse = await createCourse(instructor, { lectures: [lecture('Other course lesson')] });
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE' });
  await Enrollment.create({ student: otherStudent._id, course: otherCourse._id, source: 'PURCHASE' });

  const previousTokenKey = process.env.CLOUDINARY_AUTH_TOKEN_KEY;
  process.env.CLOUDINARY_AUTH_TOKEN_KEY = 'course-access-auth-token-key';
  const urlMock = t.mock.method(cloudinary.v2, 'url', (id, options) => {
    assert.equal(id, publicId);
    assert.equal(options.type, 'authenticated');
    return 'https://res.cloudinary.example/tokenized-paid-video.mp4';
  });
  try {
    const enrolled = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(enrolled.status, 200);
    assert.deepEqual(enrolled.body.lecture, {
      id: String(course.lectures[0]._id),
      title: 'Enrolled lesson',
      description: 'Enrolled lesson description',
      durationSeconds: 0,
      isPreview: false,
      secureUrl: 'https://res.cloudinary.example/tokenized-paid-video.mp4'
    });
    assert.equal(urlMock.mock.callCount(), 1);
    assert.equal(JSON.stringify(enrolled.body.lecture).includes(storedUrl), false);
    assert.equal(JSON.stringify(enrolled.body.lecture).includes(publicId), false);
    assert.equal(Object.hasOwn(enrolled.body.lecture, 'deliveryType'), false);

    const wrongCourse = await (await login(otherStudent)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(wrongCourse.status, 403);
    assert.equal(wrongCourse.body.message, 'Purchase or enrol in this course to access this lesson');
    assert.equal(Object.hasOwn(wrongCourse.body, 'lecture'), false);
    assert.equal(urlMock.mock.callCount(), 1);
  } finally {
    if (previousTokenKey === undefined) delete process.env.CLOUDINARY_AUTH_TOKEN_KEY;
    else process.env.CLOUDINARY_AUTH_TOKEN_KEY = previousTokenKey;
  }
});

test('public previews return the stored URL without tokenizing paid course media', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const storedUrl = 'https://video.example/public-preview.mp4';
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Paid preview', {
      isPreview: true,
      durationSeconds: 45,
      lecture: { public_id: 'public-preview-id', secure_url: storedUrl, deliveryType: 'PUBLIC' }
    })]
  });
  const urlMock = t.mock.method(cloudinary.v2, 'url', () => 'https://res.cloudinary.example/should-not-be-used');

  const response = await request(app).get(`/api/v1/courses/${course.id}/preview`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.lecture, {
    id: String(course.lectures[0]._id),
    title: 'Paid preview',
    description: 'Paid preview description',
    durationSeconds: 45,
    isPreview: true,
    secureUrl: storedUrl
  });
  assert.equal(urlMock.mock.callCount(), 0);
});

test('an enrolled student receives a signed R2 URL for a paid R2 lecture without storage metadata', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Private R2 lesson', {
      lecture: {
        storage: { provider: 'R2', key: 'lectures/paid-private.mp4', contentType: 'video/mp4', size: 42 },
        deliveryType: 'AUTHENTICATED'
      }
    })]
  });
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' });
  const original = Object.fromEntries(['R2_ENABLED', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_SIGNED_URL_TTL_SECONDS']
    .map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    R2_ENABLED: 'true',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'lms-private-test',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    R2_SIGNED_URL_TTL_SECONDS: '600'
  });
  try {
    const response = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(response.status, 200);
    assert.match(response.body.lecture.secureUrl, /^https:\/\/lms-private-test\.0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/lectures\/paid-private\.mp4\?/);
    assert.equal(Object.hasOwn(response.body.lecture, 'storage'), false);
    assert.equal(JSON.stringify(response.body.lecture).includes('provider'), false);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a visitor receives a signed R2 URL for only the resolved preview lecture', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [
      lecture('Private non-preview R2 lesson', {
        lecture: { storage: { provider: 'R2', key: 'lectures/not-preview.mp4', contentType: 'video/mp4', size: 42 }, deliveryType: 'AUTHENTICATED' }
      }),
      lecture('R2 preview lesson', {
        isPreview: true,
        lecture: { storage: { provider: 'R2', key: 'lectures/the-preview.mp4', contentType: 'video/mp4', size: 42 }, deliveryType: 'PUBLIC' }
      })
    ]
  });
  const original = Object.fromEntries(['R2_ENABLED', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_SIGNED_URL_TTL_SECONDS']
    .map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    R2_ENABLED: 'true', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'lms-private-test', R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key', R2_SIGNED_URL_TTL_SECONDS: '600'
  });
  try {
    const preview = await request(app).get(`/api/v1/courses/${course.id}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.body.lecture.secureUrl, /\/lectures\/the-preview\.mp4\?/);
    assert.equal(Object.hasOwn(preview.body.lecture, 'storage'), false);

    const denied = await (await login(await createUser())).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(denied.status, 403);
    assert.equal(Object.hasOwn(denied.body, 'lecture'), false);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('R2 lecture upload persists a random course-scoped object and removes its local temporary file', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor);
  const agent = await login(instructor);
  const calls = [];
  const storage = fakeR2MediaStorage(calls);
  const restoreR2 = withR2Enabled();
  const restoreStorage = courseController.__setMediaStorageFactoryForTests({ get: () => storage });
  try {
    const response = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'R2 upload lesson')
      .field('description', 'The uploaded lecture is private provider metadata.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });

    assert.equal(response.status, 200);
    const put = calls.find(([method]) => method === 'put');
    assert.ok(put);
    const [, uploaded] = put;
    assert.match(uploaded.key, new RegExp(`^courses/${course.id}/lectures/[a-f0-9-]+\\.mp4$`));
    assert.equal(uploaded.key.includes(instructor.email), false);
    assert.equal(uploaded.consumedBytes, uploaded.contentLength);
    await assert.rejects(() => fs.access(uploaded.body.path));

    const stored = await Course.findById(course.id);
    assert.deepEqual(stored.lectures[0].lecture.storage.toObject(), {
      provider: 'R2', key: uploaded.key, contentType: 'video/mp4', size: uploaded.contentLength
    });
    assert.equal(Object.hasOwn(response.body.lecture, 'storage'), false);
  } finally {
    restoreStorage();
    restoreR2();
  }
});

test('a failed R2 lecture save removes exactly the newly uploaded object without Cloudinary deletion', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor);
  const agent = await login(instructor);
  const calls = [];
  const storage = fakeR2MediaStorage(calls);
  const restoreR2 = withR2Enabled();
  const restoreStorage = courseController.__setMediaStorageFactoryForTests({ get: () => storage });
  const cloudinaryDestroy = t.mock.method(cloudinary.v2.uploader, 'destroy', async () => { throw new Error('legacy deletion must not run'); });
  t.mock.method(Course.prototype, 'save', async () => { throw new Error('Mongo save failed'); });
  try {
    const response = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'R2 cleanup lesson')
      .field('description', 'A failed save removes exactly the new R2 object.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });

    assert.equal(response.status, 500);
    const put = calls.find(([method]) => method === 'put');
    assert.ok(put);
    assert.deepEqual(calls.filter(([method]) => method === 'remove'), [['remove', put[1].key]]);
    assert.equal(cloudinaryDestroy.mock.callCount(), 0);
  } finally {
    restoreStorage();
    restoreR2();
  }
});

test('R2 lecture and course deletion remove provider media only after the database mutation succeeds', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const lectureMedia = { storage: { provider: 'R2', key: 'courses/test/lectures/delete-me.mp4', contentType: 'video/mp4', size: 42 }, deliveryType: 'AUTHENTICATED' };
  const courseDeleteMedia = { storage: { provider: 'R2', key: 'courses/test/lectures/course-delete.mp4', contentType: 'video/mp4', size: 43 }, deliveryType: 'AUTHENTICATED' };
  const course = await createCourse(instructor, {
    thumbnail: { storage: { provider: 'R2', key: 'thumbnails/delete-me.png', contentType: 'image/png', size: 10 } },
    lectures: [
      lecture('Delete R2 lecture', { lecture: lectureMedia }),
      lecture('Delete course R2 lecture', { lecture: courseDeleteMedia })
    ]
  });
  const calls = [];
  const storage = fakeR2MediaStorage(calls);
  const agent = await login(instructor);
  const restoreR2 = withR2Enabled();
  const restoreStorage = courseController.__setMediaStorageFactoryForTests({ get: () => storage });
  try {
    const lectureDelete = await agent.delete(`/api/v1/instructor/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(lectureDelete.status, 200);
    assert.equal((await Course.findById(course.id)).lectures.length, 1);
    assert.deepEqual(calls, [['remove', lectureMedia.storage.key]]);

    const courseDelete = await agent.delete(`/api/v1/instructor/courses/${course.id}`);
    assert.equal(courseDelete.status, 200);
    assert.equal(await Course.exists({ _id: course._id }), null);
    assert.deepEqual(calls, [
      ['remove', lectureMedia.storage.key],
      ['remove', 'thumbnails/delete-me.png'],
      ['remove', courseDeleteMedia.storage.key]
    ]);
  } finally {
    restoreStorage();
    restoreR2();
  }
});

test('a denied R2 non-preview lesson never invokes the signing adapter', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    accessType: 'PAID', price: 500,
    lectures: [lecture('Denied R2 lesson', {
      lecture: { storage: { provider: 'R2', key: 'courses/test/lectures/denied.mp4', contentType: 'video/mp4', size: 42 }, deliveryType: 'AUTHENTICATED' }
    })]
  });
  const calls = [];
  const agent = await login(student);
  const restoreR2 = withR2Enabled();
  const restoreStorage = courseController.__setMediaStorageFactoryForTests({ get: () => fakeR2MediaStorage(calls) });
  try {
    const response = await agent.get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(response.status, 403);
    assert.equal(calls.some(([method]) => method === 'sign'), false);
  } finally {
    restoreStorage();
    restoreR2();
  }
});

test('an enrolled free lesson returns the safe DTO with its public URL only', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const storedUrl = 'https://video.example/free-public-video.mp4';
  const publicId = 'free-public-video-id';
  const course = await createCourse(instructor, {
    lectures: [lecture('Free safe lesson', {
      durationSeconds: 120,
      lecture: { public_id: publicId, secure_url: storedUrl, deliveryType: 'PUBLIC' }
    })]
  });
  await Enrollment.create({ student: student._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });

  const response = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.lecture, {
    id: String(course.lectures[0]._id),
    title: 'Free safe lesson',
    description: 'Free safe lesson description',
    durationSeconds: 120,
    isPreview: false,
    secureUrl: storedUrl
  });
  assert.equal(JSON.stringify(response.body.lecture).includes(publicId), false);
  assert.equal(Object.hasOwn(response.body.lecture, 'deliveryType'), false);
});

test('authenticated delivery without a token key returns the safe video-unavailable error', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Unavailable premium lesson', {
      lecture: { public_id: 'unavailable-premium-video', secure_url: 'https://video.example/must-not-leak.mp4', deliveryType: 'AUTHENTICATED' }
    })]
  });
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' });
  const previousTokenKey = process.env.CLOUDINARY_AUTH_TOKEN_KEY;
  delete process.env.CLOUDINARY_AUTH_TOKEN_KEY;
  try {
    const response = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body.error, {
      code: 'VIDEO_DELIVERY_UNAVAILABLE',
      message: 'Premium video playback is temporarily unavailable. Please try again shortly.'
    });
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
  } finally {
    if (previousTokenKey === undefined) delete process.env.CLOUDINARY_AUTH_TOKEN_KEY;
    else process.env.CLOUDINARY_AUTH_TOKEN_KEY = previousTokenKey;
  }
});

test('a paid lesson with legacy public delivery metadata fails closed without generating a URL', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const storedUrl = 'https://video.example/legacy-paid-url-must-not-leak.mp4';
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Legacy paid lesson', {
      lecture: {
        public_id: 'legacy-paid-public-media',
        secure_url: storedUrl,
        deliveryType: 'PUBLIC'
      }
    })]
  });
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' });
  const urlMock = t.mock.method(cloudinary.v2, 'url', () => 'https://res.cloudinary.example/must-not-be-generated');

  const response = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, {
    code: 'VIDEO_DELIVERY_UNAVAILABLE',
    message: 'Premium video playback is temporarily unavailable. Please try again shortly.'
  });
  assert.equal(JSON.stringify(response.body).includes(storedUrl), false);
  assert.equal(urlMock.mock.callCount(), 0);
});

test('a paid lesson with missing delivery metadata fails closed without generating a URL', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const storedUrl = 'https://video.example/missing-paid-url-must-not-leak.mp4';
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Missing delivery metadata lesson', {
      lecture: {
        public_id: 'missing-paid-delivery-media',
        secure_url: storedUrl,
        deliveryType: 'PUBLIC'
      }
    })]
  });
  await Course.collection.updateOne(
    { _id: course._id },
    { $unset: { 'lectures.0.lecture.deliveryType': '' } }
  );
  const persisted = await Course.collection.findOne({ _id: course._id });
  assert.equal(Object.hasOwn(persisted.lectures[0].lecture, 'deliveryType'), false);
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' });
  const urlMock = t.mock.method(cloudinary.v2, 'url', () => 'https://res.cloudinary.example/must-not-be-generated');

  const response = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, {
    code: 'VIDEO_DELIVERY_UNAVAILABLE',
    message: 'Premium video playback is temporarily unavailable. Please try again shortly.'
  });
  assert.equal(JSON.stringify(response.body).includes(storedUrl), false);
  assert.equal(urlMock.mock.callCount(), 0);
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

test('successful course creation and updates write exactly one safe audit event each', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);

  const created = await agent.post('/api/v1/instructor/courses').send({
    title: 'Audited instructor course',
    description: 'The successful course creation must be audited.',
    category: 'Programming'
  });
  assert.equal(created.status, 200);
  const courseId = created.body.course._id;
  const createdEvents = await AuditLog.find({ action: 'COURSE_CREATED', 'target.id': courseId });
  assert.equal(createdEvents.length, 1);
  assert.equal(String(createdEvents[0].actor), String(instructor._id));
  assert.equal(createdEvents[0].target.type, 'COURSE');
  assert.equal(createdEvents[0].summary, undefined);

  const updated = await agent.patch(`/api/v1/instructor/courses/${courseId}`).send({
    title: 'Audited updated course'
  });
  assert.equal(updated.status, 200);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': courseId }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': courseId }), 0);

  const draft = await createCourse(instructor, { status: 'UNPUBLISHED' });
  const published = await agent.patch(`/api/v1/instructor/courses/${draft.id}`).send({ status: 'PUBLISHED' });
  assert.equal(published.status, 200);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': draft._id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': draft._id }), 0);

  const invalidCreate = await agent.post('/api/v1/instructor/courses').send({
    title: 'short', description: 'Rejected course must not be audited.', category: 'Programming'
  });
  const invalidUpdateData = await agent.patch(`/api/v1/instructor/courses/${courseId}`).send({
    accessType: 'FREE', price: 500
  });
  const invalidUpdate = await agent.patch('/api/v1/instructor/courses/not-an-id').send({ title: 'No audit' });
  assert.equal(invalidCreate.status, 422);
  assert.equal(invalidUpdateData.status, 422);
  assert.equal(invalidUpdate.status, 400);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_CREATED' }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED' }), 1);
});

test('a successful course create remains successful when audit storage fails', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  t.mock.method(AuditLog, 'create', async () => { throw new Error('audit storage unavailable'); });

  const response = await agent.post('/api/v1/instructor/courses').send({
    title: 'Audit resilient course create',
    description: 'Course persistence must not depend on the audit store.',
    category: 'Programming'
  });

  assert.equal(response.status, 200);
  assert.ok(await Course.exists({ _id: response.body.course._id }));
  assert.equal(AuditLog.create.mock.callCount(), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_CREATED' }), 0);
});

test('a PUBLISHED course title update emits only COURSE_UPDATED', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, { status: 'PUBLISHED' });

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({
    title: 'Explicit published course update'
  });

  assert.equal(response.status, 200);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': course._id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': course._id }), 0);
});

test('a failed course save writes no update or publication audit event', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, { status: 'PUBLISHED' });
  t.mock.method(Course.prototype, 'save', async () => { throw new Error('course save unavailable'); });

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({
    title: 'Failed persisted update'
  });

  assert.equal(response.status, 500);
  assert.equal(await AuditLog.countDocuments({
    action: { $in: ['COURSE_UPDATED', 'COURSE_PUBLISHED'] },
    'target.id': course._id
  }), 0);
});

test('successful lecture mutations audit their original lecture identifiers and failures do not', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor);
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  cloudinary.v2.uploader.upload = async () => ({ public_id: 'audited-lecture', secure_url: 'https://video.example/audited' });
  cloudinary.v2.uploader.destroy = async () => {};

  try {
    const added = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Audited lecture')
      .field('description', 'A successful lecture creation needs an audit event.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(added.status, 200);
    const lectureId = added.body.lecture.id;
    assert.equal(Object.hasOwn(added.body.lecture, 'storage'), false);
    assert.equal(await AuditLog.countDocuments({ action: 'LECTURE_CREATED', 'target.type': 'LECTURE', 'target.id': lectureId }), 1);

    const deleted = await agent.delete(`/api/v1/instructor/courses/${course.id}/lectures/${lectureId}`);
    assert.equal(deleted.status, 200);
    assert.equal(await AuditLog.countDocuments({ action: 'LECTURE_DELETED', 'target.type': 'LECTURE', 'target.id': lectureId }), 1);

    const addedForCleanupFailure = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Cleanup failure lecture')
      .field('description', 'The saved mutation must still be audited if media cleanup fails.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(addedForCleanupFailure.status, 200);
    const cleanupFailureLectureId = addedForCleanupFailure.body.lecture.id;
    cloudinary.v2.uploader.destroy = async () => { throw new Error('media cleanup unavailable'); };
    const cleanupFailedDeletion = await agent.delete(`/api/v1/instructor/courses/${course.id}/lectures/${cleanupFailureLectureId}`);
    assert.equal(cleanupFailedDeletion.status, 500);
    assert.equal(await AuditLog.countDocuments({ action: 'LECTURE_DELETED', 'target.id': cleanupFailureLectureId }), 1);

    const failed = await agent.post(`/api/v1/instructor/courses/${course.id}/lectures`).send({
      title: 'Missing video', description: 'This rejected lecture must not be audited.'
    });
    assert.equal(failed.status, 400);
    assert.equal(await AuditLog.countDocuments({ action: 'LECTURE_CREATED' }), 2);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('lecture upload and save failures write no LECTURE_CREATED audit event', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor);
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;

  try {
    cloudinary.v2.uploader.upload = async () => { throw new Error('upload unavailable'); };
    const uploadFailure = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Upload failure lecture')
      .field('description', 'This upload failure must not create an audit event.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(uploadFailure.status, 500);
    assert.equal(await AuditLog.countDocuments({ action: 'LECTURE_CREATED', 'target.type': 'LECTURE' }), 0);

    cloudinary.v2.uploader.upload = async () => ({ public_id: 'save-failure-lecture', secure_url: 'https://video.example/save-failure' });
    cloudinary.v2.uploader.destroy = async () => {};
    t.mock.method(Course.prototype, 'save', async () => { throw new Error('course save unavailable'); });
    const saveFailure = await agent
      .post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Save failure lecture')
      .field('description', 'A post-upload save failure must not create an audit event.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(saveFailure.status, 500);
    assert.equal(await AuditLog.countDocuments({ action: 'LECTURE_CREATED', 'target.type': 'LECTURE' }), 0);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('course deletion audits once after deletion, including media cleanup failure, but never a stale delete', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, { thumbnail: { public_id: 'audit-delete', secure_url: 'https://image.example/audit-delete' } });
  const originalDestroy = cloudinary.v2.uploader.destroy;

  try {
    cloudinary.v2.uploader.destroy = async () => {};
    const deleted = await agent.delete(`/api/v1/instructor/courses/${course.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(await Course.exists({ _id: course._id }), null);
    assert.equal(await AuditLog.countDocuments({ action: 'COURSE_DELETED', 'target.type': 'COURSE', 'target.id': course._id }), 1);

    const cleanupFailure = await createCourse(instructor, { thumbnail: { public_id: 'audit-cleanup-failure', secure_url: 'https://image.example/audit-cleanup-failure' } });
    cloudinary.v2.uploader.destroy = async () => { throw new Error('media cleanup unavailable'); };
    const cleanupFailedResponse = await agent.delete(`/api/v1/instructor/courses/${cleanupFailure.id}`);
    assert.equal(cleanupFailedResponse.status, 500);
    assert.equal(await Course.exists({ _id: cleanupFailure._id }), null);
    assert.equal(await AuditLog.countDocuments({ action: 'COURSE_DELETED', 'target.id': cleanupFailure._id }), 1);

    const stale = await createCourse(instructor);
    const originalDeleteOne = Course.deleteOne;
    Course.deleteOne = async () => ({ deletedCount: 0 });
    try {
      const staleResponse = await agent.delete(`/api/v1/instructor/courses/${stale.id}`);
      assert.equal(staleResponse.status, 409);
      assert.equal(await AuditLog.countDocuments({ action: 'COURSE_DELETED', 'target.id': stale._id }), 0);
    } finally {
      Course.deleteOne = originalDeleteOne;
    }
    assert.equal(await AuditLog.countDocuments({ action: 'COURSE_DELETED', 'target.id': course._id }), 1);
  } finally {
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
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
        .attach('video', videoBytes(extension), `lesson.${extension}`);
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.body.error, {
        code: 'UPLOAD_FILE_TYPE_UNSUPPORTED',
        message: 'This file type is not supported. Choose one of the accepted file types.'
      });
    }
    assert.equal(uploaded.length, 0);

    for (const extension of ['mp4', 'webm', 'mov']) {
      const accepted = await agent
        .post(`/api/v1/instructor/courses/${course.id}/lectures`)
        .field('title', `Allowed ${extension}`)
        .field('description', 'This format must reach the lecture handler.')
        .attach('video', videoBytes(extension), `lesson.${extension}`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.lecture.title, `Allowed ${extension}`);
    }
    assert.equal(uploaded.length, 3);
    assert.equal((await Course.findById(course._id)).lectures.length, 3);

    const legacy = await agent
      .post(`/api/v1/courses/${course.id}`)
      .field('title', 'Legacy lecture field')
      .field('description', 'The legacy lecture field remains explicitly supported.')
      .attach('lecture', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
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
      .attach('thumbnail', pngBytes(), { filename: 'thumbnail.png', contentType: 'image/png' });
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
      .attach('thumbnail', pngBytes(), { filename: 'thumbnail.png', contentType: 'image/png' });
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
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(matchingVideoMime.status, 200);

    const matchingImageMime = await agent
      .post('/api/v1/instructor/courses')
      .field('title', 'Matching thumbnail MIME course')
      .field('description', 'Matching extension and MIME reach the handler.')
      .field('category', 'Programming')
      .attach('thumbnail', pngBytes(), { filename: 'thumbnail.png', contentType: 'image/png' });
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
    assert.equal(response.body.error.code, response.status === 400 ? 'COURSE_INVALID_REQUEST' : response.body.message === 'Lecture not found' ? 'COURSE_LECTURE_NOT_FOUND' : 'COURSE_NOT_FOUND');
    assert.equal(/CastError/.test(response.body.message), false);
  }
});

test('course access lookup failures use safe domain guidance without database internals', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor, { lectures: [lecture('Unavailable lookup lesson')] });
  const agent = await login(instructor);
  const originalFindById = Course.findById;
  Course.findById = async () => { throw new Error('database password=secret host=private'); };
  try {
    const response = await agent.get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body.error, { code: 'COURSE_UNAVAILABLE', message: 'We could not complete this course request. Please try again shortly.' });
    assert.equal(/password=|host=|private/.test(JSON.stringify(response.body)), false);
  } finally {
    Course.findById = originalFindById;
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
  assert.deepEqual(paidResponse.body.error, { code: 'COURSE_PURCHASE_REQUIRED', message: 'This course requires payment' });
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
  assert.equal(deniedLesson.body.error.code, 'COURSE_PURCHASE_REQUIRED');
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
    assert.equal(response.body.message, 'Your account does not have permission to do that.');
    assert.equal(response.body.error.code, 'AUTH_ROLE_FORBIDDEN');
  }

  const revoked = await (await login(revokedStudent)).post(`/api/v1/courses/${course.id}/enroll`);
  assert.deepEqual(revoked.body.error, { code: 'COURSE_ACCESS_REVOKED', message: 'Your access to this course has been revoked' });
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

test('revoked students cannot read an authenticated premium lecture or generate a delivery URL', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    accessType: 'PAID',
    price: 500,
    lectures: [lecture('Revoked protected lesson', {
      lecture: {
        public_id: 'revoked-authenticated-video',
        secure_url: 'https://video.example/revoked-authenticated-video.mp4',
        deliveryType: 'AUTHENTICATED'
      }
    })]
  });
  await Enrollment.create({ student: student._id, course: course._id, source: 'PURCHASE', status: 'REVOKED' });
  const urlMock = t.mock.method(cloudinary.v2, 'url', () => 'https://res.cloudinary.example/must-not-be-generated');
  const response = await (await login(student)).get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(response.status, 403);
  assert.deepEqual(response.body.error, { code: 'COURSE_ACCESS_REVOKED', message: 'Your access to this course has been revoked' });
  assert.equal(urlMock.mock.callCount(), 0);
});

test('Multer file size limits produce safe corrective guidance without technical details', () => {
  const error = new multer.MulterError('LIMIT_FILE_SIZE', 'private-field');
  error.message = 'Multer private upload path /secret/file';
  let status;
  let body;
  errorMiddleware(error, {}, { status(value) { status = value; return this; }, json(value) { body = value; } }, () => {});
  assert.equal(status, 400);
  assert.deepEqual(body, {
    success: false,
    message: 'This file is too large. Choose a smaller file and try again.',
    error: { code: 'UPLOAD_FILE_TOO_LARGE', message: 'This file is too large. Choose a smaller file and try again.' }
  });
});

test('lecture uploads require a file with corrective guidance', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor);
  const path = `/api/v1/instructor/courses/${course.id}/lectures`;
  const missing = await agent.post(path).send({ title: 'Missing video lesson', description: 'A video is required.' });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.error, { code: 'UPLOAD_FILE_REQUIRED', message: 'Choose a video file to upload.' });
});

test('lecture uploads select Cloudinary delivery from course access and preview status', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const paid = await createCourse(instructor, { accessType: 'PAID', price: 500 });
  const paidPreview = await createCourse(instructor, { accessType: 'PAID', price: 500 });
  const free = await createCourse(instructor);
  const uploadMock = t.mock.method(cloudinary.v2.uploader, 'upload', async () => ({
    public_id: unique('uploaded-video'),
    secure_url: 'https://video.example/uploaded.mp4'
  }));

  for (const [course, fields] of [
    [paid, {}],
    [paidPreview, { isPreview: 'true' }],
    [free, {}]
  ]) {
    const response = await agent.post(`/api/v1/instructor/courses/${course.id}/lectures`)
      .field('title', 'Delivery selection lesson')
      .field('description', 'The upload delivery must match course access.')
      .field(fields)
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(response.status, 200);
  }

  assert.deepEqual(uploadMock.mock.calls.map(({ arguments: [, options] }) => options.type), [
    'authenticated', 'upload', 'upload'
  ]);
  assert.equal((await Course.findById(paid.id)).lectures[0].lecture.deliveryType, 'AUTHENTICATED');
  assert.equal((await Course.findById(paidPreview.id)).lectures[0].lecture.deliveryType, 'PUBLIC');
  assert.equal((await Course.findById(free.id)).lectures[0].lecture.deliveryType, 'PUBLIC');
});

test('access changes rename only non-preview lecture assets in both directions', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    lectures: [
      lecture('Protected lesson', { lecture: { public_id: 'transition-private', secure_url: 'https://video.example/private', deliveryType: 'PUBLIC' } }),
      lecture('Public preview', { isPreview: true, lecture: { public_id: 'transition-preview', secure_url: 'https://video.example/preview', deliveryType: 'PUBLIC' } })
    ]
  });
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async () => ({}));

  const paid = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ accessType: 'PAID', price: 500 });
  assert.equal(paid.status, 200);
  assert.deepEqual(renameMock.mock.calls[0].arguments, ['transition-private', 'transition-private', {
    resource_type: 'video', type: 'upload', to_type: 'authenticated', overwrite: true, invalidate: true
  }]);
  let stored = await Course.findById(course.id);
  assert.equal(stored.lectures[0].lecture.deliveryType, 'AUTHENTICATED');
  assert.equal(stored.lectures[1].lecture.deliveryType, 'PUBLIC');

  const free = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ accessType: 'FREE', price: 0 });
  assert.equal(free.status, 200);
  assert.deepEqual(renameMock.mock.calls[1].arguments, ['transition-private', 'transition-private', {
    resource_type: 'video', type: 'authenticated', to_type: 'upload', overwrite: true, invalidate: true
  }]);
  assert.equal(renameMock.mock.callCount(), 2);
  stored = await Course.findById(course.id);
  assert.equal(stored.accessType, 'FREE');
  assert.equal(stored.lectures[0].lecture.deliveryType, 'PUBLIC');
  assert.equal(stored.lectures[1].lecture.deliveryType, 'PUBLIC');
});

test('invalid paid pricing is rejected before any video delivery rename', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    lectures: [lecture('No invalid conversion', {
      lecture: { public_id: 'invalid-price-video', secure_url: 'https://video.example/invalid', deliveryType: 'PUBLIC' }
    })]
  });
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async () => ({}));

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ accessType: 'PAID', price: 0 });
  assert.equal(response.status, 422);
  assert.equal(renameMock.mock.callCount(), 0);
  assert.equal((await Course.findById(course.id)).accessType, 'FREE');
});

test('invalid paid pricing rejects a multipart thumbnail update before every Cloudinary operation', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    lectures: [lecture('No invalid multipart conversion', {
      lecture: { public_id: 'invalid-multipart-video', secure_url: 'https://video.example/invalid-multipart', deliveryType: 'PUBLIC' }
    })]
  });
  const uploadMock = t.mock.method(cloudinary.v2.uploader, 'upload', async () => ({}));
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async () => ({}));

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`)
    .field('accessType', 'PAID')
    .field('price', '0')
    .attach('thumbnail', Buffer.from('image'), { filename: 'thumbnail.png', contentType: 'image/png' });

  assert.equal(response.status, 422);
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(renameMock.mock.callCount(), 0);
  assert.equal((await Course.findById(course.id)).accessType, 'FREE');
});

test('failed free-to-paid delivery conversion durably records protected assets and never promotes the course', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    lectures: [
      lecture('First conversion', { lecture: { public_id: 'rollback-first', secure_url: 'https://video.example/first', deliveryType: 'PUBLIC' } }),
      lecture('Second conversion', { lecture: { public_id: 'rollback-second', secure_url: 'https://video.example/second', deliveryType: 'PUBLIC' } })
    ]
  });
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async (publicId) => {
    if (publicId === 'rollback-second') throw new Error('provider unavailable');
    return {};
  });

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ accessType: 'PAID', price: 500 });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, {
    code: 'VIDEO_DELIVERY_UNAVAILABLE',
    message: 'Premium video playback is temporarily unavailable. Please try again shortly.'
  });
  assert.deepEqual(renameMock.mock.calls.map(({ arguments }) => arguments), [
    ['rollback-first', 'rollback-first', { resource_type: 'video', type: 'upload', to_type: 'authenticated', overwrite: true, invalidate: true }],
    ['rollback-second', 'rollback-second', { resource_type: 'video', type: 'upload', to_type: 'authenticated', overwrite: true, invalidate: true }]
  ]);
  const stored = await Course.findById(course.id);
  assert.equal(stored.accessType, 'FREE');
  assert.deepEqual(stored.lectures.map((item) => item.lecture.deliveryType), ['AUTHENTICATED', 'PUBLIC']);
});

test('free-to-paid retry resumes only incomplete delivery conversions', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    lectures: [
      lecture('Already converted', { lecture: { public_id: 'retry-authenticated', secure_url: 'https://video.example/one', deliveryType: 'AUTHENTICATED' } }),
      lecture('Still public', { lecture: { public_id: 'retry-public', secure_url: 'https://video.example/two', deliveryType: 'PUBLIC' } })
    ]
  });
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async () => ({}));

  const response = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ accessType: 'PAID', price: 500 });
  assert.equal(response.status, 200);
  assert.equal(renameMock.mock.callCount(), 1);
  assert.equal(renameMock.mock.calls[0].arguments[0], 'retry-public');
  const stored = await Course.findById(course.id);
  assert.equal(stored.accessType, 'PAID');
  assert.deepEqual(stored.lectures.map((item) => item.lecture.deliveryType), ['AUTHENTICATED', 'AUTHENTICATED']);
});

test('free conversion failure leaves the course free with authenticated media and resumes on retry', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    accessType: 'PAID', price: 500,
    lectures: [
      lecture('First release', { lecture: { public_id: 'release-first', secure_url: 'https://video.example/first', deliveryType: 'AUTHENTICATED' } }),
      lecture('Second release', { lecture: { public_id: 'release-second', secure_url: 'https://video.example/second', deliveryType: 'AUTHENTICATED' } })
    ]
  });
  let failSecond = true;
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async (publicId) => {
    if (publicId === 'release-second' && failSecond) throw new Error('provider unavailable');
    return {};
  });

  const failed = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ accessType: 'FREE', price: 0 });
  assert.equal(failed.status, 500);
  let stored = await Course.findById(course.id);
  assert.equal(stored.accessType, 'FREE');
  assert.deepEqual(stored.lectures.map((item) => item.lecture.deliveryType), ['PUBLIC', 'AUTHENTICATED']);
  failSecond = false;
  const retried = await agent.patch(`/api/v1/instructor/courses/${course.id}`).send({ price: 0 });
  assert.equal(retried.status, 200);
  assert.equal(renameMock.mock.callCount(), 3);
  assert.equal(renameMock.mock.calls[2].arguments[0], 'release-second');
  stored = await Course.findById(course.id);
  assert.deepEqual(stored.lectures.map((item) => item.lecture.deliveryType), ['PUBLIC', 'PUBLIC']);
});

test('paid preview replacement authenticates the prior preview before it is demoted', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    accessType: 'PAID', price: 500,
    lectures: [lecture('Old public preview', {
      isPreview: true,
      lecture: { public_id: 'old-paid-preview', secure_url: 'https://video.example/old-preview', deliveryType: 'PUBLIC' }
    })]
  });
  const order = [];
  t.mock.method(cloudinary.v2.uploader, 'upload', async () => ({ public_id: 'new-paid-preview', secure_url: 'https://video.example/new-preview' }));
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async (...args) => {
    order.push(args);
    return {};
  });

  const response = await agent.post(`/api/v1/instructor/courses/${course.id}/lectures`)
    .field('title', 'New paid preview').field('description', 'A new preview replaces the old preview safely.')
    .field('isPreview', 'true')
    .attach('video', videoBytes(), { filename: 'preview.mp4', contentType: 'video/mp4' });
  assert.equal(response.status, 200);
  assert.equal(renameMock.mock.callCount(), 1);
  assert.equal(order[0][0], 'old-paid-preview');
  const stored = await Course.findById(course.id);
  assert.equal(stored.lectures[0].isPreview, false);
  assert.equal(stored.lectures[0].lecture.deliveryType, 'AUTHENTICATED');
  assert.equal(stored.lectures[1].isPreview, true);
  assert.equal(stored.lectures[1].lecture.deliveryType, 'PUBLIC');
});

test('failed paid preview replacement keeps the old preview authenticated without a reverse public rename', async (t) => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor, {
    accessType: 'PAID', price: 500,
    lectures: [lecture('Old preview after failed replacement', {
      isPreview: true,
      lecture: { public_id: 'failed-old-paid-preview', secure_url: 'https://video.example/old-preview-secret', deliveryType: 'PUBLIC' }
    })]
  });
  t.mock.method(cloudinary.v2.uploader, 'upload', async () => ({ public_id: 'failed-new-paid-preview', secure_url: 'https://video.example/new-preview-secret' }));
  const renameMock = t.mock.method(cloudinary.v2.uploader, 'rename', async () => ({}));
  const destroyMock = t.mock.method(cloudinary.v2.uploader, 'destroy', async () => ({}));
  const originalSave = Course.prototype.save;
  t.mock.method(Course.prototype, 'save', async function failOnlyFinalPreviewSave(...args) {
    if (this.lectures.length === 2) throw new Error('final preview save unavailable');
    return originalSave.apply(this, args);
  });

  const response = await agent.post(`/api/v1/instructor/courses/${course.id}/lectures`)
    .field('title', 'Replacement preview that cannot be persisted')
    .field('description', 'The old preview must remain fail-closed after a save error.')
    .field('isPreview', 'true')
    .attach('video', videoBytes(), { filename: 'preview.mp4', contentType: 'video/mp4' });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body.error, {
    code: 'VIDEO_DELIVERY_UNAVAILABLE',
    message: 'Premium video playback is temporarily unavailable. Please try again shortly.'
  });
  assert.equal(renameMock.mock.callCount(), 1);
  assert.equal(renameMock.mock.calls[0].arguments[2].to_type, 'authenticated');
  assert.equal(renameMock.mock.calls.some(({ arguments }) => arguments[2].to_type === 'upload'), false);
  assert.equal(destroyMock.mock.callCount(), 1);
  const stored = await Course.findById(course.id);
  assert.equal(stored.lectures.length, 1);
  assert.equal(stored.lectures[0].isPreview, true);
  assert.equal(stored.lectures[0].lecture.deliveryType, 'AUTHENTICATED');
  assert.equal(JSON.stringify(response.body).includes('old-preview-secret'), false);
  assert.equal(JSON.stringify(response.body).includes('new-preview-secret'), false);
});

test('lecture uploads redact Cloudinary errors while cleaning local files', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const agent = await login(instructor);
  const course = await createCourse(instructor);
  const path = `/api/v1/instructor/courses/${course.id}/lectures`;
  const originalUpload = cloudinary.v2.uploader.upload;
  let uploadedPath;
  cloudinary.v2.uploader.upload = async filePath => {
    uploadedPath = filePath;
    throw new Error('Cloudinary api_secret=private-key /internal/upload/path');
  };
  try {
    const response = await agent.post(path)
      .field('title', 'Unavailable video upload').field('description', 'Provider failures must be safe.')
      .attach('video', videoBytes(), { filename: 'lesson.mp4', contentType: 'video/mp4' });
    assert.equal(response.status, 500);
    assert.deepEqual(response.body.error, { code: 'UPLOAD_UNAVAILABLE', message: 'We could not upload this file. Please try again shortly.' });
    assert.equal(/Cloudinary|api_secret|private-key|internal\/upload/.test(JSON.stringify(response.body)), false);
    await assert.rejects(() => fs.access(uploadedPath));
    assert.equal((await Course.findById(course.id)).lectures.length, 0);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
  }
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
