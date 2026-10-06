const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Purchase = require('../models/purchase.schema');
const PurchaseOrderReservation = require('../models/purchase-order-reservation.schema');
const Payment = require('../models/payment.schema');
const { createPurchaseService } = require('../services/purchase.service');
const { createPurchaseOrderReservationService, createReceipt } = require('../services/purchase-order-reservation.service');
const { createApp } = require('../app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildRazorpay() {
  const calls = [];
  return {
    calls,
    client: {
      orders: {
        all: async () => ({ items: [] }),
        create: async (payload) => {
          calls.push(payload);
          return { id: `order_${calls.length}`, amount: 1, currency: 'USD' };
        }
      }
    }
  };
}

function buildApp(razorpay, options = {}) {
  razorpay.orders.all ??= async () => ({ items: [] });
  return createApp({
    purchaseService: createPurchaseService({ razorpay, secret: 'purchase-flow-secret' }),
    razorpayKeyId: 'rzp_test_public_key',
    ...options
  });
}

async function createUser(role = 'STUDENT') {
  const id = unique('purchase-user');
  return User.create({
    fullName: 'Purchase Test User',
    email: `${id}@example.com`,
    password: 'password123',
    role
  });
}

async function login(app, user) {
  const agent = request.agent(app);
  const response = await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'password123' });
  assert.equal(response.status, 200);
  return agent;
}

async function createCourse(instructor, overrides = {}) {
  return Course.create({
    title: unique('A paid purchase course').slice(0, 48),
    description: 'A course used to test safe Razorpay order creation.',
    category: 'Programming',
    instructor: instructor._id,
    accessType: 'PAID',
    price: 49900,
    thumbnail: { public_id: unique('thumbnail'), secure_url: 'https://example.test/thumbnail.jpg' },
    ...overrides
  });
}

function paymentPayload(orderId, paymentId, secret = 'purchase-flow-secret') {
  return {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex')
  };
}

test.before(async () => {
  process.env.JWT_SECRET = 'purchase-flow-jwt-secret';
  process.env.JWT_EXPIRY = '1h';
  process.env.FRONTEND_URL = 'http://lms-frontend.test';
  await connectTestDb();
  await Purchase.init();
  await PurchaseOrderReservation.init();
});

test.after(async () => {
  await disconnectTestDb();
});

test('a student creates a paid order using only the server-side course price and receives safe fields', async () => {
  const razorpay = buildRazorpay();
  const app = buildApp(razorpay.client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);

  const response = await (await login(app, student))
    .post('/api/v1/payments/orders')
    .send({ courseId: course.id, amount: 1, currency: 'USD', receipt: 'attacker-receipt' });

  assert.equal(response.status, 201);
  assert.deepEqual(razorpay.calls, [{ amount: 49900, currency: 'INR', receipt: response.body.purchase.receipt }]);
  assert.deepEqual(response.body.order, { id: 'order_1', amount: 49900, currency: 'INR' });
  assert.equal(response.body.keyId, 'rzp_test_public_key');
  assert.equal(response.body.purchase.amount, 49900);
  assert.equal(response.body.purchase.currency, 'INR');
  assert.equal(response.body.purchase.status, 'PENDING');
  assert.equal(Object.hasOwn(response.body.purchase, 'razorpaySignature'), false);
  assert.equal(JSON.stringify(response.body).includes('purchase-flow-secret'), false);

  const stored = await Purchase.findOne({ student: student._id, course: course._id }).lean();
  assert.equal(stored.amount, 49900);
  assert.equal(stored.status, 'PENDING');
  assert.equal(stored.razorpayOrderId, 'order_1');
  assert.match(stored.receipt, /^c_[a-f0-9]{32}$/);
  assert.equal(stored.receipt.length, 34);
  assert.equal(stored.receipt.length <= 40, true);
});

