const mongoose = require('mongoose');

const purchaseOrderReservationSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true
  },
  receipt: { type: String, required: true, unique: true },
  leaseToken: { type: String, required: true },
  leaseExpiresAt: { type: Date, required: true }
}, {
  timestamps: true
});

purchaseOrderReservationSchema.index({ student: 1, course: 1 }, { unique: true });
purchaseOrderReservationSchema.index({ leaseExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PurchaseOrderReservation', purchaseOrderReservationSchema);
