const express = require('express');
const {
  createQuiz,
  listInstructorQuizzes,
  updateQuiz,
  deleteQuiz
} = require('../controller/instructor-quiz.controller');

const router = express.Router({ mergeParams: true });

router.route('/')
  .post(createQuiz)
  .get(listInstructorQuizzes);

router.route('/:quizId')
  .patch(updateQuiz)
  .delete(deleteQuiz);

module.exports = router;
