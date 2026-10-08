const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const User = require('../models/user.schema');
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

process.env.FRONTEND_URL ??= 'http://lms-frontend.test';
const app = createTestApp();

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUser(role = 'STUDENT') {
  const id = unique('learning-progress');
  return User.create({
    fullName: 'Learning Progress Student',
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
    title: unique('Learning progress course').slice(0, 45),
    description: 'A course used to exercise student learning progress routes.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: unique('thumbnail'),
      secure_url: 'https://image.example/thumbnail.jpg'
    },
    ...overrides
  });
}

async function activateEnrollment(student, course, overrides = {}) {
  await Enrollment.create({
    student: student._id,
    course: course._id,
    source: 'PURCHASE',
    status: 'ACTIVE',
    ...overrides
  });
}

test.before(async () => {
  process.env.JWT_SECRET = 'learning-progress-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
});

test('learning progress rejects unauthenticated, non-student, and unenrolled requests', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, { lectures: [lecture('Protected lesson', { durationSeconds: 100 })] });
  const progressPath = `/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}/progress`;

  const unauthenticated = await request(app).patch(progressPath).send({ watchedSeconds: 10, durationSeconds: 100 });
  assert.equal(unauthenticated.status, 401);

  const instructorResponse = await (await login(instructor)).patch(progressPath).send({ watchedSeconds: 10, durationSeconds: 100 });
  assert.equal(instructorResponse.status, 403);

  const unenrolled = await (await login(student)).patch(progressPath).send({ watchedSeconds: 10, durationSeconds: 100 });
  assert.equal(unenrolled.status, 403);
  assert.equal(unenrolled.body.message, 'Purchase or enrol in this course to access this lesson');

  const missingLecture = await (await login(student))
    .patch(`/api/v1/courses/${course.id}/lectures/${new mongoose.Types.ObjectId()}/progress`)
    .send({ watchedSeconds: 10, durationSeconds: 100 });
  assert.equal(missingLecture.status, 404);
  assert.equal(missingLecture.body.message, 'Lecture not found');
});

test('learning progress validates ids, primitive time values, and authoritative duration', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, { lectures: [lecture('Validated lesson', { durationSeconds: 100 })] });
  await activateEnrollment(student, course);
  const agent = await login(student);
  const progressPath = `/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}/progress`;

  for (const response of [
    await agent.patch(`/api/v1/courses/not-an-id/lectures/${course.lectures[0]._id}/progress`).send({ watchedSeconds: 1, durationSeconds: 100 }),
    await agent.patch(`/api/v1/courses/${course.id}/lectures/not-an-id/progress`).send({ watchedSeconds: 1, durationSeconds: 100 }),
    await agent.patch(progressPath).send({ watchedSeconds: '1', durationSeconds: 100 }),
    await agent.patch(progressPath).send({ watchedSeconds: 1, durationSeconds: 0 }),
    await agent.patch(progressPath).send({ watchedSeconds: 1, durationSeconds: 99 }),
    await agent.patch(progressPath).send({ watchedSeconds: 101, durationSeconds: 100 })
  ]) {
    assert.equal(response.status, 400);
  }
});

test('learning progress rejects a lecture id that belongs to a different enrolled course without creating state', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const courseA = await createCourse(instructor, { lectures: [lecture('Course A lesson', { durationSeconds: 100 })] });
  const courseB = await createCourse(instructor, { lectures: [lecture('Course B lesson', { durationSeconds: 100 })] });
  await activateEnrollment(student, courseA);
  const agent = await login(student);
  const foreignLecturePath = `/api/v1/courses/${courseA.id}/lectures/${courseB.lectures[0]._id}`;

  const progress = await agent.patch(`${foreignLecturePath}/progress`).send({ watchedSeconds: 10, durationSeconds: 100 });
  assert.equal(progress.status, 404);
  assert.equal(progress.body.message, 'Lecture not found');

  const completion = await agent.post(`${foreignLecturePath}/complete`);
  assert.equal(completion.status, 404);
  assert.equal(completion.body.message, 'Lecture not found');
  assert.equal(await LectureProgress.countDocuments({ student: student._id }), 0);
});

