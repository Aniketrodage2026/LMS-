# Assignments, Submissions, and Instructor Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build course-level assignments with secure student versioned submissions, instructor grading/feedback, resubmission workflow, and file handling.

**Architecture:** Persist assignment requirements separately from immutable submission versions. Use an assignment `submissionCount` as the atomic lifecycle marker, mirroring the quiz safety model: students reserve the marker before persisting a version, while instructor content updates/deletion use conditional zero-count operations. Dedicated instructor and student controllers serialize data differently and reuse course-manager and active-enrollment authorization patterns.

**Tech Stack:** Node.js, Express, Mongoose, Multer, Cloudinary, JWT cookie authentication, Node test runner, Supertest, mongodb-memory-server.

---

## File structure

**Concurrency contract:** `SubmissionState` is the sole per-student current-version and review-state lock. Both instructor review and student version creation use MongoDB transactions that write this document, preventing a stale grade from winning against a newly created version.

- Create: `LMS/server/models/assignment.schema.js` — assignment requirements and submission-count lifecycle marker.
- Create: `LMS/server/models/submission.schema.js` — immutable student submission versions and grading state.
- Create: `LMS/server/services/assignment.service.js` — safe serializers, access checks, payload validation, and submission version calculation.
- Create: `LMS/server/controller/instructor-assignment.controller.js` — assignment authoring, submission queue, grading, and resubmission operations.
- Create: `LMS/server/controller/student-assignment.controller.js` — published assignment reads and student submissions.
- Create: `LMS/server/routes/instructor-assignment.route.js` — nested course-manager routes.
- Create: `LMS/server/routes/student-assignment.route.js` — nested student course routes.
- Modify: `LMS/server/middleware/multer.middleware.js` — add 25 MB document/archive/image submission upload validation.
- Modify: `LMS/server/routes/instructor-course.route.js` — mount instructor assignment routes before generic course routes.
- Modify: `LMS/server/routes/course.route.js` — mount student assignment routes before generic `/:courseId`.
- Modify: `LMS/server/README.md` — document assignment API and file rules.
- Create: `LMS/server/tests/assignment-model.test.js` — models, file filter, and service tests.
- Create: `LMS/server/tests/assignment-flow.test.js` — instructor/student lifecycle integration tests.

### Task 1: Assignment/submission models and submission-file validation

**Files:**
- Create: `LMS/server/models/assignment.schema.js`
- Create: `LMS/server/models/submission-state.schema.js`
- Create: `LMS/server/services/submission-lifecycle.service.js`
- Create: `LMS/server/models/submission.schema.js`
- Create: `LMS/server/services/assignment.service.js`
- Modify: `LMS/server/middleware/multer.middleware.js`
- Test: `LMS/server/tests/assignment-model.test.js`

- [ ] **Step 1: Write failing model and upload-filter tests.**

```js
test('assignment validates marks, status, and a server-owned submission counter', async () => {
  await assert.rejects(Assignment.create({ course, title: '', instructions: 'Build it', maxMarks: 0 }), /title|maxMarks/);
  const assignment = await Assignment.create({ course, title: 'Portfolio', instructions: 'Build a project', maxMarks: 50 });
  assert.equal(assignment.status, 'DRAFT');
  assert.equal(assignment.submissionCount, 0);
});

test('submission requires actual work and preserves immutable version/grading values', async () => {
  await assert.rejects(Submission.create(baseSubmission({ writtenAnswer: '', projectUrl: '', file: null })), /submission content/);
  const submission = await Submission.create(baseSubmission({ writtenAnswer: 'My answer' }));
  submission.version = 99;
  await submission.save();
  assert.equal((await Submission.findById(submission._id)).version, 1);
});
```

- [ ] **Step 2: Run focused tests and confirm missing imports fail.**

Run: `node --test tests/assignment-model.test.js`

Expected: FAIL with missing assignment/submission model imports.

- [ ] **Step 3: Implement strict schemas and indexes.**

```js
const assignmentSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true },
  title: { type: String, required: true, trim: true },
  instructions: { type: String, required: true, trim: true },
  dueDate: { type: Date, default: null },
  maxMarks: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger } },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT' },
  submissionCount: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger } }
}, { timestamps: true });
assignmentSchema.index({ course: 1, status: 1 });
assignmentSchema.index({ course: 1 });
```

`Submission` must enforce version >= 1, status enum `SUBMITTED`/`GRADED`/`RESUBMISSION_REQUESTED`, immutable assignment/course/student/version/work content/late fields, required server-owned status defaults, and `{ assignment, student, version }` unique plus `{ assignment, student, createdAt: -1 }` indexes. Validate `projectUrl` with `new URL` restricted to `http:`/`https:` and require at least one nonempty written answer, valid URL, or file metadata.

`SubmissionState` stores immutable assignment/course/student identity plus mutable `latestVersion`, `latestSubmission`, and status. Its unique `{ assignment, student }` index makes it the one authoritative current-version record; it is never returned to clients.

- [ ] **Step 4: Add a separate Multer submission uploader.**

