const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

const Course = require('../models/course.schema');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const Enrollment = require('../models/enrollment.schema');
const User = require('../models/user.schema');
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

process.env.FRONTEND_URL ??= 'http://lms-frontend.test';
const app = createTestApp();

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUser(role) {
  const emailPrefix = unique('quiz-flow');
  return User.create({
    fullName: 'Quiz Flow User',
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
    title: unique('Quiz authoring course').slice(0, 45),
    description: 'A course used to test protected instructor quiz authoring.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: unique('thumbnail'),
      secure_url: 'https://image.example/thumbnail.jpg'
    },
    ...overrides
  });
}

function quizPayload(overrides = {}) {
  return {
    course: new mongoose.Types.ObjectId().toString(),
    title: 'JavaScript foundations quiz',
    instructions: 'Choose one answer for each question.',
    passMark: 70,
    status: 'PUBLISHED',
    questions: [{
      prompt: 'Which keyword creates a block-scoped variable?',
      options: ['var', 'let'],
      correctOptionIndex: 1,
      explanation: 'let is block scoped.'
    }],
    ...overrides
  };
}

function quizPath(courseId, quizId) {
  const base = `/api/v1/instructor/courses/${courseId}/quizzes`;
  return quizId ? `${base}/${quizId}` : base;
}

function studentQuizPath(courseId, quizId) {
  const base = `/api/v1/courses/${courseId}/quizzes`;
  return quizId ? `${base}/${quizId}` : base;
}

async function enroll(student, course) {
  return Enrollment.create({
    student: student._id,
    course: course._id,
    source: 'FREE_ENROLLMENT',
    status: 'ACTIVE'
  });
}

async function createQuiz(course, overrides = {}) {
  return Quiz.create({
    ...quizPayload({ status: 'DRAFT', ...overrides }),
    course: course._id
  });
}

async function createAttempt(quiz, student) {
  await Quiz.updateOne({ _id: quiz._id }, { $inc: { attemptCount: 1 } });
  return QuizAttempt.create({
    quiz: quiz._id,
    course: quiz.course,
    student: student._id,
    answers: [1],
    correctAnswers: 1,
    totalQuestions: 1,
    score: 1,
    percentage: 100,
    passed: true
  });
}

test.before(async () => {
  process.env.JWT_SECRET = 'quiz-flow-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
  await Promise.all([Quiz.init(), QuizAttempt.init()]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('instructor quiz creation pins the managed course, forces DRAFT, and list exposes answer keys', async () => {
  const owner = await createUser('INSTRUCTOR');
  const intruder = await createUser('INSTRUCTOR');
  const admin = await createUser('ADMIN');
  const course = await createCourse(owner);
  const path = quizPath(course._id);

  await (await login(intruder)).post(path).send(quizPayload()).expect(403);

  const created = await (await login(owner)).post(path).send(quizPayload()).expect(201);
  assert.equal(created.body.success, true);
  assert.equal(created.body.quiz.status, 'DRAFT');
  assert.equal(created.body.quiz.course, course.id);
  assert.equal(created.body.quiz.questions[0].correctOptionIndex, 1);
  assert.equal(created.body.quiz.questions[0].explanation, 'let is block scoped.');

  const stored = await Quiz.findById(created.body.quiz.id).lean();
  assert.equal(stored.course.toString(), course.id);
  assert.equal(stored.status, 'DRAFT');

  const listed = await (await login(owner)).get(path).expect(200);
  assert.equal(listed.body.quizzes.length, 1);
  assert.equal(listed.body.quizzes[0].questions[0].correctOptionIndex, 1);
  assert.equal(listed.body.quizzes[0].questions[0].explanation, 'let is block scoped.');

  const adminCreated = await (await login(admin)).post(path).send(quizPayload({ title: 'Admin-created quiz' })).expect(201);
  assert.equal(adminCreated.body.quiz.course, course.id);
});

test('instructor quiz updates validate ids, preserve course scope, and support draft publishing', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const otherCourse = await createCourse(owner);
  const quiz = await createQuiz(course);
  const agent = await login(owner);
  const path = quizPath(course._id, quiz._id);

  const updated = await agent.patch(path).send({
    title: 'Updated JavaScript quiz',
    instructions: 'Updated instructions.',
    passMark: 80,
    questions: [{
      prompt: 'Which value is a boolean?',
      options: ['true', '"true"'],
      correctOptionIndex: 0,
      explanation: 'true without quotes is boolean.'
    }]
  }).expect(200);
  assert.equal(updated.body.quiz.title, 'Updated JavaScript quiz');
  assert.equal(updated.body.quiz.passMark, 80);
  assert.equal(updated.body.quiz.questions[0].correctOptionIndex, 0);

  const published = await agent.patch(path).send({ status: 'PUBLISHED' }).expect(200);
  assert.equal(published.body.quiz.status, 'PUBLISHED');
  const unpublished = await agent.patch(path).send({ status: 'DRAFT' }).expect(200);
  assert.equal(unpublished.body.quiz.status, 'DRAFT');

  await agent.patch(quizPath(course._id, 'not-an-object-id')).send({ status: 'PUBLISHED' }).expect(400);
  await agent.patch(quizPath(course._id, new mongoose.Types.ObjectId())).send({ status: 'PUBLISHED' }).expect(404);
  await agent.patch(quizPath(otherCourse._id, quiz._id)).send({ status: 'PUBLISHED' }).expect(404);
});

test('instructor quiz attempts make content immutable while status-only changes remain allowed', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, { status: 'PUBLISHED' });
  await createAttempt(quiz, student);
  const agent = await login(owner);
  const path = quizPath(course._id, quiz._id);

  for (const body of [
    { title: 'Changed after attempt' },
    { instructions: 'Changed after attempt' },
    { passMark: 90 },
    { questions: quizPayload().questions },
    { course: new mongoose.Types.ObjectId().toString() },
    { status: 'PUBLISHED', unexpected: true },
    { status: 'INVALID' },
    {},
    { status: 'DRAFT', title: 'Also invalid' }
  ]) {
    await agent.patch(path).send(body).expect(409);
  }

  const changedStatus = await agent.patch(path).send({ status: 'DRAFT' }).expect(200);
  assert.equal(changedStatus.body.quiz.status, 'DRAFT');
  const persisted = await Quiz.findById(quiz._id).lean();
  assert.equal(persisted.title, quiz.title);
  assert.equal(persisted.passMark, quiz.passMark);
  assert.equal(persisted.questions[0].correctOptionIndex, quiz.questions[0].correctOptionIndex);

  await agent.delete(path).expect(409);
  assert.ok(await Quiz.exists({ _id: quiz._id }));
});

