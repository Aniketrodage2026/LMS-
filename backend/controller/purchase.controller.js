const mongoose = require('mongoose');

const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Purchase = require('../models/purchase.schema');
const PurchaseOrderReservation = require('../models/purchase-order-reservation.schema');
const createRazorpayClient = require('../utils/razorpay');
const { createPurchaseService } = require('../services/purchase.service');
const { createPurchaseOrderReservationService } = require('../services/purchase-order-reservation.service');
const { recordAuditSafely } = require('../services/audit-log.service');

function publicPurchase(purchase) {
  return {
    id: purchase.id,
    amount: purchase.amount,
    currency: purchase.currency,
    receipt: purchase.receipt,
    status: purchase.status
  };
}

function publicPurchaseHistory(purchase) {
  const course = purchase.course;
  return {
    id: purchase.id,
    amount: purchase.amount,
    currency: purchase.currency,
    receipt: purchase.receipt,
    ...(purchase.status === 'PENDING' ? {
      status: 'PENDING',
      code: purchase.razorpayPaymentId ? 'PAYMENT_VERIFICATION_PENDING' : 'PAYMENT_ORDER_PENDING'
    } : {}),
    razorpayPaymentId: purchase.razorpayPaymentId,
    updatedAt: purchase.updatedAt,
    course: course ? {
      id: course.id,
      title: course.title,
      category: course.category,
      thumbnail: course.thumbnail,
      accessType: course.accessType,
      price: course.price
    } : null
  };
}

function publicEnrollment(enrollment) {
  return {
    status: enrollment.status,
    source: enrollment.source
  };
}

function audit(req, action, type, id) {
  return recordAuditSafely({
    actor: req.user._id,
    action,
    target: { type, id },
    requestId: req.requestId
  });
}

function runtimePurchaseService() {
  return createPurchaseService({
    razorpay: createRazorpayClient(),
    secret: process.env.RAZORPAY_KEY_SECRET
  });
}

function verificationUnavailable(status = 500) {
  return new AppError('Payment verification is temporarily unavailable. Do not pay again; retry verification or check your purchases shortly.', status, 'PAYMENT_VERIFICATION_UNAVAILABLE');
}

