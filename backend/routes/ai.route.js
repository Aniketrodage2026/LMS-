const express = require('express');
const { isLoggedIn, optionalAuth, requireRole } = require('../middleware/auth.middleware');
const { createAiController, aiErrorHandler } = require('../controller/ai.controller');

function createAiRouter(options, tutorOptions) {
  const router = express.Router();
  const controller = createAiController(options, tutorOptions);
  router.post('/chatbot', optionalAuth, controller.chatbot);
  router.use(isLoggedIn, requireRole('STUDENT'));
  router.post('/course-practice', controller.coursePractice);
  router.get('/coach', controller.learningCoach);
  router.get('/study-plan', controller.studyPlan);
  router.post('/study-plan/preview', controller.previewStudyPlan);
  router.put('/study-plan', controller.saveStudyPlan);
  router.delete('/study-plan', controller.deleteStudyPlan);
  router.get('/profile', controller.getProfile);
  router.put('/profile', controller.putProfile);
  router.get('/recommendations', controller.recommendations);
  router.get('/guidance', controller.guidance);
  router.post('/chat', controller.chat);
  router.post('/course-tutor', controller.courseTutor);
  return router;
}

module.exports = { createAiRouter, aiErrorHandler };
