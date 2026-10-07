# Course Certificates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let eligible students claim one immutable, publicly verifiable certificate per course.

**Architecture:** A certificate service calculates eligibility from current Course, LectureProgress, Quiz/QuizAttempt, Assignment/Submission, and Enrollment records. Claiming uses a unique student-course record so repeated or concurrent claims return one certificate. Public verification uses only an unguessable token and a deliberately safe response serializer.

**Tech Stack:** Node.js, Express, Mongoose, Node test runner, Supertest, mongodb-memory-server.

---

## File structure

- Create: `LMS/server/models/certificate.schema.js` — immutable certificate and indexes.
- Create: `LMS/server/services/certificate.service.js` — eligibility calculations, claim creation, safe serializers.
- Create: `LMS/server/controller/certificate.controller.js` — student and public HTTP operations.
- Create: `LMS/server/routes/certificate.route.js` — certificate API routes.
- Modify: `LMS/server/app.js` — mount public and student certificate routers.
- Modify: `LMS/server/README.md` — certificate claim/list/verification documentation.
- Create: `LMS/server/tests/certificate-model.test.js` — model/token tests.
- Create: `LMS/server/tests/certificate-flow.test.js` — eligibility, claim, privacy, and public verification tests.

### Task 1: Certificate persistence and eligibility calculator

**Files:**
- Create: `LMS/server/models/certificate.schema.js`
- Create: `LMS/server/services/certificate.service.js`
- Test: `LMS/server/tests/certificate-model.test.js`

- [ ] **Step 1: Write failing model/calculator tests.**

```js
test('certificate has unique student/course, number, and verification token', async () => {
  const certificate = await Certificate.create(validCertificate());
  await assert.rejects(Certificate.create({ ...validCertificate(), certificateNumber: certificate.certificateNumber }), /duplicate key/);
});

test('eligibility requires 80% lecture completion, every quiz passed, every assignment graded, and 80% assessment average', async () => {
  const eligibility = await calculateEligibility(student._id, course._id);
  assert.deepEqual(eligibility, { eligible: true, lecturePercent: 80, assessmentAverage: 80, requiredQuizzes: 1, passedQuizzes: 1, requiredAssignments: 1, gradedAssignments: 1 });
});
```

- [ ] **Step 2: Run focused tests and confirm missing imports fail.**

Run: `node --test tests/certificate-model.test.js`

Expected: FAIL with missing certificate model/service imports.

- [ ] **Step 3: Implement immutable certificate model.**

```js
const certificateSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true },
  certificateNumber: { type: String, required: true, immutable: true, unique: true },
  verificationToken: { type: String, required: true, immutable: true, unique: true },
  issuedAt: { type: Date, default: Date.now, immutable: true },
  eligibilitySnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true }
}, { timestamps: true });
certificateSchema.index({ student: 1, course: 1 }, { unique: true });
```

- [ ] **Step 4: Implement deterministic eligibility queries.**

Calculate completed current lectures from `LectureProgress.completed`; use current published quizzes only and each student's best `QuizAttempt.percentage`/passed state; use current published assignments and latest `Submission` per assignment, requiring `GRADED`. Assessment average is the arithmetic average of quiz best percentages and assignment latest `marks / assignment.maxMarks * 100`, or 100 when there are no assessments. Generate number `LMS-YYYY-<random uppercase>` and a crypto-random token.

- [ ] **Step 5: Run focused tests.**

Run: `node --test tests/certificate-model.test.js`

Expected: PASS.

### Task 2: Student claim, eligibility, list, and public verification APIs

**Files:**
- Create: `LMS/server/controller/certificate.controller.js`
- Create: `LMS/server/routes/certificate.route.js`
- Modify: `LMS/server/app.js`
- Modify: `LMS/server/services/certificate.service.js`
- Test: `LMS/server/tests/certificate-flow.test.js`

- [ ] **Step 1: Write failing integration tests.**

```js
test('an eligible active student claims once and a repeat claim returns the same certificate', async () => {
  const first = await student.post(`/api/v1/courses/${course._id}/certificate/claim`).expect(201);
  const repeat = await student.post(`/api/v1/courses/${course._id}/certificate/claim`).expect(200);
  assert.equal(first.body.certificate.certificateNumber, repeat.body.certificate.certificateNumber);
});

test('public verification exposes only safe certificate facts', async () => {
  const response = await request(app).get(`/api/v1/certificates/verify/${certificate.verificationToken}`).expect(200);
  assert.deepEqual(Object.keys(response.body.certificate).sort(), ['certificateNumber', 'courseTitle', 'issuedAt', 'learnerName', 'valid']);
});
```

- [ ] **Step 2: Run focused tests and confirm routes return 404.**

Run: `node --test tests/certificate-flow.test.js`

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement protected endpoints.**

Mount `GET /api/v1/courses/:courseId/certificate/eligibility` and `POST /api/v1/courses/:courseId/certificate/claim` under `isLoggedIn` + `requireRole('STUDENT')`, verifying active enrollment before calculations. Claim rejects ineligible state with 409 and safe checklist. It handles duplicate-key concurrency by returning the existing student/course certificate. `GET /api/v1/me/certificates` returns only the caller's safe certificate list.

- [ ] **Step 4: Implement public verification.**

Mount `GET /api/v1/certificates/verify/:token` without auth. Invalid/missing tokens return 404. Populate only user full name and course title; return neither IDs, email, snapshots, assessment results, nor token.

- [ ] **Step 5: Add boundary/privacy cases and run focused tests.**

```js
test('80 percent boundaries and missing assessment requirements block claims', async () => {
  await student.get(eligibilityPath).expect(200);
  await student.post(claimPath).expect(409);
  // Set the final lecture/assessment state to exact 80% and assert claim succeeds.
});
```

Run: `node --test tests/certificate-flow.test.js`

Expected: PASS.

### Task 3: Documentation and full verification

**Files:**
- Modify: `LMS/server/README.md`
- Verify: `LMS/server/tests/certificate-model.test.js`
- Verify: `LMS/server/tests/certificate-flow.test.js`

- [ ] **Step 1: Document the four certificate endpoints and exact eligibility rules.**

State the 80% lecture/assessment average rules, all published quiz/assignment requirements, claim-based issuance, idempotency, and public verification privacy.

- [ ] **Step 2: Run complete regression verification.**

Run: `npm test`

Expected: all existing LMS tests and certificate tests pass with zero failures.

- [ ] **Step 3: Check final diff.**

Run: `git diff --check; git status --short`

Expected: no whitespace errors and only intended certificate files/docs.
