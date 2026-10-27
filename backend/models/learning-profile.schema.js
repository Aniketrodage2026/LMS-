const mongoose = require('mongoose');

function normalizedTags(value) {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map((tag) => typeof tag === 'string' ? tag.trim().toLowerCase() : tag))];
}

function tags() {
  return {
    type: [{ type: String, trim: true, lowercase: true, minLength: 1, maxLength: 80, cast: false }],
    castNonArrays: false,
    default: [],
    set: normalizedTags,
    validate: {
      validator: (value) => Array.isArray(value) && value.length <= 20 && value.every((tag) => typeof tag === 'string' && tag.length > 0),
      message: 'Provide at most 20 nonempty text tags'
    }
  };
}

const learningProfileSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, unique: true },
  careerGoal: { type: String, required: true, trim: true, maxLength: 500, cast: false },
  interests: tags(),
  selfReportedSkills: tags(),
  experienceLevel: { type: String, required: true, enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] },
  weeklyAvailabilityHours: {
    type: Number,
    required: true,
    min: 1,
    max: 80,
    cast: false,
    validate: { validator: Number.isInteger, message: 'Weekly availability must be an integer from 1 to 80' }
  }
}, { timestamps: true, strict: 'throw' });

learningProfileSchema.pre('validate', function () {
  for (const path of ['interests', 'selfReportedSkills']) {
    const value = this.get(path);
    if (Array.isArray(value) && new Set(value).size !== value.length) this.set(path, value);
  }
});

// Query/atomic array updates cannot validate the resulting collection bounds.
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite']) {
  learningProfileSchema.pre(operation, function () {
    throw new Error('LearningProfile changes require document validation and save.');
  });
}

module.exports = mongoose.model('LearningProfile', learningProfileSchema);
