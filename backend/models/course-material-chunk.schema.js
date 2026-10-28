const mongoose = require('mongoose');
const CourseMaterial = require('./course-material.schema');

function integer(min, max) {
  return { type: Number, required: true, min, max, cast: false,
    validate: { validator: Number.isSafeInteger, message: 'Provide a bounded safe integer' } };
}
const courseMaterialChunkSchema = new mongoose.Schema({
  material: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseMaterial', required: true, immutable: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true, index: true },
  lecture: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  ordinal: { ...integer(0, Number.MAX_SAFE_INTEGER), immutable: true },
  pageStart: integer(1, 100),
  pageEnd: integer(1, 100),
  text: { type: String, required: true, trim: true, maxLength: 12000, cast: false },
  embedding: { type: [{ type: Number, cast: false }], required: true, default: undefined, castNonArrays: false,
    validate: { validator: (value) => Array.isArray(value) && value.length === 768 && value.every(Number.isFinite),
      message: 'Embedding requires exactly 768 finite numbers' } },
  embeddingModel: { type: String, required: true, enum: ['gemini-embedding-2'], immutable: true, cast: false },
  embeddingDimension: { ...integer(768, 768), immutable: true },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true }
}, { strict: 'throw', optimisticConcurrency: true });

courseMaterialChunkSchema.index({ material: 1, ordinal: 1 }, { unique: true });
courseMaterialChunkSchema.pre('validate', async function () {
  if (this.pageStart > this.pageEnd) this.invalidate('pageEnd', 'Chunk pageEnd must not precede pageStart');
  if (!this.material || this.$errors?.material) return;
  const parent = await CourseMaterial.findById(this.material).select('course lecture pageCount').lean();
  if (!parent) { this.invalidate('material', 'Chunk requires an existing material'); return; }
  if (!parent.course.equals(this.course)) this.invalidate('course', 'Chunk course must match its material');
  if (String(parent.lecture ?? '') !== String(this.lecture ?? '')) this.invalidate('lecture', 'Chunk lecture must match its material');
  if (this.pageEnd > parent.pageCount) this.invalidate('pageEnd', 'Chunk pages must be within the material pageCount');
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite']) {
  courseMaterialChunkSchema.pre(operation, function () {
    throw new Error('CourseMaterialChunk changes require document validation and save.');
  });
}

module.exports = mongoose.model('CourseMaterialChunk', courseMaterialChunkSchema);