```js
const submissionExtensions = new Set(['.pdf', '.docx', '.zip', '.png', '.jpg', '.jpeg']);
const submissionMimes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip', 'application/x-zip-compressed',
  'image/png', 'image/jpeg'
]);
upload.submission = createUpload(submissionExtensions, submissionMimes, 25 * 1024 * 1024);
```

Extend `createUpload` with a size parameter without changing thumbnail/video limits. Export the existing filename helper and preserve extension-plus-MIME verification.

- [ ] **Step 5: Run focused tests.**

Run: `node --test tests/assignment-model.test.js`

Expected: PASS.

- [ ] **Step 6: Commit this persistence slice.**

```bash
git add LMS/server/models/assignment.schema.js LMS/server/models/submission.schema.js LMS/server/services/assignment.service.js LMS/server/middleware/multer.middleware.js LMS/server/tests/assignment-model.test.js
git commit -m "feat: add assignment submission models"
```

### Task 2: Instructor assignment authoring and grading workflow

**Files:**
- Create: `LMS/server/controller/instructor-assignment.controller.js`
- Create: `LMS/server/routes/instructor-assignment.route.js`
- Modify: `LMS/server/routes/instructor-course.route.js`
- Modify: `LMS/server/services/assignment.service.js`
- Test: `LMS/server/tests/assignment-flow.test.js`

- [ ] **Step 1: Write failing instructor lifecycle tests.**

```js
test('only a manager creates a DRAFT assignment pinned to its course', async () => {
  await otherInstructor.post(assignmentsPath).send(payload).expect(403);
  const response = await owner.post(assignmentsPath).send({ ...payload, course: otherCourse._id, status: 'PUBLISHED' }).expect(201);
  assert.equal(response.body.assignment.status, 'DRAFT');
  assert.equal(response.body.assignment.courseId, String(course._id));
});

test('an assignment with a submission blocks content changes/deletion but permits status change', async () => {
  await createSubmissionVersion(assignment, student);
  await owner.patch(assignmentPath).send({ title: 'Changed' }).expect(409);
  await owner.patch(assignmentPath).send({ status: 'DRAFT' }).expect(200);
  await owner.delete(assignmentPath).expect(409);
});
```

- [ ] **Step 2: Confirm instructor routes initially fail with 404.**

Run: `node --test tests/assignment-flow.test.js --test-name-pattern="instructor assignment"`

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement manager-scoped assignment operations atomically.**

Create uses `req.course._id`, forces `DRAFT`, and ignores client `course`, `status`, and `submissionCount`. For draft content update/delete, require `submissionCount: 0` in the `findOneAndUpdate`/`findOneAndDelete` predicate. Once count is positive, allow only exactly `{ status: 'DRAFT' | 'PUBLISHED' }` using an atomic status update. A conditional miss must distinguish missing/cross-course assignment (404) from attempted assignment conflict (409).

Submission queue queries assignment/course scope and populates only safe student fields (`fullName`, `email`, `avatar`). Review requires exactly one:

```js
{ action: 'GRADE', marks: 0..assignment.maxMarks, feedback: 'non-empty feedback' }
{ action: 'REQUEST_RESUBMISSION', feedback: 'non-empty feedback' }
```

Only the latest submission version for a student can be reviewed. `reviewLatestSubmission` runs a transaction that conditionally changes the matching `SubmissionState` (`latestSubmission` and `status: SUBMITTED`) before updating that same submission version. Grade writes `GRADED`, marks, feedback, gradedAt, and `gradedBy`; resubmission request writes `RESUBMISSION_REQUESTED`, feedback, gradedAt, and `gradedBy` without marks. If a new version wins the state lock first, the stale review fails without grading the old version.

- [ ] **Step 4: Mount manager-only routes before generic instructor course routes.**

```js
router.use('/:courseId/assignments', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, instructorAssignmentRouter);
```

The nested router provides assignment POST/GET, assignment PATCH/DELETE, submissions GET, and submission review PATCH exactly as in the design.

- [ ] **Step 5: Add grade and resubmission tests, then run focused tests.**

```js
test('manager grades within max marks or requests resubmission with feedback', async () => {
  await owner.patch(reviewPath).send({ action: 'GRADE', marks: 101, feedback: 'Good' }).expect(400);
  await owner.patch(reviewPath).send({ action: 'REQUEST_RESUBMISSION', feedback: 'Add tests' }).expect(200);
  await owner.patch(reviewPath).send({ action: 'GRADE', marks: 40, feedback: 'Complete' }).expect(400);
});
```

Run: `node --test tests/assignment-flow.test.js --test-name-pattern="instructor assignment"`

Expected: PASS.

- [ ] **Step 6: Commit instructor workflow.**

```bash
git add LMS/server/controller/instructor-assignment.controller.js LMS/server/routes/instructor-assignment.route.js LMS/server/routes/instructor-course.route.js LMS/server/services/assignment.service.js LMS/server/tests/assignment-flow.test.js
git commit -m "feat: add instructor assignment grading workflow"
```

