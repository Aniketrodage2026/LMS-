const express = require('express');
const mongoose = require('mongoose');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const upload = require('../middleware/multer.middleware');
const AppError = require('../utils/appError');
const {
  createStudentSubmission,
  downloadSubmissionFile,
  getStudentAssignment,
  listStudentAssignments,
  listStudentSubmissions
} = require('../controller/student-assignment.controller');

const router = express.Router({ mergeParams: true });

function validateObjectId(name) {
  return (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params[name])) {
      return next(new AppError('Choose a valid course and assessment.', 400, 'ASSESSMENT_INVALID_REQUEST'));
    }
    return next();
  };
}

router.use(isLoggedIn);
router.use(validateObjectId('courseId'));

router.get('/:assignmentId/submissions/:submissionId/file',
  validateObjectId('assignmentId'), validateObjectId('submissionId'), downloadSubmissionFile);

router.use(requireRole('STUDENT'));

router.route('/')
  .get(listStudentAssignments);

router.route('/:assignmentId')
  .get(validateObjectId('assignmentId'), getStudentAssignment);

router.route('/:assignmentId/submissions')
  .post(validateObjectId('assignmentId'), upload.submission.single('file'), createStudentSubmission)
  .get(validateObjectId('assignmentId'), listStudentSubmissions);

module.exports = router;
