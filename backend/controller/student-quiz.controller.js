const mongoose = require('mongoose');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const AppError = require('../utils/appError');
const {
  attemptSummary,
  gradeAttempt,
  publicQuiz,
  publicQuizCard,
  requireStudentCourseAccess,
  requireStudentQuizAccess,
  validateAnswers
} = require('../services/quiz.service');

function safePersistenceError(error) {
  if (error instanceof AppError) return error;
  return new AppError('Could not save quiz attempt', 500);
}

exports.listStudentQuizzes = async (req, res, next) => {
  try {
    const course = await requireStudentCourseAccess(req.user._id, req.params.courseId);
    const quizzes = await Quiz.find({ course: course._id, status: 'PUBLISHED' }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, quizzes: quizzes.map(publicQuizCard) });
  } catch (error) {
    return next(error);
  }
};

exports.getStudentQuiz = async (req, res, next) => {
  try {
    const quiz = await requireStudentQuizAccess(req.user._id, req.params.courseId, req.params.quizId);
    return res.status(200).json({ success: true, quiz: publicQuiz(quiz) });
  } catch (error) {
    return next(error);
  }
};

exports.submitStudentQuizAttempt = async (req, res, next) => {
  try {
    const quiz = await requireStudentQuizAccess(req.user._id, req.params.courseId, req.params.quizId);
    validateAnswers(quiz, req.body && req.body.answers);

    const markedQuiz = await Quiz.findOneAndUpdate(
      { _id: quiz._id, course: quiz.course, status: 'PUBLISHED' },
      { $inc: { attemptCount: 1 } },
      { new: true }
    );
    if (!markedQuiz) throw new AppError('Quiz not found', 404);

    const grading = gradeAttempt(markedQuiz, req.body.answers);
    const attemptId = new mongoose.Types.ObjectId();
    let attempt;
    try {
      attempt = await QuizAttempt.create({
        _id: attemptId,
        quiz: markedQuiz._id,
        course: markedQuiz.course,
        student: req.user._id,
        answers: req.body.answers,
        ...grading
      });
    } catch (error) {
      try {
        const persistedAttempt = await QuizAttempt.exists({ _id: attemptId });
        if (persistedAttempt === null) {
          await Quiz.updateOne(
            { _id: markedQuiz._id, course: markedQuiz.course, attemptCount: { $gt: 0 } },
            { $inc: { attemptCount: -1 } }
          );
        }
      } catch (compensationError) {
        // Preserve the original storage failure as the safe response.
      }
      return next(safePersistenceError(error));
    }

    const review = markedQuiz.questions.map((question, index) => ({
      questionId: String(question._id),
      selectedOptionIndex: attempt.answers[index],
      correctOptionIndex: question.correctOptionIndex,
      explanation: question.explanation
    }));
    return res.status(201).json({
      success: true,
      attempt: attemptSummary(attempt),
      review
    });
  } catch (error) {
    return next(error);
  }
};

exports.listStudentQuizAttempts = async (req, res, next) => {
  try {
    const quiz = await requireStudentQuizAccess(req.user._id, req.params.courseId, req.params.quizId);
    const attempts = await QuizAttempt.find({ quiz: quiz._id, student: req.user._id })
      .sort({ submittedAt: -1, _id: -1 });
    const summaries = attempts.map((attempt) => attemptSummary(attempt, { includeAnswers: true }));
    const bestAttempt = attempts.reduce((best, attempt) => (
      !best
      || attempt.percentage > best.percentage
      || (attempt.percentage === best.percentage && attempt.submittedAt > best.submittedAt)
        ? attempt
        : best
    ), null);

    return res.status(200).json({
      success: true,
      attempts: summaries,
      best: bestAttempt ? attemptSummary(bestAttempt, { includeAnswers: true }) : null
    });
  } catch (error) {
    return next(error);
  }
};
