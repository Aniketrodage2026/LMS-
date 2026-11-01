const mongoose = require('mongoose');

const instructorAiDraftBudgetSchema = new mongoose.Schema({
  instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  dayStart: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true },
  used: { type: Number, required: true, min: 0, default: 0, cast: false,
    validate: { validator: Number.isSafeInteger, message: 'Provide a bounded safe integer' } }
}, { strict: 'throw' });

instructorAiDraftBudgetSchema.index({ instructor: 1, dayStart: 1 }, { unique: true });
instructorAiDraftBudgetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('InstructorAiDraftBudget', instructorAiDraftBudgetSchema);
