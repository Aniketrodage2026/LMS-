# Paid Course Purchases: Design

## Goal

Enable students to buy one published paid course at a time through Razorpay Test Mode. A verified payment creates permanent course access through an active `PURCHASE` enrolment.

## Scope

- Razorpay Orders created server-side with Test Mode keys.
- Server-side Razorpay signature verification.
- Purchase records, receipts, and a student purchase-history API.
- Atomic purchase enrolment that reuses the existing `Enrollment` access model.
- Duplicate, tampered, self-purchase, and replay protections.

Not in this milestone: live payments, refunds, coupons, subscriptions, instructor payouts, webhooks, or frontend Checkout UI.

## Purchase Flow

```text
Student selects paid course
  -> API validates published paid course and ownership
  -> API reads price from Course and creates Razorpay order
  -> Client completes Razorpay Test Mode Checkout
  -> Client submits order/payment/signature to API
  -> API verifies signature and matching pending purchase
  -> API marks Purchase verified and creates ACTIVE PURCHASE Enrollment
  -> Course becomes available in My Purchases and protected lessons
```

## Data Model

`Purchase` contains:

- `student` and `course` object references.
- `amount` (integer paise) and `currency` (`INR`) copied from the course when the order is created.
- `status`: `PENDING`, `VERIFIED`, or `FAILED`.
- unique Razorpay `orderId`; nullable unique payment ID after verification; signature; server-generated receipt ID.
- timestamps.

One student may have one verified purchase per course. A verified purchase creates or preserves a matching active `Enrollment` with `source: PURCHASE`; it never overwrites a revoked enrolment.

## APIs

| Endpoint | Access | Behaviour |
| --- | --- | --- |
| `POST /api/v1/payments/orders` | Student | Creates a pending Razorpay order for `{ courseId }`. |
| `POST /api/v1/payments/verify` | Student | Verifies `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`, finalizes the purchase, and grants access. |
| `GET /api/v1/purchases` | Student | Returns verified purchases with course cards and receipt details. |

## Rules and Security

- The browser never chooses amount or currency; the API reads the current course price.
- Only a published `PAID` course with a positive paise price can receive an order.
- A student cannot purchase their own course; admins may not use student-purchase routes.
- Existing active purchase access returns the current purchase rather than creating another order.
- Signature verification uses `RAZORPAY_KEY_SECRET`; the order must belong to the pending purchase and requesting student.
- Verification is idempotent. A repeated valid verification returns the verified purchase without duplicate enrolment.
- Signature/payment/order reuse across a student or course is rejected.
- Razorpay secrets, internal error details, and payment-signature material are never returned in API responses.

## Test Mode Configuration

Use `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` generated in Razorpay Test Mode. Keys remain only in local `.env`; `.env.example` contains placeholders. Test transactions are simulated and must not use live customer payment details.

## Testing

Automated integration tests use a mocked Razorpay client and MongoMemoryServer to prove:

1. Valid paid-course order creation uses server-side price in paise.
2. Invalid/free/unpublished/missing/self-owned/already-owned courses cannot create a new order.
3. A valid signature marks exactly one purchase verified and creates exactly one active purchase enrolment.
4. Invalid, mismatched, and replayed payment data never grants access.
5. Repeated verification is safe and idempotent.
6. Purchase history contains only the requesting student’s verified purchases.

## Migration Note

The existing subscription endpoints are outside this feature. They should be removed or retired in a later cleanup milestone after no client relies on them; individual course purchases are the only new paid-access path.
