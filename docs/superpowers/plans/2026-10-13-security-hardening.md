# Production Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the LMS API with secure HTTP defaults, bounded request bodies, targeted rate limits, safe operational logs, readiness checks, and privacy-first audit records.

**Architecture:** Security middleware is composed before API routes in `backend/app.js`. A focused audit model/service stores only allow-listed action data. Controllers write audit events after—not before—the business action succeeds. An admin-only cursor-paginated API exposes those safe records for a later Admin UI.

**Tech Stack:** Express 5, Mongoose 8, Node.js test runner, Supertest, Helmet, express-rate-limit.

---

## File structure

- Create: `backend/middleware/security.middleware.js` — request ID, safe request logger, and rate-limiter factory.
- Create: `backend/models/audit-log.schema.js` — immutable audit entries and indexes.
- Create: `backend/services/audit-log.service.js` — validation and best-effort writing.
- Create: `backend/controller/audit-log.controller.js` and `backend/routes/audit-log.route.js` — protected audit retrieval.
- Create: `backend/tests/security.middleware.test.js` and `backend/tests/audit-log.test.js`.
- Modify: `backend/app.js`, `backend/middleware/error.middleware.js`, `backend/tests/helpers/app.js`, `backend/package.json`, and `backend/package-lock.json`.
- Modify: user, course, quiz, assignment, purchase, and certificate controllers plus their existing flow tests.
- Modify: `backend/.env.example` and `backend/README.md`.

### Task 1: Secure the HTTP boundary

**Files:**
- Create: `backend/middleware/security.middleware.js`
- Create: `backend/tests/security.middleware.test.js`
- Modify: `backend/app.js`
- Modify: `backend/middleware/error.middleware.js`
- Modify: `backend/tests/helpers/app.js`
- Modify: `backend/package.json`, `backend/package-lock.json`

- [ ] **Step 1: Write failing security-contract tests.**

```js
test('security middleware adds safe headers and a request ID', async () => {
  const app = createTestApp({ security: { enabled: true } });
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
});

test('oversized JSON returns a friendly 413 error', async () => {
  const app = createTestApp({ security: { enabled: true } });
  const response = await request(app).post('/api/v1/auth/login')
    .send({ email: 'learner@example.com', password: 'x'.repeat(1_100_000) });

  assert.equal(response.status, 413);
  assert.deepEqual(response.body.error, {
    code: 'REQUEST_TOO_LARGE',
    message: 'This request is too large. Reduce it and try again.'
  });
});

test('login and reset limits return a stable 429 error', async () => {
  const app = createTestApp({
    security: { enabled: true, authMax: 1, resetMax: 1, publicMax: 50 }
  });
  await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com', password: 'bad' });
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com', password: 'bad' });
  await request(app).post('/api/v1/auth/reset').send({ email: 'a@b.com' });
  const reset = await request(app).post('/api/v1/auth/reset').send({ email: 'a@b.com' });

  assert.equal(login.status, 429);
  assert.equal(reset.status, 429);
  assert.equal(login.body.error.code, 'SECURITY_RATE_LIMITED');
  assert.equal(reset.body.message, 'Too many requests. Please wait a few minutes and try again.');
});
```

- [ ] **Step 2: Prove the tests fail.**

Run from `backend`: `npm test -- --test-name-pattern="security middleware|oversized JSON|login and reset limits"`

Expected: FAIL because no security middleware, body limit, or rate limiter exists.

- [ ] **Step 3: Install the exact runtime dependencies.**

Run from `backend`: `npm install helmet express-rate-limit`

Expected: only `helmet` and `express-rate-limit` are added to runtime dependencies and lockfile.

- [ ] **Step 4: Implement focused, reusable middleware.**

Create `backend/middleware/security.middleware.js`:

```js
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const AppError = require('../utils/appError');

const RATE_LIMIT_MESSAGE = 'Too many requests. Please wait a few minutes and try again.';

function assignRequestId(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function createLimiter({ max, windowMs }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => next(new AppError(RATE_LIMIT_MESSAGE, 429, 'SECURITY_RATE_LIMITED'))
  });
}

function safeRequestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => console.info(JSON.stringify({
    event: 'http_request',
    requestId: req.requestId,
    method: req.method,
    route: req.route?.path || 'unmatched',
    status: res.statusCode,
    durationMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2))
  })));
  next();
}

module.exports = { RATE_LIMIT_MESSAGE, assignRequestId, createLimiter, safeRequestLogger };
```

