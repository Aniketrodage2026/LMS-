const mongoose = require('mongoose');

function isInteger(value) {
  return Number.isInteger(value);
}

const questionSchema = new mongoose.Schema({
  prompt: { type: String, required: true, trim: true },
  options: [{ type: String, required: true, trim: true }],
  correctOptionIndex: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: isInteger,
      message: 'correctOptionIndex must be an integer'
    }
  },
  explanation: { type: String, trim: true, default: '' }
}, { _id: true });

questionSchema.pre('validate', function validateQuestion(next) {
  const options = Array.isArray(this.options) ? this.options : [];
  const normalizedOptions = options.map((option) => (
    typeof option === 'string'
      ? option.trim().replace(/\s+/g, ' ').toLowerCase()
      : option
  ));

  if (options.length < 2 || options.length > 6 || new Set(normalizedOptions).size !== options.length) {
    this.invalidate('options', 'Questions require 2 through 6 distinct options');
  }

  if (!isInteger(this.correctOptionIndex) || this.correctOptionIndex < 0 || this.correctOptionIndex >= options.length) {
    this.invalidate('correctOptionIndex', 'correctOptionIndex must select an option');
  }

  next();
});

const quizSchema = new mongoose.Schema({
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true
  },
  title: { type: String, required: true, trim: true },
  instructions: { type: String, trim: true },
  passMark: {
    type: Number,
    required: true,
    min: 1,
    max: 100,
    validate: {
      validator: isInteger,
      message: 'passMark must be an integer'
    }
  },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT' },
  attemptCount: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: isInteger,
      message: 'attemptCount must be a nonnegative integer'
    }
  },
  questions: { type: [questionSchema], required: true }
}, { timestamps: true });

quizSchema.pre('validate', function validateQuiz(next) {
  if (!Array.isArray(this.questions) || this.questions.length === 0) {
    this.invalidate('questions', 'A quiz requires at least one question');
  }
  next();
});

quizSchema.index({ course: 1, status: 1 });
quizSchema.index({ course: 1 });

module.exports = mongoose.model('Quiz', quizSchema);
