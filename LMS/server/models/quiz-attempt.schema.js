const mongoose = require('mongoose');

const quizAttemptSchema = new mongoose.Schema({
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
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
  answers: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    immutable: true
  },
  correctAnswers: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  totalQuestions: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  score: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  percentage: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  passed: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  submittedAt: { type: Date, required: true, immutable: true, default: Date.now }
}, { timestamps: true });

quizAttemptSchema.pre('validate', function validateAttempt(next) {
  const isInteger = (value) => Number.isInteger(value);
  const { answers, correctAnswers, totalQuestions, score, percentage, passed } = this;

  if (!isInteger(totalQuestions) || totalQuestions < 1) {
    this.invalidate('totalQuestions', 'totalQuestions must be a positive integer');
  }

  if (!Array.isArray(answers)) {
    this.invalidate('answers', 'answers must be an array');
  } else {
    if (isInteger(totalQuestions) && answers.length !== totalQuestions) {
      this.invalidate('answers', 'answers must have one value per question');
    }
    if (answers.some((answer) => answer !== null && (!isInteger(answer) || answer < 0))) {
      this.invalidate('answers', 'answers must be null or nonnegative integers');
    }
  }

  if (!isInteger(correctAnswers) || correctAnswers < 0 || (isInteger(totalQuestions) && correctAnswers > totalQuestions)) {
    this.invalidate('correctAnswers', 'correctAnswers must be an integer from 0 through totalQuestions');
  }

  if (!isInteger(score) || score !== correctAnswers) {
    this.invalidate('score', 'score must equal correctAnswers');
  }

  if (!isInteger(percentage) || (isInteger(correctAnswers) && isInteger(totalQuestions)
    && percentage !== Math.round((correctAnswers / totalQuestions) * 100))) {
    this.invalidate('percentage', 'percentage must match the calculated score');
  }

  if (typeof passed !== 'boolean') {
    this.invalidate('passed', 'passed must be a boolean');
  }

  next();
});

quizAttemptSchema.index({ student: 1, quiz: 1, submittedAt: -1 });

module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