Never log `originalUrl`, query strings, cookies, authorization values, headers, or request bodies: reset tokens may appear in paths and secrets may appear in payloads.

- [ ] **Step 5: Compose the boundary in the application factory.**

In `backend/app.js`, use `helmet()`, `assignRequestId`, and `safeRequestLogger` before routes. Replace parsers with:

```js
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(assignRequestId);
if (security.enabled) {
  app.use(helmet());
  app.use(safeRequestLogger);
}
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
```

Build three limiter instances once per app:

```js
const authLimiter = createLimiter({ max: security.authMax, windowMs: security.windowMs });
const resetLimiter = createLimiter({ max: security.resetMax, windowMs: security.windowMs });
const publicLimiter = createLimiter({ max: security.publicMax, windowMs: security.windowMs });
app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/register', authLimiter);
app.use('/api/v1/auth/reset', resetLimiter);
app.use('/api/v1', (req, res, next) => req.path.startsWith('/auth/') ? next() : publicLimiter(req, res, next));
```

Use defaults `authMax: 10`, `resetMax: 5`, `publicMax: 300`, and `windowMs: 15 * 60 * 1000`. Make the factory default security to `process.env.NODE_ENV !== 'test'`; let tests explicitly opt in.

Add readiness without exposing database details:

```js
app.get('/ready', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'ready' : 'not_ready'
  });
});
```

Leave `/health` unthrottled and unchanged.

- [ ] **Step 6: Normalize parser errors and protect existing broad tests.**

Add before the `AppError` branch in `publicError`:

```js
if (error?.type === 'entity.too.large' || error?.status === 413) {
  return { statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'This request is too large. Reduce it and try again.' };
}
if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, 'body')) {
  return { statusCode: 400, code: 'REQUEST_INVALID_JSON', message: 'This request contains invalid JSON. Check it and try again.' };
}
```

For unexpected 5xx responses emit only `event`, `requestId`, `statusCode`, and `code` in `console.error`; do not log the error message, stack, or request data.

Change `backend/tests/helpers/app.js` to:

```js
function createTestApp(options = {}) {
  return createApp({
    ...options,
    security: { enabled: false, ...(options.security || {}) }
  });
}
```

- [ ] **Step 7: Run focused and health tests.**

Run from `backend`:

```powershell
npm test -- --test-name-pattern="security middleware|oversized JSON|login and reset limits|health"
```

Expected: PASS. Existing tests use explicit security disablement; security tests enable it with small thresholds.

- [ ] **Step 8: Commit the isolated task.**

```powershell
git add backend/package.json backend/package-lock.json backend/app.js backend/middleware/security.middleware.js backend/middleware/error.middleware.js backend/tests/helpers/app.js backend/tests/security.middleware.test.js
git commit -m "feat: harden API request boundary"
```

### Task 2: Create private audit storage and retrieval

**Files:**
- Create: `backend/models/audit-log.schema.js`
- Create: `backend/services/audit-log.service.js`
- Create: `backend/controller/audit-log.controller.js`
- Create: `backend/routes/audit-log.route.js`
- Modify: `backend/app.js`
- Create: `backend/tests/audit-log.test.js`

- [ ] **Step 1: Write failing audit endpoint and privacy tests.**

```js
test('only an ADMIN can page through privacy-safe audit entries', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser({ role: 'STUDENT' });
  const first = await AuditLog.create({ actor: admin._id, action: 'ROLE_CHANGED', target: { type: 'USER', id: student._id }, summary: { fromRole: 'STUDENT', toRole: 'INSTRUCTOR' } });
  const second = await AuditLog.create({ actor: admin._id, action: 'COURSE_CREATED', target: { type: 'COURSE', id: new mongoose.Types.ObjectId() } });
  const adminAgent = await loginAs(admin);
  const studentAgent = await loginAs(student);

  const page = await adminAgent.get('/api/v1/admin/audit-logs?limit=1');
  const denied = await studentAgent.get('/api/v1/admin/audit-logs');

  assert.equal(page.status, 200);
  assert.equal(page.body.entries[0].id, String(second._id));
  assert.ok(page.body.nextCursor);
  assert.equal(denied.status, 403);
  assert.equal(page.body.entries[0].ipAddress, undefined);
  assert.equal(page.body.entries[0].userAgent, undefined);
  assert.notEqual(String(first._id), '');
});

test('audit service rejects secret-shaped summaries', async () => {
  await assert.rejects(
    () => recordAudit({
      actor: new mongoose.Types.ObjectId(),
      action: 'ROLE_CHANGED',
      target: { type: 'USER', id: new mongoose.Types.ObjectId() },
      summary: { password: 'never-store-this' }
    }),
    /safe audit summary/
  );
});
```