test('ineligible courses and self-owned course are rejected before Razorpay is called', async () => {
  const razorpay = buildRazorpay();
  const app = buildApp(razorpay.client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const free = await createCourse(instructor, { accessType: 'FREE', price: 0 });
  const unpublished = await createCourse(instructor, { status: 'UNPUBLISHED' });
  const studentAgent = await login(app, student);

  const attempts = [
    await studentAgent.post('/api/v1/payments/orders').send({ courseId: free.id }),
    await studentAgent.post('/api/v1/payments/orders').send({ courseId: unpublished.id }),
    await studentAgent.post('/api/v1/payments/orders').send({ courseId: new mongoose.Types.ObjectId().toString() }),
    await studentAgent.post('/api/v1/payments/orders').send({ courseId: 'not-an-object-id' }),
    await (await login(app, instructor)).post('/api/v1/payments/orders').send({ courseId: free.id })
  ];

  assert.equal(attempts[0].status, 400);
  assert.equal(attempts[0].body.message, 'This course requires payment');
  assert.equal(attempts[1].status, 404);
  assert.equal(attempts[2].status, 404);
  assert.equal(attempts[3].status, 400);
  assert.equal(attempts[4].status, 403);
  assert.equal(razorpay.calls.length, 0);

  const owned = await createCourse(student);
  const selfOwned = await studentAgent.post('/api/v1/payments/orders').send({ courseId: owned.id });
  assert.equal(selfOwned.status, 403);
  assert.equal(selfOwned.body.message, 'You cannot purchase your own course');
  assert.equal(razorpay.calls.length, 0);
});

test('only students can create purchase orders', async () => {
  const razorpay = buildRazorpay();
  const app = buildApp(razorpay.client);
  const owner = await createUser('INSTRUCTOR');
  const course = await createCourse(owner);
  for (const role of ['INSTRUCTOR', 'ADMIN']) {
    const response = await (await login(app, await createUser(role)))
      .post('/api/v1/payments/orders').send({ courseId: course.id });
    assert.equal(response.status, 403);
    assert.equal(response.body.message, 'You do not have access to this route');
  }
  assert.equal(razorpay.calls.length, 0);
});

test('a contender receives a retryable response while a durable order reservation is creating', async () => {
  let releaseOrder;
  let signalOrderStarted;
  const orderStarted = new Promise((resolve) => { signalOrderStarted = resolve; });
  const orderReleaseGate = new Promise((resolve) => { releaseOrder = resolve; });
  const razorpay = { calls: [], orders: { create: async (payload) => {
    razorpay.calls.push(payload);
    signalOrderStarted();
    await orderReleaseGate;
    return { id: 'order_concurrent', amount: payload.amount, currency: payload.currency };
  } } };
  const app = buildApp(razorpay);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const agent = await login(app, student);

  const first = agent.post('/api/v1/payments/orders').send({ courseId: course.id }).then((response) => response);
  await orderStarted;
  const second = await agent.post('/api/v1/payments/orders').send({ courseId: course.id });
  releaseOrder();
  const firstResponse = await first;
  const secondResponse = second;

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 202);
  assert.equal(secondResponse.body.message, 'Purchase order is being created. Please retry shortly.');
  assert.equal(razorpay.calls.length, 1);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id, status: 'PENDING' }), 1);

  const repeated = await agent.post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.purchase.id, firstResponse.body.purchase.id);
  assert.equal(razorpay.calls.length, 1);
});

test('separate app instances use the durable reservation so only its winner calls Razorpay', async () => {
  let releaseOrder;
  let signalOrderStarted;
  const orderStarted = new Promise((resolve) => { signalOrderStarted = resolve; });
  const firstRazorpay = { calls: [], orders: { create: async (payload) => {
    firstRazorpay.calls.push(payload);
    signalOrderStarted();
    await new Promise((resolve) => { releaseOrder = resolve; });
    return { id: 'order_worker_a', amount: payload.amount, currency: payload.currency };
  } } };
  const secondRazorpay = { calls: [], orders: { create: async (payload) => {
    secondRazorpay.calls.push(payload);
    return { id: 'order_worker_b', amount: payload.amount, currency: payload.currency };
  } } };
  const appA = buildApp(firstRazorpay);
  const appB = buildApp(secondRazorpay);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const agentA = await login(appA, student);
  const agentB = await login(appB, student);

  const winner = agentA.post('/api/v1/payments/orders').send({ courseId: course.id }).then((response) => response);
  await orderStarted;
  const contender = await agentB.post('/api/v1/payments/orders').send({ courseId: course.id });
  const contenderCallCount = secondRazorpay.calls.length;
  const creatingReservations = await PurchaseOrderReservation.countDocuments({
    student: student._id,
    course: course._id
  });
  releaseOrder();
  const winnerResponse = await winner;
  assert.equal(contender.status, 202);
  assert.equal(contender.body.message, 'Purchase order is being created. Please retry shortly.');
  assert.equal(firstRazorpay.calls.length, 1);
  assert.equal(contenderCallCount, 0);
  assert.equal(creatingReservations, 1);
  assert.equal(winnerResponse.status, 201);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 1);
  assert.equal(await PurchaseOrderReservation.countDocuments({ student: student._id, course: course._id }), 0);

  const reused = await agentB.post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(reused.status, 200);
  assert.equal(reused.body.order.id, 'order_worker_a');
  assert.equal(secondRazorpay.calls.length, 0);
});

test('a duplicate-receipt provider response is recovered by receipt lookup without another order', async () => {
  let providerOrder;
  let lookupCount = 0;
  const razorpay = { calls: [], orders: {
    all: async () => {
      lookupCount += 1;
      return { items: lookupCount === 1 ? [] : [providerOrder] };
    },
    create: async (payload) => {
      razorpay.calls.push(payload);
      throw new Error('receipt already exists');
    }
  } };
  const app = buildApp(razorpay);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  providerOrder = {
    id: 'order_duplicate_receipt',
    amount: course.price,
    currency: 'INR',
    receipt: createReceipt(course.id, student.id)
  };
  const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(response.status, 201);
  assert.equal(response.body.order.id, providerOrder.id);
  assert.equal(response.body.purchase.receipt, createReceipt(course.id, student.id));
  assert.equal(razorpay.calls.length, 1);
  assert.equal(lookupCount, 2);
});

