const mongoose = require('mongoose');
const Assignment = require('../models/assignment.schema');
const Submission = require('../models/submission.schema');
const AppError = require('../utils/appError');
const { reviewLatestSubmission } = require('../services/submission-lifecycle.service');
const {
  hasText,
  instructorAssignment,
  instructorSubmissionSummary
} = require('../services/assignment.service');

const editableFields = new Set(['title', 'instructions', 'dueDate', 'maxMarks']);

function validObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function validationError(error) {
  if (error instanceof AppError) return error;
  return new AppError(error.message, error.name === 'ValidationError' ? 400 : 500);
}

function assignmentUpdates(body) {
  const keys = Object.keys(body || {});
  const unexpected = keys.find((key) => !editableFields.has(key));
  if (unexpected) throw new AppError(`Unsupported assignment field: ${unexpected}`, 400);
  if (keys.length === 0) throw new AppError('At least one assignment field is required', 400);
  return Object.fromEntries(keys.map((key) => [key, body[key]]));
}

function statusOnlyUpdate(body) {
  const keys = Object.keys(body || {});
  return keys.length === 1
    && keys[0] === 'status'
    && ['DRAFT', 'PUBLISHED'].includes(body.status);
}

async function findManagedAssignment(req) {
  const { assignmentId } = req.params;
  if (!validObjectId(assignmentId)) throw new AppError('Invalid assignmentId format', 400);
  const assignment = await Assignment.findOne({ _id: assignmentId, course: req.course._id });
  if (!assignment) throw new AppError('Assignment not found', 404);
  return assignment;
}

async function conditionalMutationFailure(req, assignmentId) {
  const current = await Assignment.findOne({ _id: assignmentId, course: req.course._id });
  if (!current) throw new AppError('Assignment not found', 404);
  if (current.submissionCount > 0) {
    throw new AppError('Assignments with submissions can only change status', 409);
  }
  throw new AppError('Assignment was modified before it could be updated', 409);
}

function validateReview(body, assignment) {
  const keys = Object.keys(body || {});
  if (body.action === 'GRADE') {
    if (keys.length !== 3 || !keys.every((key) => ['action', 'marks', 'feedback'].includes(key))) {
      throw new AppError('A grade requires only action, marks, and feedback', 400);
    }
    if (!Number.isInteger(body.marks) || body.marks < 0 || body.marks > assignment.maxMarks) {
      throw new AppError('marks must be an integer within the assignment maximum', 400);
    }
    if (!hasText(body.feedback)) throw new AppError('feedback is required', 400);
    return { status: 'GRADED', marks: body.marks, feedback: body.feedback.trim() };
  }

  if (body.action === 'REQUEST_RESUBMISSION') {
    if (keys.length !== 2 || !keys.every((key) => ['action', 'feedback'].includes(key))) {
      throw new AppError('A resubmission request requires only action and feedback', 400);
    }
    if (!hasText(body.feedback)) throw new AppError('feedback is required', 400);
    return { status: 'RESUBMISSION_REQUESTED', marks: null, feedback: body.feedback.trim() };
  }

  throw new AppError('Invalid review action', 400);
}

exports.createAssignment = async (req, res, next) => {
  try {
    const { title, instructions, dueDate, maxMarks } = req.body;
    const assignment = await Assignment.create({
      course: req.course._id,
      title,
      instructions,
      dueDate,
      maxMarks,
      status: 'DRAFT',
      submissionCount: 0
    });
    return res.status(201).json({ success: true, assignment: instructorAssignment(assignment) });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.listInstructorAssignments = async (req, res, next) => {
  try {
    const assignments = await Assignment.find({ course: req.course._id }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, assignments: assignments.map(instructorAssignment) });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.updateAssignment = async (req, res, next) => {
  try {
    const assignment = await findManagedAssignment(req);

    if (statusOnlyUpdate(req.body)) {
      const updated = await Assignment.findOneAndUpdate(
        { _id: assignment._id, course: req.course._id },
        { $set: { status: req.body.status } },
        { new: true, runValidators: true }
      );
      if (!updated) throw new AppError('Assignment not found', 404);
      return res.status(200).json({ success: true, assignment: instructorAssignment(updated) });
    }

    if (assignment.submissionCount > 0) {
      throw new AppError('Assignments with submissions can only change status', 409);
    }

    const updates = assignmentUpdates(req.body);
    const candidate = new Assignment({ ...assignment.toObject(), ...updates });
    await candidate.validate();
    const updated = await Assignment.findOneAndUpdate(
      { _id: assignment._id, course: req.course._id, submissionCount: 0 },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updated) await conditionalMutationFailure(req, assignment._id);
    return res.status(200).json({ success: true, assignment: instructorAssignment(updated) });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.deleteAssignment = async (req, res, next) => {
  try {
    const assignment = await findManagedAssignment(req);
    if (assignment.submissionCount > 0) {
      throw new AppError('Assignments with submissions cannot be deleted', 409);
    }
    const deleted = await Assignment.findOneAndDelete({
      _id: assignment._id,
      course: req.course._id,
      submissionCount: 0
    });
    if (!deleted) await conditionalMutationFailure(req, assignment._id);
    return res.status(200).json({ success: true, message: 'Assignment deleted successfully' });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.listAssignmentSubmissions = async (req, res, next) => {
  try {
    const assignment = await findManagedAssignment(req);
    const submissions = await Submission.find({
      assignment: assignment._id,
      course: req.course._id
    })
      .populate('student', 'fullName email avatar')
      .sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      submissions: submissions.map(instructorSubmissionSummary)
    });
  } catch (error) {
    return next(validationError(error));
  }
};

exports.reviewSubmission = async (req, res, next) => {
  try {
    const assignment = await findManagedAssignment(req);
    const { submissionId } = req.params;
    if (!validObjectId(submissionId)) throw new AppError('Invalid submissionId format', 400);
    const submission = await Submission.findOne({
      _id: submissionId,
      assignment: assignment._id,
      course: req.course._id
    });
    if (!submission) throw new AppError('Submission not found', 404);

    const review = validateReview(req.body, assignment);
    const updated = await reviewLatestSubmission({
      assignment,
      submission,
      review,
      reviewerId: req.user._id
    });
    await updated.populate('student', 'fullName email avatar');
    return res.status(200).json({ success: true, submission: instructorSubmissionSummary(updated) });
  } catch (error) {
    return next(validationError(error));
  }
};
