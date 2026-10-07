const mongoose = require('mongoose');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Quiz = require('../models/quiz.schema');
const AppError = require('../utils/appError');

function gradeAttempt(quiz, answers) {
  const correctAnswers = quiz.questions.reduce((count, question, index) => (
    answers[index] === question.correctOptionIndex ? count + 1 : count
  ), 0);
  const totalQuestions = quiz.questions.length;
  const percentage = Math.round((correctAnswers / totalQuestions) * 100);

  return {
    correctAnswers,
    totalQuestions,
    score: correctAnswers,
    percentage,
    passed: percentage >= quiz.passMark
  };
}

function validObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function publicQuizCard(quiz) {
  return {
    id: String(quiz._id),
    title: quiz.title,
    instructions: quiz.instructions,
    passMark: quiz.passMark
  };
}

function publicQuiz(quiz) {
  return {
    ...publicQuizCard(quiz),
    questions: quiz.questions.map((question) => ({
      id: String(question._id),
      prompt: question.prompt,
      options: question.options
    }))
  };
}

function attemptSummary(attempt, { includeAnswers = false } = {}) {
  const summary = {
    id: String(attempt._id),
    score: attempt.score,
    correctAnswers: attempt.correctAnswers,
    totalQuestions: attempt.totalQuestions,
    percentage: attempt.percentage,
    passed: attempt.passed,
    submittedAt: attempt.submittedAt
  };
  if (includeAnswers) summary.answers = attempt.answers;
  return summary;
}

async function requireStudentCourseAccess(studentId, courseId) {
  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found', 404);

  const enrollment = await Enrollment.exists({
    student: studentId,
    course: course._id,
    status: 'ACTIVE'
  });
  if (!enrollment) {
    throw new AppError('Purchase or enrol in this course to access this quiz', 403);
  }
  return course;
}

async function requireStudentQuizAccess(studentId, courseId, quizId) {
  const course = await requireStudentCourseAccess(studentId, courseId);
  const quiz = await Quiz.findOne({ _id: quizId, course: course._id, status: 'PUBLISHED' });
  if (!quiz) throw new AppError('Quiz not found', 404);
  return quiz;
}

function validateAnswers(quiz, answers) {
  if (!Array.isArray(answers) || answers.length !== quiz.questions.length) {
    throw new AppError('answers must contain one value per quiz question', 400);
  }

  for (const [index, answer] of answers.entries()) {
    const optionCount = quiz.questions[index].options.length;
    if (answer !== null && (!Number.isInteger(answer) || answer < 0 || answer >= optionCount)) {
      throw new AppError(`answers[${index}] must be null or a valid option index`, 400);
    }
  }
}

module.exports = {
  attemptSummary,
  gradeAttempt,
  publicQuiz,
  publicQuizCard,
  requireStudentCourseAccess,
  requireStudentQuizAccess,
  validObjectId,
  validateAnswers
};