### Task 3: Student assignment discovery and versioned submission

**Files:**
- Create: `LMS/server/controller/student-assignment.controller.js`
- Create: `LMS/server/routes/student-assignment.route.js`
- Modify: `LMS/server/routes/course.route.js`
- Modify: `LMS/server/services/assignment.service.js`
- Modify: `LMS/server/services/submission-lifecycle.service.js`
- Test: `LMS/server/tests/assignment-flow.test.js`

- [ ] **Step 1: Write failing student-flow tests.**

```js
test('an active student reads only published assignments with no internal file identifiers', async () => {
  const detail = await student.get(assignmentPath).expect(200);
  assert.equal(detail.body.assignment.submissionCount, undefined);
  await student.get(draftAssignmentPath).expect(404);
});

test('student creates versioned late submission and can resubmit only when allowed', async () => {
  const first = await student.post(submissionsPath).field('writtenAnswer', 'First').expect(201);
  assert.equal(first.body.submission.version, 1);
  assert.equal(first.body.submission.late, true);
  await requestResubmission(first.body.submission.id);
  const second = await student.post(submissionsPath).field('projectUrl', 'https://github.com/example/project').expect(201);
  assert.equal(second.body.submission.version, 2);
});
```

- [ ] **Step 2: Confirm student routes initially fail with 404.**

Run: `node --test tests/assignment-flow.test.js --test-name-pattern="student assignment"`

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement ACTIVE-enrollment access and safe serializers.**

Student routes apply `isLoggedIn` and `requireRole('STUDENT')`. Validate IDs, load course, require `{ student, course, status: 'ACTIVE' }`, then find a course-scoped `PUBLISHED` assignment. Public assignment serializers return only `{ id, title, instructions, dueDate, maxMarks }`; never return submission counts, manager data, or submission file internal IDs.

- [ ] **Step 4: Implement submission creation with the shared lifecycle lock and cleanup.**

Before upload/persistence, reject client-supplied status/marks/feedback and validate text/link/file content. Upload files to Cloudinary using `resource_type: 'image'` for images and `raw` for other allowed files; always remove the Multer temporary file.

After a successful upload, Task 3 **must** call `createSubmissionVersion` from `submission-lifecycle.service` with only server-built work data (including server-calculated `late: Boolean(dueDate && new Date() > dueDate)`). The transaction requires a published, course-scoped assignment; increments `submissionCount`; rejects a state whose latest version is `GRADED`; calculates the next version; creates the immutable submission; and inserts or updates `SubmissionState` to `{ latestVersion, latestSubmission, status: 'SUBMITTED' }`. Do not independently query “latest” or update `Submission`/`SubmissionState` from the controller. If this transaction rejects after upload, clean the new Cloudinary asset; marker, version, and state all roll back together.

- [ ] **Step 5: Add isolation/file tests and run focused tests.**

```js
test('bad uploads and another student requests create no submission or marker', async () => {
  await unenrolled.post(submissionsPath).field('writtenAnswer', 'No access').expect(403);
  await student.post(submissionsPath).attach('file', badExePath).expect(400);
  assert.equal(await Submission.countDocuments({ assignment }), 0);
  assert.equal((await Assignment.findById(assignment._id)).submissionCount, 0);
});
```

Run: `node --test tests/assignment-flow.test.js --test-name-pattern="student assignment"`

Expected: PASS.

- [ ] **Step 6: Commit student submissions.**

```bash
git add LMS/server/controller/student-assignment.controller.js LMS/server/routes/student-assignment.route.js LMS/server/routes/course.route.js LMS/server/services/assignment.service.js LMS/server/tests/assignment-flow.test.js
git commit -m "feat: add student assignment submissions"
```

### Task 4: Documentation and final verification

**Files:**
- Modify: `LMS/server/README.md`
- Verify: `LMS/server/tests/assignment-model.test.js`
- Verify: `LMS/server/tests/assignment-flow.test.js`

- [ ] **Step 1: Document assignment endpoints and file constraints.**

Add the six instructor and four student URLs from the design. Document active enrollment, draft secrecy, accepted one-file types, 25 MB limit, version history, late marker, grading/resubmission state, and that student responses omit Cloudinary `public_id`.

- [ ] **Step 2: Run complete regression verification.**

Run: `npm test`

Expected: all existing LMS tests plus assignment tests pass with zero failures.

- [ ] **Step 3: Inspect diff and contract coverage.**

Run: `git diff --check; git status --short`

Expected: no whitespace errors and only intentional assignment code, docs, and test changes.

Verify: course managers cannot alter/delete after first submission; no student sees another student's data; the server controls versions, late status, marks, feedback, and lifecycle; uploaded assets and temporary files are cleaned safely on failed persistence.

- [ ] **Step 4: Commit documentation.**

```bash
git add LMS/server/README.md LMS/server/tests/assignment-model.test.js LMS/server/tests/assignment-flow.test.js
git commit -m "docs: document assignment submission APIs"
```