function createPurchaseController({ purchaseService, reservationService, razorpayKeyId } = {}) {
  const reservations = reservationService || createPurchaseOrderReservationService({
    Reservation: PurchaseOrderReservation,
    Purchase
  });

  async function existingPurchaseOrAccess(studentId, courseId) {
    const enrollment = await Enrollment.findOne({ student: studentId, course: courseId });
    if (enrollment && enrollment.status === 'REVOKED') {
      throw new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED');
    }

    const verifiedPurchase = await Purchase.findOne({ student: studentId, course: courseId, status: 'VERIFIED' });
    if (verifiedPurchase) {
      return { purchase: verifiedPurchase };
    }

    if (enrollment && enrollment.status === 'ACTIVE' && enrollment.source === 'PURCHASE') {
      return {
        access: {
          granted: true,
          status: enrollment.status,
          source: enrollment.source
        }
      };
    }

    return null;
  }

  function assertRecoveredProviderOrder(order, receipt) {
    if (!order
      || order.receipt !== receipt
      || order.currency !== 'INR'
      || !Number.isInteger(order.amount)
      || order.amount <= 0) {
      throw new AppError('Recovered provider order does not match this purchase intent', 409, 'PAYMENT_ORDER_CONFLICT');
    }
  }

  function retryableReservationError() {
    return new AppError('Your purchase order is being prepared. Do not pay again; check your purchases shortly.', 202, 'PAYMENT_ORDER_PREPARING');
  }

  async function pendingOrderResponse(purchase, responseStatus = 200) {
    let reusable = false;
    if (!purchase.razorpayPaymentId) {
      let state;
      try {
        state = await (purchaseService || runtimePurchaseService()).getOrderState(purchase.razorpayOrderId);
      } catch (error) { throw verificationUnavailable(503); }
      const { order, payments } = state || {};
      if (!order || !payments || !Array.isArray(payments.items)) throw verificationUnavailable(503);
      if (order.id !== purchase.razorpayOrderId || order.receipt !== purchase.receipt
        || order.amount !== purchase.amount || order.currency !== purchase.currency) {
        throw new AppError('The existing payment order could not be confirmed. Check your purchases or contact support.', 409, 'PAYMENT_ORDER_CONFLICT');
      }
      // "attempted" alone is not proof of an unpaid order. Only final failed
      // attempts are safe to retry; authorized/captured/unknown payments wait.
      reusable = ['created', 'attempted'].includes(order.status) && order.amount_paid === 0
        && Number.isInteger(order.attempts) && order.attempts === payments.items.length
        && (order.status === 'created' || payments.items.length > 0)
        && payments.items.every(payment => payment.status === 'failed');
    }
    // A valid callback may have arrived while the provider lookup was in flight.
    const current = await Purchase.findById(purchase._id);
    if (!current) throw verificationUnavailable(503);
    if (current.status === 'VERIFIED') {
      return { status: 200, body: { success: true, code: 'PAYMENT_ALREADY_OWNED', purchase: publicPurchase(current) } };
    }
    if (current.status !== 'PENDING') throw new AppError('Payment verification conflict', 409, 'PAYMENT_VERIFICATION_CONFLICT');
    reusable = reusable && !current.razorpayPaymentId;
    return {
      status: responseStatus,
      body: {
        success: true,
        code: reusable ? 'PAYMENT_ORDER_REUSABLE' : 'PAYMENT_VERIFICATION_PENDING',
        purchase: publicPurchase(current),
        ...(reusable ? {
          order: { id: current.razorpayOrderId, amount: current.amount, currency: current.currency },
          keyId: razorpayKeyId || process.env.RAZORPAY_KEY_ID
        } : {})
      }
    };
  }

  async function assertLeaseOwnership(reservation) {
    if (!await reservations.ownsLease(reservation)) {
      throw retryableReservationError();
    }
  }

  async function releaseIfLeaseOwner(reservation) {
    if (!await reservations.ownsLease(reservation)) {
      return false;
    }
    await reservations.release(reservation);
    return true;
  }

  async function findProviderOrder(reservation, service) {
    await assertLeaseOwnership(reservation);
    try {
      return await service.findOrderByReceipt(reservation.receipt);
    } catch (error) {
      throw new AppError('Unable to look up purchase order', 502, 'PAYMENT_ORDER_UNAVAILABLE');
    }
  }

  async function persistPendingPurchase({ order, amount, reservation, studentId, course }) {
    const existingPending = await Purchase.findOne({ student: studentId, course: course._id, status: 'PENDING' });
    if (existingPending) {
      return existingPending;
    }

    try {
      return await Purchase.create({
        student: studentId,
        course: course._id,
        amount,
        currency: 'INR',
        status: 'PENDING',
        receipt: reservation.receipt,
        razorpayOrderId: order.id
      });
    } catch (error) {
      if (error && error.code === 11000) {
        const reusedPurchase = await Purchase.findOne({
          $or: [
            { receipt: reservation.receipt },
            { razorpayOrderId: order.id },
            { student: studentId, course: course._id, status: 'PENDING' }
          ]
        });
        if (reusedPurchase) {
          return reusedPurchase;
        }
      }
      throw error;
    }
  }

  async function createReservedOrder({ reservation, studentId, course, service }) {
    let order;
    let recoveredOrder = false;
    try {
      const failedPurchase = await Purchase.findOne({ student: studentId, course: course._id, status: 'FAILED' });
      order = await findProviderOrder(reservation, service);
      if (!order) {
        if (failedPurchase) {
          await assertLeaseOwnership(reservation);
          await Purchase.deleteOne({ _id: failedPurchase._id, status: 'FAILED' });
        }
        try {
          await assertLeaseOwnership(reservation);
          order = await service.createOrder({ amount: course.price, receipt: reservation.receipt });
        } catch (error) {
          order = await findProviderOrder(reservation, service);
          if (!order) {
            throw new AppError('Unable to create purchase order', 502, 'PAYMENT_ORDER_UNAVAILABLE');
          }
          recoveredOrder = true;
        }
      } else {
        recoveredOrder = true;
      }
      if (recoveredOrder) {
        try {
          assertRecoveredProviderOrder(order, reservation.receipt);
        } catch (error) {
          if (failedPurchase) {
            await assertLeaseOwnership(reservation);
            await Purchase.deleteOne({ _id: failedPurchase._id, status: 'FAILED' });
          }
          throw error;
        }
      }
      if (failedPurchase && recoveredOrder) {
        await assertLeaseOwnership(reservation);
        failedPurchase.status = 'PENDING';
        failedPurchase.amount = order.amount;
        failedPurchase.currency = 'INR';
        failedPurchase.razorpayOrderId = order.id;
        await failedPurchase.save();
        if (!await releaseIfLeaseOwner(reservation)) {
          throw retryableReservationError();
        }
        return { purchase: failedPurchase, reusedFailedPurchase: true, recoveredOrder };
      }
      await assertLeaseOwnership(reservation);
      const purchase = await persistPendingPurchase({
        order,
        amount: recoveredOrder ? order.amount : course.price,
        reservation,
        studentId,
        course
      });
      if (!await releaseIfLeaseOwner(reservation)) {
        throw retryableReservationError();
      }
      return { purchase, reusedFailedPurchase: false, recoveredOrder };
    } catch (error) {
      await releaseIfLeaseOwner(reservation);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Unable to create purchase order', 500, 'PAYMENT_ORDER_UNAVAILABLE');
    }
  }

  async function createOrder(req, res, next) {
    try {
      const { courseId } = req.body || {};
      if (!mongoose.isObjectIdOrHexString(courseId)) {
        throw new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST');
      }

      const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' });
      if (!course) {
        throw new AppError('Course not found', 404, 'COURSE_NOT_FOUND');
      }
      if (course.accessType !== 'PAID') {
        throw new AppError('This course requires payment', 400, 'PAYMENT_COURSE_NOT_PAID');
      }
      if (!Number.isInteger(course.price) || course.price <= 0) {
        throw new AppError('Course price is unavailable', 400, 'PAYMENT_PRICE_UNAVAILABLE');
      }
      if (course.instructor.equals(req.user._id)) {
        throw new AppError('You cannot purchase your own course', 403, 'COURSE_ACCESS_DENIED');
      }

      const alreadyEntitled = await existingPurchaseOrAccess(req.user._id, course._id);
      if (alreadyEntitled) {
        return res.status(200).json({
          success: true,
          // Idempotent success: clients must open learning instead of checkout.
          code: 'PAYMENT_ALREADY_OWNED',
          ...(alreadyEntitled.purchase ? { purchase: publicPurchase(alreadyEntitled.purchase) } : {}),
          ...(alreadyEntitled.access ? { access: alreadyEntitled.access } : {})
        });
      }

      const existingPending = await Purchase.findOne({ student: req.user._id, course: course._id, status: 'PENDING' });
      if (existingPending) {
        const response = await pendingOrderResponse(existingPending);
        return res.status(response.status).json(response.body);
      }

      const reservation = await reservations.acquire({ studentId: req.user._id, courseId: course._id });
      if (!reservation.owner) {
        throw retryableReservationError();
      }

      const result = await createReservedOrder({
        reservation: reservation.reservation,
        studentId: req.user._id,
        course,
        service: purchaseService || runtimePurchaseService()
      });
      if (result.recoveredOrder) {
        const response = await pendingOrderResponse(result.purchase, result.reusedFailedPurchase ? 200 : 201);
        return res.status(response.status).json(response.body);
      }
      const order = {
        id: result.purchase.razorpayOrderId,
        amount: result.purchase.amount,
        currency: result.purchase.currency
      };
      return res.status(result.reusedFailedPurchase ? 200 : 201).json({
        success: true,
        code: 'PAYMENT_ORDER_REUSABLE',
        purchase: publicPurchase(result.purchase),
        order,
        keyId: razorpayKeyId || process.env.RAZORPAY_KEY_ID
      });
    } catch (error) {
      return next(error instanceof AppError ? error : new AppError('Unable to create purchase order', 500, 'PAYMENT_ORDER_UNAVAILABLE'));
    }
  }

  function validVerificationBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const keys = Object.keys(body);
    const expected = ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'];
    return keys.length === expected.length
      && expected.every((key) => keys.includes(key))
      && expected.every((key) => typeof body[key] === 'string' && body[key].trim().length > 0);
  }

  async function ensurePurchaseEnrollment(purchase, studentId, session) {
    const membership = { student: studentId, course: purchase.course };
    const existing = await Enrollment.findOne(membership).session(session || null);
    if (existing && existing.status === 'REVOKED') {
      throw new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED');
    }

    try {
      await Enrollment.updateOne(
        membership,
        {
          $set: { source: 'PURCHASE', status: 'ACTIVE' },
          $setOnInsert: { enrolledAt: new Date() }
        },
        { upsert: true, session }
      );
    } catch (error) {
      if (!error || error.code !== 11000) throw error;
    }

    const enrollment = await Enrollment.findOne(membership).session(session || null);
    if (!enrollment) throw verificationUnavailable();
    if (enrollment.status === 'REVOKED') {
      throw new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED');
    }
    return enrollment;
  }

  function transactionUnavailable(error) {
    return Boolean(error && /Transaction numbers are only allowed|does not support transactions|transactions unsupported|replica set/i.test(error.message));
  }

  async function finalizeVerification({ purchase, studentId, paymentId, signature }) {
    const update = {
      _id: purchase._id,
      student: studentId,
      status: 'PENDING',
      $or: [
        { razorpayPaymentId: { $exists: false } },
        { razorpayPaymentId: null },
        { razorpayPaymentId: paymentId }
      ]
    };

    async function finalize(session) {
      const revoked = await Enrollment.findOne({ student: studentId, course: purchase.course, status: 'REVOKED' }).session(session || null);
      if (revoked) throw new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED');
      const verified = await Purchase.findOneAndUpdate(
        update,
        { $set: { status: 'VERIFIED', razorpayPaymentId: paymentId, razorpaySignature: signature } },
        { new: true, session }
      );
      if (!verified) return null;
      const enrollment = await ensurePurchaseEnrollment(verified, studentId, session);
      return { verified, enrollment };
    }

    let session;
    try {
      session = await mongoose.startSession();
      let result;
      await session.withTransaction(async () => { result = await finalize(session); });
      return result;
    } catch (error) {
      if (transactionUnavailable(error)) {
        throw verificationUnavailable(503);
      }
      throw error;
    } finally {
      if (session) await session.endSession();
    }
  }

  async function verifyPayment(req, res, next) {
    try {
      if (!validVerificationBody(req.body)) {
        throw new AppError('Invalid payment verification payload', 400, 'PAYMENT_VERIFICATION_INVALID');
      }

      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
      const studentId = req.user._id;
      const purchase = await Purchase.findOne({ razorpayOrderId: orderId, student: studentId }).select('+razorpaySignature');
      // Keep a foreign order indistinguishable from an unknown order.
      if (!purchase) throw new AppError('Purchase not found', 404, 'PAYMENT_PURCHASE_NOT_FOUND');

      const revoked = await Enrollment.findOne({ student: studentId, course: purchase.course, status: 'REVOKED' });
      if (revoked) throw new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED');

      const service = purchaseService || runtimePurchaseService();
      if (purchase.status === 'VERIFIED') {
        if (purchase.razorpayPaymentId !== paymentId) throw new AppError('You already own this course. Check your purchases or continue learning.', 409, 'PAYMENT_ALREADY_OWNED');
        if (!service.verifySignature({ orderId, paymentId, signature })
          || !service.signaturesEqual(purchase.razorpaySignature, signature)) {
          throw new AppError('Payment verification failed', 400, 'PAYMENT_VERIFICATION_FAILED');
        }
        const enrollment = await ensurePurchaseEnrollment(purchase, studentId);
        return res.status(200).json({ success: true, purchase: publicPurchase(purchase), enrollment: publicEnrollment(enrollment) });
      }
      if (purchase.status === 'FAILED') throw new AppError('Payment verification has already failed', 409, 'PAYMENT_VERIFICATION_FAILED');

      if (!service.verifySignature({ orderId, paymentId, signature })) {
        if (!purchase.razorpayPaymentId) await Purchase.updateOne({ _id: purchase._id, status: 'PENDING', razorpayPaymentId: { $exists: false } }, { $set: { status: 'FAILED' } });
        throw new AppError('Payment verification failed', 400, 'PAYMENT_VERIFICATION_FAILED');
      }

      const boundElsewhere = await Purchase.exists({
        razorpayPaymentId: paymentId,
        _id: { $ne: purchase._id }
      });
      if (boundElsewhere) throw new AppError('Payment has already been used', 409, 'PAYMENT_VERIFICATION_CONFLICT');

      // Record only an HMAC-validated callback before the access transaction.
      // A rollback/outage must not make a submitted payment look unpaid later.
      await Purchase.findOneAndUpdate({
        _id: purchase._id, status: 'PENDING',
        $or: [{ razorpayPaymentId: { $exists: false } }, { razorpayPaymentId: null }, { razorpayPaymentId: paymentId }]
      }, { $set: { razorpayPaymentId: paymentId, razorpaySignature: signature } });

      const finalized = await finalizeVerification({ purchase, studentId, paymentId, signature });
      const verified = finalized && finalized.verified;

      if (!verified) {
        const current = await Purchase.findOne({ razorpayOrderId: orderId, student: studentId });
        if (current && current.status === 'VERIFIED' && current.razorpayPaymentId === paymentId) {
          const enrollment = await ensurePurchaseEnrollment(current, studentId);
          return res.status(200).json({ success: true, purchase: publicPurchase(current), enrollment: publicEnrollment(enrollment) });
        }
        throw new AppError('Payment verification conflict', 409, 'PAYMENT_VERIFICATION_CONFLICT');
      }

      const enrollment = finalized.enrollment;
      await audit(req, 'PURCHASE_VERIFIED', 'PURCHASE', verified._id);
      return res.status(200).json({ success: true, purchase: publicPurchase(verified), enrollment: publicEnrollment(enrollment) });
    } catch (error) {
      if (error && error.code === 11000) {
        try {
          const orderId = req.body && req.body.razorpay_order_id;
          const paymentId = req.body && req.body.razorpay_payment_id;
          const signature = req.body && req.body.razorpay_signature;
          const recovered = await Purchase.findOne({ razorpayOrderId: orderId, student: req.user && req.user._id }).select('+razorpaySignature');
          const service = purchaseService || runtimePurchaseService();
          if (recovered && recovered.status === 'VERIFIED'
            && recovered.razorpayPaymentId === paymentId
            && service.verifySignature({ orderId, paymentId, signature })
            && service.signaturesEqual(recovered.razorpaySignature, signature)) {
            const enrollment = await ensurePurchaseEnrollment(recovered, req.user._id);
            return res.status(200).json({ success: true, purchase: publicPurchase(recovered), enrollment: publicEnrollment(enrollment) });
          }
        } catch (recoveryError) {
          return next(recoveryError instanceof AppError ? recoveryError : verificationUnavailable());
        }
        return next(new AppError('Payment verification conflict', 409, 'PAYMENT_VERIFICATION_CONFLICT'));
      }
      return next(error instanceof AppError ? error : verificationUnavailable());
    }
  }

  async function getPurchaseHistory(req, res, next) {
    try {
      const purchases = await Purchase.find({ student: req.user._id, status: { $in: ['VERIFIED', 'PENDING'] } })
        .sort({ createdAt: -1 })
        .populate({ path: 'course', select: 'title category thumbnail accessType price' });
      return res.status(200).json({
        success: true,
        purchases: purchases.map(publicPurchaseHistory)
      });
    } catch (error) {
      return next(error);
    }
  }

  return { createOrder, verifyPayment, getPurchaseHistory };
}

module.exports = { createPurchaseController, publicPurchase, publicPurchaseHistory };
