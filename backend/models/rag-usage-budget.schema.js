const mongoose = require('mongoose');

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const ragUsageBudgetSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  dayKey: { type: String, required: true, immutable: true, cast: false,
    validate: { validator: validDay, message: 'Provide an actual UTC calendar day' } },
  used: { type: Number, required: true, default: 0, min: 0, cast: false,
    validate: { validator: Number.isSafeInteger, message: 'Usage must be a nonnegative safe integer' } }
}, { versionKey: false, strict: 'throw' });
ragUsageBudgetSchema.index({ student: 1, dayKey: 1 }, { unique: true });

function mutationError() { return new Error('Unsafe RAG budget mutation.'); }
ragUsageBudgetSchema.pre('save', function () {
  if (!this.isNew) throw mutationError();
});
// Permit the existing durable reservation pattern only: initialize/import with
// $max, then reserve one request under an explicit safe upper bound. Validate
// raw input here: update validators do not validate $inc or pipeline results.
ragUsageBudgetSchema.pre('findOneAndUpdate', function () {
  const filter = this.getFilter();
  const update = this.getUpdate();
  const options = this.getOptions();
  const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
  if (!keys(filter, ['student', 'dayKey', 'used']) || !mongoose.isObjectIdOrHexString(filter.student)
    || !validDay(filter.dayKey) || !update || Array.isArray(update)) throw mutationError();
  const increment = keys(update, ['$inc']) && Object.keys(update).length === 1
    && keys(update.$inc, ['used']) && update.$inc.used === 1
    && keys(filter.used, ['$lt']) && Number.isSafeInteger(filter.used.$lt) && filter.used.$lt > 0
    && !options.upsert;
  const initialize = keys(filter, ['student', 'dayKey']) && keys(update, ['$max', '$setOnInsert'])
    && keys(update.$max, ['used']) && Number.isSafeInteger(update.$max.used) && update.$max.used >= 0
    && keys(update.$setOnInsert, ['student', 'dayKey'])
    && String(update.$setOnInsert.student) === String(filter.student) && update.$setOnInsert.dayKey === filter.dayKey;
  if (!increment && !initialize) throw mutationError();
});
// Deleting a counter would permit same-day reinitialization and extra requests.
for (const operation of ['updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace', 'bulkWrite',
  'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  ragUsageBudgetSchema.pre(operation, function () { throw mutationError(); });
}
ragUsageBudgetSchema.pre('deleteOne', { document: true, query: false }, function () { throw mutationError(); });

module.exports = mongoose.model('RagUsageBudget', ragUsageBudgetSchema);
