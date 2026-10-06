const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: Number.isInteger,
      message: 'Purchase amount must be an integer number of paise'
    }
  },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  status: { type: String, enum: ['PENDING', 'VERIFIED', 'FAILED'], default: 'PENDING' },
  receipt: { type: String, required: true, unique: true },
  razorpayOrderId: { type: String, required: true, unique: true, sparse: true },
  razorpayPaymentId: { type: String, unique: true, sparse: true },
  razorpaySignature: { type: String, select: false }
}, {
  timestamps: true
});

purchaseSchema.index({ student: 1, course: 1, status: 1 });
purchaseSchema.index({ student: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Purchase', purchaseSchema);
