const cloudinary = require('cloudinary');
const fs = require('node:fs/promises');
const mongoose = require('mongoose');
const Assignment = require('../models/assignment.schema');
const Course = require('../models/course.schema');
const AppError = require('../utils/appError');
const assessmentError = require('../utils/assessmentError');
const { canManageCourse } = require('../services/course-access.service');
const { CLOUDINARY, R2, objectKeyFor } = require('../services/media-storage.service');
const { createRuntimeMediaStorageFactory } = require('../services/runtime-media-storage.service');
const { validateStoredUpload } = require('../services/media-validation.service');
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
let mediaStorageFactory = createRuntimeMediaStorageFactory({ cloudinary });

function setMediaStorageFactoryForTests(factory) {
  const previous = mediaStorageFactory;
  mediaStorageFactory = factory;
  return () => { mediaStorageFactory = previous; };
}

async function removeLocalFile(file) {
  if (file && file.path) await fs.unlink(file.path).catch(() => undefined);
}

function validateSubmissionPayload(body = {}, file) {
  body ||= {};
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

function configuredMediaStorage() {
  const storage = mediaStorageFactory.get();
  return {
    provider: mediaStorageFactory.provider || (process.env.R2_ENABLED === 'true' ? R2 : CLOUDINARY),
    storage
  };
}

async function uploadSubmissionFile(file, course, assignment) {
  let provider;
  let storage;
  try {
    ({ provider, storage } = configuredMediaStorage());
    const media = await validateStoredUpload(file, 'submission');
    const resourceType = media.contentType.startsWith('image/') ? 'image' : 'raw';
    const uploaded = await storage.uploadLocalFile({
      provider,
      localPath: file.path,
      key: provider === R2
        ? `assignments/${course._id}/assignments/${assignment._id}/${objectKeyFor({ category: 'assignments', extension: media.extension }).split('/').at(-1)}`
        : undefined,
      contentType: media.contentType,
      size: media.size,
      options: { folder: 'lms/assignments', resource_type: resourceType }
    });
    if (provider === CLOUDINARY && (!hasText(uploaded.public_id) || !isHttpUrl(uploaded.secure_url))) {
      throw new AppError('Submission file upload failed', 502, 'UPLOAD_UNAVAILABLE');
    }
    return {
      storage,
      resourceType,
      value: {
        ...uploaded,
        originalName: file.originalname,
        mimetype: media.contentType,
        size: media.size
      }
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('We could not upload your submission file. Try again shortly.', 502, 'UPLOAD_UNAVAILABLE');
  }
}

exports.listStudentAssignments = async (req, res, next) => {
  try {
    const course = await requireStudentAssignmentCourseAccess(req.user._id, req.params.courseId);
    const assignments = await Assignment.find({ course: course._id, status: 'PUBLISHED' })
      .sort({ createdAt: -1, _id: -1 });
    return res.status(200).json({ success: true, assignments: assignments.map(publicAssignment) });
  } catch (error) {
    return next(assessmentError(error));
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
    return next(assessmentError(error));
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
    const file = req.file ? await uploadSubmissionFile(req.file, course, assignment) : null;
    uploaded = file;
    const submission = await createSubmissionVersion({
      assignment,
      course,
      student: req.user,
      submission: {
        writtenAnswer: hasText(req.body.writtenAnswer) ? req.body.writtenAnswer.trim() : '',
        projectUrl: hasText(req.body.projectUrl) ? req.body.projectUrl.trim() : '',
        file: file?.value,
        late: Boolean(assignment.dueDate && new Date() > assignment.dueDate)
      }
    });
    return res.status(201).json({ success: true, submission: studentSubmissionSummary(submission) });
  } catch (error) {
    if (uploaded) {
      await uploaded.storage.remove(uploaded.value, { resource_type: uploaded.resourceType }).catch(() => undefined);
    }
    return next(assessmentError(error));
  } finally {
    await removeLocalFile(req.file);
  }
};

exports.downloadSubmissionFile = async (req, res, next) => {
  try {
    const { courseId, assignmentId, submissionId } = req.params;
    if (![courseId, assignmentId, submissionId].every(mongoose.Types.ObjectId.isValid)) {
      throw new AppError('Choose a valid assessment file.', 400, 'ASSESSMENT_INVALID_REQUEST');
    }
    const course = await Course.findById(courseId);
    if (!course) throw new AppError('Course not found', 404, 'ASSESSMENT_NOT_AVAILABLE');
    const assignment = await Assignment.findOne({ _id: assignmentId, course: course._id });
    if (!assignment) throw new AppError('Assignment not found', 404, 'ASSESSMENT_NOT_AVAILABLE');
    const submission = await Submission.findOne({ _id: submissionId, assignment: assignment._id, course: course._id });
    if (!submission || !submission.file) throw new AppError('Submission file not found', 404, 'ASSESSMENT_NOT_AVAILABLE');

    if (req.user.role === 'STUDENT') {
      await requireStudentAssignmentCourseAccess(req.user._id, course._id);
      if (!submission.student.equals(req.user._id)) {
        throw new AppError('You do not have access to this submission file.', 403, 'AUTH_ROLE_FORBIDDEN');
      }
    } else if (!await canManageCourse(req.user, course)) {
      throw new AppError('You do not have access to this submission file.', 403, 'AUTH_ROLE_FORBIDDEN');
    }

    let url;
    try {
      url = await configuredMediaStorage().storage.signedReadUrl(submission.file);
    } catch {
      throw new AppError('We could not prepare this file download. Please try again shortly.', 503, 'MEDIA_READ_UNAVAILABLE');
    }
    return res.status(302).set('Location', url).end();
  } catch (error) {
    return next(assessmentError(error));
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
    return next(assessmentError(error));
  }
};

exports.setMediaStorageFactoryForTests = setMediaStorageFactoryForTests;
