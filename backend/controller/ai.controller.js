const AppError = require('../utils/appError');
const { RATE_LIMIT_MESSAGE } = require('../middleware/security.middleware');
const { saveProfile } = require('../services/ai/learning-profile.service');
const { getRecommendations } = require('../services/ai/recommendation.service');
const { buildStudentContext } = require('../services/ai/student-context.service');
const { createAssistantService, sanitizePublicDto } = require('../services/ai/assistant.service');
const { createCourseTutorService } = require('../services/course-tutor.service');

const PROFILE_FIELDS = ['careerGoal', 'interests', 'selfReportedSkills', 'experienceLevel', 'weeklyAvailabilityHours'];
const REQUIRED_PROFILE_FIELDS = ['careerGoal', 'interests', 'experienceLevel', 'weeklyAvailabilityHours'];
const ERRORS = {
  AI_REQUEST_INVALID: [400, 'Provide only valid parameters for this learning assistant request.'],
  AI_PROFILE_INVALID: [400, 'Provide valid learning profile fields and values.'],
  AI_CHAT_INVALID: [400, 'Provide a message of 1 to 2000 characters and, optionally, a valid courseId.'],
  AI_TUTOR_INVALID: [400, 'Provide a valid course, optional lecture, and a question of 1 to 2000 characters.'],
  AI_ENROLLMENT_REQUIRED: [403, 'An active published course enrollment is required'],
  AI_UNAVAILABLE: [503, 'The learning assistant is temporarily unavailable. Please try again later.'],
  AUTH_REQUIRED: [401, 'Authentication required'],
  AUTH_ROLE_FORBIDDEN: [403, 'Your account does not have permission to do that.'],
  SECURITY_RATE_LIMITED: [429, RATE_LIMIT_MESSAGE],
  REQUEST_INVALID_JSON: [400, 'This request contains invalid JSON. Check it and try again.'],
  REQUEST_TOO_LARGE: [413, 'This request is too large. Reduce it and try again.']
};

function requestError(code) {
  const [status, message] = ERRORS[code];
  return new AppError(message, status, code);
}

function onlyFields(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) throw requestError(code);
}

function validCourseId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function profileResponse(profile) {
  const missingFields = REQUIRED_PROFILE_FIELDS.filter((field) =>
    field === 'interests' ? !profile?.interests?.length : !profile?.[field]);
  return { success: true, profile: sanitizePublicDto(profile), missingFields };
}

function validateProfile(input) {
  onlyFields(input, PROFILE_FIELDS, 'AI_PROFILE_INVALID');
  for (const [field, value] of Object.entries(input)) {
    const valid = ['interests', 'selfReportedSkills'].includes(field)
      ? Array.isArray(value) && value.every((tag) => typeof tag === 'string')
      : field === 'weeklyAvailabilityHours' ? typeof value === 'number' && Number.isInteger(value)
        : typeof value === 'string';
    if (!valid) throw requestError('AI_PROFILE_INVALID');
  }
}

function createAiController(options, tutorOptions) {
  // Only backend construction can supply configuration/HTTP injection. Every chat
  // still uses Task 3's authorization, durable reservations, and immutable audit.
  const assistant = createAssistantService(options);
  const tutor = createCourseTutorService(tutorOptions);
  return {
    async courseTutor(req, res) {
      onlyFields(req.query, [], 'AI_TUTOR_INVALID');
      onlyFields(req.body, ['courseId', 'lectureId', 'question'], 'AI_TUTOR_INVALID');
      const { courseId, lectureId, question } = req.body;
      if (!validCourseId(courseId) || (lectureId !== undefined && !validCourseId(lectureId))
        || typeof question !== 'string' || !question.trim() || question.length > 2000) throw requestError('AI_TUTOR_INVALID');
      const result = await tutor.answerCourseQuestion({ studentId: req.user._id, courseId, lectureId, question });
      return res.set('Cache-Control', 'no-store').json({ success: true, tutor: result });
    },
    async getProfile(req, res) {
      onlyFields(req.query, [], 'AI_REQUEST_INVALID');
      const { profile } = await buildStudentContext(req.user._id);
      return res.status(200).json(profileResponse(profile));
    },

    async putProfile(req, res) {
      onlyFields(req.query, [], 'AI_REQUEST_INVALID');
      validateProfile(req.body);
      let profile;
      try {
        profile = await saveProfile(req.user._id, req.body);
      } catch (error) {
        if (['ValidationError', 'CastError', 'StrictModeError'].includes(error?.name)) {
          throw requestError('AI_PROFILE_INVALID');
        }
        throw error;
      }
      return res.status(200).json(profileResponse(profile));
    },

    async recommendations(req, res) {
      onlyFields(req.query, ['limit'], 'AI_REQUEST_INVALID');
      const value = req.query.limit;
      if (value !== undefined && (typeof value !== 'string' || !/^(?:[1-9]|1\d|20)$/.test(value))) {
        throw requestError('AI_REQUEST_INVALID');
      }
      const recommendations = await getRecommendations(req.user._id, value === undefined ? 5 : Number(value));
      return res.status(200).json({ success: true, recommendations: sanitizePublicDto(recommendations) });
    },

    async guidance(req, res) {
      onlyFields(req.query, ['courseId'], 'AI_REQUEST_INVALID');
      const { courseId } = req.query;
      if (courseId !== undefined && !validCourseId(courseId)) throw requestError('AI_REQUEST_INVALID');
      const { activeCourses } = await buildStudentContext(req.user._id, courseId);
      return res.status(200).json({ success: true, guidance: sanitizePublicDto({ activeCourses }) });
    },

    async chat(req, res) {
      onlyFields(req.query, [], 'AI_REQUEST_INVALID');
      onlyFields(req.body, ['message', 'courseId'], 'AI_CHAT_INVALID');
      const { message, courseId } = req.body;
      if (typeof message !== 'string' || !message.trim() || message.length > 2000
        || (courseId !== undefined && !validCourseId(courseId))) throw requestError('AI_CHAT_INVALID');
      const response = await assistant.respondToStudent({ studentId: req.user._id, message, courseId });
      return res.status(200).json({ success: true, assistant: response });
    }
  };
}

// Keep the common response/logging middleware, but never pass it raw model,
// parser, provider, or stack details, even when NODE_ENV is not production.
function aiErrorHandler(error, req, res, next) {
  let code = 'AI_UNAVAILABLE';
  if (error?.type === 'entity.too.large' || error?.status === 413) code = 'REQUEST_TOO_LARGE';
  else if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, 'body')) code = 'REQUEST_INVALID_JSON';
  else if (error instanceof AppError) {
    if (error.statusCode === 401) code = 'AUTH_REQUIRED';
    else if (error.statusCode === 403) code = error.code === 'AUTH_ROLE_FORBIDDEN' ? error.code : 'AI_ENROLLMENT_REQUIRED';
    else if (Object.hasOwn(ERRORS, error.code)) code = error.code;
  }
  const safeError = requestError(code);
  safeError.stack = undefined;
  return next(safeError);
}

module.exports = { createAiController, aiErrorHandler };
