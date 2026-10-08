const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const AppError = require('../utils/appError');
const { validObjectId } = require('../services/quiz.service');
const {
  getStudentQuiz,
  listStudentQuizAttempts,
  listStudentQuizzes,
  submitStudentQuizAttempt
} = require('../controller/student-quiz.controller');

const router = express.Router({ mergeParams: true });

function validateObjectId(name) {
  return (req, res, next) => {
    if (!validObjectId(req.params[name])) {
      return next(new AppError(`Invalid ${name} format`, 400));
    }
    return next();
  };
}

router.use(isLoggedIn, requireRole('STUDENT'));
router.use(validateObjectId('courseId'));

router.route('/')
  .get(listStudentQuizzes);

router.route('/:quizId')
  .get(validateObjectId('quizId'), getStudentQuiz);

router.route('/:quizId/attempts')
  .post(validateObjectId('quizId'), submitStudentQuizAttempt)
  .get(validateObjectId('quizId'), listStudentQuizAttempts);

module.exports = router;
