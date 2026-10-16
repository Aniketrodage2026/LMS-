const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

const { createApp } = require('../app');
const Assignment = require('../models/assignment.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Submission = require('../models/submission.schema');
const SubmissionState = require('../models/submission-state.schema');
const User = require('../models/user.schema');
const { studentSubmissionSummary, instructorSubmissionSummary } = require('../services/assignment.service');
const { setMediaStorageFactoryForTests } = require('../controller/student-assignment.controller');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

const app = createApp({ security: { enabled: false } });

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUser(role) {
  return User.create({
    fullName: `${role} assignment file user`,
    email: `${unique('assignment-file')}@example.com`,
    password: 'password123',
    role
  });
}

async function login(user) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'password123' }).expect(200);
  return agent;
}

async function createFixture() {
  const instructor = await createUser('INSTRUCTOR');
  const owner = await createUser('STUDENT');
  const otherStudent = await createUser('STUDENT');
  const admin = await createUser('ADMIN');
  const course = await Course.create({
    title: unique('Assignment download course').slice(0, 45),
    description: 'A course for assignment file authorization tests.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: { public_id: unique('thumbnail'), secure_url: 'https://image.example/thumbnail.png' }
  });
  const assignment = await Assignment.create({
    course: course._id,
    title: 'Downloadable assignment',
    instructions: 'Attach your completed work.',
    maxMarks: 20,
    status: 'PUBLISHED'
  });
  await Enrollment.create({ student: owner._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });
  await Enrollment.create({ student: otherStudent._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });
  const submission = await Submission.create({
    assignment: assignment._id,
    course: course._id,
    student: owner._id,
    version: 1,
    writtenAnswer: '',
    file: {
      public_id: 'legacy-assignment-file',
      secure_url: 'https://res.cloudinary.com/example/raw/upload/legacy-assignment-file.pdf',
      originalName: 'portfolio.pdf',
      mimetype: 'application/pdf',
      size: 123
    },
    late: false
  });
  await SubmissionState.create({
    assignment: assignment._id,
    course: course._id,
    student: owner._id,
    latestVersion: 1,
    latestSubmission: submission._id,
    status: 'SUBMITTED'
  });
  return { instructor, owner, otherStudent, admin, course, assignment, submission };
}

function filePath({ course, assignment, submission }) {
  return `/api/v1/courses/${course.id}/assignments/${assignment.id}/submissions/${submission.id}/file`;
}

test.before(async () => {
  process.env.JWT_SECRET = 'assignment-file-access-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
  await Promise.all([Assignment.init(), Submission.init(), SubmissionState.init()]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('submission summaries redact provider identifiers and give only a download endpoint', () => {
  const ids = { course: new mongoose.Types.ObjectId(), assignment: new mongoose.Types.ObjectId(), submission: new mongoose.Types.ObjectId(), student: new mongoose.Types.ObjectId() };
  const submission = {
    _id: ids.submission,
    course: ids.course,
    assignment: ids.assignment,
    student: ids.student,
    version: 1,
    writtenAnswer: '',
    projectUrl: '',
    late: false,
    status: 'SUBMITTED',
    file: {
      storage: { provider: 'R2', key: 'assignments/secret-key.pdf', contentType: 'application/pdf', size: 123 },
      public_id: 'cloudinary-secret',
      secure_url: 'https://provider.example/permanent-secret.pdf',
      originalName: 'portfolio.pdf', mimetype: 'application/pdf', size: 123
    }
  };
  const serialized = JSON.stringify({ student: studentSubmissionSummary(submission), instructor: instructorSubmissionSummary(submission) });
  assert.equal(serialized.includes('secret-key'), false);
  assert.equal(serialized.includes('cloudinary-secret'), false);
  assert.equal(serialized.includes('permanent-secret'), false);
  assert.match(serialized, /\/courses\//);
});

test('only owner, course manager, or admin can obtain a legacy assignment download', async () => {
  const fixture = await createFixture();
  const signedUrl = fixture.submission.file.secure_url;

  const path = filePath(fixture);
  const ownerResponse = await (await login(fixture.owner)).get(path).redirects(0);
  assert.equal(ownerResponse.status, 302);
  assert.equal(ownerResponse.headers.location, signedUrl);
  assert.equal(ownerResponse.text, '');

  const denied = await (await login(fixture.otherStudent)).get(path).redirects(0);
  assert.equal(denied.status, 403);

  const instructorResponse = await (await login(fixture.instructor)).get(path).redirects(0);
  assert.equal(instructorResponse.status, 302);
  const adminResponse = await (await login(fixture.admin)).get(path).redirects(0);
  assert.equal(adminResponse.status, 302);
});

test('download lookup refuses course and assignment association mismatches before signing', async () => {
  const fixture = await createFixture();
  const otherInstructor = await createUser('INSTRUCTOR');
  const otherCourse = await Course.create({
    title: unique('Other assignment course').slice(0, 45), description: 'Association mismatch test course.', category: 'Programming',
    instructor: otherInstructor._id,
    thumbnail: { public_id: unique('thumbnail'), secure_url: 'https://image.example/thumbnail.png' }
  });
  const path = `/api/v1/courses/${otherCourse.id}/assignments/${fixture.assignment.id}/submissions/${fixture.submission.id}/file`;
  const response = await (await login(fixture.admin)).get(path).redirects(0);
  assert.equal(response.status, 404);
});

test('R2 file download signs only after owner or manager authorization', async (t) => {
  const fixture = await createFixture();
  await Submission.updateOne({ _id: fixture.submission._id }, {
    $set: {
      'file.storage': { provider: 'R2', key: 'assignments/private-work.pdf', contentType: 'application/pdf', size: 123 },
      'file.secure_url': undefined,
      'file.public_id': undefined
    }
  });
  const signed = [];
  const restoreFactory = setMediaStorageFactoryForTests({ provider: 'R2', get: () => ({
    signedReadUrl: async (media) => { signed.push(media.storage.key); return 'https://r2.example/signed-assignment'; }
  }) });
  t.after(() => {
    restoreFactory();
  });

  const path = filePath(fixture);
  const denied = await (await login(fixture.otherStudent)).get(path).redirects(0);
  assert.equal(denied.status, 403);
  assert.deepEqual(signed, []);

  const owner = await (await login(fixture.owner)).get(path).redirects(0);
  assert.equal(owner.status, 302);
  assert.equal(owner.headers.location, 'https://r2.example/signed-assignment');
  const instructor = await (await login(fixture.instructor)).get(path).redirects(0);
  const admin = await (await login(fixture.admin)).get(path).redirects(0);
  assert.equal(instructor.status, 302);
  assert.equal(admin.status, 302);
  assert.deepEqual(signed, ['assignments/private-work.pdf', 'assignments/private-work.pdf', 'assignments/private-work.pdf']);
});
