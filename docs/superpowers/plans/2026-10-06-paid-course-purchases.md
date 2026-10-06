# Paid Course Purchases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Razorpay Test Mode one-time paid-course purchases that create verified course access and a student purchase history.

**Architecture:** Use a `Purchase` model as the payment audit record and the existing `Enrollment` model as the access authority. A payment service owns Razorpay order creation and signature verification; controllers only validate request ownership and coordinate an atomic verified-purchase plus enrolment update.

**Tech Stack:** Node.js, Express, Mongoose, Razorpay Node SDK, Node `crypto`, Node test runner, Supertest, MongoMemoryServer.

---

## File structure

| File | Responsibility |
| --- | --- |
| `server/models/purchase.schema.js` | Immutable payment/order metadata, statuses, indexes, and references. |
| `server/services/purchase.service.js` | Razorpay order creation, HMAC verification, and purchase-safe helpers. |
| `server/controller/purchase.controller.js` | Student order, verification, and history HTTP actions. |
| `server/routes/purchase.route.js` | Student-only purchase routes. |
| `server/app.js` | Mount `/api/v1/payments` and `/api/v1/purchases` routes. |
| `server/tests/purchase-model.test.js` | Schema/index/invariant tests. |
| `server/tests/purchase-flow.test.js` | End-to-end order, verification, access, replay, and history tests with mocked Razorpay. |
| `server/.env.example` | Test Mode key names and no secrets. |
| `server/README.md` | Test Mode setup and local purchase-testing instructions. |

## Task 1: Purchase persistence and Razorpay order creation

**Files:**
- Create: `server/models/purchase.schema.js`
- Create: `server/services/purchase.service.js`
- Create: `server/tests/purchase-model.test.js`
- Create: `server/tests/purchase-flow.test.js`
- Create: `server/controller/purchase.controller.js`
- Create: `server/routes/purchase.route.js`
- Modify: `server/app.js`

- [ ] **Step 1: Write failing purchase-model and order tests**

```js
test('a pending purchase stores a paise snapshot and has a unique Razorpay order', async () => {
  const purchase = await Purchase.create({
    student: studentId,
    course: paidCourseId,
    amount: 49900,
    currency: 'INR',
    status: 'PENDING',
    receipt: 'course_abc_student_xyz',
    razorpayOrderId: 'order_test_001'
  });
  assert.equal(purchase.status, 'PENDING');
  await assert.rejects(Purchase.create({ ...purchase.toObject(), _id: undefined }));
});

test('a student creates an order using the server-side course price', async () => {
  const response = await request(app)
    .post('/api/v1/payments/orders')
    .set('Cookie', studentCookie)
    .send({ courseId: paidCourseId, amount: 1 });
  assert.equal(response.status, 201);
  assert.equal(razorpayCreateOrder.mock.calls[0][0].amount, 49900);
  assert.equal(response.body.purchase.amount, 49900);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/purchase-model.test.js tests/purchase-flow.test.js`

Expected: module/route failures because Purchase and payment routes do not exist.

- [ ] **Step 3: Implement the model, Test Mode client seam, and order endpoint**

Create a `Purchase` schema with `student`, `course`, `amount`, `currency`, `status`, `receipt`, `razorpayOrderId`, `razorpayPaymentId`, and `razorpaySignature`. Use status enum `PENDING`, `VERIFIED`, `FAILED`; require amount as a positive integer and currency `INR`. Add unique sparse indexes for `razorpayOrderId` and `razorpayPaymentId`, plus `{ student: 1, course: 1, status: 1 }` for ownership lookups.

Export a service factory so tests inject a fake Razorpay client:

```js
function createPurchaseService({ razorpay, secret }) {
  return {
    async createOrder({ amount, receipt }) {
      return razorpay.orders.create({ amount, currency: 'INR', receipt });
    },
    verifySignature({ orderId, paymentId, signature }) {
      const expected = crypto.createHmac('sha256', secret)
        .update(`${orderId}|${paymentId}`).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    }
  };
}
```

`POST /api/v1/payments/orders` requires `STUDENT`. Validate ObjectId, then find a published `PAID` course; reject free/unpublished/missing courses, self-owned courses, revoked enrolments, and existing active purchase access. Ignore all client amount/currency data. Create Razorpay order with course `price`, persist `PENDING` purchase, and return only safe order data: `{ purchase: { id, amount, currency, receipt }, order: { id, amount, currency }, keyId }`.

- [ ] **Step 4: Run focused tests and full suite**

Run: `node --test tests/purchase-model.test.js tests/purchase-flow.test.js && npm test`

Expected: all tests pass; no payment secret or signature is present in response bodies.

