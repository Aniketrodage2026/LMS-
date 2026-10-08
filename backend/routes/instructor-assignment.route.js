const express = require('express');
const {
  createAssignment,
  listInstructorAssignments,
  updateAssignment,
  deleteAssignment,
  listAssignmentSubmissions,
  reviewSubmission
} = require('../controller/instructor-assignment.controller');

const router = express.Router({ mergeParams: true });

router.route('/')
  .post(createAssignment)
  .get(listInstructorAssignments);

router.route('/:assignmentId')
  .patch(updateAssignment)
  .delete(deleteAssignment);

router.get('/:assignmentId/submissions', listAssignmentSubmissions);
router.patch('/:assignmentId/submissions/:submissionId/review', reviewSubmission);

module.exports = router;
