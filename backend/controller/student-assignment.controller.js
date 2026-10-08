const cloudinary = require('cloudinary');
const fs = require('node:fs/promises');
const Assignment = require('../models/assignment.schema');
const AppError = require('../utils/appError');
const {
  hasText,
  isHttpUrl,
  publicAssignment,
  requirePublishedStudentAssignment,
  requireStudentAssignmentCourseAccess,
  studentSubmissionSummary,
  validateSubmissionContent
} = require('../services/assignment.service');
const { createSubmissionVersion } = require('../services/submission-lifecycle.service');
const Submission = require('../models/submission.schema');

const permittedSubmissionFields = new Set(['writtenAnswer', 'projectUrl']);

async function removeLocalFile(file) {
  if (file && file.path) await fs.unlink(file.path).catch(() => undefined);
}

function validateSubmissionPayload(body = {}, file) {
  for (const key of Object.keys(body)) {
    if (!permittedSubmissionFields.has(key)) {
      throw new AppError(`Client-supplied ${key} is not allowed`, 400);
    }
  }
  if (body.writtenAnswer !== undefined && typeof body.writtenAnswer !== 'string') {
    throw new AppError('writtenAnswer must be text', 400);
  }
  if (body.projectUrl !== undefined && typeof body.projectUrl !== 'string') {
    throw new AppError('projectUrl must be a valid http or https URL', 400);
  }
  if (hasText(body.projectUrl) && !isHttpUrl(body.projectUrl)) {
    throw new AppError('projectUrl must be a valid http or https URL', 400);
  }
  if (!hasText(body.writtenAnswer) && !hasText(body.projectUrl) && !file) {
    validateSubmissionContent({ writtenAnswer: body.writtenAnswer, projectUrl: body.projectUrl });
  }
}

function resourceTypeFor(file) {
  return file.mimetype.startsWith('image/') ? 'image' : 'raw';
}

async function uploadSubmissionFile(file) {
  const resource_type = resourceTypeFor(file);
  const result = await cloudinary.v2.uploader.upload(file.path, {
    folder: 'lms/assignments',
    resource_type
  });
  if (!result || !hasText(result.public_id) || !isHttpUrl(result.secure_url)) {
    throw new AppError('Submission file upload failed', 502);
  }
  return {
    resourceType: resource_type,
    value: {
      public_id: result.public_id,
      secure_url: result.secure_url,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    }
  };
}

exports.listStudentAssignments = async (req, res, next) => {
  try {
    const course = await requireStudentAssignmentCourseAccess(req.user._id, req.params.courseId);
    const assignments = await Assignment.find({ course: course._id, status: 'PUBLISHED' })
      .sort({ createdAt: -1, _id: -1 });
    return res.status(200).json({ success: true, assignments: assignments.map(publicAssignment) });
  } catch (error) {
    return next(error);
  }
};

exports.getStudentAssignment = async (req, res, next) => {
  try {
    const assignment = await requirePublishedStudentAssignment(
      req.user._id,
      req.params.courseId,
      req.params.assignmentId
    );
    return res.status(200).json({ success: true, assignment: publicAssignment(assignment) });
  } catch (error) {
    return next(error);
  }
};

exports.createStudentSubmission = async (req, res, next) => {
  let uploaded;
  try {
    validateSubmissionPayload(req.body, req.file);
    const assignment = await requirePublishedStudentAssignment(
      req.user._id,
      req.params.courseId,
      req.params.assignmentId
    );
    const course = await requireStudentAssignmentCourseAccess(req.user._id, req.params.courseId);
    const file = req.file ? await uploadSubmissionFile(req.file) : null;
    uploaded = file;
    const submission = await createSubmissionVersion({
      assignment,
      course,
      student: req.user,
      submission: {
        writtenAnswer: hasText(req.body.writtenAnswer) ? req.body.writtenAnswer.trim() : '',
        projectUrl: hasText(req.body.projectUrl) ? req.body.projectUrl.trim() : '',
        file: file && file.value,
        late: Boolean(assignment.dueDate && new Date() > assignment.dueDate)
      }
    });
    return res.status(201).json({ success: true, submission: studentSubmissionSummary(submission) });
  } catch (error) {
    if (uploaded) {
      await cloudinary.v2.uploader.destroy(uploaded.value.public_id, { resource_type: uploaded.resourceType })
        .catch(() => undefined);
    }
    return next(error);
  } finally {
    await removeLocalFile(req.file);
  }
};

exports.listStudentSubmissions = async (req, res, next) => {
  try {
    const assignment = await requirePublishedStudentAssignment(
      req.user._id,
      req.params.courseId,
      req.params.assignmentId
    );
    const submissions = await Submission.find({ assignment: assignment._id, student: req.user._id })
      .sort({ createdAt: -1, _id: -1 });
    return res.status(200).json({ success: true, submissions: submissions.map(studentSubmissionSummary) });
  } catch (error) {
    return next(error);
  }
};
