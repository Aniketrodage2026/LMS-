const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  kind: { type: String, required: true, enum: ['LESSON', 'QUIZ', 'ASSIGNMENT'], immutable: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true },
  source: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  courseTitle: { type: String, required: true, trim: true, maxLength: 80, immutable: true },
  title: { type: String, required: true, trim: true, maxLength: 160, immutable: true },
  scheduledAt: { type: Date, required: true },
  dueAt: { type: Date, default: null, immutable: true },
  minutes: {
    type: Number,
    required: true,
    min: 15,
    max: 180,
    cast: false,
    validate: { validator: Number.isInteger, message: 'Study session length must be a whole number of minutes' }
  },
  position: {
    type: Number,
    required: true,
    min: 0,
    max: 20,
    cast: false,
    validate: { validator: Number.isInteger, message: 'Study session position must be a nonnegative integer' }
  }
}, { _id: false, strict: 'throw' });

const studyPlanSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  weekStart: { type: Date, required: true, immutable: true },
  timeZone: { type: String, required: true, trim: true, maxLength: 80 },
  totalAvailableMinutes: {
    type: Number,
    required: true,
    min: 60,
    max: 4800,
    cast: false,
    validate: { validator: Number.isInteger, message: 'Available study time must be whole minutes' }
  },
  sessions: {
    type: [sessionSchema],
    required: true,
    castNonArrays: false,
    validate: {
      validator: (sessions) => Array.isArray(sessions) && sessions.length <= 21,
      message: 'A weekly study plan can contain at most 21 sessions'
    }
  }
}, { timestamps: true, strict: 'throw' });

studyPlanSchema.index({ student: 1, weekStart: 1 }, { unique: true });

function documentOnlyUpdates() {
  throw new Error('AIStudyPlan changes require document validation and save.');
}

for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite']) {
  studyPlanSchema.pre(operation, documentOnlyUpdates);
}

module.exports = mongoose.model('AIStudyPlan', studyPlanSchema);
