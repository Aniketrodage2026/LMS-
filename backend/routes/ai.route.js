const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const { createAiController, aiErrorHandler } = require('../controller/ai.controller');

function createAiRouter(options, tutorOptions) {
  const router = express.Router();
  const controller = createAiController(options, tutorOptions);
  router.use(isLoggedIn, requireRole('STUDENT'));
  router.get('/profile', controller.getProfile);
  router.put('/profile', controller.putProfile);
  router.get('/recommendations', controller.recommendations);
  router.get('/guidance', controller.guidance);
  router.post('/chat', controller.chat);
  router.post('/course-tutor', controller.courseTutor);
  return router;
}

module.exports = { createAiRouter, aiErrorHandler };