test('instructor quiz attempt markers atomically block draft content changes and deletion but allow status changes', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course);
  const agent = await login(owner);
  const path = quizPath(course._id, quiz._id);

  await Quiz.updateOne({ _id: quiz._id }, { $set: { attemptCount: 1 } });

  await agent.patch(path).send({ title: 'Must not change' }).expect(409);
  await agent.delete(path).expect(409);
  const published = await agent.patch(path).send({ status: 'PUBLISHED' }).expect(200);
  assert.equal(published.body.quiz.status, 'PUBLISHED');
  assert.equal((await Quiz.findById(quiz._id)).title, quiz.title);
});

test('instructor quiz legacy attempts with no marker are still immutable', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course);
  const agent = await login(owner);

  await QuizAttempt.create({
    quiz: quiz._id,
    course: quiz.course,
    student: student._id,
    answers: [1],
    correctAnswers: 1,
    totalQuestions: 1,
    score: 1,
    percentage: 100,
    passed: true
  });

  await agent.patch(quizPath(course._id, quiz._id)).send({ passMark: 100 }).expect(409);
  await agent.delete(quizPath(course._id, quiz._id)).expect(409);
});

test('instructor quiz conditional draft writes reject an attempt marker added after the initial read', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course);
  const agent = await login(owner);
  const path = quizPath(course._id, quiz._id);
  const originalFindOneAndUpdate = Quiz.findOneAndUpdate;

  Quiz.findOneAndUpdate = async (...args) => {
    await Quiz.updateOne({ _id: quiz._id }, { $set: { attemptCount: 1 } });
    return originalFindOneAndUpdate.apply(Quiz, args);
  };

  try {
    await agent.patch(path).send({ title: 'Race should not update' }).expect(409);
    assert.equal((await Quiz.findById(quiz._id)).title, quiz.title);
  } finally {
    Quiz.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('instructor quiz conditional deletion rejects an attempt marker added after the initial read', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course);
  const agent = await login(owner);
  const path = quizPath(course._id, quiz._id);
  const originalFindOneAndDelete = Quiz.findOneAndDelete;

  Quiz.findOneAndDelete = async (...args) => {
    await Quiz.updateOne({ _id: quiz._id }, { $set: { attemptCount: 1 } });
    return originalFindOneAndDelete.apply(Quiz, args);
  };

  try {
    await agent.delete(path).expect(409);
    assert.ok(await Quiz.exists({ _id: quiz._id }));
  } finally {
    Quiz.findOneAndDelete = originalFindOneAndDelete;
  }
});

