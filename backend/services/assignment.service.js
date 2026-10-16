const AppError = require('../utils/appError');
const mongoose = require('mongoose');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Assignment = require('../models/assignment.schema');

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpUrl(value) {
  if (!hasText(value)) return false;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function hasSubmissionFile(file) {
  const hasStorageRecord = Boolean(
    file?.storage
    && (file.storage.provider === 'CLOUDINARY' || file.storage.provider === 'R2')
    && hasText(file.storage.key)
    && hasText(file.storage.contentType)
    && Number.isInteger(file.storage.size)
    && file.storage.size >= 0
  );
  return Boolean(
    file
    && (hasStorageRecord || (hasText(file.public_id) && isHttpUrl(file.secure_url)))
    && hasText(file.originalName)
    && hasText(file.mimetype)
    && Number.isInteger(file.size)
    && file.size >= 0
  );
}

function validateSubmissionContent({ writtenAnswer, projectUrl, file } = {}) {
  if (hasText(writtenAnswer) || isHttpUrl(projectUrl) || hasSubmissionFile(file)) return;
  throw new AppError('submission content is required', 400);
}

async function requireStudentAssignmentCourseAccess(studentId, courseId) {
  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found', 404);
  const enrollment = await Enrollment.exists({ student: studentId, course: course._id, status: 'ACTIVE' });
  if (!enrollment) throw new AppError('Active enrollment is required to access assignments', 403);
  return course;
}

async function requirePublishedStudentAssignment(studentId, courseId, assignmentId) {
  if (!mongoose.Types.ObjectId.isValid(assignmentId)) {
    throw new AppError('Invalid assignmentId format', 400);
  }
  const course = await requireStudentAssignmentCourseAccess(studentId, courseId);
  const assignment = await Assignment.findOne({
    _id: assignmentId,
    course: course._id,
    status: 'PUBLISHED'
  });
  if (!assignment) throw new AppError('Assignment not found', 404);
  return assignment;
}

function publicAssignment(assignment) {
  return {
    id: String(assignment._id),
    title: assignment.title,
    instructions: assignment.instructions,
    dueDate: assignment.dueDate,
    maxMarks: assignment.maxMarks
  };
}

function submissionFileDownloadEndpoint(submission) {
  if (!submission?.file || !submission?.course || !submission?.assignment || !submission?._id) return null;
  return `/courses/${String(submission.course)}/assignments/${String(submission.assignment)}/submissions/${String(submission._id)}/file`;
}

function safeSubmissionFile(submission) {
  if (!submission?.file) return null;
  return {
    originalName: submission.file.originalName,
    mimetype: submission.file.mimetype,
    size: submission.file.size,
    downloadEndpoint: submissionFileDownloadEndpoint(submission)
  };
}

function studentSubmissionSummary(submission) {
  return {
    id: String(submission._id),
    version: submission.version,
    writtenAnswer: submission.writtenAnswer,
    projectUrl: submission.projectUrl,
    file: safeSubmissionFile(submission),
    late: submission.late,
    status: submission.status,
    marks: submission.marks,
    feedback: submission.feedback,
    gradedAt: submission.gradedAt
  };
}

function instructorAssignment(assignment) {
  return {
    id: String(assignment._id),
    courseId: String(assignment.course),
    title: assignment.title,
    instructions: assignment.instructions,
    dueDate: assignment.dueDate,
    maxMarks: assignment.maxMarks,
    status: assignment.status,
    submissionCount: assignment.submissionCount,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt
  };
}

function instructorSubmissionSummary(submission) {
  const student = submission.student || {};
  return {
    id: String(submission._id),
    student: {
      id: String(student._id || student),
      fullName: student.fullName,
      email: student.email,
      avatar: student.avatar && { secureUrl: student.avatar.secure_url }
    },
    version: submission.version,
    writtenAnswer: submission.writtenAnswer,
    projectUrl: submission.projectUrl,
    file: safeSubmissionFile(submission),
    late: submission.late,
    status: submission.status,
    marks: submission.marks,
    feedback: submission.feedback,
    gradedAt: submission.gradedAt,
    gradedBy: submission.gradedBy && String(submission.gradedBy),
    createdAt: submission.createdAt
  };
}

module.exports = {
  hasSubmissionFile,
  hasText,
  instructorAssignment,
  instructorSubmissionSummary,
  isHttpUrl,
  publicAssignment,
  requirePublishedStudentAssignment,
  requireStudentAssignmentCourseAccess,
  safeSubmissionFile,
  submissionFileDownloadEndpoint,
  studentSubmissionSummary,
  validateSubmissionContent
};
