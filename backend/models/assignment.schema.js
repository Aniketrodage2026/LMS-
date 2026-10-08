const mongoose = require('mongoose');

function isInteger(value) {
  return Number.isInteger(value);
}

const assignmentSchema = new mongoose.Schema({
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
    immutable: true
  },
  title: { type: String, required: true, trim: true, cast: false },
  instructions: { type: String, required: true, trim: true, cast: false },
  dueDate: { type: Date, default: null },
  maxMarks: {
    type: Number,
    required: true,
    min: 1,
    cast: false,
    validate: {
      validator: isInteger,
      message: 'maxMarks must be a positive integer'
    }
  },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT', cast: false },
  submissionCount: {
    type: Number,
    default: 0,
    min: 0,
    cast: false,
    validate: {
      validator: isInteger,
      message: 'submissionCount must be a nonnegative integer'
    }
  }
}, { timestamps: true });

assignmentSchema.index({ course: 1, status: 1 });
assignmentSchema.index({ course: 1 });

module.exports = mongoose.model('Assignment', assignmentSchema);
