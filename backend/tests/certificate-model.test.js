const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Certificate = require('../models/certificate.schema');
const Course = require('../models/course.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const Assignment = require('../models/assignment.schema');
const Submission = require('../models/submission.schema');
const { calculateEligibility, createCertificateValues } = require('../services/certificate.service');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function validCertificate(overrides = {}) {
  return {
    student: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    certificateNumber: `LMS-2026-${'A'.repeat(20)}`,
    verificationToken: 'a'.repeat(64),
    eligibilitySnapshot: { ruleVersion: 1 },
    ...overrides
  };
}

function lecture(title) {
  return {
    title,
    description: `${title} description`,
    lecture: { public_id: `lectures/${title}`, secure_url: 'https://example.test/lecture.mp4' }
  };
}

async function createCourse(lectures = []) {
  return Course.create({
    title: 'Certificate testing course',
    description: 'A course used only to test certificate eligibility.',
    category: 'Testing',
    instructor: new mongoose.Types.ObjectId(),
    thumbnail: { public_id: 'courses/testing', secure_url: 'https://example.test/course.png' },
    lectures
  });
}

function quizValues(course, overrides = {}) {
  return {
    course: course._id,
    title: 'Eligibility quiz',
    passMark: 80,
    status: 'PUBLISHED',
    questions: [{ prompt: 'Choose the right answer', options: ['No', 'Yes'], correctOptionIndex: 1 }],
    ...overrides
  };
}

function attemptValues({ quiz, course, student, percentage, passed, submittedAt = new Date() }) {
  const totalQuestions = 100;
  const correctAnswers = percentage;
  return {
    quiz: quiz._id,
    course: course._id,
    student,
    answers: Array.from({ length: totalQuestions }, (_value, index) => (index < correctAnswers ? 1 : 0)),
    correctAnswers,
    totalQuestions,
    score: correctAnswers,
    percentage,
    passed,
    submittedAt
  };
}

function assignmentValues(course, overrides = {}) {
  return {
    course: course._id,
    title: 'Eligibility assignment',
    instructions: 'Submit a completed project.',
    maxMarks: 100,
    status: 'PUBLISHED',
    ...overrides
  };
}

function submissionValues({ assignment, course, student, version, status, marks }) {
  return {
    assignment: assignment._id,
    course: course._id,
    student,
    version,
    writtenAnswer: `Work for version ${version}`,
    late: false,
    status,
    marks,
    gradedAt: status === 'GRADED' ? new Date() : null
  };
}

test.before(async () => {
  await connectTestDb();
  await Promise.all([
    Certificate.init(),
    Course.init(),
    LectureProgress.init(),
    Quiz.init(),
    QuizAttempt.init(),
    Assignment.init(),
    Submission.init()
  ]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('certificate has unique immutable student/course, number, and verification token', async () => {
  const certificate = await Certificate.create(validCertificate());

  await assert.rejects(
    Certificate.create(validCertificate({
      student: new mongoose.Types.ObjectId(),
      course: new mongoose.Types.ObjectId(),
      certificateNumber: certificate.certificateNumber
    })),
    /duplicate key/
  );
  await assert.rejects(
    Certificate.create(validCertificate({
      student: certificate.student,
      course: certificate.course,
      certificateNumber: `LMS-2026-${'B'.repeat(20)}`,
      verificationToken: 'b'.repeat(64)
    })),
    /duplicate key/
  );

  const original = certificate.toObject();
  certificate.student = new mongoose.Types.ObjectId();
  certificate.course = new mongoose.Types.ObjectId();
  certificate.certificateNumber = 'LMS-2026-CHANGED';
  certificate.verificationToken = 'c'.repeat(64);
  certificate.issuedAt = new Date(0);
  certificate.eligibilitySnapshot = { ruleVersion: 2 };
  await certificate.save();

  const persisted = await Certificate.findById(certificate._id).select('+verificationToken').lean();
  assert.equal(String(persisted.student), String(original.student));
  assert.equal(String(persisted.course), String(original.course));
  assert.equal(persisted.certificateNumber, original.certificateNumber);
  assert.equal(persisted.verificationToken, original.verificationToken);
  assert.equal(persisted.issuedAt.getTime(), original.issuedAt.getTime());
  assert.deepEqual(persisted.eligibilitySnapshot, original.eligibilitySnapshot);
});

test('certificate hides verification tokens by default but permits explicit verification lookup', async () => {
  const certificate = await Certificate.create(validCertificate({
    certificateNumber: `LMS-2026-${'D'.repeat(20)}`,
    verificationToken: 'd'.repeat(64)
  }));

  const ordinaryRead = await Certificate.findById(certificate._id).lean();
  const verificationRead = await Certificate.findOne({ verificationToken: certificate.verificationToken })
    .select('+verificationToken')
    .lean();

  assert.equal(Object.hasOwn(ordinaryRead, 'verificationToken'), false);
  assert.equal(verificationRead.verificationToken, certificate.verificationToken);
});

test('certificate rejects verification tokens and certificate numbers outside generated formats', async () => {
  for (const overrides of [
    { certificateNumber: 'LMS-2026-TOO-SHORT' },
    { certificateNumber: `lms-2026-${'A'.repeat(20)}` },
    { certificateNumber: `LMS-20X6-${'A'.repeat(20)}` },
    { verificationToken: 'e'.repeat(63) },
    { verificationToken: 'E'.repeat(64) },
    { verificationToken: 'g'.repeat(64) }
  ]) {
    await assert.rejects(
      () => new Certificate(validCertificate(overrides)).validate(),
      mongoose.Error.ValidationError
    );
  }
});

test('certificate value generation produces formatted numbers and unguessable tokens', () => {
  const first = createCertificateValues();
  const second = createCertificateValues();

  assert.match(first.certificateNumber, /^LMS-\d{4}-[A-Z0-9]+$/);
  assert.match(first.verificationToken, /^[a-f0-9]{64}$/);
  assert.notEqual(first.certificateNumber, second.certificateNumber);
  assert.notEqual(first.verificationToken, second.verificationToken);
});

test('eligibility accepts exact 80 percent lecture completion and assessment average', async () => {
  const student = new mongoose.Types.ObjectId();
  const course = await createCourse([
    lecture('Lecture one'), lecture('Lecture two'), lecture('Lecture three'), lecture('Lecture four'), lecture('Lecture five')
  ]);
  await LectureProgress.insertMany(course.lectures.slice(0, 4).map((item) => ({
    student,
    course: course._id,
    lectureId: item._id,
    completed: true
  })));
  const quiz = await Quiz.create(quizValues(course));
  await QuizAttempt.create(attemptValues({ quiz, course, student, percentage: 80, passed: true }));
  const assignment = await Assignment.create(assignmentValues(course));
  await Submission.create(submissionValues({ assignment, course, student, version: 1, status: 'GRADED', marks: 80 }));

  const eligibility = await calculateEligibility(student, course._id);

  assert.deepEqual(eligibility, {
    eligible: true,
    totalLectures: 5,
    completedLectures: 4,
    lecturePercent: 80,
    requiredQuizzes: 1,
    passedQuizzes: 1,
    requiredAssignments: 1,
    gradedAssignments: 1,
    assessmentAverage: 80,
    lectureRequirementMet: true,
    quizzesRequirementMet: true,
    assignmentsRequirementMet: true,
    assessmentRequirementMet: true
  });
});

test('eligibility has a perfect assessment average when current course has no assessments', async () => {
  const student = new mongoose.Types.ObjectId();
  const course = await createCourse([lecture('First'), lecture('Second'), lecture('Third'), lecture('Fourth'), lecture('Fifth')]);
  await LectureProgress.insertMany(course.lectures.slice(0, 4).map((item) => ({
    student,
    course: course._id,
    lectureId: item._id,
    completed: true
  })));

  const eligibility = await calculateEligibility(student, course._id);

  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.assessmentAverage, 100);
  assert.equal(eligibility.requiredQuizzes, 0);
  assert.equal(eligibility.requiredAssignments, 0);
});

test('eligibility uses only current course contents, best quiz attempt, and latest assignment submission', async () => {
  const student = new mongoose.Types.ObjectId();
  const course = await createCourse([lecture('Current lesson')]);
  await LectureProgress.create({ student, course: course._id, lectureId: course.lectures[0]._id, completed: true });
  await LectureProgress.create({ student, course: course._id, lectureId: new mongoose.Types.ObjectId(), completed: false });

  const quiz = await Quiz.create(quizValues(course));
  const deletedQuiz = await Quiz.create(quizValues(course, { title: 'Deleted quiz' }));
  await QuizAttempt.create(attemptValues({ quiz, course, student, percentage: 50, passed: false, submittedAt: new Date('2026-01-01') }));
  await QuizAttempt.create(attemptValues({ quiz, course, student, percentage: 100, passed: true, submittedAt: new Date('2026-01-02') }));
  await QuizAttempt.create(attemptValues({ quiz: deletedQuiz, course, student, percentage: 0, passed: false }));
  await Quiz.deleteOne({ _id: deletedQuiz._id });

  const assignment = await Assignment.create(assignmentValues(course));
  const deletedAssignment = await Assignment.create(assignmentValues(course, { title: 'Deleted assignment' }));
  await Submission.create(submissionValues({ assignment, course, student, version: 1, status: 'GRADED', marks: 100 }));
  await Submission.create(submissionValues({ assignment, course, student, version: 2, status: 'GRADED', marks: 60 }));
  await Submission.create(submissionValues({ assignment: deletedAssignment, course, student, version: 1, status: 'SUBMITTED', marks: null }));
  await Assignment.deleteOne({ _id: deletedAssignment._id });

  const eligibility = await calculateEligibility(student, course._id);

  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.lecturePercent, 100);
  assert.equal(eligibility.requiredQuizzes, 1);
  assert.equal(eligibility.passedQuizzes, 1);
  assert.equal(eligibility.requiredAssignments, 1);
  assert.equal(eligibility.gradedAssignments, 1);
  assert.equal(eligibility.assessmentAverage, 80);
});

test('eligibility blocks incomplete current requirements and reports each failed checklist rule', async () => {
  const student = new mongoose.Types.ObjectId();
  const course = await createCourse([lecture('One'), lecture('Two'), lecture('Three'), lecture('Four'), lecture('Five')]);
  await LectureProgress.insertMany(course.lectures.slice(0, 3).map((item) => ({
    student,
    course: course._id,
    lectureId: item._id,
    completed: true
  })));
  const quiz = await Quiz.create(quizValues(course));
  await QuizAttempt.create(attemptValues({ quiz, course, student, percentage: 79, passed: false }));
  const assignment = await Assignment.create(assignmentValues(course));
  await Submission.create(submissionValues({ assignment, course, student, version: 1, status: 'SUBMITTED', marks: null }));

  const eligibility = await calculateEligibility(student, course._id);

  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.lectureRequirementMet, false);
  assert.equal(eligibility.quizzesRequirementMet, false);
  assert.equal(eligibility.assignmentsRequirementMet, false);
  assert.equal(eligibility.assessmentRequirementMet, false);
  assert.equal(eligibility.lecturePercent, 60);
  assert.equal(eligibility.assessmentAverage, 39.5);
});
