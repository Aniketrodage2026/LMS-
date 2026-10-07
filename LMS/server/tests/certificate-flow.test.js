const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

const Certificate = require('../models/certificate.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const User = require('../models/user.schema');
const { claimCertificate } = require('../services/certificate.service');
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

process.env.FRONTEND_URL ??= 'http://lms-frontend.test';
const app = createTestApp();

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUser(role = 'STUDENT', fullName = 'Certificate Student') {
  const id = unique('certificate');
  return User.create({
    fullName,
    email: `${id}@example.com`,
    password: 'password123',
    role
  });
}

async function login(user) {
  const agent = request.agent(app);
  const response = await agent.post('/api/v1/auth/login').send({
    email: user.email,
    password: 'password123'
  });
  assert.equal(response.status, 200);
  return agent;
}

function lecture(title) {
  return {
    title,
    description: `${title} description`,
    lecture: {
      public_id: unique('certificate-video'),
      secure_url: 'https://video.example/certificate.mp4'
    }
  };
}

async function createCourse(instructor, overrides = {}) {
  return Course.create({
    title: unique('Certificate course').slice(0, 45),
    description: 'A course used to exercise certificate routes.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: unique('certificate-thumbnail'),
      secure_url: 'https://image.example/certificate.png'
    },
    lectures: [lecture('One'), lecture('Two'), lecture('Three'), lecture('Four'), lecture('Five')],
    ...overrides
  });
}

async function enroll(student, course, status = 'ACTIVE') {
  return Enrollment.create({
    student: student._id,
    course: course._id,
    source: 'FREE_ENROLLMENT',
    status
  });
}

async function completeFourLectures(student, course) {
  await LectureProgress.insertMany(course.lectures.slice(0, 4).map((item) => ({
    student: student._id,
    course: course._id,
    lectureId: item._id,
    completed: true
  })));
}

test.before(async () => {
  process.env.JWT_SECRET = 'certificate-flow-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
  await Promise.all([Certificate.init(), Enrollment.init()]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('certificate routes require an authenticated active student enrollment and validate course ids', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const coursePath = `/api/v1/courses/${course._id}/certificate/eligibility`;

  assert.equal((await request(app).get(coursePath)).status, 401);
  assert.equal((await (await login(instructor)).get(coursePath)).status, 403);
  assert.equal((await (await login(student)).get(coursePath)).status, 403);
  assert.equal((await (await login(student)).get('/api/v1/courses/not-an-id/certificate/eligibility')).status, 400);
});

test('a revoked enrollment cannot check eligibility or claim a certificate', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  await enroll(student, course, 'REVOKED');
  const agent = await login(student);
  const basePath = `/api/v1/courses/${course._id}/certificate`;

  assert.equal((await agent.get(`${basePath}/eligibility`)).status, 403);
  assert.equal((await agent.post(`${basePath}/claim`)).status, 403);
  assert.equal(await Certificate.countDocuments({ student: student._id, course: course._id }), 0);
});

test('claim service rejects a revocation interleaved after the controller enrollment check', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  await enroll(student, course);
  await completeFourLectures(student, course);

  const controllerCheck = await Enrollment.exists({
    student: student._id,
    course: course._id,
    status: 'ACTIVE'
  });
  assert.ok(controllerCheck);
  await Enrollment.updateOne(
    { _id: controllerCheck },
    { $set: { status: 'REVOKED' } }
  );

  await assert.rejects(
    claimCertificate(student._id, course._id),
    (error) => error.statusCode === 403 && error.message === 'An active enrollment is required to claim a certificate'
  );
  assert.equal(await Certificate.countDocuments({ student: student._id, course: course._id }), 0);
});

