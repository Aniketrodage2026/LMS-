const mongoose = require('mongoose');

// Callers must redact user text and validate assistant copy before persistence.
// This schema stores the displayed conversation only, never provider payloads.
const messageSchema = new mongoose.Schema({
  role: { type: String, required: true, enum: ['USER', 'ASSISTANT'] },
  text: { type: String, required: true, trim: true, maxLength: 2000, cast: false },
  createdAt: { type: Date, default: Date.now, required: true }
}, { _id: false, strict: 'throw' });

const aiConversationSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, unique: true },
  messages: {
    type: [messageSchema],
    castNonArrays: false,
    default: [],
    validate: {
      validator: (value) => Array.isArray(value) && value.length <= 20 && value.every((message) => message != null),
      message: 'Keep at most 20 safe messages'
    }
  },
  recommendedCourseIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
    castNonArrays: false,
    default: [],
    validate: {
      validator: (value) => Array.isArray(value) && value.length <= 5 && value.every((id) => id != null),
      message: 'Keep at most 5 recommended course references'
    }
  }
}, { timestamps: true, strict: 'throw' });

// Query/atomic array updates cannot validate the resulting collection bounds.
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'bulkWrite']) {
  aiConversationSchema.pre(operation, function () {
    throw new Error('AIConversation changes require document validation and save.');
  });
}

module.exports = mongoose.model('AIConversation', aiConversationSchema);