test('instructor quiz deletion removes unattempted managed quizzes and validates quiz ids', async () => {
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course);
  const agent = await login(owner);
  const path = quizPath(course._id, quiz._id);

  const response = await agent.delete(path).expect(200);
  assert.equal(response.body.success, true);
  assert.equal(await Quiz.exists({ _id: quiz._id }), null);

  await agent.delete(quizPath(course._id, 'not-an-object-id')).expect(400);
  await agent.delete(quizPath(course._id, new mongoose.Types.ObjectId())).expect(404);
});

test('student quiz reads require authentication, the STUDENT role, an existing course, and active enrollment', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, { status: 'PUBLISHED' });
  const path = studentQuizPath(course._id, quiz._id);

  await request(app).get(path).expect(401);
  await (await login(instructor)).get(path).expect(403);
  await (await login(student)).get(path).expect(403);
  await (await login(student)).get(studentQuizPath('not-an-object-id', quiz._id)).expect(400);
  await (await login(student)).get(studentQuizPath(new mongoose.Types.ObjectId(), quiz._id)).expect(404);
  await enroll(student, course);
  await (await login(student)).get(studentQuizPath(course._id, 'not-an-object-id')).expect(400);
});

test('student quiz lists and opens only enrolled published quizzes without answer keys', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const otherCourse = await createCourse(owner);
  const published = await createQuiz(course, {
    status: 'PUBLISHED',
    questions: [{
      prompt: 'Which value is a boolean?',
      options: ['true', '"true"'],
      correctOptionIndex: 0,
      explanation: 'The quoted value is a string.'
    }]
  });
  const draft = await createQuiz(course, { title: 'Draft quiz' });
  const crossCourse = await createQuiz(otherCourse, { status: 'PUBLISHED' });
  await enroll(student, course);
  const agent = await login(student);

  const listed = await agent.get(studentQuizPath(course._id)).expect(200);
  assert.equal(listed.body.quizzes.length, 1);
  assert.equal(listed.body.quizzes[0].id, published.id);
  assert.equal(listed.body.quizzes[0].questions, undefined);
  assert.equal(listed.body.quizzes[0].correctOptionIndex, undefined);

  const opened = await agent.get(studentQuizPath(course._id, published._id)).expect(200);
  assert.equal(opened.body.quiz.questions[0].correctOptionIndex, undefined);
  assert.equal(opened.body.quiz.questions[0].explanation, undefined);
  assert.equal(opened.body.quiz.questions[0].options[0], 'true');
  await agent.get(studentQuizPath(course._id, draft._id)).expect(404);
  await agent.get(studentQuizPath(course._id, crossCourse._id)).expect(404);
});

test('student quiz submission grades on the server, permits blanks and unlimited attempts, and returns review only on success', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, {
    status: 'PUBLISHED',
    passMark: 75,
    questions: [
      { prompt: 'One plus one?', options: ['one', 'two'], correctOptionIndex: 1, explanation: '1 + 1 = 2.' },
      { prompt: 'Three plus one?', options: ['four', 'five'], correctOptionIndex: 0, explanation: '3 + 1 = 4.' }
    ]
  });
  await enroll(student, course);
  const agent = await login(student);
  const path = studentQuizPath(course._id, quiz._id);

  const first = await agent.post(`${path}/attempts`).send({
    answers: [1, null], score: 99, percentage: 99, passed: true, correctAnswers: 99
  }).expect(201);
  assert.deepEqual(first.body.attempt.score, 1);
  assert.deepEqual(first.body.attempt.totalQuestions, 2);
  assert.deepEqual(first.body.attempt.percentage, 50);
  assert.deepEqual(first.body.attempt.passed, false);
  assert.equal(first.body.review[0].selectedOptionIndex, 1);
  assert.equal(first.body.review[0].correctOptionIndex, 1);
  assert.equal(first.body.review[0].explanation, '1 + 1 = 2.');
  assert.equal(first.body.review[1].selectedOptionIndex, null);
  assert.equal((await Quiz.findById(quiz._id)).attemptCount, 1);

  const second = await agent.post(`${path}/attempts`).send({ answers: [1, 0] }).expect(201);
  assert.equal(second.body.attempt.percentage, 100);
  assert.equal(await QuizAttempt.countDocuments({ quiz: quiz._id, student: student._id }), 2);
  assert.equal((await Quiz.findById(quiz._id)).attemptCount, 2);
});

