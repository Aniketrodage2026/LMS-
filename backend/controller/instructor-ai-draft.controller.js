const AppError = require('../utils/appError');

function createInstructorAiDraftController(service) {
  return async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).sort().join(',') !== 'focus,kind') {
        throw new AppError('Choose a valid draft type and provide a focus of 1 to 300 characters.', 400, 'AI_DRAFT_INVALID');
      }
      const result = await service.generate({
        instructorId: req.user._id,
        courseId: req.course._id,
        course: req.course,
        kind: body.kind,
        focus: body.focus
      });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createInstructorAiDraftController };
