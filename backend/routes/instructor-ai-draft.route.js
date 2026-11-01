const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const { requireCourseManager } = require('./instructor-course.route');
const { createInstructorAiDraftService } = require('../services/instructor-ai-draft.service');
const { createInstructorAiDraftController } = require('../controller/instructor-ai-draft.controller');

function createInstructorAiDraftRouter(options = {}) {
  const router = express.Router();
  const service = options.service || createInstructorAiDraftService(options);
  router.post('/:courseId/ai-drafts', isLoggedIn, requireRole('INSTRUCTOR'), requireCourseManager,
    createInstructorAiDraftController(service));
  return router;
}

module.exports = { createInstructorAiDraftRouter };
