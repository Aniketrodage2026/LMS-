const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

const { createApp } = require('../app');
const Assignment = require('../models/assignment.schema');
const Submission = require('../models/submission.schema');
const SubmissionState = require('../models/submission-state.schema');
const upload = require('../middleware/multer.middleware');
const { validateSubmissionContent } = require('../services/assignment.service');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function validAssignment(overrides = {}) {
  return {
    course: new mongoose.Types.ObjectId(),
    title: '  Portfolio  ',
    instructions: '  Build a project  ',
    maxMarks: 50,
    ...overrides
  };
}

function validSubmission(overrides = {}) {
  return {
    assignment: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    student: new mongoose.Types.ObjectId(),
    version: 1,
    writtenAnswer: '  My completed work  ',
    late: false,
    ...overrides
  };
}

function submissionUploadApp() {
  const app = express();
  app.post('/submission', upload.submission.single('file'), (req, res) => {
    res.status(201).json({ file: req.file && { path: req.file.path, size: req.file.size } });
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 400 : 500)).json({
      message: error.message,
      code: error.code
    });
  });
  return app;
}

test.before(async () => {
  await connectTestDb();
  await Promise.all([Assignment.init(), Submission.init(), SubmissionState.init()]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('assignment trims requirements, applies lifecycle defaults, and declares course indexes', async () => {
  const assignment = await Assignment.create(validAssignment());

  assert.equal(assignment.title, 'Portfolio');
  assert.equal(assignment.instructions, 'Build a project');
  assert.equal(assignment.dueDate, null);
  assert.equal(assignment.status, 'DRAFT');
  assert.equal(assignment.submissionCount, 0);
  assert.equal(Assignment.schema.path('course').options.ref, 'Course');

  const indexes = Assignment.schema.indexes();
  assert.ok(indexes.some(([keys]) => keys.course === 1 && keys.status === 1));
  assert.ok(indexes.some(([keys]) => keys.course === 1 && Object.keys(keys).length === 1));
});

test('assignment requires strict immutable course, nonempty requirements, and integer marks/counter', async () => {
  for (const overrides of [
    { course: undefined },
    { title: '   ' },
    { instructions: '   ' },
    { maxMarks: 0 },
    { maxMarks: 12.5 },
    { maxMarks: '50' },
    { submissionCount: -1 },
    { submissionCount: 0.5 },
    { submissionCount: '0' }
  ]) {
    await assert.rejects(() => new Assignment(validAssignment(overrides)).validate(), mongoose.Error.ValidationError);
  }

  const assignment = await Assignment.create(validAssignment());
  const originalCourse = assignment.course.toString();
  assignment.course = new mongoose.Types.ObjectId();
  await assignment.save();
  assert.equal((await Assignment.findById(assignment._id)).course.toString(), originalCourse);
});

test('submission requires work, applies server defaults, and declares version-history indexes', async () => {
  await assert.rejects(
    () => Submission.create(validSubmission({ writtenAnswer: ' ', projectUrl: ' ', file: null })),
    /submission content/
  );

  const submission = await Submission.create(validSubmission());
  assert.equal(submission.writtenAnswer, 'My completed work');
  assert.equal(submission.status, 'SUBMITTED');
  assert.equal(submission.marks, null);
  assert.equal(submission.feedback, '');
  assert.equal(submission.gradedAt, null);
  assert.ok(submission.createdAt instanceof Date);
  assert.ok(submission.updatedAt instanceof Date);

  const indexes = Submission.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => (
    keys.assignment === 1 && keys.student === 1 && keys.version === 1 && options.unique
  )));
  assert.ok(indexes.some(([keys]) => (
    keys.assignment === 1 && keys.student === 1 && keys.createdAt === -1
  )));
});

test('submission state tracks exactly one latest version per assignment and student', async () => {
  const assignment = new mongoose.Types.ObjectId();
  const student = new mongoose.Types.ObjectId();
  const state = await SubmissionState.create({
    assignment,
    course: new mongoose.Types.ObjectId(),
    student,
    latestVersion: 1,
    latestSubmission: new mongoose.Types.ObjectId(),
    status: 'SUBMITTED'
  });
  assert.equal(state.status, 'SUBMITTED');

  await assert.rejects(() => SubmissionState.create({
    assignment,
    course: new mongoose.Types.ObjectId(),
    student,
    latestVersion: 2,
    latestSubmission: new mongoose.Types.ObjectId(),
    status: 'RESUBMISSION_REQUESTED'
  }), /duplicate key/);
  await assert.rejects(() => SubmissionState.create({
    assignment: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    student: new mongoose.Types.ObjectId(),
    latestVersion: 0,
    latestSubmission: new mongoose.Types.ObjectId(),
    status: 'INVALID'
  }), mongoose.Error.ValidationError);
});

test('submission validates strict project URLs, optional file metadata, and server numeric fields', async () => {
  for (const projectUrl of ['ftp://example.com/work', 'javascript:alert(1)', 'not a url', 42]) {
    await assert.rejects(
      () => new Submission(validSubmission({ writtenAnswer: '', projectUrl })).validate(),
      mongoose.Error.ValidationError
    );
  }

  await assert.doesNotReject(() => new Submission(validSubmission({
    writtenAnswer: '',
    projectUrl: 'https://example.com/work'
  })).validate());
  await assert.doesNotReject(() => new Submission(validSubmission({
    writtenAnswer: '',
    file: {
      public_id: 'assignments/work',
      secure_url: 'https://res.cloudinary.com/example/raw/upload/work.pdf',
      originalName: 'work.pdf',
      mimetype: 'application/pdf',
      size: 1024
    }
  })).validate());

  for (const file of [
    {},
    { public_id: 'asset', secure_url: 'https://example.com/work.pdf', originalName: 'work.pdf', mimetype: 'application/pdf', size: -1 },
    { public_id: 'asset', secure_url: 'https://example.com/work.pdf', originalName: 'work.pdf', mimetype: 'application/pdf', size: '1024' }
  ]) {
    await assert.rejects(
      () => new Submission(validSubmission({ writtenAnswer: '', file })).validate(),
      mongoose.Error.ValidationError
    );
  }

  for (const marks of [-1, 2.5, '2']) {
    await assert.rejects(() => new Submission(validSubmission({ marks })).validate(), mongoose.Error.ValidationError);
  }
});

test('submission identity, work, version, and late fields remain immutable after creation', async () => {
  const submission = await Submission.create(validSubmission({
    projectUrl: 'https://example.com/original',
    file: {
      public_id: 'assignments/original',
      secure_url: 'https://example.com/original.pdf',
      originalName: 'original.pdf',
      mimetype: 'application/pdf',
      size: 1
    }
  }));
  const original = {
    assignment: submission.assignment.toString(),
    course: submission.course.toString(),
    student: submission.student.toString(),
    version: submission.version,
    writtenAnswer: submission.writtenAnswer,
    projectUrl: submission.projectUrl,
    file: submission.file.toObject(),
    late: submission.late
  };

  submission.assignment = new mongoose.Types.ObjectId();
  submission.course = new mongoose.Types.ObjectId();
  submission.student = new mongoose.Types.ObjectId();
  submission.version = 2;
  submission.writtenAnswer = 'Changed work';
  submission.projectUrl = 'https://example.com/changed';
  submission.file = {
    public_id: 'assignments/changed',
    secure_url: 'https://example.com/changed.pdf',
    originalName: 'changed.pdf',
    mimetype: 'application/pdf',
    size: 2
  };
  submission.late = true;
  await submission.save();

  const persisted = await Submission.findById(submission._id).lean();
  assert.equal(persisted.assignment.toString(), original.assignment);
  assert.equal(persisted.course.toString(), original.course);
  assert.equal(persisted.student.toString(), original.student);
  assert.equal(persisted.version, original.version);
  assert.equal(persisted.writtenAnswer, original.writtenAnswer);
  assert.equal(persisted.projectUrl, original.projectUrl);
  assert.deepEqual(persisted.file, original.file);
  assert.equal(persisted.late, original.late);
});

test('validateSubmissionContent rejects an empty submission before persistence', () => {
  assert.throws(
    () => validateSubmissionContent({ writtenAnswer: ' ', projectUrl: '', file: null }),
    /submission content/
  );
  assert.doesNotThrow(() => validateSubmissionContent({ projectUrl: 'https://example.com/work' }));
});

test('submission uploader accepts one approved file and rejects type mismatches and files over 25 MB', async () => {
  const app = submissionUploadApp();
  const accepted = await request(app)
    .post('/submission')
    .attach('file', Buffer.from('pdf data'), { filename: 'work.pdf', contentType: 'application/pdf' })
    .expect(201);
  assert.equal(accepted.body.file.size, 8);
  await fs.unlink(path.resolve(accepted.body.file.path));

  const mismatch = await request(app)
    .post('/submission')
    .attach('file', Buffer.from('not really a PDF'), { filename: 'work.pdf', contentType: 'application/octet-stream' })
    .expect(400);
  assert.match(mismatch.body.message, /Unsupported file type/);

  const oversized = await request(app)
    .post('/submission')
    .attach('file', Buffer.alloc((25 * 1024 * 1024) + 1), { filename: 'work.pdf', contentType: 'application/pdf' })
    .expect(400);
  assert.equal(oversized.body.code, 'LIMIT_FILE_SIZE');
});

test('submission uploader requires the MIME type approved for the file extension', async () => {
  const app = submissionUploadApp();

  for (const file of [
    { filename: 'work.pdf', contentType: 'image/jpeg' },
    { filename: 'screenshot.png', contentType: 'application/pdf' }
  ]) {
    const response = await request(app)
      .post('/submission')
      .attach('file', Buffer.from('wrong MIME pair'), file);
    assert.equal(response.status, 400, `${file.filename} must reject ${file.contentType}`);
  }

  for (const file of [
    { filename: 'work.pdf', contentType: 'application/pdf' },
    { filename: 'screenshot.png', contentType: 'image/png' }
  ]) {
    const response = await request(app)
      .post('/submission')
      .attach('file', Buffer.from('approved MIME pair'), file)
      .expect(201);
    await fs.unlink(path.resolve(response.body.file.path));
  }
});

test('the real app returns safe 400 responses for Multer submission limits', async () => {
  const app = createApp({
    configureApp(instance) {
      instance.post('/_test/submission-upload', upload.submission.single('file'), (_req, res) => {
        res.status(201).json({ success: true });
      });
    }
  });

  const oversized = await request(app)
    .post('/_test/submission-upload')
    .attach('file', Buffer.alloc((25 * 1024 * 1024) + 1), {
      filename: 'work.pdf',
      contentType: 'application/pdf'
    })
    .expect(400);
  assert.deepEqual(oversized.body, { success: false, message: 'Invalid upload request' });

  const unexpected = await request(app)
    .post('/_test/submission-upload')
    .attach('file', Buffer.from('approved file'), { filename: 'work.pdf', contentType: 'application/pdf' })
    .attach('extraFile', Buffer.from('extra approved file'), {
      filename: 'second.pdf',
      contentType: 'application/pdf'
    })
    .expect(400);
  assert.deepEqual(unexpected.body, { success: false, message: 'Invalid upload request' });
});
