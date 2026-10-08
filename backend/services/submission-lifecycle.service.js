const mongoose = require('mongoose');
const Assignment = require('../models/assignment.schema');
const Submission = require('../models/submission.schema');
const SubmissionState = require('../models/submission-state.schema');
const AppError = require('../utils/appError');

function transactionUnavailable(error) {
  return Boolean(error && /Transaction numbers are only allowed|does not support transactions|transactions unsupported|replica set/i.test(error.message));
}

async function withSubmissionStateTransaction(work) {
  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (transactionUnavailable(error)) {
      throw new AppError('Submission processing is temporarily unavailable', 503);
    }
    throw error;
  } finally {
    if (session) await session.endSession();
  }
}

async function reviewLatestSubmission({ assignment, submission, review, reviewerId }) {
  return withSubmissionStateTransaction(async (session) => {
    const state = await SubmissionState.findOneAndUpdate(
      {
        assignment: assignment._id,
        course: assignment.course,
        student: submission.student,
        latestSubmission: submission._id,
        status: 'SUBMITTED'
      },
      { $set: { status: review.status } },
      { new: true, session, runValidators: true }
    );
    if (!state) {
      throw new AppError('Only the latest unreviewed submission version can be reviewed', 400);
    }

    const updated = await Submission.findOneAndUpdate(
      { _id: submission._id, status: 'SUBMITTED' },
      {
        $set: {
          ...review,
          gradedAt: new Date(),
          gradedBy: reviewerId
        }
      },
      { new: true, session, runValidators: true }
    );
    if (!updated) {
      throw new AppError('A reviewed submission cannot be reviewed again', 400);
    }
    return updated;
  });
}

// Task 3 must call this after validating the student payload and uploading any
// asset.  The caller cleans an uploaded asset if this transaction rejects.
async function createSubmissionVersion({ assignment, course, student, submission }) {
  return withSubmissionStateTransaction(async (session) => {
    const reservedAssignment = await Assignment.findOneAndUpdate(
      { _id: assignment._id, course: course._id, status: 'PUBLISHED' },
      { $inc: { submissionCount: 1 } },
      { new: true, session }
    );
    if (!reservedAssignment) {
      throw new AppError('Assignment is not accepting submissions', 409);
    }

    const state = await SubmissionState.findOne({
      assignment: assignment._id,
      course: course._id,
      student: student._id
    }).session(session);
    if (state && state.status === 'GRADED') {
      throw new AppError('A graded submission cannot be replaced', 400);
    }

    const version = state ? state.latestVersion + 1 : 1;
    const [created] = await Submission.create([{
      ...submission,
      assignment: assignment._id,
      course: course._id,
      student: student._id,
      version,
      status: 'SUBMITTED',
      marks: null,
      feedback: '',
      gradedAt: null,
      gradedBy: null
    }], { session });

    if (state) {
      state.latestVersion = created.version;
      state.latestSubmission = created._id;
      state.status = 'SUBMITTED';
      await state.save({ session });
    } else {
      await SubmissionState.create([{
        assignment: assignment._id,
        course: course._id,
        student: student._id,
        latestVersion: created.version,
        latestSubmission: created._id,
        status: 'SUBMITTED'
      }], { session });
    }
    return created;
  });
}

module.exports = {
  createSubmissionVersion,
  reviewLatestSubmission,
  withSubmissionStateTransaction
};