- [ ] **Step 2: Prove tests fail.**

Run from `backend`: `npm test -- --test-name-pattern="privacy-safe audit|secret-shaped"`

Expected: FAIL because the model, service, and route do not exist.

- [ ] **Step 3: Implement append-only audit data and safe writer.**

Create model fields exactly as below, with `createdAt` and all action identity fields immutable:

```js
actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
action: { type: String, required: true, immutable: true, enum: [
  'ROLE_CHANGED', 'COURSE_CREATED', 'COURSE_UPDATED', 'COURSE_PUBLISHED', 'COURSE_DELETED',
  'LECTURE_CREATED', 'LECTURE_DELETED', 'QUIZ_CREATED', 'QUIZ_UPDATED', 'QUIZ_PUBLISHED',
  'QUIZ_DELETED', 'ASSIGNMENT_CREATED', 'ASSIGNMENT_UPDATED', 'ASSIGNMENT_PUBLISHED',
  'ASSIGNMENT_DELETED', 'SUBMISSION_GRADED', 'PURCHASE_VERIFIED', 'CERTIFICATE_GENERATED'
] },
target: {
  type: { type: String, required: true, immutable: true, enum: ['USER', 'COURSE', 'LECTURE', 'QUIZ', 'ASSIGNMENT', 'SUBMISSION', 'PURCHASE', 'CERTIFICATE'] },
  id: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true }
},
summary: { type: Map, of: String, immutable: true },
createdAt: { type: Date, default: Date.now, immutable: true, index: true }
```

Add index `{ createdAt: -1, _id: -1 }`.

The service must export `recordAudit` and `recordAuditSafely`. Validate scalar string summary values and reject any summary key matching:

```js
/password|token|secret|cookie|authorization|ip|agent|email|content|file|payload|signature/i
```

`recordAuditSafely` catches persistence failure, logs only `{ event: 'audit_log_failure', requestId, action }`, and returns `null`. It must never cause the completed LMS action to fail.

- [ ] **Step 4: Implement bounded cursor pagination and route access.**

Create an admin route:

```js
router.get('/', isLoggedIn, requireRole('ADMIN'), listAuditLogs);
```

Mount it at `/api/v1/admin/audit-logs` before the existing `/api/v1/admin` user router.

The controller must:
- default `limit` to 25 and accept only integer values from 1–50;
- encode an opaque base64url cursor containing `createdAt` and `id`;
- sort by `createdAt: -1, _id: -1`;
- fetch `limit + 1` entries to calculate `nextCursor`;
- map entries to only `id, actor, action, target, summary, createdAt`;
- return invalid input as `AUDIT_INVALID_REQUEST` with “Check the audit-log paging details and try again.”

- [ ] **Step 5: Run audit-focused tests.**

Run from `backend`: `npm test -- --test-name-pattern="audit"`

Expected: PASS. Assert response bodies do not contain IP address, user-agent, cookie, token, or raw request fields.

- [ ] **Step 6: Commit the isolated task.**

```powershell
git add backend/app.js backend/models/audit-log.schema.js backend/services/audit-log.service.js backend/controller/audit-log.controller.js backend/routes/audit-log.route.js backend/tests/audit-log.test.js
git commit -m "feat: add privacy-safe audit logs"
```

### Task 3: Audit role and course management

**Files:**
- Modify: `backend/controller/user.controller.js`
- Modify: `backend/controller/course.controller.js`
- Modify: `backend/tests/auth.test.js`
- Modify: `backend/tests/course-access.test.js`

- [ ] **Step 1: Write failing success-only event tests.**

