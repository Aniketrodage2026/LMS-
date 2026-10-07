const express = require('express');
const mongoose = require('mongoose');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const upload = require('../middleware/multer.middleware');
const AppError = require('../utils/appError');
const {
  createStudentSubmission,
  getStudentAssignment,
  listStudentAssignments,
  listStudentSubmissions
} = require('../controller/student-assignment.controller');

const router = express.Router({ mergeParams: true });

function validateObjectId(name) {
  return (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params[name])) {
      return next(new AppError(`Invalid ${name} format`, 400));
    }
    return next();
  };
}

router.use(isLoggedIn, requireRole('STUDENT'));
router.use(validateObjectId('courseId'));

router.route('/')
  .get(listStudentAssignments);

router.route('/:assignmentId')
  .get(validateObjectId('assignmentId'), getStudentAssignment);

router.route('/:assignmentId/submissions')
  .post(validateObjectId('assignmentId'), upload.submission.single('file'), createStudentSubmission)
  .get(validateObjectId('assignmentId'), listStudentSubmissions);

module.exports = router;