test('a FAILED Purchase with a valid provider order is restored to PENDING without creating another order', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const receipt = createReceipt(course.id, student.id);
  const failed = await Purchase.create({
    student: student._id,
    course: course._id,
    amount: course.price,
    receipt,
    razorpayOrderId: 'order_failed_reusable',
    status: 'FAILED'
  });
  const providerOrder = { id: 'order_failed_reusable', receipt, currency: 'INR', amount: course.price };
  const razorpay = { calls: [], orders: {
    all: async () => ({ items: [providerOrder] }),
    create: async (payload) => { razorpay.calls.push(payload); throw new Error('must not create'); }
  } };
  const app = buildApp(razorpay);

  const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(response.status, 200);
  assert.equal(response.body.purchase.id, failed.id);
  assert.equal(response.body.purchase.status, 'PENDING');
  assert.equal(razorpay.calls.length, 0);
  const restored = await Purchase.findById(failed._id);
  assert.equal(restored.status, 'PENDING');
  assert.equal(restored.razorpayOrderId, providerOrder.id);
});

test('a FAILED Purchase without a provider order is removed before a new order is created', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const receipt = createReceipt(course.id, student.id);
  const failed = await Purchase.create({
    student: student._id,
    course: course._id,
    amount: course.price,
    receipt,
    razorpayOrderId: 'order_failed_missing',
    status: 'FAILED'
  });
  const razorpay = { calls: [], orders: {
    all: async () => ({ items: [] }),
    create: async (payload) => {
      razorpay.calls.push(payload);
      return { id: 'order_after_failed_cleanup', amount: payload.amount, currency: payload.currency };
    }
  } };
  const app = buildApp(razorpay);

  const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(response.status, 201);
  assert.equal(razorpay.calls.length, 1);
  assert.equal(await Purchase.exists({ _id: failed._id }), null);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id, status: 'PENDING' }), 1);
});

test('a stale lease owner returns retryable 202 without touching Razorpay while a replacement creates one order', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const receipt = createReceipt(course.id, student.id);
  const staleReservationService = {
    acquire: async () => ({
      owner: true,
      reservation: { _id: new mongoose.Types.ObjectId(), receipt, leaseToken: 'stale-token' }
    }),
    ownsLease: async () => false,
    release: async () => assert.fail('stale worker must not release another worker lease')
  };
  const razorpay = { calls: [], lookups: 0, orders: {
    all: async () => { razorpay.lookups += 1; return { items: [] }; },
    create: async (payload) => {
      razorpay.calls.push(payload);
      return { id: 'order_replacement_winner', amount: payload.amount, currency: payload.currency };
    }
  } };
  const staleApp = buildApp(razorpay, { reservationService: staleReservationService });
  const replacementApp = buildApp(razorpay);

  const stale = await (await login(staleApp, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(stale.status, 202);
  assert.equal(stale.body.message, 'Purchase order is being created. Please retry shortly.');
  assert.equal(razorpay.lookups, 0);
  assert.equal(razorpay.calls.length, 0);

  const replacement = await (await login(replacementApp, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(replacement.status, 201);
  assert.equal(razorpay.calls.length, 1);
});

test('a Razorpay receipt lookup failure returns safe 502 without creating a Purchase', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const razorpay = { calls: [], orders: {
    all: async () => { throw new Error('provider lookup secret detail'); },
    create: async (payload) => { razorpay.calls.push(payload); throw new Error('must not create'); }
  } };
  const app = buildApp(razorpay);

  const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(response.status, 502);
  assert.equal(response.body.message, 'Unable to look up purchase order');
  assert.equal(JSON.stringify(response.body).includes('provider lookup secret detail'), false);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 0);
  assert.equal(razorpay.calls.length, 0);
});

test('an expired lease recovers a provider order created before local Purchase persistence', async () => {
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const receipt = createReceipt(course.id, student.id);
  const providerOrder = { id: 'order_crash_recovery', amount: course.price, currency: 'INR', receipt };
  const razorpay = { calls: [], orders: {
    all: async () => ({ items: [providerOrder] }),
    create: async (payload) => { razorpay.calls.push(payload); throw new Error('must not create'); }
  } };
  const app = buildApp(razorpay);
  await PurchaseOrderReservation.create({
    student: student._id,
    course: course._id,
    receipt,
    leaseToken: 'crashed-worker',
    leaseExpiresAt: new Date(Date.now() - 60_000)
  });
  await Course.updateOne({ _id: course._id }, { $set: { price: 99900 } });

  const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(response.status, 201);
  assert.equal(response.body.order.id, providerOrder.id);
  assert.equal(response.body.purchase.amount, 49900);
  assert.equal(razorpay.calls.length, 0);
  const persisted = await Purchase.findOne({ student: student._id, course: course._id });
  assert.equal(persisted.amount, 49900);
  assert.equal(persisted.razorpayOrderId, providerOrder.id);
});

test('recovered provider orders with mismatched receipt, currency, or amount are rejected without local access', async () => {
  const cases = [
    { name: 'receipt', order: { receipt: 'c_wrong_receipt', currency: 'INR', amount: 49900 } },
    { name: 'currency', order: { currency: 'USD', amount: 49900 } },
    { name: 'amount', order: { currency: 'INR', amount: 1.5 } }
  ];

  for (const invalid of cases) {
    const instructor = await createUser('INSTRUCTOR');
    const student = await createUser();
    const course = await createCourse(instructor);
    const receipt = createReceipt(course.id, student.id);
    const providerOrder = {
      id: `order_invalid_${invalid.name}_${unique('provider')}`,
      receipt,
      ...invalid.order
    };
    const razorpay = { calls: [], orders: {
      all: async () => ({ items: [providerOrder] }),
      create: async (payload) => { razorpay.calls.push(payload); throw new Error('must not create'); }
    } };
    const app = buildApp(razorpay);
    await PurchaseOrderReservation.create({
      student: student._id,
      course: course._id,
      receipt,
      leaseToken: `invalid-${invalid.name}`,
      leaseExpiresAt: new Date(Date.now() - 60_000)
    });

    const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
    assert.equal(response.status, 409, invalid.name);
    assert.equal(response.body.message, 'Recovered provider order does not match this purchase intent');
    assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 0);
    assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
    assert.equal(razorpay.calls.length, 0);
  }
});

