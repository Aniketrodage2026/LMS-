const mongoose = require('mongoose');
const Course = require('./course.schema');

function integer(min, max, defaultValue) {
  return { type: Number, required: true, min, max, default: defaultValue, cast: false,
    validate: { validator: Number.isSafeInteger, message: 'Provide a bounded safe integer' } };
}
function displayText(value) {
  return typeof value === 'string' ? value.trim().replace(/[^\S\r\n]+/g, ' ') : value;
}
const storageSchema = new mongoose.Schema({
  // R2 objects are private; no delivery URL or public-storage variant is stored.
  provider: { type: String, required: true, enum: ['R2'], cast: false },
  key: { type: String, required: true, maxLength: 1024, cast: false,
    validate: { validator: (value) => /^materials\/[a-zA-Z0-9/_-]+\.pdf$/.test(value) && !value.includes('//'),
      message: 'Provide a private material object key' } },
  contentType: { type: String, required: true, enum: ['application/pdf'], cast: false },
  size: integer(1, 10485760)
}, { _id: false, strict: 'throw' });

const courseMaterialSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true, index: true },
  // Lectures are subdocuments of Course, not separate model references.
  lecture: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  title: { type: String, required: true, maxLength: 120, cast: false, set: displayText,
    match: /^[^\x00-\x1f\x7f]+$/ },
  originalFilename: { type: String, required: true, maxLength: 255, cast: false, immutable: true,
    set: (value) => typeof value === 'string' ? displayText(value.split(/[\\/]/).pop()) : value,
    match: /^[^\x00-\x1f\x7f]+\.pdf$/i },
  storage: { type: storageSchema, required: true, immutable: true },
  contentType: { type: String, required: true, enum: ['application/pdf'], immutable: true, cast: false },
  size: { ...integer(1, 10485760), immutable: true },
  status: { type: String, required: true, default: 'DRAFT', cast: false,
    enum: ['DRAFT', 'PROCESSING', 'READY', 'PUBLISHED', 'FAILED'] },
  contentHash: { type: String, required: true, immutable: true, cast: false, match: /^[a-f0-9]{64}$/ },
  pageCount: integer(0, 100, 0),
  extractedCharacterCount: integer(0, 1000000, 0),
  failureCode: { type: String, default: null, cast: false, enum: [null, 'INVALID_PDF', 'PDF_TOO_LARGE',
    'TOO_MANY_PAGES', 'ENCRYPTED_PDF', 'NO_READABLE_TEXT', 'EXTRACTION_FAILED', 'EMBEDDING_FAILED',
    'STORAGE_FAILED', 'PROCESSING_FAILED'] },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true }
}, { timestamps: true, strict: 'throw', optimisticConcurrency: true });

courseMaterialSchema.index({ course: 1, lecture: 1, status: 1 });
courseMaterialSchema.index({ course: 1, createdAt: 1 });
// Deletion is physical: every retained source participates in duplicate detection.
courseMaterialSchema.index({ course: 1, lecture: 1, contentHash: 1 },
  { unique: true, partialFilterExpression: { contentHash: { $type: 'string' } } });

const transitions = {
  DRAFT: ['PROCESSING'], PROCESSING: ['READY', 'FAILED'], READY: ['PUBLISHED', 'PROCESSING'],
  PUBLISHED: ['READY'], FAILED: ['PROCESSING']
};
courseMaterialSchema.pre('validate', async function () {
  if (!this.isNew && this.isModified('storage')) {
    this.invalidate('storage', 'Material source storage is immutable');
  }
  if (this.course && !this.$errors?.course) {
    const owner = await Course.findById(this.course).select('lectures._id').lean();
    if (!owner) this.invalidate('course', 'Material requires an existing course');
    else if (this.lecture && !owner.lectures.some((entry) => entry._id.equals(this.lecture))) {
      this.invalidate('lecture', 'Material lecture must belong to its course');
    }
  }
  if (this.storage && (this.storage.size !== this.size || this.storage.contentType !== this.contentType)) {
    this.invalidate('storage', 'Storage must match PDF contentType and size');
  }
  if (['READY', 'PUBLISHED'].includes(this.status)) {
    if (!(this.pageCount > 0)) this.invalidate('pageCount', 'Ready material requires a pageCount');
    if (!(this.extractedCharacterCount > 0)) this.invalidate('extractedCharacterCount', 'Ready material requires extractedCharacterCount');
  }
  if ((this.status === 'FAILED') !== (this.failureCode != null)) {
    this.invalidate('failureCode', 'Only failed material requires a safe failureCode');
  }
  if (this.isNew) {
    if (!['DRAFT', 'PROCESSING'].includes(this.status)) this.invalidate('status', 'Invalid initial lifecycle transition');
  } else if (this.isModified('status')) {
    const previous = await this.constructor.findById(this._id).select('status').lean();
    if (!previous || (previous.status !== this.status && !transitions[previous.status]?.includes(this.status))) {
      this.invalidate('status', 'Invalid material lifecycle transition');
    }
  }
});

// Atomic updates cannot validate ownership or the prior lifecycle state.
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite']) {
  courseMaterialSchema.pre(operation, function () {
    throw new Error('CourseMaterial changes require document validation and save.');
  });
}

module.exports = mongoose.model('CourseMaterial', courseMaterialSchema);