## Task 2: Verified payment finalization and protected access

**Files:**
- Modify: `server/services/purchase.service.js`
- Modify: `server/controller/purchase.controller.js`
- Modify: `server/routes/purchase.route.js`
- Modify: `server/tests/purchase-flow.test.js`

- [ ] **Step 1: Write failing verification and replay tests**

```js
test('a valid signature verifies one pending purchase and grants purchase enrolment once', async () => {
  const response = await request(app).post('/api/v1/payments/verify')
    .set('Cookie', studentCookie)
    .send(validRazorpayPayload);
  assert.equal(response.status, 200);
  assert.equal(response.body.purchase.status, 'VERIFIED');
  assert.equal(await Enrollment.countDocuments({ student: studentId, course: paidCourseId, source: 'PURCHASE' }), 1);
});

test('a mismatched or replayed payment never grants access', async () => {
  const response = await request(app).post('/api/v1/payments/verify')
    .set('Cookie', differentStudentCookie)
    .send(validRazorpayPayload);
  assert.equal(response.status, 403);
  assert.equal(await Enrollment.exists({ student: differentStudentId, course: paidCourseId }), null);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/purchase-flow.test.js`

Expected: verification route failures because pending purchases are not finalized.

- [ ] **Step 3: Implement idempotent verification**

`POST /api/v1/payments/verify` requires `STUDENT`, loads the pending purchase by `razorpay_order_id` and `student`, verifies the HMAC before any access change, and rejects unknown/mismatched/invalid data. In a Mongo transaction when available, or through idempotent unique-index operations when the test database lacks transactions:

```js
const purchase = await Purchase.findOne({ razorpayOrderId: orderId, student: req.user._id });
if (!purchase) return next(new AppError('Purchase order not found', 404));
if (purchase.status === 'VERIFIED') return res.status(200).json({ success: true, purchase: publicPurchase(purchase) });
if (!service.verifySignature({ orderId, paymentId, signature })) {
  purchase.status = 'FAILED';
  await purchase.save();
  return next(new AppError('Payment verification failed', 400));
}
```

After successful signature verification, set payment ID/signature/status to verified. Atomically upsert an `Enrollment` only when none exists; it must create `{ source: 'PURCHASE', status: 'ACTIVE' }`. A `REVOKED` enrolment blocks purchase finalization with 403 and remains unchanged. Unique payment/order indexes handle concurrent or repeated verification safely.

- [ ] **Step 4: Run verification tests and access test**

Run: `node --test tests/purchase-flow.test.js && npm test`

Expected: valid verification grants protected course lesson access; invalid/replay attempts do not.

## Task 3: Purchase history, documentation, and Test Mode verification

**Files:**
- Modify: `server/controller/purchase.controller.js`
- Modify: `server/routes/purchase.route.js`
- Modify: `server/tests/purchase-flow.test.js`
- Modify: `server/.env.example`
- Modify: `server/README.md`

- [ ] **Step 1: Write failing purchase-history test**

```js
test('purchase history returns only this student’s verified purchases with safe course cards', async () => {
  const response = await request(app).get('/api/v1/purchases').set('Cookie', studentCookie);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.purchases.map((purchase) => purchase.course._id), [paidCourseId.toString()]);
  assert.equal(JSON.stringify(response.body), JSON.stringify(response.body).includes('razorpaySignature'), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/purchase-flow.test.js`

Expected: 404 because purchase history endpoint does not exist.

- [ ] **Step 3: Implement safe history and update docs**

Implement `GET /api/v1/purchases` for `STUDENT`, filtering `{ student: req.user._id, status: 'VERIFIED' }`, populating a limited course selection (`title category thumbnail accessType price`), sorted newest first. Return public purchase fields only: id, amount, currency, receipt, payment ID, verified timestamp, and course card. Do not return signature, Razorpay order ID, or internal status transitions.

Document Test Mode API keys, local-only `.env` storage, mock/test checkout flow, and that Live Mode requires a separate operational/legal readiness review. Do not put values in `.env.example` beyond placeholders.

- [ ] **Step 4: Run full verification**

Run: `npm test && node --check controller/purchase.controller.js && node --check services/purchase.service.js && git diff --check`

Expected: all tests pass, syntax checks exit zero, and no whitespace errors are reported.

## Plan self-review

- Spec coverage: Task 1 establishes safe order state and price snapshots; Task 2 validates signatures and grants only verified access; Task 3 exposes purchase history and documents Test Mode use.
- Placeholder scan: the plan uses concrete model fields, endpoints, error outcomes, test assertions, and commands.
- Type consistency: `Purchase.status`, `Enrollment.source`, Razorpay order/payment fields, and paise amounts use the same names throughout.