test('learning progress denies unenrolled summaries and completion without creating state', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, { lectures: [lecture('Unenrolled lesson', { durationSeconds: 100 })] });
  const agent = await login(student);
  const denial = 'Purchase or enrol in this course to access this lesson';

  const summary = await agent.get(`/api/v1/courses/${course.id}/progress`);
  assert.equal(summary.status, 403);
  assert.equal(summary.body.message, denial);

  const completion = await agent.post(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}/complete`);
  assert.equal(completion.status, 403);
  assert.equal(completion.body.message, denial);
  assert.equal(await LectureProgress.countDocuments({ student: student._id }), 0);
});

test('learning progress writes safely, never lowers progress, and auto-completes at ninety percent', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, { lectures: [lecture('Monotonic lesson', { durationSeconds: 100 })] });
  await activateEnrollment(student, course);
  const agent = await login(student);
  const progressPath = `/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}/progress`;

  const first = await agent.patch(progressPath).send({ watchedSeconds: 95, durationSeconds: 100 });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.progress, {
    id: first.body.progress.id,
    courseId: course.id,
    lectureId: String(course.lectures[0]._id),
    watchedSeconds: 95,
    watchedPercent: 95,
    durationSeconds: 100,
    completed: true,
    completedAt: first.body.progress.completedAt,
    lastWatchedAt: first.body.progress.lastWatchedAt
  });
  assert.equal(typeof first.body.progress.id, 'string');
  assert.equal(typeof first.body.progress.completedAt, 'string');
  assert.equal(Object.hasOwn(first.body.progress, 'lecture'), false);
  assert.equal(Object.hasOwn(first.body.progress, 'student'), false);

  const second = await agent.patch(progressPath).send({ watchedSeconds: 40, durationSeconds: 100 });
  assert.equal(second.status, 200);
  assert.equal(second.body.progress.watchedSeconds, 95);
  assert.equal(second.body.progress.watchedPercent, 95);
  assert.equal(second.body.progress.completed, true);
  assert.equal(second.body.progress.completedAt, first.body.progress.completedAt);
});

test('learning progress manually completes lectures without a video duration and returns current-course summary totals', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    lectures: [
      lecture('Completed lesson', { durationSeconds: 100 }),
      lecture('Duration-free lesson', { durationSeconds: 0 })
    ]
  });
  await activateEnrollment(student, course);
  const agent = await login(student);
  const firstBasePath = `/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`;
  const secondBasePath = `/api/v1/courses/${course.id}/lectures/${course.lectures[1]._id}`;

  const completed = await agent.post(`${firstBasePath}/complete`);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.progress.watchedSeconds, 100);
  assert.equal(completed.body.progress.watchedPercent, 100);
  assert.equal(completed.body.progress.durationSeconds, 100);
  assert.equal(completed.body.progress.completed, true);

  const initialSummary = await agent.get(`/api/v1/courses/${course.id}/progress`);
  assert.equal(initialSummary.status, 200);
  assert.equal(initialSummary.body.progress.totalLectures, 2);
  assert.equal(initialSummary.body.progress.completedLectures, 1);
  assert.equal(initialSummary.body.progress.completionPercent, 50);
  assert.deepEqual(initialSummary.body.progress.lectures[1], {
    id: String(course.lectures[1]._id),
    title: 'Duration-free lesson',
    watchedSeconds: 0,
    watchedPercent: 0,
    durationSeconds: 0,
    completed: false,
    completedAt: null,
    lastWatchedAt: null
  });
  assert.equal(Object.hasOwn(initialSummary.body.progress.lectures[0], 'lecture'), false);

  const manuallyCompleted = await agent.post(`${secondBasePath}/complete`);
  assert.equal(manuallyCompleted.status, 200);
  assert.equal(manuallyCompleted.body.progress.durationSeconds, 0);
  assert.equal(manuallyCompleted.body.progress.watchedSeconds, 0);
  assert.equal(manuallyCompleted.body.progress.watchedPercent, 100);
  assert.equal(manuallyCompleted.body.progress.completed, true);

  await Course.updateOne(
    { _id: course._id, 'lectures._id': course.lectures[1]._id },
    { $set: { 'lectures.$.durationSeconds': 120 } }
  );
  const authoritativeRetry = await agent.post(`${secondBasePath}/complete`);
  assert.equal(authoritativeRetry.status, 200);
  assert.equal(authoritativeRetry.body.progress.durationSeconds, 120);
  assert.equal(authoritativeRetry.body.progress.watchedSeconds, 120);
  assert.equal(authoritativeRetry.body.progress.watchedPercent, 100);
  assert.equal(authoritativeRetry.body.progress.completed, true);
  assert.equal(authoritativeRetry.body.progress.completedAt, manuallyCompleted.body.progress.completedAt);

  const delayedDuration = await agent.patch(`${secondBasePath}/progress`).send({ watchedSeconds: 60, durationSeconds: 120 });
  assert.equal(delayedDuration.status, 200);
  assert.equal(delayedDuration.body.progress.durationSeconds, 120);
  assert.equal(delayedDuration.body.progress.watchedSeconds, 120);
  assert.equal(delayedDuration.body.progress.watchedPercent, 100);
  assert.equal(delayedDuration.body.progress.completed, true);
});

test('learning progress summary handles enrolled courses with no current lectures', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  await activateEnrollment(student, course);

  const response = await (await login(student)).get(`/api/v1/courses/${course.id}/progress`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    progress: {
      courseId: course.id,
      totalLectures: 0,
      completedLectures: 0,
      completionPercent: 0,
      lectures: []
    }
  });
});

test('My Learning rejects unauthenticated and non-student requests', async () => {
  const instructor = await createUser('INSTRUCTOR');

  const unauthenticated = await request(app).get('/api/v1/me/learning');
  assert.equal(unauthenticated.status, 401);

  const instructorResponse = await (await login(instructor)).get('/api/v1/me/learning');
  assert.equal(instructorResponse.status, 403);
});

test('My Learning omits active enrollments for unpublished courses', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const publishedCourse = await createCourse(instructor, { lectures: [lecture('Published lesson')] });
  const unpublishedCourse = await createCourse(instructor, {
    status: 'UNPUBLISHED',
    lectures: [lecture('Unpublished lesson')]
  });
  await activateEnrollment(student, publishedCourse);
  await activateEnrollment(student, unpublishedCourse);

  const response = await (await login(student)).get('/api/v1/me/learning');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.learning.map((item) => item.course.id), [publishedCourse.id]);
});

test('My Learning includes only the current student\'s active live courses and uses only current lectures for progress', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const otherStudent = await createUser();
  const course = await createCourse(instructor, {
    lectures: [lecture('Current completed lesson'), lecture('Current incomplete lesson')]
  });
  const revokedCourse = await createCourse(instructor, { lectures: [lecture('Revoked lesson')] });
  const otherStudentsCourse = await createCourse(instructor, { lectures: [lecture('Other student lesson')] });
  const deletedCourse = await createCourse(instructor, { lectures: [lecture('Deleted course lesson')] });
  await activateEnrollment(student, course);
  await activateEnrollment(student, revokedCourse, { status: 'REVOKED' });
  await activateEnrollment(otherStudent, otherStudentsCourse);
  await activateEnrollment(student, deletedCourse);

  const currentActivity = new Date('2026-01-02T03:04:05.000Z');
  const completedAt = new Date('2026-01-02T02:00:00.000Z');
  await LectureProgress.create({
    student: student._id,
    course: course._id,
    lectureId: course.lectures[0]._id,
    watchedSeconds: 75,
    watchedPercent: 75,
    durationSeconds: 100,
    completed: true,
    completedAt,
    lastWatchedAt: currentActivity
  });
  await LectureProgress.create({
    student: student._id,
    course: course._id,
    lectureId: new mongoose.Types.ObjectId(),
    completed: true,
    lastWatchedAt: new Date('2026-12-31T23:59:59.000Z')
  });
  await Course.deleteOne({ _id: deletedCourse._id });

  const response = await (await login(student)).get('/api/v1/me/learning');
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.learning.length, 1);

  const [item] = response.body.learning;
  assert.deepEqual(Object.keys(item.course).sort(), ['accessType', 'category', 'id', 'price', 'thumbnail', 'title']);
  assert.equal(Object.hasOwn(item.course, 'lectures'), false);
  assert.equal(Object.hasOwn(item.course, 'instructor'), false);
  assert.equal(Object.hasOwn(item.course.thumbnail, 'public_id'), false);
  assert.equal(Object.hasOwn(item, 'enrollment'), false);
  assert.equal(Object.hasOwn(item, 'payment'), false);
  assert.deepEqual(Object.keys(item.lastWatchedLecture).sort(), [
    'completed',
    'completedAt',
    'durationSeconds',
    'id',
    'lastWatchedAt',
    'title',
    'watchedPercent',
    'watchedSeconds'
  ]);
  assert.deepEqual(item.course, {
    id: course.id,
    title: course.title,
    category: course.category,
    thumbnail: {
      secure_url: course.thumbnail.secure_url
    },
    accessType: course.accessType,
    price: course.price
  });
  assert.deepEqual(item, {
    course: item.course,
    totalLectures: 2,
    completedLectures: 1,
    completionPercent: 50,
    lastWatchedAt: currentActivity.toISOString(),
    lastWatchedLecture: {
      id: String(course.lectures[0]._id),
      title: 'Current completed lesson',
      watchedSeconds: 75,
      watchedPercent: 75,
      durationSeconds: 100,
      completed: true,
      completedAt: completedAt.toISOString(),
      lastWatchedAt: currentActivity.toISOString()
    }
  });
});

test('My Learning gives empty courses zero progress and orders current activity before null activity with enrollment tie breaks', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const newestActivity = await createCourse(instructor, { lectures: [lecture('Newest activity lesson')] });
  const laterEnrollment = await createCourse(instructor, { lectures: [lecture('Later enrollment lesson')] });
  const earlierEnrollment = await createCourse(instructor, { lectures: [lecture('Earlier enrollment lesson')] });
  const emptyCourse = await createCourse(instructor);
  await activateEnrollment(student, newestActivity, { enrolledAt: new Date('2026-01-01T00:00:00.000Z') });
  await activateEnrollment(student, laterEnrollment, { enrolledAt: new Date('2026-01-03T00:00:00.000Z') });
  await activateEnrollment(student, earlierEnrollment, { enrolledAt: new Date('2026-01-02T00:00:00.000Z') });
  await activateEnrollment(student, emptyCourse, { enrolledAt: new Date('2026-01-04T00:00:00.000Z') });

  await LectureProgress.create({
    student: student._id,
    course: newestActivity._id,
    lectureId: newestActivity.lectures[0]._id,
    lastWatchedAt: new Date('2026-02-02T00:00:00.000Z')
  });
  const tiedActivity = new Date('2026-02-01T00:00:00.000Z');
  await LectureProgress.create({
    student: student._id,
    course: laterEnrollment._id,
    lectureId: laterEnrollment.lectures[0]._id,
    lastWatchedAt: tiedActivity
  });
  await LectureProgress.create({
    student: student._id,
    course: earlierEnrollment._id,
    lectureId: earlierEnrollment.lectures[0]._id,
    lastWatchedAt: tiedActivity
  });

  const response = await (await login(student)).get('/api/v1/me/learning');
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.learning.map((item) => item.course.id),
    [newestActivity.id, laterEnrollment.id, earlierEnrollment.id, emptyCourse.id]
  );

  const empty = response.body.learning[3];
  assert.deepEqual(empty, {
    course: empty.course,
    totalLectures: 0,
    completedLectures: 0,
    completionPercent: 0,
    lastWatchedAt: null,
    lastWatchedLecture: null
  });
});