test('a lease expiry during a slow provider create still produces one provider order and one Purchase', async () => {
  let nowMs = Date.now();
  const reservationService = createPurchaseOrderReservationService({
    Reservation: PurchaseOrderReservation,
    Purchase,
    leaseMs: 10,
    now: () => new Date(nowMs)
  });
  let releaseCreate;
  let signalCreated;
  let signalRecoveryLookup;
  const created = new Promise((resolve) => { signalCreated = resolve; });
  const recoveryLookup = new Promise((resolve) => { signalRecoveryLookup = resolve; });
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  let providerOrder;
  const razorpay = { calls: [], orders: {
    all: async ({ receipt }) => {
      if (providerOrder && providerOrder.receipt === receipt) {
        signalRecoveryLookup();
        return { items: [providerOrder] };
      }
      return { items: [] };
    },
    create: async (payload) => {
      razorpay.calls.push(payload);
      if (!providerOrder) {
        providerOrder = { id: 'order_slow_provider', amount: payload.amount, currency: payload.currency, receipt: payload.receipt };
        signalCreated();
      }
      await createGate;
      return providerOrder;
    }
  } };
  const appA = buildApp(razorpay, { reservationService });
  const appB = buildApp(razorpay, { reservationService });
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const agentA = await login(appA, student);
  const agentB = await login(appB, student);

  const first = agentA.post('/api/v1/payments/orders').send({ courseId: course.id }).then((response) => response);
  await created;
  nowMs += 11;
  const recoveredPromise = agentB.post('/api/v1/payments/orders').send({ courseId: course.id }).then((response) => response);
  await recoveryLookup;
  releaseCreate();
  const recovered = await recoveredPromise;
  const firstResponse = await first;

  assert.equal(recovered.status, 201);
  // The original owner lost its lease while Razorpay was in flight. It must
  // not finalize the Purchase after the replacement has taken ownership.
  assert.equal(firstResponse.status, 202);
  assert.equal(razorpay.calls.length, 1);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 1);
  assert.equal((await Purchase.findOne({ student: student._id, course: course._id })).razorpayOrderId, 'order_slow_provider');
});

test('a failed Razorpay call removes its reservation so the student can retry without access', async () => {
  let attempts = 0;
  const razorpay = { orders: { create: async (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error('Razorpay unavailable');
    return { id: 'order_retry_after_failure', amount: payload.amount, currency: payload.currency };
  } } };
  const app = buildApp(razorpay);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const agent = await login(app, student);

  const failed = await agent.post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(failed.status, 502);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 0);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
  assert.equal(await PurchaseOrderReservation.countDocuments({ student: student._id, course: course._id }), 0);

  const retried = await agent.post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(retried.status, 201);
  assert.equal(retried.body.order.id, 'order_retry_after_failure');
  assert.equal(attempts, 2);
});