test('an eligible active student claims once, sees only their own safe certificate list, and repeat claims are idempotent', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT', 'Eligible Certificate Student');
  const otherStudent = await createUser();
  const course = await createCourse(instructor);
  await enroll(student, course);
  await completeFourLectures(student, course);
  const agent = await login(student);
  const claimPath = `/api/v1/courses/${course._id}/certificate/claim`;

  const eligibility = await agent.get(`/api/v1/courses/${course._id}/certificate/eligibility`).expect(200);
  assert.equal(eligibility.body.eligibility.eligible, true);
  assert.equal(eligibility.body.eligibility.lecturePercent, 80);

  const first = await agent.post(claimPath).expect(201);
  const repeat = await agent.post(claimPath).expect(200);
  assert.equal(first.body.certificate.certificateNumber, repeat.body.certificate.certificateNumber);
  assert.deepEqual(Object.keys(first.body.certificate).sort(), ['certificateNumber', 'courseTitle', 'issuedAt']);

  const otherCourse = await createCourse(instructor);
  await Certificate.create({
    student: otherStudent._id,
    course: otherCourse._id,
    certificateNumber: `LMS-2026-${'A'.repeat(20)}`,
    verificationToken: 'a'.repeat(64),
    eligibilitySnapshot: { ruleVersion: 1 }
  });
  const listed = await agent.get('/api/v1/me/certificates').expect(200);
  assert.equal(listed.body.certificates.length, 1);
  assert.deepEqual(Object.keys(listed.body.certificates[0]).sort(), ['certificateNumber', 'courseTitle', 'issuedAt']);
  assert.equal(Object.hasOwn(listed.body.certificates[0], 'verificationToken'), false);
  assert.equal(Object.hasOwn(listed.body.certificates[0], 'student'), false);
});

test('concurrent eligible claims converge on one certificate', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  await enroll(student, course);
  await completeFourLectures(student, course);
  const agent = await login(student);
  const claimPath = `/api/v1/courses/${course._id}/certificate/claim`;

  const responses = await Promise.all(Array.from({ length: 4 }, () => agent.post(claimPath)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 201]);
  assert.equal(new Set(responses.map((response) => response.body.certificate.certificateNumber)).size, 1);
  assert.equal(await Certificate.countDocuments({ student: student._id, course: course._id }), 1);
});

test('ineligible claims return a safe checklist and public verification reveals exact safe facts only', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT', 'Public Certificate Student');
  const course = await createCourse(instructor);
  await enroll(student, course);
  await LectureProgress.insertMany(course.lectures.slice(0, 3).map((item) => ({
    student: student._id,
    course: course._id,
    lectureId: item._id,
    completed: true
  })));
  const agent = await login(student);
  const claim = await agent.post(`/api/v1/courses/${course._id}/certificate/claim`).expect(409);
  assert.equal(claim.body.success, false);
  assert.equal(claim.body.eligibility.eligible, false);
  assert.equal(Object.hasOwn(claim.body, 'snapshot'), false);
  assert.equal(Object.hasOwn(claim.body, 'verificationToken'), false);

  await LectureProgress.create({
    student: student._id,
    course: course._id,
    lectureId: course.lectures[3]._id,
    completed: true
  });
  const created = await agent.post(`/api/v1/courses/${course._id}/certificate/claim`).expect(201);
  const certificate = await Certificate.findOne({ certificateNumber: created.body.certificate.certificateNumber })
    .select('+verificationToken')
    .lean();
  const publicResponse = await request(app).get(`/api/v1/certificates/verify/${certificate.verificationToken}`).expect(200);
  assert.deepEqual(Object.keys(publicResponse.body.certificate).sort(), [
    'certificateNumber', 'courseTitle', 'issuedAt', 'learnerName', 'valid'
  ]);
  assert.equal(publicResponse.body.certificate.learnerName, student.fullName);
  assert.equal(publicResponse.body.certificate.courseTitle, course.title);
  assert.equal(publicResponse.body.certificate.valid, true);
  assert.equal((await request(app).get('/api/v1/certificates/verify/not-a-token')).status, 404);
  assert.equal((await request(app).get(`/api/v1/certificates/verify/${'f'.repeat(64)}`)).status, 404);
});
