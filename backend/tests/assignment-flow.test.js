const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const cloudinary = require('cloudinary');
const fs = require('node:fs/promises');

const { createApp } = require('../app');
const Assignment = require('../models/assignment.schema');
const AuditLog = require('../models/audit-log.schema');
const Submission = require('../models/submission.schema');
const SubmissionState = require('../models/submission-state.schema');
const Enrollment = require('../models/enrollment.schema');
const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const { createSubmissionVersion: createVersionThroughState } = require('../services/submission-lifecycle.service');
const { setMediaStorageFactoryForTests } = require('../controller/student-assignment.controller');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

const app = createApp({ security: { enabled: false } });

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUser(role) {
  const emailPrefix = unique('assignment-flow');
  return User.create({
    fullName: 'Assignment Flow User',
    email: `${emailPrefix}@example.com`,
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
    title: unique('Assignment authoring course').slice(0, 45),
    description: 'A course used to test protected instructor assignment authoring.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: unique('thumbnail'),
      secure_url: 'https://image.example/thumbnail.jpg'
    },
    ...overrides
  });
}

function assignmentPayload(overrides = {}) {
  return {
    course: new mongoose.Types.ObjectId().toString(),
    title: 'Portfolio assignment',
    instructions: 'Build a well-tested portfolio project.',
    dueDate: '2030-01-01T00:00:00.000Z',
    maxMarks: 50,
    status: 'PUBLISHED',
    submissionCount: 99,
    ...overrides
  };
}

function assignmentsPath(courseId, assignmentId) {
  const base = `/api/v1/instructor/courses/${courseId}/assignments`;
  return assignmentId ? `${base}/${assignmentId}` : base;
}

function submissionsPath(courseId, assignmentId, submissionId) {
  const base = `${assignmentsPath(courseId, assignmentId)}/submissions`;
  return submissionId ? `${base}/${submissionId}/review` : base;
}

function studentAssignmentsPath(courseId, assignmentId) {
  const base = `/api/v1/courses/${courseId}/assignments`;
  return assignmentId ? `${base}/${assignmentId}` : base;
}

function studentSubmissionsPath(courseId, assignmentId) {
  return `${studentAssignmentsPath(courseId, assignmentId)}/submissions`;
}

async function enroll(student, course, status = 'ACTIVE') {
  return Enrollment.create({
    student: student._id,
    course: course._id,
    source: 'FREE_ENROLLMENT',
    status
  });
}

async function createAssignment(course, overrides = {}) {
  return Assignment.create({
    ...assignmentPayload({ status: 'DRAFT', submissionCount: 0, ...overrides }),
    course: course._id
  });
}