test('verified purchases, purchase enrollments, and revoked access remain unchanged', async () => {
  const razorpay = buildRazorpay();
  const app = buildApp(razorpay.client);
  const instructor = await createUser('INSTRUCTOR');
  const course = await createCourse(instructor);

  const verifiedStudent = await createUser();
  const verified = await Purchase.create({
    student: verifiedStudent._id, course: course._id, amount: course.price, receipt: unique('receipt'),
    razorpayOrderId: unique('order'), status: 'VERIFIED'
  });
  const verifiedResponse = await (await login(app, verifiedStudent)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(verifiedResponse.status, 200);
  assert.equal(verifiedResponse.body.purchase.id, verified.id);
  assert.equal(verifiedResponse.body.purchase.status, 'VERIFIED');

  const enrolledStudent = await createUser();
  await Enrollment.create({ student: enrolledStudent._id, course: course._id, source: 'PURCHASE' });
  const enrolledResponse = await (await login(app, enrolledStudent)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(enrolledResponse.status, 200);
  assert.equal(enrolledResponse.body.access.granted, true);
  assert.equal(await Purchase.countDocuments({ student: enrolledStudent._id, course: course._id }), 0);

  const revokedStudent = await createUser();
  await Enrollment.create({ student: revokedStudent._id, course: course._id, source: 'PURCHASE', status: 'REVOKED' });
  const revokedResponse = await (await login(app, revokedStudent)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.deepEqual(revokedResponse.body.success, false);
  assert.equal(revokedResponse.status, 403);
  assert.equal(revokedResponse.body.message, 'Your access to this course has been revoked');
  assert.equal(await Purchase.countDocuments({ student: revokedStudent._id, course: course._id }), 0);
  assert.equal(razorpay.calls.length, 0);
});

test('a reservation finalization failure after Razorpay order creation grants no access and returns a safe error', async () => {
  const razorpay = buildRazorpay();
  const app = buildApp(razorpay.client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const originalCreate = Purchase.create;
  Purchase.create = async () => { throw new Error('database implementation detail'); };

  try {
    const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
    assert.equal(response.status, 500);
    assert.equal(response.body.message, 'Unable to create purchase order');
    assert.equal(JSON.stringify(response.body).includes('database implementation detail'), false);
    assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 0);
    assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
    assert.equal(await PurchaseOrderReservation.countDocuments({ student: student._id, course: course._id }), 0);
    assert.equal(razorpay.calls.length, 1);
  } finally {
    Purchase.create = originalCreate;
  }
});

test('an expired lease is deterministically taken over without waiting for TTL cleanup', async () => {
  const razorpay = { calls: [], orders: { create: async (payload) => {
    razorpay.calls.push(payload);
    return { id: 'order_expired_lease', amount: payload.amount, currency: payload.currency };
  } } };
  const app = buildApp(razorpay);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  await PurchaseOrderReservation.create({
    student: student._id,
    course: course._id,
    receipt: `c_${course.id.slice(-6)}_${student.id.slice(-6)}_aaaaaaaaaaaaaaaaaaaa`,
    leaseToken: 'stale-lease-token',
    leaseExpiresAt: new Date(Date.now() - 60_000)
  });

  const response = await (await login(app, student)).post('/api/v1/payments/orders').send({ courseId: course.id });
  assert.equal(response.status, 201);
  assert.equal(razorpay.calls.length, 1);
  assert.equal(await Purchase.countDocuments({ student: student._id, course: course._id }), 1);
  assert.equal(await PurchaseOrderReservation.countDocuments({ student: student._id, course: course._id }), 0);
});

test('the app health endpoint can be imported without Razorpay credentials', async () => {
  const oldKey = process.env.RAZORPAY_KEY_ID;
  const oldSecret = process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  try {
    delete require.cache[require.resolve('../app')];
    const freshApp = require('../app');
    const response = await request(freshApp).get('/health');
    assert.deepEqual(response.body, { success: true, status: 'ok' });
  } finally {
    if (oldKey === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = oldKey;
    if (oldSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = oldSecret;
  }
});

test('a student verifies a paid order once, receives purchase access, and may safely repeat the callback', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    lectures: [{
      title: 'Purchased lesson',
      description: 'Protected after successful payment.',
      lecture: { public_id: unique('video'), secure_url: 'https://example.test/video.mp4' }
    }]
  });
  const orderId = unique('order');
  const paymentId = unique('payment');
  await Purchase.create({
    student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'),
    razorpayOrderId: orderId, status: 'PENDING'
  });
  const agent = await login(app, student);

  const first = await agent.post('/api/v1/payments/verify').send(paymentPayload(orderId, paymentId));
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(JSON.stringify(first.body).includes('purchase-flow-secret'), false);
  assert.equal(JSON.stringify(first.body).includes('razorpay_signature'), false);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' }), 1);
  const stored = await Purchase.findOne({ razorpayOrderId: orderId }).select('+razorpaySignature');
  assert.equal(stored.status, 'VERIFIED');
  assert.equal(stored.razorpayPaymentId, paymentId);

  const repeated = await agent.post('/api/v1/payments/verify').send(paymentPayload(orderId, paymentId));
  assert.equal(repeated.status, 200);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 1);
  const lesson = await agent.get(`/api/v1/courses/${course.id}/lectures/${course.lectures[0]._id}`);
  assert.equal(lesson.status, 200);
});

test('an invalid payment signature fails the local purchase and grants no enrollment', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const orderId = unique('order');
  await Purchase.create({ student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'), razorpayOrderId: orderId });

  const response = await (await login(app, student)).post('/api/v1/payments/verify').send({
    razorpay_order_id: orderId,
    razorpay_payment_id: unique('payment'),
    razorpay_signature: 'not-a-valid-signature'
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.message, 'Payment verification failed');
  assert.equal((await Purchase.findOne({ razorpayOrderId: orderId })).status, 'FAILED');
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
  const retry = await (await login(app, student)).post('/api/v1/payments/verify').send(paymentPayload(orderId, unique('payment')));
  assert.equal(retry.status, 409);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
});

test('verification hides foreign orders and rejects a payment identifier replay', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const firstStudent = await createUser();
  const secondStudent = await createUser();
  const firstCourse = await createCourse(instructor);
  const secondCourse = await createCourse(instructor);
  const firstOrder = unique('order');
  const secondOrder = unique('order');
  const paymentId = unique('payment');
  await Purchase.create({ student: firstStudent._id, course: firstCourse._id, amount: firstCourse.price, receipt: unique('receipt'), razorpayOrderId: firstOrder });
  await Purchase.create({ student: secondStudent._id, course: secondCourse._id, amount: secondCourse.price, receipt: unique('receipt'), razorpayOrderId: secondOrder });

  const verified = await (await login(app, firstStudent)).post('/api/v1/payments/verify').send(paymentPayload(firstOrder, paymentId));
  assert.equal(verified.status, 200);
  const foreign = await (await login(app, secondStudent)).post('/api/v1/payments/verify').send(paymentPayload(firstOrder, unique('payment')));
  assert.equal(foreign.status, 404);
  const replay = await (await login(app, secondStudent)).post('/api/v1/payments/verify').send(paymentPayload(secondOrder, paymentId));
  assert.equal(replay.status, 409);
  assert.equal((await Purchase.findOne({ razorpayOrderId: secondOrder })).status, 'PENDING');
  assert.equal(await Enrollment.countDocuments({ student: secondStudent._id, course: secondCourse._id }), 0);
});

test('verification preserves a revoked enrollment and only accepts complete student payloads', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const orderId = unique('order');
  await Purchase.create({ student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'), razorpayOrderId: orderId });
  await Enrollment.create({ student: student._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'REVOKED' });
  const agent = await login(app, student);

  const revoked = await agent.post('/api/v1/payments/verify').send(paymentPayload(orderId, unique('payment')));
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.message, 'Your access to this course has been revoked');
  assert.equal((await Purchase.findOne({ razorpayOrderId: orderId })).status, 'PENDING');
  const malformed = await agent.post('/api/v1/payments/verify').send({ razorpay_order_id: orderId, razorpay_payment_id: '' });
  assert.equal(malformed.status, 400);
  assert.equal((await Purchase.findOne({ razorpayOrderId: orderId })).status, 'PENDING');
  for (const role of ['INSTRUCTOR', 'ADMIN']) {
    const denied = await (await login(app, await createUser(role))).post('/api/v1/payments/verify').send(paymentPayload(orderId, unique('payment')));
    assert.equal(denied.status, 403);
  }
});

test('concurrent valid callbacks create exactly one active purchase enrollment', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const orderId = unique('order');
  const paymentId = unique('payment');
  await Purchase.create({ student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'), razorpayOrderId: orderId });
  const agent = await login(app, student);
  const payload = paymentPayload(orderId, paymentId);
  const responses = await Promise.all([
    agent.post('/api/v1/payments/verify').send(payload),
    agent.post('/api/v1/payments/verify').send(payload)
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
  assert.equal(await Purchase.countDocuments({ razorpayOrderId: orderId, status: 'VERIFIED', razorpayPaymentId: paymentId }), 1);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' }), 1);
});

test('an enrollment write failure rolls back the payment transaction so no paid access or verified purchase persists', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const orderId = unique('order');
  const paymentId = unique('payment');
  await Purchase.create({ student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'), razorpayOrderId: orderId });
  const originalUpdateOne = Enrollment.updateOne;
  Enrollment.updateOne = async () => { throw new Error('enrollment persistence failed'); };
  try {
    const response = await (await login(app, student)).post('/api/v1/payments/verify').send(paymentPayload(orderId, paymentId));
    assert.equal(response.status, 500);
    assert.equal((await Purchase.findOne({ razorpayOrderId: orderId })).status, 'PENDING');
    assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id, status: 'ACTIVE' }), 0);
  } finally {
    Enrollment.updateOne = originalUpdateOne;
  }
});

test('unavailable transaction support returns a safe 503 without changing payment or access state', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const orderId = unique('order');
  await Purchase.create({ student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'), razorpayOrderId: orderId });
  const originalStartSession = mongoose.startSession;
  mongoose.startSession = async () => { throw new Error('transactions unsupported'); };
  try {
    const response = await (await login(app, student)).post('/api/v1/payments/verify').send(paymentPayload(orderId, unique('payment')));
    assert.equal(response.status, 503);
    assert.equal(response.body.message, 'Payment verification is temporarily unavailable');
    assert.equal((await Purchase.findOne({ razorpayOrderId: orderId })).status, 'PENDING');
    assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
  } finally {
    mongoose.startSession = originalStartSession;
  }
});

test('a verified purchase only treats the exact valid callback as idempotent', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor);
  const orderId = unique('order');
  const paymentId = unique('payment');
  const signature = paymentPayload(orderId, paymentId).razorpay_signature;
  await Purchase.create({
    student: student._id, course: course._id, amount: course.price, receipt: unique('receipt'), razorpayOrderId: orderId,
    razorpayPaymentId: paymentId, razorpaySignature: signature, status: 'VERIFIED'
  });
  const agent = await login(app, student);
  const wrongPayment = await agent.post('/api/v1/payments/verify').send(paymentPayload(orderId, unique('payment')));
  assert.equal(wrongPayment.status, 409);
  const wrongSignature = await agent.post('/api/v1/payments/verify').send({ ...paymentPayload(orderId, paymentId), razorpay_signature: 'bad-signature' });
  assert.equal(wrongSignature.status, 400);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id }), 0);
  const repeated = await agent.post('/api/v1/payments/verify').send(paymentPayload(orderId, paymentId));
  assert.equal(repeated.status, 200);
  assert.equal(await Enrollment.countDocuments({ student: student._id, course: course._id, source: 'PURCHASE', status: 'ACTIVE' }), 1);
});

