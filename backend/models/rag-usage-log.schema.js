const mongoose = require('mongoose');

function count(max = Number.MAX_SAFE_INTEGER) {
  return { type: Number, min: 0, max, cast: false, immutable: true,
    validate: { validator: Number.isSafeInteger, message: 'Counts must be nonnegative safe integers' } };
}
// Operational categories only: no question, answer, excerpt, vector, provider
// payload, storage descriptor, or delivery URL belongs in this collection.
const ragUsageLogSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true },
  provider: { type: String, required: true, immutable: true, enum: ['GEMINI', 'NONE'], cast: false },
  modelAlias: { type: String, required: true, immutable: true, trim: true, maxLength: 80, cast: false,
    match: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ },
  outcome: { type: String, required: true, immutable: true, cast: false,
    enum: ['SUCCESS', 'NO_RELEVANT_SOURCE', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', 'INVALID_OUTPUT', 'QUOTA_EXCEEDED', 'ERROR'] },
  sourceCount: { ...count(5), required: true, default: 0 },
  inputTokens: count(), outputTokens: count(),
  createdAt: { type: Date, required: true, default: Date.now, immutable: true }
}, { versionKey: false, strict: 'throw' });
ragUsageLogSchema.index({ student: 1, createdAt: -1 });
function appendOnlyError() { return new Error('RagUsageLog records are append-only.'); }
ragUsageLogSchema.pre('save', function () { if (!this.isNew) throw appendOnlyError(); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite']) {
  ragUsageLogSchema.pre(operation, function () { throw appendOnlyError(); });
}
ragUsageLogSchema.pre('deleteOne', { document: true, query: false }, function () { throw appendOnlyError(); });

module.exports = mongoose.model('RagUsageLog', ragUsageLogSchema);
