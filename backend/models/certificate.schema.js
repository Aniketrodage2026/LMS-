const mongoose = require('mongoose');

const certificateSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
    immutable: true
  },
  certificateNumber: {
    type: String,
    required: true,
    immutable: true,
    unique: true,
    minlength: 29,
    maxlength: 29,
    match: [/^LMS-\d{4}-[A-F0-9]{20}$/, 'certificateNumber must use the LMS-YYYY-<20 uppercase hex characters> format']
  },
  verificationToken: {
    type: String,
    required: true,
    immutable: true,
    unique: true,
    select: false,
    match: [/^[a-f0-9]{64}$/, 'verificationToken must be 64 lowercase hexadecimal characters']
  },
  issuedAt: { type: Date, default: Date.now, immutable: true },
  eligibilitySnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true }
}, { timestamps: true });

certificateSchema.index({ student: 1, course: 1 }, { unique: true });

module.exports = mongoose.model('Certificate', certificateSchema);