async function createSubmissionVersion(assignment, student, overrides = {}) {
  await Assignment.updateOne({ _id: assignment._id }, { $inc: { submissionCount: 1 } });
  const submission = await Submission.create({
    assignment: assignment._id,
    course: assignment.course,
    student: student._id,
    version: 1,
    writtenAnswer: 'Completed work',
    late: false,
    ...overrides
  });
  await SubmissionState.findOneAndUpdate(
    { assignment: assignment._id, student: student._id },
    {
      $set: {
        course: assignment.course,
        latestVersion: submission.version,
        latestSubmission: submission._id,
        status: submission.status
      }
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
  return submission;
}

test.before(async () => {
  process.env.JWT_SECRET = 'assignment-flow-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
  await Promise.all([Assignment.init(), Submission.init(), SubmissionState.init()]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('instructor assignment creation requires a manager, pins its course, and forces DRAFT', async () => {
  const owner = await createUser('INSTRUCTOR');
  const intruder = await createUser('INSTRUCTOR');
  const admin = await createUser('ADMIN');
  const course = await createCourse(owner);
  const otherCourse = await createCourse(owner);
  const path = assignmentsPath(course._id);

  await (await login(intruder)).post(path).send(assignmentPayload()).expect(403);

  const created = await (await login(owner))
    .post(path)
    .send(assignmentPayload({ course: otherCourse._id.toString() }))
    .expect(201);
  assert.equal(created.body.assignment.status, 'DRAFT');
  assert.equal(created.body.assignment.courseId, course.id);
  assert.equal(created.body.assignment.submissionCount, 0);

  const stored = await Assignment.findById(created.body.assignment.id).lean();
  assert.equal(stored.course.toString(), course.id);
  assert.equal(stored.status, 'DRAFT');
  assert.equal(stored.submissionCount, 0);

  const adminCreated = await (await login(admin))
    .post(path)
    .send(assignmentPayload({ title: 'Admin assignment' }))
    .expect(201);
  assert.equal(adminCreated.body.assignment.courseId, course.id);
});

test('instructor assignment list, update, and delete stay course scoped while drafts are editable', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const otherCourse = await createCourse(owner);
  const assignment = await createAssignment(course);
  const agent = await login(owner);
  const path = assignmentsPath(course._id, assignment._id);

  const listed = await agent.get(assignmentsPath(course._id)).expect(200);
  assert.equal(listed.body.assignments.length, 1);
  assert.equal(listed.body.assignments[0].id, assignment.id);

  const updated = await agent.patch(path).send({
    title: 'Revised portfolio assignment',
    instructions: 'Build a revised project.',
    dueDate: null,
    maxMarks: 75
  }).expect(200);
  assert.equal(updated.body.assignment.title, 'Revised portfolio assignment');
  assert.equal(updated.body.assignment.maxMarks, 75);
  assert.equal(updated.body.assignment.status, 'DRAFT');

  await agent.patch(assignmentsPath(otherCourse._id, assignment._id)).send({ title: 'Nope' }).expect(404);
  await agent.patch(assignmentsPath(course._id, 'not-an-object-id')).send({ title: 'Nope' }).expect(400);
  await agent.delete(assignmentsPath(otherCourse._id, assignment._id)).expect(404);

  const deleted = await agent.delete(path).expect(200);
  assert.equal(deleted.body.success, true);
  assert.equal(await Assignment.exists({ _id: assignment._id }), null);
});

test('submission marker makes requirements and deletion immutable but permits exact status updates', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED' });
  await createSubmissionVersion(assignment, student);
  const agent = await login(owner);
  const path = assignmentsPath(course._id, assignment._id);

  for (const body of [
    { title: 'Changed after submission' },
    { instructions: 'Changed after submission' },
    { maxMarks: 100 },
    { dueDate: null },
    { course: new mongoose.Types.ObjectId().toString() },
    { status: 'DRAFT', title: 'Also invalid' },
    { status: 'INVALID' },
    {},
    { submissionCount: 0 }
  ]) {
    await agent.patch(path).send(body).expect(409);
  }

  const unpublished = await agent.patch(path).send({ status: 'DRAFT' }).expect(200);
  assert.equal(unpublished.body.assignment.status, 'DRAFT');
  const published = await agent.patch(path).send({ status: 'PUBLISHED' }).expect(200);
  assert.equal(published.body.assignment.status, 'PUBLISHED');
  await agent.delete(path).expect(409);
});

test('conditional assignment writes report conflicts if a submission marker appears during the mutation', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course);
  const agent = await login(owner);
  const path = assignmentsPath(course._id, assignment._id);
  const originalFindOneAndUpdate = Assignment.findOneAndUpdate;

  Assignment.findOneAndUpdate = async (...args) => {
    await Assignment.updateOne({ _id: assignment._id }, { $set: { submissionCount: 1 } });
    return originalFindOneAndUpdate.apply(Assignment, args);
  };
  try {
    await agent.patch(path).send({ title: 'Must not change' }).expect(409);
    assert.equal((await Assignment.findById(assignment._id)).title, assignment.title);
  } finally {
    Assignment.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('manager sees a safe submission queue and may grade only the latest version once', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED', maxMarks: 50 });
  const older = await createSubmissionVersion(assignment, student);
  const latest = await createSubmissionVersion(assignment, student, {
    version: 2,
    writtenAnswer: 'Improved completed work',
    late: false
  });
  const agent = await login(owner);

  const queue = await agent.get(submissionsPath(course._id, assignment._id)).expect(200);
  assert.equal(queue.body.submissions.length, 2);
  assert.equal(queue.body.submissions[0].student.fullName, student.fullName);
  assert.equal(queue.body.submissions[0].student.password, undefined);
  assert.equal(queue.body.submissions[0].student.role, undefined);
  assert.equal(queue.body.submissions[0].file?.publicId, undefined);

  const stale = await agent.patch(submissionsPath(course._id, assignment._id, older._id))
    .send({ action: 'GRADE', marks: 40, feedback: 'Good work' })
    .expect(400);
  assert.equal(stale.body.error.code, 'ASSESSMENT_REVIEW_CONFLICT');
  await agent.patch(submissionsPath(course._id, assignment._id, latest._id))
    .send({ action: 'GRADE', marks: 51, feedback: 'Good work' })
    .expect(400);
  await agent.patch(submissionsPath(course._id, assignment._id, latest._id))
    .send({ action: 'GRADE', marks: 50, feedback: 'Excellent work' })
    .expect(200);

  const graded = await Submission.findById(latest._id).lean();
  assert.equal(graded.status, 'GRADED');
  assert.equal(graded.marks, 50);
  assert.equal(graded.feedback, 'Excellent work');
  assert.equal(graded.gradedBy.toString(), owner.id);
  assert.ok(graded.gradedAt instanceof Date);

  await agent.patch(submissionsPath(course._id, assignment._id, latest._id))
    .send({ action: 'GRADE', marks: 49, feedback: 'Changed my mind' })
    .expect(400);
});

test('review rejects an old version when a newer version wins the submission-state lock during review', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED', maxMarks: 50 });
  const first = await createSubmissionVersion(assignment, student);
  const agent = await login(owner);
  const originalFindOneAndUpdate = SubmissionState.findOneAndUpdate;
  let interleaved = false;

  SubmissionState.findOneAndUpdate = async (...args) => {
    const [filter] = args;
    if (!interleaved && filter.latestSubmission && String(filter.latestSubmission) === first.id) {
      interleaved = true;
      const second = await Submission.create({
        assignment: assignment._id,
        course: course._id,
        student: student._id,
        version: 2,
        writtenAnswer: 'Newer work wins',
        late: false
      });
      await originalFindOneAndUpdate.call(SubmissionState,
        { assignment: assignment._id, student: student._id },
        {
          $set: {
            latestVersion: second.version,
            latestSubmission: second._id,
            status: 'SUBMITTED'
          }
        },
        { new: true, runValidators: true }
      );
    }
    return originalFindOneAndUpdate.apply(SubmissionState, args);
  };

  try {
    await agent.patch(submissionsPath(course._id, assignment._id, first._id))
      .send({ action: 'GRADE', marks: 50, feedback: 'Would be stale' })
      .expect(400);
    assert.equal(interleaved, true);
    assert.equal((await Submission.findById(first._id)).status, 'SUBMITTED');
    const state = await SubmissionState.findOne({ assignment: assignment._id, student: student._id });
    assert.equal(state.latestVersion, 2);
  } finally {
    SubmissionState.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('submission-state creation atomically reserves the assignment marker and advances the latest version', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED' });

  const first = await createVersionThroughState({
    assignment,
    course,
    student,
    submission: { writtenAnswer: 'First work', late: false }
  });
  const second = await createVersionThroughState({
    assignment,
    course,
    student,
    submission: { writtenAnswer: 'Replacement work', late: false }
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal((await Assignment.findById(assignment._id)).submissionCount, 2);
  const state = await SubmissionState.findOne({ assignment: assignment._id, student: student._id });
  assert.equal(state.latestVersion, 2);
  assert.equal(state.latestSubmission.toString(), second.id);
  assert.equal(state.status, 'SUBMITTED');

  await SubmissionState.updateOne({ _id: state._id }, { $set: { status: 'GRADED' } });
  await assert.rejects(
    () => createVersionThroughState({
      assignment,
      course,
      student,
      submission: { writtenAnswer: 'Rejected replacement', late: false }
    }),
    /graded submission cannot be replaced/
  );
  assert.equal((await Assignment.findById(assignment._id)).submissionCount, 2);
  assert.equal(await Submission.countDocuments({ assignment: assignment._id, student: student._id }), 2);
});

test('manager requests resubmission with feedback only and cannot review a foreign submission', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const otherOwner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const otherCourse = await createCourse(otherOwner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED' });
  const foreignAssignment = await createAssignment(otherCourse, { status: 'PUBLISHED' });
  const submission = await createSubmissionVersion(assignment, student);
  const foreignSubmission = await createSubmissionVersion(foreignAssignment, student);
  const agent = await login(owner);

  await agent.patch(submissionsPath(course._id, assignment._id, submission._id))
    .send({ action: 'REQUEST_RESUBMISSION', marks: 1, feedback: 'Add tests' })
    .expect(400);
  await agent.patch(submissionsPath(course._id, assignment._id, submission._id))
    .send({ action: 'REQUEST_RESUBMISSION', feedback: '   ' })
    .expect(400);
  await agent.patch(submissionsPath(course._id, assignment._id, submission._id))
    .send({ action: 'REQUEST_RESUBMISSION', feedback: 'Add tests' })
    .expect(200);

  const requested = await Submission.findById(submission._id).lean();
  assert.equal(requested.status, 'RESUBMISSION_REQUESTED');
  assert.equal(requested.marks, null);
  assert.equal(requested.feedback, 'Add tests');
  assert.equal(requested.gradedBy.toString(), owner.id);
  assert.ok(requested.gradedAt instanceof Date);

  await agent.patch(submissionsPath(course._id, assignment._id, submission._id))
    .send({ action: 'GRADE', marks: 40, feedback: 'Now good' })
    .expect(400);
  await agent.patch(submissionsPath(course._id, foreignAssignment._id, foreignSubmission._id))
    .send({ action: 'GRADE', marks: 40, feedback: 'No access' })
    .expect(404);
});

test('only actively enrolled students discover published assignments without internal fields', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const unenrolled = await createUser('STUDENT');
  const course = await createCourse(owner);
  const published = await createAssignment(course, { status: 'PUBLISHED' });
  const draft = await createAssignment(course, { title: 'Private draft' });
  await enroll(student, course);

  const studentAgent = await login(student);
  const list = await studentAgent.get(studentAssignmentsPath(course._id)).expect(200);
  assert.deepEqual(list.body.assignments.map((assignment) => assignment.id), [published.id]);
  assert.equal(list.body.assignments[0].submissionCount, undefined);

  const detail = await studentAgent.get(studentAssignmentsPath(course._id, published._id)).expect(200);
  assert.equal(detail.body.assignment.id, published.id);
  assert.equal(detail.body.assignment.submissionCount, undefined);
  const unavailable = await studentAgent.get(studentAssignmentsPath(course._id, draft._id)).expect(404);
  assert.equal(unavailable.body.error.code, 'ASSESSMENT_NOT_AVAILABLE');
  await (await login(unenrolled)).get(studentAssignmentsPath(course._id)).expect(403);
});

test('student submission versions are server-owned, late, isolated, and stop after grading', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const otherStudent = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, {
    status: 'PUBLISHED',
    dueDate: new Date('2000-01-01T00:00:00.000Z')
  });
  await Promise.all([enroll(student, course), enroll(otherStudent, course)]);
  const studentAgent = await login(student);
  const otherAgent = await login(otherStudent);
  const path = studentSubmissionsPath(course._id, assignment._id);

  await studentAgent.post(path).send({ writtenAnswer: 'No server state', status: 'GRADED' }).expect(400);
  const first = await studentAgent.post(path).send({ writtenAnswer: 'First work' }).expect(201);
  assert.equal(first.body.submission.version, 1);
  assert.equal(first.body.submission.late, true);
  assert.equal(first.body.submission.status, 'SUBMITTED');
  assert.equal(first.body.submission.file, null);

  const firstId = first.body.submission.id;
  const history = await studentAgent.get(path).expect(200);
  assert.equal(history.body.submissions.length, 1);
  await otherAgent.get(path).expect(200).then((response) => assert.equal(response.body.submissions.length, 0));

  await (await login(owner))
    .patch(submissionsPath(course._id, assignment._id, firstId))
    .send({ action: 'REQUEST_RESUBMISSION', feedback: 'Please add tests' })
    .expect(200);
  const second = await studentAgent.post(path).send({ projectUrl: 'https://github.com/example/project' }).expect(201);
  assert.equal(second.body.submission.version, 2);

  await (await login(owner))
    .patch(submissionsPath(course._id, assignment._id, second.body.submission.id))
    .send({ action: 'GRADE', marks: 50, feedback: 'Complete' })
    .expect(200);
  const locked = await studentAgent.post(path).send({ writtenAnswer: 'Too late to replace' }).expect(400);
  assert.equal(locked.body.error.code, 'ASSESSMENT_SUBMISSION_LOCKED');
  assert.match(locked.body.message, /graded/i);

  assert.equal((await Assignment.findById(assignment._id)).submissionCount, 2);
  assert.equal(await Submission.countDocuments({ assignment: assignment._id, student: student._id }), 2);
});

test('student file submission cleans temporary files and uploads safe metadata only', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED' });
  const persistenceFailureAssignment = await createAssignment(course, { status: 'PUBLISHED', title: 'Persistence failure' });
  await enroll(student, course);
  const path = studentSubmissionsPath(course._id, assignment._id);
  const agent = await login(student);
  const originalUpload = cloudinary.v2.uploader.upload;
  const originalDestroy = cloudinary.v2.uploader.destroy;
  const uploads = [];
  const destroyed = [];
  let failPersistence = false;
  cloudinary.v2.uploader.upload = async (filePath, options) => {
    uploads.push({ filePath, options });
    if (failPersistence) {
      await Assignment.updateOne({ _id: persistenceFailureAssignment._id }, { $set: { status: 'DRAFT' } });
    }
    return { public_id: 'student-work-file', secure_url: 'https://res.cloudinary.com/example/image/upload/work.png' };
  };
  cloudinary.v2.uploader.destroy = async (publicId, options) => { destroyed.push({ publicId, options }); };

  try {
    await agent.post(path).attach('file', Buffer.from('not a supported file'), {
      filename: 'malware.exe', contentType: 'application/octet-stream'
    }).expect(400);
    assert.equal(await Submission.countDocuments({ assignment: assignment._id }), 0);
    assert.equal((await Assignment.findById(assignment._id)).submissionCount, 0);

    const response = await agent.post(path).attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      filename: 'work.png', contentType: 'image/png'
    }).expect(201);
    assert.equal(response.body.submission.file.publicId, undefined);
    assert.equal(response.body.submission.file.originalName, 'work.png');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].options.resource_type, 'image');
    await assert.rejects(() => fs.access(uploads[0].filePath));
    assert.deepEqual(destroyed, []);

    failPersistence = true;
    const failedPath = studentSubmissionsPath(course._id, persistenceFailureAssignment._id);
    await agent.post(failedPath).attach('file', Buffer.from('%PDF-1.7\n'), {
      filename: 'work.pdf', contentType: 'application/pdf'
    }).expect(409);
    assert.deepEqual(destroyed, [{ publicId: 'student-work-file', options: { resource_type: 'raw' } }]);
    await assert.rejects(() => fs.access(uploads[1].filePath));
    assert.equal((await Assignment.findById(persistenceFailureAssignment._id)).submissionCount, 0);
  } finally {
    cloudinary.v2.uploader.upload = originalUpload;
    cloudinary.v2.uploader.destroy = originalDestroy;
  }
});

