const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const { gradeAttempt } = require('../services/quiz.service');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function validQuiz(overrides = {}) {
  return {
    course: new mongoose.Types.ObjectId(),
    title: '  JavaScript basics  ',
    passMark: 67,
    questions: [{
      prompt: '  Which keyword declares a variable?  ',
      options: [' var ', 'let'],
      correctOptionIndex: 1
    }],
    ...overrides
  };
}

function validAttempt(overrides = {}) {
  return {
    quiz: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    student: new mongoose.Types.ObjectId(),
    answers: [1, null],
    correctAnswers: 1,
    totalQuestions: 2,
    score: 1,
    percentage: 50,
    passed: false,
    ...overrides
  };
}

test.before(async () => {
  await connectTestDb();
  await Promise.all([Quiz.init(), QuizAttempt.init()]);
});

test.after(async () => {
  await disconnectTestDb();
});

test('quiz applies defaults, trims content, and declares course lookup indexes', async () => {
  const quiz = await Quiz.create(validQuiz());

  assert.equal(quiz.title, 'JavaScript basics');
  assert.equal(quiz.status, 'DRAFT');
  assert.equal(quiz.attemptCount, 0);
  assert.equal(quiz.instructions, undefined);
  assert.equal(quiz.questions[0].prompt, 'Which keyword declares a variable?');
  assert.equal(quiz.questions[0].options[0], 'var');
  assert.equal(quiz.questions[0].explanation, '');
  assert.equal(Quiz.schema.path('course').options.ref, 'Course');

  const indexes = Quiz.schema.indexes();
  assert.ok(indexes.some(([keys]) => keys.course === 1 && keys.status === 1));
  assert.ok(indexes.some(([keys]) => keys.course === 1 && Object.keys(keys).length === 1));
});

test('quiz attemptCount is a nonnegative integer with a zero default', async () => {
  for (const attemptCount of [-1, 0.5]) {
    await assert.rejects(
      () => new Quiz(validQuiz({ attemptCount })).validate(),
      (error) => Boolean(error.errors.attemptCount)
    );
  }
});

test('quiz requires a course, nonempty title, integer pass mark, and at least one question', async () => {
  for (const overrides of [
    { course: undefined },
    { title: '   ' },
    { passMark: 0 },
    { passMark: 100.5 },
    { passMark: 101 },
    { questions: [] }
  ]) {
    await assert.rejects(() => new Quiz(validQuiz(overrides)).validate(), mongoose.Error.ValidationError);
  }
});

test('quiz rejects options outside 2 through 6 or duplicated after case and whitespace normalization', async () => {
  for (const options of [
    ['only one'],
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
    [' Yes ', 'yes']
  ]) {
    const quiz = new Quiz(validQuiz({
      questions: [{ prompt: 'Choose', options, correctOptionIndex: 0 }]
    }));
    await assert.rejects(
      () => quiz.validate(),
      (error) => Boolean(error.errors['questions.0.options'])
    );
  }
});

test('quiz rejects missing or out-of-range correct option indexes', async () => {
  for (const correctOptionIndex of [undefined, -1, 2, 0.5]) {
    const quiz = new Quiz(validQuiz({
      questions: [{ prompt: 'Choose', options: ['one', 'two'], correctOptionIndex }]
    }));
    await assert.rejects(
      () => quiz.validate(),
      (error) => Boolean(error.errors['questions.0.correctOptionIndex'])
    );
  }
});

test('quiz question prompt and options must be nonempty strings', async () => {
  for (const question of [
    { prompt: '   ', options: ['one', 'two'], correctOptionIndex: 0 },
    { prompt: 'Choose', options: ['one', '   '], correctOptionIndex: 0 }
  ]) {
    await assert.rejects(
      () => new Quiz(validQuiz({ questions: [question] })).validate(),
      mongoose.Error.ValidationError
    );
  }
});

test('quiz attempt records timestamps, required results, and a student quiz history index', async () => {
  const attempt = await QuizAttempt.create(validAttempt());

  assert.ok(attempt.submittedAt instanceof Date);
  assert.ok(attempt.createdAt instanceof Date);
  assert.ok(attempt.updatedAt instanceof Date);
  assert.equal(QuizAttempt.schema.path('quiz').options.ref, 'Quiz');
  assert.equal(QuizAttempt.schema.path('course').options.ref, 'Course');
  assert.equal(QuizAttempt.schema.path('student').options.ref, 'User');
  assert.ok(QuizAttempt.schema.indexes().some(([keys]) => (
    keys.student === 1 && keys.quiz === 1 && keys.submittedAt === -1
  )));

  const incomplete = new QuizAttempt(validAttempt({ score: undefined }));
  await assert.rejects(
    () => incomplete.validate(),
    (error) => Boolean(error.errors.score)
  );
});

test('quiz attempt answer and calculated result fields cannot change after creation', async () => {
  const attempt = await QuizAttempt.create(validAttempt());
  const original = {
    answers: [...attempt.answers],
    correctAnswers: attempt.correctAnswers,
    totalQuestions: attempt.totalQuestions,
    score: attempt.score,
    percentage: attempt.percentage,
    passed: attempt.passed,
    submittedAt: attempt.submittedAt.getTime()
  };

  attempt.answers = [0, 1];
  attempt.correctAnswers = 2;
  attempt.totalQuestions = 99;
  attempt.score = 2;
  attempt.percentage = 100;
  attempt.passed = true;
  attempt.submittedAt = new Date(0);
  await attempt.save();

  const persisted = await QuizAttempt.findById(attempt._id).lean();
  assert.deepEqual(persisted.answers, original.answers);
  assert.equal(persisted.correctAnswers, original.correctAnswers);
  assert.equal(persisted.totalQuestions, original.totalQuestions);
  assert.equal(persisted.score, original.score);
  assert.equal(persisted.percentage, original.percentage);
  assert.equal(persisted.passed, original.passed);
  assert.equal(persisted.submittedAt.getTime(), original.submittedAt);
});

test('quiz attempt rejects malformed answer arrays and inconsistent server-calculated results', async () => {
  const invalidAttempts = [
    { answers: 'not an array' },
    { answers: [1], totalQuestions: 2 },
    { answers: [1, -1] },
    { answers: [1, 0.5] },
    { answers: [1, '0'] },
    { correctAnswers: -1 },
    { correctAnswers: 3 },
    { totalQuestions: 0 },
    { totalQuestions: '2' },
    { score: 0 },
    { percentage: 49 },
    { passed: 'false' }
  ];

  for (const overrides of invalidAttempts) {
    await assert.rejects(
      () => new QuizAttempt(validAttempt(overrides)).validate(),
      mongoose.Error.ValidationError
    );
  }
});

test('gradeAttempt grades null answers server-side and rounds percentage at the pass threshold', () => {
  const quiz = {
    passMark: 67,
    questions: [
      { correctOptionIndex: 0 },
      { correctOptionIndex: 1 },
      { correctOptionIndex: 1 }
    ]
  };

  assert.deepEqual(gradeAttempt(quiz, [0, null, 1]), {
    correctAnswers: 2,
    totalQuestions: 3,
    score: 2,
    percentage: 67,
    passed: true
  });
  assert.deepEqual(gradeAttempt({ ...quiz, passMark: 68 }, [0, null, 1]), {
    correctAnswers: 2,
    totalQuestions: 3,
    score: 2,
    percentage: 67,
    passed: false
  });
});
