const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const Purchase = require('../models/purchase.schema');
const PurchaseOrderReservation = require('../models/purchase-order-reservation.schema');
const { createPurchaseService } = require('../services/purchase.service');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function purchaseValues(overrides = {}) {
  return {
    student: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    amount: 49900,
    receipt: `receipt_${crypto.randomUUID()}`,
    razorpayOrderId: `order_${crypto.randomUUID()}`,
    ...overrides
  };
}

test.before(async () => {
  await connectTestDb();
  await Purchase.init();
  await PurchaseOrderReservation.init();
});

test.after(async () => {
  await disconnectTestDb();
});

test('purchase validates its server-side payment snapshot and declares safe indexes', async () => {
  const purchase = await Purchase.create(purchaseValues());
  assert.equal(purchase.status, 'PENDING');
  assert.equal(purchase.currency, 'INR');
  assert.ok(purchase.createdAt instanceof Date);
  assert.equal(Purchase.schema.path('student').options.ref, 'User');
  assert.equal(Purchase.schema.path('course').options.ref, 'Course');
  assert.equal(Purchase.schema.path('razorpaySignature').options.select, false);
  assert.deepEqual(Purchase.schema.path('status').enumValues, ['PENDING', 'VERIFIED', 'FAILED']);

  await assert.rejects(
    () => Purchase.create(purchaseValues({ amount: 1.5 })),
    (error) => Boolean(error.errors.amount)
  );
  await assert.rejects(
    () => Purchase.create(purchaseValues({ amount: 0 })),
    (error) => Boolean(error.errors.amount)
  );

  const indexes = Purchase.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.razorpayOrderId === 1 && options.unique && options.sparse));
  assert.ok(indexes.some(([keys, options]) => keys.razorpayPaymentId === 1 && options.unique && options.sparse));
  assert.ok(indexes.some(([keys]) => keys.student === 1 && keys.course === 1 && keys.status === 1));
  assert.ok(indexes.some(([keys]) => keys.student === 1 && keys.status === 1 && keys.createdAt === -1));
  assert.equal(indexes.some(([keys, options]) => keys.student === 1 && keys.course === 1 && options.unique), false);
  await assert.rejects(
    () => new Purchase(purchaseValues({ status: 'ORDER_CREATING' })).validate(),
    (error) => Boolean(error.errors.status)
  );
  await assert.rejects(
    () => new Purchase(purchaseValues({ razorpayOrderId: undefined })).validate(),
    (error) => Boolean(error.errors.razorpayOrderId)
  );
});

test('purchase order identifiers remain unique while reservations own the active lease', async () => {
  const student = new mongoose.Types.ObjectId();
  const course = new mongoose.Types.ObjectId();
  await Purchase.create(purchaseValues({ student, course, razorpayOrderId: 'order_unique_purchase' }));

  await assert.rejects(
    () => Purchase.create(purchaseValues({ razorpayOrderId: 'order_unique_purchase' })),
    (error) => error && error.code === 11000
  );
});

test('purchase order reservations have a unique course lease and TTL cleanup index', async () => {
  const student = new mongoose.Types.ObjectId();
  const course = new mongoose.Types.ObjectId();
  await PurchaseOrderReservation.create({
    student,
    course,
    receipt: `c_${course.toString().slice(-6)}_${student.toString().slice(-6)}_0123456789abcdef0123`,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60_000)
  });
  await assert.rejects(
    () => PurchaseOrderReservation.create({
      student,
      course,
      receipt: `c_other_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000)
    }),
    (error) => error && error.code === 11000
  );

  const indexes = PurchaseOrderReservation.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.student === 1 && keys.course === 1 && options.unique));
  assert.ok(indexes.some(([keys, options]) => keys.leaseExpiresAt === 1 && options.expireAfterSeconds === 0));
});

test('signature verification uses timing-safe comparison and rejects unequal signatures without throwing', () => {
  const service = createPurchaseService({
    razorpay: { orders: { create: async () => ({}) } },
    secret: 'purchase-test-secret'
  });
  const orderId = 'order_test_123';
  const paymentId = 'pay_test_123';
  const signature = crypto.createHmac('sha256', 'purchase-test-secret')
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  assert.equal(service.verifySignature({ orderId, paymentId, signature }), true);
  assert.equal(service.verifySignature({ orderId, paymentId, signature: 'short' }), false);
  assert.equal(service.verifySignature({ orderId, paymentId, signature: `${signature}00` }), false);
});