```js
test('role change writes one ROLE_CHANGED entry with role transition only', async () => {
  const response = await adminAgent.patch('/api/v1/admin/users/' + student.id + '/role').send({ role: 'INSTRUCTOR' });
  const event = await AuditLog.findOne({ action: 'ROLE_CHANGED', 'target.id': student._id });

  assert.equal(response.status, 200);
  assert.equal(String(event.actor), String(admin._id));
  assert.equal(event.summary.get('fromRole'), 'STUDENT');
  assert.equal(event.summary.get('toRole'), 'INSTRUCTOR');
});

test('successful course work is audited but rejected work is not', async () => {
  const course = await createCourseAsInstructor();
  await instructorAgent.patch('/api/v1/instructor/courses/' + course.id).send({ title: 'Updated course title' });
  await instructorAgent.patch('/api/v1/instructor/courses/not-an-id').send({ title: 'No audit' });

  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_CREATED', 'target.id': course.id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': course.id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': '000000000000000000000000' }), 0);
});
```

- [ ] **Step 2: Prove tests fail.**

Run from `backend`: `npm test -- --test-name-pattern="ROLE_CHANGED entry|course work is audited"`

Expected: FAIL because success controllers do not call the audit service.

- [ ] **Step 3: Add success-only audit calls.**

Import `recordAuditSafely` and use a local wrapper:

```js
async function audit(req, action, type, id, summary) {
  return recordAuditSafely({
    actor: req.user._id,
    action,
    target: { type, id },
    summary,
    requestId: req.requestId
  });
}
```

Record these event/action pairs only after the matching database operation succeeds:

- role change: `ROLE_CHANGED / USER`, summary only `{ fromRole, toRole }`;
- new course: `COURSE_CREATED / COURSE`;
- course update: `COURSE_UPDATED / COURSE`, except transition to published is `COURSE_PUBLISHED / COURSE`;
- course deletion: `COURSE_DELETED / COURSE`;
- lecture add/delete: `LECTURE_CREATED` or `LECTURE_DELETED / LECTURE`.

Do not audit validation, authorization, conflict, media-upload, or cleanup failures.

- [ ] **Step 4: Run flow regression tests.**

Run from `backend`: `npm test -- --test-name-pattern="ROLE_CHANGED entry|course work is audited|role management|course"`

Expected: PASS, including existing authorization and Cloudinary-related error behavior.

- [ ] **Step 5: Commit the isolated task.**

```powershell
git add backend/controller/user.controller.js backend/controller/course.controller.js backend/tests/auth.test.js backend/tests/course-access.test.js
git commit -m "feat: audit role and course changes"
```

### Task 4: Audit assessments, purchases, and certificates

**Files:**
- Modify: `backend/controller/instructor-quiz.controller.js`
- Modify: `backend/controller/instructor-assignment.controller.js`
- Modify: `backend/controller/purchase.controller.js`
- Modify: `backend/controller/certificate.controller.js`
- Modify: `backend/tests/quiz-flow.test.js`
- Modify: `backend/tests/assignment-flow.test.js`
- Modify: `backend/tests/purchase-flow.test.js`
- Modify: `backend/tests/certificate-flow.test.js`

- [ ] **Step 1: Write failing idempotency-aware audit tests.**

```js
test('quiz publication and assignment grading create exactly one audit event', async () => {
  const quiz = await createQuizAsInstructor();
  await instructorAgent.patch(quiz.path).send({ status: 'PUBLISHED' });
  const submission = await createStudentSubmission();
  await instructorAgent.patch(submission.reviewPath).send({ marks: 80, feedback: 'Well done' });

  assert.equal(await AuditLog.countDocuments({ action: 'QUIZ_PUBLISHED', 'target.id': quiz.id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'SUBMISSION_GRADED', 'target.id': submission.id }), 1);
});

test('idempotent purchase verification and certificate claim do not duplicate audit entries', async () => {
  await verifyPaymentAsStudent();
  await verifyPaymentAsStudent();
  await claimEligibleCertificate();
  await claimEligibleCertificate();

  assert.equal(await AuditLog.countDocuments({ action: 'PURCHASE_VERIFIED' }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'CERTIFICATE_GENERATED' }), 1);
});
```

