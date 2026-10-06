const crypto = require('crypto');

const DEFAULT_LEASE_MS = 30_000;
const MAX_RECEIPT_ATTEMPTS = 3;

function createReceipt(courseId, studentId) {
  const intent = `${courseId.toString()}:${studentId.toString()}`;
  return `c_${crypto.createHash('sha256').update(intent).digest('hex').slice(0, 32)}`;
}

function createPurchaseOrderReservationService({
  Reservation,
  Purchase,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => new Date()
}) {
  async function acquire({ studentId, courseId }) {
    for (let attempt = 0; attempt < MAX_RECEIPT_ATTEMPTS; attempt += 1) {
      const currentTime = now();
      const receipt = createReceipt(courseId, studentId);
      const leaseToken = crypto.randomUUID();
      const leaseExpiresAt = new Date(currentTime.getTime() + leaseMs);

      try {
        const replaced = await Reservation.findOneAndUpdate(
          { student: studentId, course: courseId, leaseExpiresAt: { $lte: currentTime } },
          { $set: { receipt, leaseToken, leaseExpiresAt } },
          { new: true, runValidators: true }
        );
        if (replaced) {
          return { owner: true, reservation: replaced };
        }

        const reservation = await Reservation.create({
          student: studentId,
          course: courseId,
          receipt,
          leaseToken,
          leaseExpiresAt
        });
        return { owner: true, reservation };
      } catch (error) {
        if (!error || error.code !== 11000) {
          throw error;
        }

        const existing = await Reservation.findOne({ student: studentId, course: courseId });
        if (!existing) {
          continue;
        }
        if (existing.leaseExpiresAt <= currentTime) {
          continue;
        }
        return { owner: false, reservation: existing };
      }
    }

    throw new Error('Unable to reserve purchase order');
  }

  async function ownsLease(reservation) {
    const active = await Reservation.exists({
      _id: reservation._id,
      leaseToken: reservation.leaseToken,
      leaseExpiresAt: { $gt: now() }
    });
    return Boolean(active);
  }

  async function release(reservation) {
    await Reservation.deleteOne({ _id: reservation._id, leaseToken: reservation.leaseToken });
  }

  return { acquire, ownsLease, release };
}

module.exports = { createPurchaseOrderReservationService, createReceipt };
