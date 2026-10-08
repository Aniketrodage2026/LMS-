const mongoose = require('mongoose');
const { hasSubmissionFile, isHttpUrl } = require('../services/assignment.service');

function isInteger(value) {
  return Number.isInteger(value);
}

const submissionFileSchema = new mongoose.Schema({
  public_id: { type: String, required: true, trim: true, cast: false },
  secure_url: {
    type: String,
    required: true,
    trim: true,
    cast: false,
    validate: {
      validator: isHttpUrl,
      message: 'file secure_url must be an http or https URL'
    }
  },
  originalName: { type: String, required: true, trim: true, cast: false },
  mimetype: { type: String, required: true, trim: true, cast: false },
  size: {
    type: Number,
    required: true,
    min: 0,
    cast: false,
    validate: {
      validator: isInteger,
      message: 'file size must be a nonnegative integer'
    }
  }
}, { _id: false });

const submissionSchema = new mongoose.Schema({
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
  version: {
    type: Number,
    required: true,
    immutable: true,
    min: 1,
    cast: false,
    validate: {
      validator: isInteger,
      message: 'version must be a positive integer'
    }
  },
  writtenAnswer: { type: String, trim: true, immutable: true, cast: false },
  projectUrl: {
    type: String,
    trim: true,
    immutable: true,
    cast: false,
    validate: {
      validator: (value) => value === undefined || value === null || value === '' || isHttpUrl(value),
      message: 'projectUrl must be an http or https URL'
    }
  },
  file: { type: submissionFileSchema, default: null, immutable: true },
  late: { type: Boolean, required: true, immutable: true, cast: false },
  status: {
    type: String,
    enum: ['SUBMITTED', 'GRADED', 'RESUBMISSION_REQUESTED'],
    default: 'SUBMITTED',
    cast: false
  },
  marks: {
    type: Number,
    default: null,
    min: 0,
    cast: false,
    validate: {
      validator: (value) => value === null || value === undefined || isInteger(value),
      message: 'marks must be a nonnegative integer'
    }
  },
  feedback: { type: String, trim: true, default: '', cast: false },
  gradedAt: { type: Date, default: null },
  gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

submissionSchema.pre('validate', function validateSubmission(next) {
  const hasWrittenAnswer = typeof this.writtenAnswer === 'string' && this.writtenAnswer.trim().length > 0;
  const hasProjectUrl = isHttpUrl(this.projectUrl);

  if (!hasWrittenAnswer && !hasProjectUrl && !hasSubmissionFile(this.file)) {
    this.invalidate('submissionContent', 'submission content is required');
  }
  next();
});

submissionSchema.index({ assignment: 1, student: 1, version: 1 }, { unique: true });
submissionSchema.index({ assignment: 1, student: 1, createdAt: -1 });

module.exports = mongoose.model('Submission', submissionSchema);
