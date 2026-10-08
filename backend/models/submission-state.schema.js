const mongoose = require('mongoose');

function isInteger(value) {
  return Number.isInteger(value);
}

const submissionStateSchema = new mongoose.Schema({
  assignment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Assignment',
    required: true,
    immutable: true
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
    immutable: true
  },
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  latestVersion: {
    type: Number,
    required: true,
    min: 1,
    cast: false,
    validate: {
      validator: isInteger,
      message: 'latestVersion must be a positive integer'
    }
  },
  latestSubmission: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true
  },
  status: {
    type: String,
    required: true,
    enum: ['SUBMITTED', 'GRADED', 'RESUBMISSION_REQUESTED'],
    cast: false
  }
}, { timestamps: true });

submissionStateSchema.index({ assignment: 1, student: 1 }, { unique: true });
submissionStateSchema.index({ assignment: 1, course: 1, student: 1 });

module.exports = mongoose.model('SubmissionState', submissionStateSchema);
