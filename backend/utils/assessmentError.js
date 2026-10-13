const AppError = require('./appError');

// Controllers share this boundary so schema/provider text never becomes public
// assessment copy. Explicit domain errors retain their status and safe message.
function assessmentError(error) {
  if (error instanceof AppError && error.code !== 'SYSTEM_UNEXPECTED') return error;
  if (error instanceof AppError) {
    if (error.statusCode === 404) return new AppError('This assessment is not available.', 404, 'ASSESSMENT_NOT_AVAILABLE');
    if (error.statusCode === 403) return new AppError('An active enrollment is required to access assessments.', 403, 'COURSE_ENROLLMENT_REQUIRED');
    if (error.statusCode === 409) return new AppError('This assessment has changed or has student work. Refresh it before making changes.', 409, 'ASSESSMENT_REVIEW_CONFLICT');
    if (error.statusCode === 400) return new AppError('Check the assessment details and try again.', 400, 'ASSESSMENT_INVALID_REQUEST');
    if (error.statusCode === 502) return new AppError('We could not upload your submission file. Try again shortly.', 502, 'UPLOAD_UNAVAILABLE');
    if (error.statusCode === 503) return new AppError('Submission processing is temporarily unavailable.', 503, 'ASSESSMENT_UNAVAILABLE');
  }
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return new AppError('Check the assessment details and try again.', 400, 'ASSESSMENT_INVALID_REQUEST');
  }
  return new AppError('We could not complete this assessment request. Try again shortly.', 500, 'SYSTEM_UNEXPECTED');
}

module.exports = assessmentError;
