const mongoose = require('mongoose');

function tokenCount() {
  return {
    type: Number,
    min: 0,
    cast: false,
    immutable: true,
    validate: { validator: Number.isInteger, message: 'Token counts must be nonnegative integers' }
  };
}

const aiUsageLogSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  feature: { type: String, required: true, immutable: true, enum: ['DISCOVERY', 'GUIDANCE'] },
  provider: { type: String, required: true, immutable: true, enum: ['GEMINI', 'NONE'] },
  modelAlias: {
    type: String,
    required: true,
    immutable: true,
    trim: true,
    maxLength: 80,
    match: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
  },
  outcome: {
    type: String,
    required: true,
    immutable: true,
    enum: ['SUCCESS', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', 'INVALID_OUTPUT', 'QUOTA_EXCEEDED', 'ERROR']
  },
  inputTokens: tokenCount(),
  outputTokens: tokenCount(),
  createdAt: { type: Date, default: Date.now, required: true, immutable: true }
}, { versionKey: false, strict: 'throw' });

aiUsageLogSchema.index({ student: 1, createdAt: -1 });

function appendOnlyError() {
  return new Error('AIUsageLog records are append-only.');
}

aiUsageLogSchema.pre('save', function () {
  if (!this.isNew) throw appendOnlyError();
});

aiUsageLogSchema.pre('bulkWrite', function () {
  throw appendOnlyError();
});

for (const operation of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
  'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'
]) {
  aiUsageLogSchema.pre(operation, function () {
    throw appendOnlyError();
  });
}

aiUsageLogSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw appendOnlyError();
});

module.exports = mongoose.model('AIUsageLog', aiUsageLogSchema);
