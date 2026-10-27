const mongoose = require('mongoose');

// Operational reservation state only; AIUsageLog remains the immutable audit trail.
const aiUsageBudgetSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  dayKey: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  used: { type: Number, required: true, default: 0, min: 0, cast: false,
    validate: { validator: Number.isSafeInteger, message: 'Usage must be a nonnegative integer' } }
}, { versionKey: false, strict: 'throw' });

aiUsageBudgetSchema.index({ student: 1, dayKey: 1 }, { unique: true });

module.exports = mongoose.model('AIUsageBudget', aiUsageBudgetSchema);