test('R2 assignment uploads use scoped random keys and remove exactly the new object if persistence fails', async (t) => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED' });
  const failingAssignment = await createAssignment(course, { status: 'PUBLISHED', title: 'R2 persistence failure' });
  await enroll(student, course);
  const uploaded = [];
  const removed = [];
  let failPersistence = false;
  const restoreFactory = setMediaStorageFactoryForTests({ provider: 'R2', get: () => ({
    uploadLocalFile: async (input) => {
      uploaded.push(input);
      if (failPersistence) await Assignment.updateOne({ _id: failingAssignment._id }, { $set: { status: 'DRAFT' } });
      return { storage: { provider: 'R2', key: input.key, contentType: input.contentType, size: input.size } };
    },
    remove: async (media) => { removed.push(media.storage.key); }
  }) });
  t.after(() => {
    restoreFactory();
  });
  const agent = await login(student);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const created = await agent.post(studentSubmissionsPath(course._id, assignment._id))
    .attach('file', png, { filename: 'work.png', contentType: 'image/png' }).expect(201);
  assert.match(uploaded[0].key, new RegExp(`^assignments/${course.id}/assignments/${assignment.id}/[0-9a-f-]+\\.png$`));
  assert.equal(created.body.submission.file.downloadEndpoint.includes(uploaded[0].key), false);
  const stored = await Submission.findById(created.body.submission.id).lean();
  assert.equal(stored.file.storage.provider, 'R2');
  assert.equal(stored.file.storage.key, uploaded[0].key);
  assert.deepEqual(removed, []);

  failPersistence = true;
  await agent.post(studentSubmissionsPath(course._id, failingAssignment._id))
    .attach('file', png, { filename: 'work.png', contentType: 'image/png' }).expect(409);
  assert.deepEqual(removed, [uploaded[1].key]);
});

