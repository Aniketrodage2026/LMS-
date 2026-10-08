const mongoose = require('mongoose');

const lectureProgressSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
    immutable: true
  },
  lectureId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    immutable: true
  },
  watchedSeconds: { type: Number, min: 0, default: 0 },
  watchedPercent: { type: Number, min: 0, max: 100, default: 0 },
  durationSeconds: { type: Number, min: 0, default: 0 },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  lastWatchedAt: { type: Date, default: Date.now }
}, { timestamps: true });

lectureProgressSchema.index({ student: 1, lectureId: 1 }, { unique: true });
lectureProgressSchema.index({ student: 1, course: 1 });
lectureProgressSchema.index({ student: 1, lastWatchedAt: -1 });

module.exports = mongoose.model('LectureProgress', lectureProgressSchema);
