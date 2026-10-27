const mongoose = require('mongoose');

const mediaStorageSchema = new mongoose.Schema({
  provider: { type: String, enum: ['CLOUDINARY', 'R2'], required: true },
  key: { type: String, required: true, trim: true },
  contentType: { type: String, required: true, trim: true },
  size: {
    type: Number,
    required: true,
    min: 0,
    cast: false,
    validate: {
      validator: Number.isInteger,
      message: 'media storage size must be a nonnegative integer'
    }
  }
}, { _id: false });

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateMedia(document, media, path) {
  const hasLegacyRecord = hasText(media?.public_id) && hasText(media?.secure_url);
  if (!hasLegacyRecord && !media?.storage) {
    document.invalidate(path, `${path} requires legacy Cloudinary media or storage metadata`);
  }
}

const lectureSchema = new mongoose.Schema({
  title: String,
  description: String,
  lecture: {
    public_id: { type: String },
    secure_url: { type: String },
    storage: { type: mediaStorageSchema, default: undefined },
    deliveryType: { type: String, enum: ['PUBLIC', 'AUTHENTICATED'], default: 'PUBLIC', required: true }
  },
  isPreview: { type: Boolean, default: false },
  position: {
    type: Number,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'Lecture position must be a nonnegative integer'
    }
  },
  durationSeconds: { type: Number, min: 0 }
});

function learningTags() {
  return {
    type: [{ type: String, trim: true, lowercase: true, minLength: 1, maxLength: 80, cast: false }],
    castNonArrays: false,
    default: [],
    set: (value) => Array.isArray(value)
      ? [...new Set(value.map((tag) => typeof tag === 'string' ? tag.trim().toLowerCase() : tag))]
      : value,
    validate: {
      validator: (value) => Array.isArray(value) && value.length <= 20 && value.every((tag) => typeof tag === 'string' && tag.length > 0),
      message: 'Provide at most 20 nonempty learning tags'
    }
  };
}

const prerequisiteSchema = new mongoose.Schema({
  courses: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
    castNonArrays: false,
    default: [],
    validate: {
      validator: (value) => Array.isArray(value) && value.length <= 20 && value.every((id) => id != null),
      message: 'At most 20 prerequisite course references are allowed'
    }
  },
  skills: learningTags()
}, { _id: false, strict: 'throw' });

const learningMetadataSchema = new mongoose.Schema({
  level: { type: String, enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] },
  skills: learningTags(),
  prerequisites: { type: prerequisiteSchema, default: undefined }
}, { _id: false, strict: 'throw' });

const courseSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title of course is required'],
    minLength: [8, 'Title must be atleast 8 char'],
    maxLength: [50, 'Title must be less than 50 char'],
    trim: true
  },
  description: { type: String, required: [true, 'Description is required'], trim: true },
  category: { type: String, required: [true, 'Category is required'] },
  instructor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function requiredForNewCourses() {
      return this.isNew;
    },
    index: true
  },
  accessType: { type: String, enum: ['FREE', 'PAID'], default: 'FREE' },
  price: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'Price must be an integer number of paise'
    }
  },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  status: { type: String, enum: ['PUBLISHED', 'UNPUBLISHED'], default: 'PUBLISHED' },
  thumbnail: {
    public_id: { type: String },
    secure_url: { type: String },
    storage: { type: mediaStorageSchema, default: undefined }
  },
  lectures: [lectureSchema],
  learningMetadata: { type: learningMetadataSchema, default: undefined },
  numberOflectures: { type: Number, default: 0 }
}, {
  timestamps: true,
  optimisticConcurrency: true
});

courseSchema.pre('validate', function validateCourseDocument(next) {
  for (const path of ['learningMetadata.skills', 'learningMetadata.prerequisites.skills']) {
    const value = this.get(path);
    if (Array.isArray(value) && new Set(value).size !== value.length) this.set(path, value);
  }
  validateMedia(this, this.thumbnail, 'thumbnail');
  this.lectures.forEach((lecture, index) => validateMedia(this, lecture.lecture, `lectures.${index}.lecture`));

  if (this.accessType === 'FREE' && this.price !== 0) {
    this.invalidate('price', 'Free courses must have a price of 0');
  }

  if (this.accessType === 'PAID' && this.price === 0) {
    this.invalidate('price', 'Paid courses require a positive price');
  }

  if (this.lectures.filter((lecture) => lecture.isPreview).length > 1) {
    this.invalidate('lectures', 'A course can have only one preview lecture');
  }

  next();
});

function changesLearningMetadata(update) {
  // Pipeline stages can replace the root document or compute arbitrary fields.
  if (Array.isArray(update)) return true;
  if (!update || typeof update !== 'object') return false;
  const metadataPath = (path) => typeof path === 'string' && (path === 'learningMetadata' || path.startsWith('learningMetadata.'));
  return Object.entries(update).some(([key, value]) => {
    if (metadataPath(key)) return true;
    if (!key.startsWith('$') || !value || typeof value !== 'object') return false;
    return Object.entries(value).some(([path, destination]) => metadataPath(path) || (key === '$rename' && metadataPath(destination)));
  });
}

function metadataMutationError() {
  return new Error('Course learning metadata changes require document validation and save.');
}

for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
  courseSchema.pre(operation, function () {
    // Upserts can seed fields from query filters without document validation.
    if (this.getOptions().upsert || changesLearningMetadata(this.getUpdate())) throw metadataMutationError();
  });
}

courseSchema.pre('bulkWrite', function (next, operations) {
  for (const operation of operations) {
    const mutation = operation.updateOne || operation.updateMany || operation.replaceOne || operation.insertOne;
    if (mutation && (mutation.upsert || changesLearningMetadata(mutation.update || mutation.replacement || mutation.document))) {
      return next(metadataMutationError());
    }
  }
  next();
});

module.exports = mongoose.model('Course', courseSchema);