test('assignment validation and submission upload failures hide technical details', async (t) => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const ownerAgent = await login(owner);
  const invalid = await ownerAgent.post(assignmentsPath(course._id)).send(assignmentPayload({ maxMarks: 'database-password-secret' })).expect(400);
  assert.equal(invalid.body.error.code, 'ASSESSMENT_INVALID_REQUEST');
  assert.doesNotMatch(JSON.stringify(invalid.body), /database-password-secret|CastError/);
  const assignment = await createAssignment(course, { status: 'PUBLISHED' });
  await enroll(student, course);
  const studentAgent = await login(student);
  let filePath;
  t.mock.method(cloudinary.v2.uploader, 'upload', async (path) => { filePath = path; throw new Error('Cloudinary password=secret'); });
  const failed = await studentAgent.post(studentSubmissionsPath(course._id, assignment._id)).attach('file', Buffer.from('%PDF-1.7\n'), { filename: 'work.pdf', contentType: 'application/pdf' }).expect(502);
  assert.equal(failed.body.error.code, 'UPLOAD_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(failed.body), /Cloudinary|password=secret/);
  await assert.rejects(() => fs.access(filePath));
  assert.equal(await Submission.countDocuments({ assignment: assignment._id }), 0);
  assert.equal((await Assignment.findById(assignment._id)).submissionCount, 0);
});