- [ ] **Step 2: Prove tests fail.**

Run from `backend`: `npm test -- --test-name-pattern="exactly one audit|do not duplicate audit"`

Expected: FAIL because no assessment, purchase, or certificate event is stored.

- [ ] **Step 3: Add only the following successful event choices.**

Use the Task 3 helper and record after the successful mutation response state exists:

- quiz: `QUIZ_CREATED`, `QUIZ_UPDATED`, `QUIZ_PUBLISHED`, `QUIZ_DELETED` with target `QUIZ`;
- assignment: `ASSIGNMENT_CREATED`, `ASSIGNMENT_UPDATED`, `ASSIGNMENT_PUBLISHED`, `ASSIGNMENT_DELETED` with target `ASSIGNMENT`;
- reviewed submission: `SUBMISSION_GRADED / SUBMISSION`;
- purchase: `PURCHASE_VERIFIED / PURCHASE` only when `finalizeVerification` returns a newly verified purchase, never on an idempotent re-check;
- certificate: `CERTIFICATE_GENERATED / CERTIFICATE` only when `result.created === true`.

Never put marks, feedback, answers, questions, files, Razorpay IDs/signatures, or certificate verification tokens into `summary`.

- [ ] **Step 4: Run each affected suite.**

Run from `backend`: `npm test -- --test-name-pattern="quiz|assignment|purchase|certificate"`

Expected: PASS. Repeat checkout verification and certificate claim leave event counts unchanged.

- [ ] **Step 5: Commit the isolated task.**

```powershell
git add backend/controller/instructor-quiz.controller.js backend/controller/instructor-assignment.controller.js backend/controller/purchase.controller.js backend/controller/certificate.controller.js backend/tests/quiz-flow.test.js backend/tests/assignment-flow.test.js backend/tests/purchase-flow.test.js backend/tests/certificate-flow.test.js
git commit -m "feat: audit LMS learning and purchase events"
```

### Task 5: Deployment guidance and full verification

**Files:**
- Modify: `backend/.env.example`
- Modify: `backend/README.md`

- [ ] **Step 1: Document the deployment configuration without secrets.**

Add to `backend/.env.example`:

```dotenv
# Set true only when a known reverse proxy/load balancer is configured correctly.
TRUST_PROXY=false
```

Document in `backend/README.md`:
- authentication (10/15m), reset (5/15m), and public (300/15m) limits;
- in-memory rate-limit scope: one API instance only;
- `TRUST_PROXY=true` only when the deployment proxy is trusted;
- liveness at `/health`, database readiness at `/ready`;
- audit endpoint, pagination, stored fields, and prohibited fields;
- Atlas backups and restore drills, uptime checks/alerts, safe log retention, and alert ownership;
- never committing or logging environment files, cookies, JWTs, reset tokens, payment payloads, or credentials.

- [ ] **Step 2: Run the complete backend verification.**

Run from `backend`:

```powershell
npm test
git diff --check
```

Expected: all backend tests pass and `git diff --check` exits 0. Do not claim a live Atlas/Razorpay test without a successful database connection and a user-run test checkout.

- [ ] **Step 3: Scan the changed backend surface for unintended secret exposure.**

Run from repository root:

```powershell
rg -n -i "password=|api[_-]?key\s*[:=]|authorization:|cookie:|razorpay_signature|forgotPasswordToken" backend --glob '!node_modules/**' --glob '!package-lock.json'
```

Expected: only deliberate model/test references; no audit record, log statement, error response, or documentation example reveals a secret.

- [ ] **Step 4: Commit documentation work.**

```powershell
git add backend/.env.example backend/README.md
git commit -m "docs: document LMS security operations"
```

## Plan self-review

- **Coverage:** Tasks 1–5 implement headers, size limits, targeted/general limits, explicit proxy trust, safe request/error logging, health/readiness, immutable privacy-first audit logs, admin pagination, success-only auditing, tests, and operations guidance.
- **Scope control:** Private videos, full Admin UI, external monitoring, distributed rate limiting, and live classes are excluded.
- **Consistency:** The model enum covers every controller event; audit events use `recordAuditSafely`; new client failures use the existing `AppError` envelope.
- **No placeholders:** Every task has exact files, tests, commands, data contracts, and commit boundaries.

