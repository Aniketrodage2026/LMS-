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
  numberOflectures: { type: Number, default: 0 }
}, {
  timestamps: true,
  optimisticConcurrency: true
});

courseSchema.pre('validate', function validateCourseDocument(next) {
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

module.exports = mongoose.model('Course', courseSchema);