test('subscription-shaped verification is dispatched to the legacy handler while purchase-shaped verification stays on purchases', async () => {
  const app = buildApp(buildRazorpay().client);
  const student = await createUser();
  student.subscription = { id: unique('subscription'), status: 'created' };
  await student.save();
  const paymentId = unique('subscription-payment');
  const subscriptionId = student.subscription.id;
  const previousSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = 'legacy-verify-secret';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`).digest('hex');
  try {
    const legacy = await (await login(app, student)).post('/api/v1/payments/verify').send({
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: signature
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.message, 'Payment verified successfully');
    assert.equal(await Payment.countDocuments({ razorpay_subscription_id: subscriptionId, razorpay_payment_id: paymentId }), 1);
    assert.equal((await User.findById(student._id)).subscription.status, 'active');

    const hybrid = await (await login(app, student)).post('/api/v1/payments/verify').send({
      razorpay_order_id: unique('order'),
      razorpay_payment_id: unique('payment'),
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: signature
    });
    assert.equal(hybrid.status, 400);
    assert.equal(await Payment.countDocuments({ razorpay_subscription_id: subscriptionId }), 1);
  } finally {
    if (previousSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = previousSecret;
  }
});

test('a student with no verified purchases receives an empty purchase history', async () => {
  const app = buildApp(buildRazorpay().client);
  const student = await createUser();

  const response = await (await login(app, student)).get('/api/v1/purchases');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, purchases: [] });
});

test('purchase history contains only the student\'s verified purchases newest first with safe course cards', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const otherStudent = await createUser();
  const olderCourse = await createCourse(instructor, {
    description: 'This description must not be exposed through a history course card.',
    lectures: [{
      title: 'Private lesson',
      description: 'Private media must not be exposed.',
      lecture: { public_id: unique('video'), secure_url: 'https://example.test/private-video.mp4' }
    }]
  });
  const newerCourse = await createCourse(instructor, { category: 'Security' });
  const excludedCourse = await createCourse(instructor, { category: 'Excluded' });
  const foreignCourse = await createCourse(instructor, { category: 'Foreign' });
  const olderAt = new Date('2026-01-01T00:00:00.000Z');
  const newerAt = new Date('2026-01-02T00:00:00.000Z');

  const older = await Purchase.create({
    student: student._id,
    course: olderCourse._id,
    amount: olderCourse.price,
    receipt: unique('receipt'),
    razorpayOrderId: unique('order'),
    razorpayPaymentId: unique('payment'),
    razorpaySignature: 'signature-must-not-leak',
    status: 'VERIFIED',
    createdAt: olderAt,
    updatedAt: olderAt
  });
  const newer = await Purchase.create({
    student: student._id,
    course: newerCourse._id,
    amount: newerCourse.price,
    receipt: unique('receipt'),
    razorpayOrderId: unique('order'),
    razorpayPaymentId: unique('payment'),
    razorpaySignature: 'another-signature-must-not-leak',
    status: 'VERIFIED',
    createdAt: newerAt,
    updatedAt: newerAt
  });
  await Purchase.create({
    student: student._id,
    course: excludedCourse._id,
    amount: excludedCourse.price,
    receipt: unique('receipt'),
    razorpayOrderId: unique('order'),
    status: 'PENDING'
  });
  await Purchase.create({
    student: student._id,
    course: excludedCourse._id,
    amount: excludedCourse.price,
    receipt: unique('receipt'),
    razorpayOrderId: unique('order'),
    status: 'FAILED'
  });
  await Purchase.create({
    student: otherStudent._id,
    course: foreignCourse._id,
    amount: foreignCourse.price,
    receipt: unique('receipt'),
    razorpayOrderId: unique('order'),
    razorpayPaymentId: unique('payment'),
    status: 'VERIFIED'
  });

  const response = await (await login(app, student)).get('/api/v1/purchases');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    purchases: [
      {
        id: newer.id,
        amount: newerCourse.price,
        currency: 'INR',
        receipt: newer.receipt,
        razorpayPaymentId: newer.razorpayPaymentId,
        updatedAt: newerAt.toISOString(),
        course: {
          id: newerCourse.id,
          title: newerCourse.title,
          category: newerCourse.category,
          thumbnail: newerCourse.thumbnail.toObject(),
          accessType: 'PAID',
          price: newerCourse.price
        }
      },
      {
        id: older.id,
        amount: olderCourse.price,
        currency: 'INR',
        receipt: older.receipt,
        razorpayPaymentId: older.razorpayPaymentId,
        updatedAt: olderAt.toISOString(),
        course: {
          id: olderCourse.id,
          title: olderCourse.title,
          category: olderCourse.category,
          thumbnail: olderCourse.thumbnail.toObject(),
          accessType: 'PAID',
          price: olderCourse.price
        }
      }
    ]
  });
  const serialized = JSON.stringify(response.body);
  for (const forbidden of [
    'razorpaySignature',
    'razorpayOrderId',
    'status',
    'signature-must-not-leak',
    'Private lesson',
    'private-video.mp4',
    'This description must not be exposed'
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('only students can view purchase history', async () => {
  const app = buildApp(buildRazorpay().client);

  for (const role of ['INSTRUCTOR', 'ADMIN']) {
    const response = await (await login(app, await createUser(role))).get('/api/v1/purchases');
    assert.equal(response.status, 403);
    assert.equal(response.body.message, 'You do not have access to this route');
  }
});

test('purchase history safely represents a verified purchase after its course is deleted', async () => {
  const app = buildApp(buildRazorpay().client);
  const instructor = await createUser('INSTRUCTOR');
  const student = await createUser();
  const course = await createCourse(instructor, {
    lectures: [{
      title: 'Deleted course lesson',
      description: 'This media must never appear in history.',
      lecture: { public_id: unique('video'), secure_url: 'https://example.test/deleted-video.mp4' }
    }]
  });
  const purchase = await Purchase.create({
    student: student._id,
    course: course._id,
    amount: course.price,
    receipt: unique('receipt'),
    razorpayOrderId: unique('order'),
    razorpayPaymentId: unique('payment'),
    razorpaySignature: 'deleted-course-signature',
    status: 'VERIFIED'
  });
  await Course.deleteOne({ _id: course._id });

  const response = await (await login(app, student)).get('/api/v1/purchases');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    purchases: [{
      id: purchase.id,
      amount: purchase.amount,
      currency: 'INR',
      receipt: purchase.receipt,
      razorpayPaymentId: purchase.razorpayPaymentId,
      updatedAt: purchase.updatedAt.toISOString(),
      course: null
    }]
  });
  assert.equal(JSON.stringify(response.body).includes('deleted-course-signature'), false);
  assert.equal(JSON.stringify(response.body).includes('deleted-video.mp4'), false);
});

test('legacy payment listing remains admin-only while student purchase history is separate', async () => {
  const app = buildApp(buildRazorpay().client);
  const admin = await createUser('ADMIN');
  const student = await createUser();
  const originalAddResources = Razorpay.prototype.addResources;
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
  Razorpay.prototype.addResources = function addMockResources() {
    this.subscriptions = {
      all: async ({ count }) => ({ items: [], count })
    };
  };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_legacy_list';
  process.env.RAZORPAY_KEY_SECRET = 'legacy-list-secret';

  try {
    const adminPayments = await (await login(app, admin)).get('/api/v1/payments');
    assert.deepEqual(adminPayments.body, {
      success: true,
      message: 'All payment',
      payments: { items: [], count: 10 }
    });

    const studentPayments = await (await login(app, student)).get('/api/v1/payments');
    assert.equal(studentPayments.status, 403);
    assert.equal(studentPayments.body.message, 'You do not have access to this route');

    const studentHistory = await (await login(app, student)).get('/api/v1/purchases');
    assert.deepEqual(studentHistory.body, { success: true, purchases: [] });
  } finally {
    Razorpay.prototype.addResources = originalAddResources;
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  }
});