test('instructor assignment mutations and reviews create redacted audit events only after success', async (t) => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const intruder = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const otherCourse = await createCourse(intruder);
  const agent = await login(owner);
  const created = await agent.post(assignmentsPath(course._id)).send(assignmentPayload()).expect(201);
  const assignmentId = created.body.assignment.id;
  const eventFor = async (action, targetId, type) => {
    const events = await AuditLog.find({ action, 'target.id': targetId }).lean();
    assert.equal(events.length, 1);
    assert.equal(String(events[0].actor), owner.id);
    assert.equal(events[0].target.type, type);
    assert.equal(String(events[0].target.id), String(targetId));
    assert.equal(events[0].summary, undefined);
    for (const forbidden of ['password', 'token', 'cookie', 'ip', 'userAgent', 'answers', 'questions', 'marks', 'feedback', 'files', 'razorpay', 'certificate']) {
      assert.equal(JSON.stringify(events[0]).toLowerCase().includes(forbidden.toLowerCase()), false);
    }
  };

  await eventFor('ASSIGNMENT_CREATED', assignmentId, 'ASSIGNMENT');
  await agent.patch(assignmentsPath(course._id, assignmentId)).send({ title: 'Audited assignment update' }).expect(200);
  await eventFor('ASSIGNMENT_UPDATED', assignmentId, 'ASSIGNMENT');
  await agent.patch(assignmentsPath(course._id, assignmentId)).send({ status: 'PUBLISHED' }).expect(200);
  await eventFor('ASSIGNMENT_PUBLISHED', assignmentId, 'ASSIGNMENT');
  await agent.patch(assignmentsPath(course._id, assignmentId)).send({ status: 'PUBLISHED' }).expect(200);
  assert.equal(await AuditLog.countDocuments({ action: 'ASSIGNMENT_PUBLISHED', 'target.id': assignmentId }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'ASSIGNMENT_UPDATED', 'target.id': assignmentId }), 1);
  await agent.patch(assignmentsPath(otherCourse._id, assignmentId)).send({ title: 'Foreign' }).expect(403);
  await agent.patch(assignmentsPath(course._id, assignmentId)).send({ status: 'INVALID' }).expect(400);
  assert.equal(await AuditLog.countDocuments({ 'target.id': assignmentId }), 3);
  await agent.delete(assignmentsPath(course._id, assignmentId)).expect(200);
  await eventFor('ASSIGNMENT_DELETED', assignmentId, 'ASSIGNMENT');

  const attemptedAssignment = await createAssignment(course);
  await Assignment.updateOne({ _id: attemptedAssignment._id }, { $set: { submissionCount: 1 } });
  await agent.patch(assignmentsPath(course._id, attemptedAssignment._id)).send({ title: 'Rejected after submission' }).expect(409);
  await agent.delete(assignmentsPath(course._id, attemptedAssignment._id)).expect(409);
  assert.equal(await AuditLog.countDocuments({ 'target.id': attemptedAssignment._id }), 0);

  const gradedAssignment = await createAssignment(course, { status: 'PUBLISHED', maxMarks: 50 });
  const submission = await createSubmissionVersion(gradedAssignment, student, { writtenAnswer: 'Private student work' });
  await agent.patch(submissionsPath(course._id, gradedAssignment._id, submission._id))
    .send({ action: 'GRADE', marks: 45, feedback: 'Private feedback' }).expect(200);
  await eventFor('SUBMISSION_GRADED', submission._id, 'SUBMISSION');
  await agent.patch(submissionsPath(course._id, gradedAssignment._id, submission._id))
    .send({ action: 'GRADE', marks: 44, feedback: 'Duplicate review' }).expect(400);
  await agent.patch(submissionsPath(otherCourse._id, gradedAssignment._id, submission._id))
    .send({ action: 'GRADE', marks: 44, feedback: 'Foreign review' }).expect(403);
  assert.equal(await AuditLog.countDocuments({ action: 'SUBMISSION_GRADED', 'target.id': submission._id }), 1);

  t.mock.method(AuditLog, 'create', async () => { throw new Error('audit storage unavailable'); });
  const resilience = await agent.post(assignmentsPath(course._id)).send(assignmentPayload({ title: 'Audit failure resilience' })).expect(201);
  assert.ok(await Assignment.exists({ _id: resilience.body.assignment.id }));
});

