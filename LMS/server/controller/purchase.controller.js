const mongoose = require('mongoose');

const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Purchase = require('../models/purchase.schema');
const PurchaseOrderReservation = require('../models/purchase-order-reservation.schema');
const createRazorpayClient = require('../utils/razorpay');
const { createPurchaseService } = require('../services/purchase.service');
const { createPurchaseOrderReservationService } = require('../services/purchase-order-reservation.service');

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

function runtimePurchaseService() {
  return createPurchaseService({
    razorpay: createRazorpayClient(),
    secret: process.env.RAZORPAY_KEY_SECRET
  });
}

function createPurchaseController({ purchaseService, reservationService, razorpayKeyId } = {}) {
  const reservations = reservationService || createPurchaseOrderReservationService({
    Reservation: PurchaseOrderReservation,
    Purchase
  });

  async function existingPurchaseOrAccess(studentId, courseId) {
    const enrollment = await Enrollment.findOne({ student: studentId, course: courseId });
    if (enrollment && enrollment.status === 'REVOKED') {
      throw new AppError('Your access to this course has been revoked', 403);
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
      throw new AppError('Recovered provider order does not match this purchase intent', 409);
    }
  }

  function retryableReservationError() {
    return new AppError('Purchase order is being created. Please retry shortly.', 202);
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
      throw new AppError('Unable to look up purchase order', 502);
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
            throw new AppError('Unable to create purchase order', 502);
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
        return { purchase: failedPurchase, reusedFailedPurchase: true };
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
      return { purchase, reusedFailedPurchase: false };
    } catch (error) {
      await releaseIfLeaseOwner(reservation);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('Unable to create purchase order', 500);
    }
  }

  async function createOrder(req, res, next) {
    try {
      const { courseId } = req.body || {};
      if (!mongoose.isObjectIdOrHexString(courseId)) {
        throw new AppError('Invalid courseId format', 400);
      }

      const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' });
      if (!course) {
        throw new AppError('Course not found', 404);
      }
      if (course.accessType !== 'PAID') {
        throw new AppError('This course requires payment', 400);
      }
      if (!Number.isInteger(course.price) || course.price <= 0) {
        throw new AppError('Course price is unavailable', 400);
      }
      if (course.instructor.equals(req.user._id)) {
        throw new AppError('You cannot purchase your own course', 403);
      }

      const alreadyEntitled = await existingPurchaseOrAccess(req.user._id, course._id);
      if (alreadyEntitled) {
        return res.status(200).json({
          success: true,
          ...(alreadyEntitled.purchase ? { purchase: publicPurchase(alreadyEntitled.purchase) } : {}),
          ...(alreadyEntitled.access ? { access: alreadyEntitled.access } : {})
        });
      }

      const existingPending = await Purchase.findOne({ student: req.user._id, course: course._id, status: 'PENDING' });
      if (existingPending) {
        return res.status(200).json({
          success: true,
          purchase: publicPurchase(existingPending),
          order: {
            id: existingPending.razorpayOrderId,
            amount: existingPending.amount,
            currency: existingPending.currency
          },
          keyId: razorpayKeyId || process.env.RAZORPAY_KEY_ID
        });
      }

      const reservation = await reservations.acquire({ studentId: req.user._id, courseId: course._id });
      if (!reservation.owner) {
        return res.status(202).json({
          success: false,
          message: 'Purchase order is being created. Please retry shortly.'
        });
      }

      const result = await createReservedOrder({
        reservation: reservation.reservation,
        studentId: req.user._id,
        course,
        service: purchaseService || runtimePurchaseService()
      });
      const order = {
        id: result.purchase.razorpayOrderId,
        amount: result.purchase.amount,
        currency: result.purchase.currency
      };
      return res.status(result.reusedFailedPurchase ? 200 : 201).json({
        success: true,
        purchase: publicPurchase(result.purchase),
        order,
        keyId: razorpayKeyId || process.env.RAZORPAY_KEY_ID
      });
    } catch (error) {
      return next(error);
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
      throw new AppError('Your access to this course has been revoked', 403);
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
    if (!enrollment) throw new AppError('Unable to grant course access', 500);
    if (enrollment.status === 'REVOKED') {
      throw new AppError('Your access to this course has been revoked', 403);
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
      if (revoked) throw new AppError('Your access to this course has been revoked', 403);
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
        throw new AppError('Payment verification is temporarily unavailable', 503);
      }
      throw error;
    } finally {
      if (session) await session.endSession();
    }
  }

  async function verifyPayment(req, res, next) {
    try {
      if (!validVerificationBody(req.body)) {
        throw new AppError('Invalid payment verification payload', 400);
      }

      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
      const studentId = req.user._id;
      const purchase = await Purchase.findOne({ razorpayOrderId: orderId, student: studentId }).select('+razorpaySignature');
      // Keep a foreign order indistinguishable from an unknown order.
      if (!purchase) throw new AppError('Purchase not found', 404);

      const revoked = await Enrollment.findOne({ student: studentId, course: purchase.course, status: 'REVOKED' });
      if (revoked) throw new AppError('Your access to this course has been revoked', 403);

      const service = purchaseService || runtimePurchaseService();
      if (purchase.status === 'VERIFIED') {
        if (purchase.razorpayPaymentId !== paymentId) throw new AppError('Payment verification conflict', 409);
        if (!service.verifySignature({ orderId, paymentId, signature })
          || !service.signaturesEqual(purchase.razorpaySignature, signature)) {
          throw new AppError('Payment verification failed', 400);
        }
        const enrollment = await ensurePurchaseEnrollment(purchase, studentId);
        return res.status(200).json({ success: true, purchase: publicPurchase(purchase), enrollment: publicEnrollment(enrollment) });
      }
      if (purchase.status === 'FAILED') throw new AppError('Payment verification has already failed', 409);

      if (!service.verifySignature({ orderId, paymentId, signature })) {
        await Purchase.updateOne({ _id: purchase._id, status: 'PENDING' }, { $set: { status: 'FAILED' } });
        throw new AppError('Payment verification failed', 400);
      }

      const boundElsewhere = await Purchase.exists({
        razorpayPaymentId: paymentId,
        _id: { $ne: purchase._id }
      });
      if (boundElsewhere) throw new AppError('Payment has already been used', 409);

      const finalized = await finalizeVerification({ purchase, studentId, paymentId, signature });
      const verified = finalized && finalized.verified;

      if (!verified) {
        const current = await Purchase.findOne({ razorpayOrderId: orderId, student: studentId });
        if (current && current.status === 'VERIFIED' && current.razorpayPaymentId === paymentId) {
          const enrollment = await ensurePurchaseEnrollment(current, studentId);
          return res.status(200).json({ success: true, purchase: publicPurchase(current), enrollment: publicEnrollment(enrollment) });
        }
        throw new AppError('Payment verification conflict', 409);
      }

      const enrollment = finalized.enrollment;
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
          return next(recoveryError);
        }
        return next(new AppError('Payment verification conflict', 409));
      }
      return next(error);
    }
  }

  async function getPurchaseHistory(req, res, next) {
    try {
      const purchases = await Purchase.find({ student: req.user._id, status: 'VERIFIED' })
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