test('student quiz submission rejects malformed answers without marking or creating an attempt', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, { status: 'PUBLISHED' });
  await enroll(student, course);
  const agent = await login(student);
  const path = `${studentQuizPath(course._id, quiz._id)}/attempts`;

  for (const body of [
    {},
    { answers: null },
    { answers: [] },
    { answers: [2] },
    { answers: [-1] },
    { answers: [1.5] },
    { answers: ['1'] },
    { answers: [false] }
  ]) {
    await agent.post(path).send(body).expect(400);
  }
  assert.equal(await QuizAttempt.countDocuments({ quiz: quiz._id }), 0);
  assert.equal((await Quiz.findById(quiz._id)).attemptCount, 0);
});

test('student quiz submission compensates the attempt marker when attempt persistence fails', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, { status: 'PUBLISHED' });
  await enroll(student, course);
  const originalCreate = QuizAttempt.create;
  QuizAttempt.create = async () => {
    throw new Error('simulated attempt storage failure');
  };

  try {
    const response = await (await login(student))
      .post(`${studentQuizPath(course._id, quiz._id)}/attempts`)
      .send({ answers: [1] })
      .expect(500);
    assert.equal(response.body.message, 'Could not save quiz attempt');
    assert.equal(await QuizAttempt.countDocuments({ quiz: quiz._id }), 0);
    assert.equal((await Quiz.findById(quiz._id)).attemptCount, 0);
  } finally {
    QuizAttempt.create = originalCreate;
  }
});

test('student quiz submission retains its marker when persistence succeeds but acknowledgement fails', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, { status: 'PUBLISHED' });
  await enroll(student, course);
  const originalCreate = QuizAttempt.create;
  QuizAttempt.create = async (attempt) => {
    await originalCreate.call(QuizAttempt, attempt);
    throw new Error('simulated acknowledgement failure');
  };

  try {
    const studentAgent = await login(student);
    const response = await studentAgent
      .post(`${studentQuizPath(course._id, quiz._id)}/attempts`)
      .send({ answers: [1] })
      .expect(500);
    assert.equal(response.body.message, 'Could not save quiz attempt');
    assert.equal(await QuizAttempt.countDocuments({ quiz: quiz._id }), 1);
    assert.equal((await Quiz.findById(quiz._id)).attemptCount, 1);

    const ownerAgent = await login(owner);
    await ownerAgent.patch(quizPath(course._id, quiz._id)).send({ title: 'Must remain immutable' }).expect(409);
    await ownerAgent.delete(quizPath(course._id, quiz._id)).expect(409);
  } finally {
    QuizAttempt.create = originalCreate;
  }
});

test('student quiz attempt history is private, has no answer key, and chooses the newest best score on ties', async () => {
  const owner = await createUser('INSTRUCTOR');
  const student = await createUser('STUDENT');
  const otherStudent = await createUser('STUDENT');
  const unenrolledStudent = await createUser('STUDENT');
  const course = await createCourse(owner);
  const quiz = await createQuiz(course, { status: 'PUBLISHED' });
  await Promise.all([enroll(student, course), enroll(otherStudent, course)]);
  const path = studentQuizPath(course._id, quiz._id);
  const agent = await login(student);
  const older = await agent.post(`${path}/attempts`).send({ answers: [1] }).expect(201);
  const newer = await agent.post(`${path}/attempts`).send({ answers: [1] }).expect(201);

  const history = await agent.get(`${path}/attempts`).expect(200);
  assert.equal(history.body.attempts.length, 2);
  assert.equal(history.body.attempts[0].id, newer.body.attempt.id);
  assert.equal(history.body.best.id, newer.body.attempt.id);
  assert.deepEqual(history.body.attempts[0].answers, [1]);
  assert.equal(history.body.attempts[0].correctOptionIndex, undefined);
  assert.equal(history.body.attempts[0].review, undefined);

  const otherHistory = await (await login(otherStudent)).get(`${path}/attempts`).expect(200);
  assert.deepEqual(otherHistory.body.attempts, []);
  assert.equal(otherHistory.body.best, null);
  await (await login(unenrolledStudent)).get(`${path}/attempts`).expect(403);
  assert.notEqual(older.body.attempt.id, newer.body.attempt.id);
});