test('a successful resubmission request persists its current review result without a grading audit event', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course, { status: 'PUBLISHED', maxMarks: 50 });
  const submission = await createSubmissionVersion(assignment, student, { writtenAnswer: 'Private student work' });
  const response = await (await login(owner))
    .patch(submissionsPath(course._id, assignment._id, submission._id))
    .send({ action: 'REQUEST_RESUBMISSION', feedback: 'Please add the missing tests.' })
    .expect(200);

  assert.equal(response.body.success, true);
  assert.equal(response.body.submission.status, 'RESUBMISSION_REQUESTED');
  const persisted = await Submission.findById(submission._id).lean();
  assert.equal(persisted.status, 'RESUBMISSION_REQUESTED');
  assert.equal(persisted.feedback, 'Please add the missing tests.');
  assert.equal(await AuditLog.countDocuments({ action: 'SUBMISSION_GRADED', 'target.id': submission._id }), 0);
});

test('parallel assignment publish requests mutate and audit only the first transition', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const assignment = await createAssignment(course);
  const agent = await login(owner);
  const path = assignmentsPath(course._id, assignment._id);

  const responses = await Promise.all([
    agent.patch(path).send({ status: 'PUBLISHED' }),
    agent.patch(path).send({ status: 'PUBLISHED' })
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
  assert.equal((await Assignment.findById(assignment._id)).status, 'PUBLISHED');
  assert.equal(await AuditLog.countDocuments({ action: 'ASSIGNMENT_PUBLISHED', 'target.id': assignment._id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'ASSIGNMENT_UPDATED', 'target.id': assignment._id }), 0);
});
