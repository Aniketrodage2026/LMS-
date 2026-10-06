# Student Learning Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let enrolled students safely save per-lecture progress and see accurate course progress and a “My Learning” dashboard.

**Architecture:** Store one `LectureProgress` document for each student and lecture, scoped to its course. A focused learning controller will validate the requested course/lecture and active enrollment before delegating mutations and dashboard calculations to a service. The existing course router will expose course-scoped progress endpoints; a dedicated learning router will serve the student dashboard.

**Tech Stack:** Node.js, Express 4, Mongoose, MongoDB, JWT cookie authentication, Mocha, Chai, Supertest, mongodb-memory-server.

---

## File structure

- Create: `LMS/server/models/lecture-progress.schema.js` — persistent per-student lecture state and indexes.
- Create: `LMS/server/services/learning-progress.service.js` — monotonic progress writes and course/dashboard summary functions.
- Create: `LMS/server/controller/learning-progress.controller.js` — HTTP validation, authorization, and response shaping.
- Create: `LMS/server/routes/learning-progress.route.js` — `/api/v1/me/learning` route.
- Modify: `LMS/server/routes/course.route.js` — add student-only course progress/update/complete routes before the generic `/:courseId` route.
- Modify: `LMS/server/app.js` — mount the learning router.
- Modify: `LMS/server/README.md` — document the four progress endpoints and client update cadence.
- Create: `LMS/server/tests/lecture-progress-model.test.js` — schema/index tests.
- Create: `LMS/server/tests/learning-progress.test.js` — route and authorization integration tests.

### Task 1: Persist and safely update lecture progress

**Files:**
- Create: `LMS/server/models/lecture-progress.schema.js`
- Create: `LMS/server/services/learning-progress.service.js`
- Test: `LMS/server/tests/lecture-progress-model.test.js`

- [ ] **Step 1: Write failing schema tests for a unique student/lecture record and valid state.**

```js
it('permits one progress document per student and lecture', async () => {
  const first = await LectureProgress.create({ student, course, lectureId, durationSeconds: 300 });
  await expect(LectureProgress.create({ student, course, lectureId, durationSeconds: 300 }))
    .to.be.rejectedWith(/duplicate key/i);
  expect(first.completed).to.equal(false);
});

it('rejects negative watched time and percent outside 0..100', async () => {
  await expect(LectureProgress.create({ student, course, lectureId, watchedSeconds: -1, durationSeconds: 300 }))
    .to.be.rejectedWith(/watchedSeconds/);
  await expect(LectureProgress.create({ student, course, lectureId, watchedPercent: 101, durationSeconds: 300 }))
    .to.be.rejectedWith(/watchedPercent/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the model does not exist.**

Run: `npm test -- --grep "lecture progress"`

Expected: FAIL with `Cannot find module '../models/lecture-progress.schema'`.

- [ ] **Step 3: Create the model with immutable ownership fields and dashboard indexes.**

```js
const mongoose = require('mongoose');

const lectureProgressSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, immutable: true },
  lectureId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  watchedSeconds: { type: Number, min: 0, default: 0 },
  watchedPercent: { type: Number, min: 0, max: 100, default: 0 },
  durationSeconds: { type: Number, min: 0, default: 0 },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  lastWatchedAt: { type: Date, default: Date.now }
}, { timestamps: true });

lectureProgressSchema.index({ student: 1, lectureId: 1 }, { unique: true });
lectureProgressSchema.index({ student: 1, course: 1 });
lectureProgressSchema.index({ student: 1, lastWatchedAt: -1 });

module.exports = mongoose.model('LectureProgress', lectureProgressSchema);
```

- [ ] **Step 4: Add an atomic, monotonic service write.**

```js
function percentFor(watchedSeconds, durationSeconds) {
  return Math.min(100, Number(((watchedSeconds / durationSeconds) * 100).toFixed(2)));
}

async function recordProgress({ studentId, courseId, lectureId, watchedSeconds, durationSeconds }) {
  const incomingPercent = percentFor(watchedSeconds, durationSeconds);
  const current = await LectureProgress.findOne({ student: studentId, lectureId });
  const nextSeconds = Math.max(current?.watchedSeconds || 0, watchedSeconds);
  const nextPercent = Math.max(current?.watchedPercent || 0, incomingPercent);
  const completed = Boolean(current?.completed || nextPercent >= 90);
  return LectureProgress.findOneAndUpdate(
    { student: studentId, lectureId },
    { $set: { course: courseId, watchedSeconds: nextSeconds, watchedPercent: nextPercent, durationSeconds, completed, completedAt: completed ? (current?.completedAt || new Date()) : null, lastWatchedAt: new Date() } },
    { new: true, upsert: true, runValidators: true }
  );
}
```

When handling a duplicate-key race, re-read the record and retry once with the same maximum-value calculation. This prevents a second browser tab from reducing a learner’s saved progress.

- [ ] **Step 5: Run model tests.**

Run: `npm test -- --grep "lecture progress"`

Expected: PASS.

- [ ] **Step 6: Commit the focused persistence slice.**

```bash
git add LMS/server/models/lecture-progress.schema.js LMS/server/services/learning-progress.service.js LMS/server/tests/lecture-progress-model.test.js
git commit -m "feat: add lecture progress persistence"
```

### Task 2: Provide authorized course progress mutation and summary APIs

**Files:**
- Create: `LMS/server/controller/learning-progress.controller.js`
- Modify: `LMS/server/routes/course.route.js`
- Modify: `LMS/server/services/learning-progress.service.js`
- Test: `LMS/server/tests/learning-progress.test.js`

- [ ] **Step 1: Write failing route tests for authorization, automatic completion, manual completion, and a course summary.**

```js
it('rejects a progress write from a student without an active enrollment', async () => {
  const response = await agent.patch(`/api/v1/courses/${course._id}/lectures/${lecture._id}/progress`)
    .send({ watchedSeconds: 10, durationSeconds: 100 });
  expect(response).to.have.status(403);
});

it('keeps progress monotonic and marks a lecture complete at 90 percent', async () => {
  await activeStudent.patch(progressPath).send({ watchedSeconds: 95, durationSeconds: 100 }).expect(200);
  const response = await activeStudent.patch(progressPath).send({ watchedSeconds: 40, durationSeconds: 100 }).expect(200);
  expect(response.body.progress).to.include({ watchedSeconds: 95, watchedPercent: 95, completed: true });
});

it('manually completes a lecture and returns course totals', async () => {
  const completed = await activeStudent.post(`${basePath}/complete`).expect(200);
  expect(completed.body.progress).to.include({ watchedPercent: 100, completed: true });
  const summary = await activeStudent.get(`/api/v1/courses/${course._id}/progress`).expect(200);
  expect(summary.body.progress).to.include({ totalLectures: 2, completedLectures: 1, completionPercent: 50 });
});
```

- [ ] **Step 2: Run the focused integration test and confirm the routes return 404.**

Run: `npm test -- --grep "learning progress"`

Expected: FAIL because the progress endpoints are not mounted.

- [ ] **Step 3: Implement shared request checks in the controller.**

```js
async function getAccessibleLecture(req) {
  const { courseId, lectureId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(courseId) || !mongoose.Types.ObjectId.isValid(lectureId)) {
    throw new AppError('Invalid courseId or lectureId format', 400);
  }
  const course = await Course.findById(courseId);
  if (!course) throw new AppError('Course not found', 404);
  const lecture = course.lectures.id(lectureId);
  if (!lecture) throw new AppError('Lecture not found', 404);
  const enrollment = await Enrollment.exists({ student: req.user._id, course: course._id, status: 'ACTIVE' });
  if (!enrollment) throw new AppError('Purchase or enrol in this course to access this lesson', 403);
  return { course, lecture };
}
```

`PATCH` must require numeric `watchedSeconds` and `durationSeconds`, require `durationSeconds > 0`, and reject `watchedSeconds < 0` or `watchedSeconds > durationSeconds` with HTTP 400. `POST .../complete` uses the course lecture duration when present (otherwise `0`) and calls a service function that sets `watchedPercent: 100`, `completed: true`, and an immutable first `completedAt` value.

- [ ] **Step 4: Implement exact routes before the generic `/:courseId` declaration.**

```js
router.patch('/:courseId/lectures/:lectureId/progress', isLoggedIn, requireRole('STUDENT'), recordLectureProgress);
router.post('/:courseId/lectures/:lectureId/complete', isLoggedIn, requireRole('STUDENT'), completeLecture);
router.get('/:courseId/progress', isLoggedIn, requireRole('STUDENT'), getCourseProgress);
```

The course summary response must be:

```js
{
  success: true,
  progress: {
    courseId: String(course._id),
    totalLectures: course.lectures.length,
    completedLectures,
    completionPercent: course.lectures.length === 0 ? 0 : Math.round((completedLectures / course.lectures.length) * 100),
    lectures: course.lectures.map(({ _id, title }) => ({ id: String(_id), title, watchedSeconds, watchedPercent, durationSeconds, completed, completedAt, lastWatchedAt }))
  }
}
```

Do not return video URLs, Cloudinary identifiers, enrollment records, or the user object from any progress endpoint.

- [ ] **Step 5: Run the focused integration test.**

Run: `npm test -- --grep "learning progress"`

Expected: PASS.

- [ ] **Step 6: Commit the student course-progress API.**

```bash
git add LMS/server/controller/learning-progress.controller.js LMS/server/routes/course.route.js LMS/server/services/learning-progress.service.js LMS/server/tests/learning-progress.test.js
git commit -m "feat: add student course progress APIs"
```

### Task 3: Build the student “My Learning” dashboard endpoint and documentation

**Files:**
- Create: `LMS/server/routes/learning-progress.route.js`
- Modify: `LMS/server/controller/learning-progress.controller.js`
- Modify: `LMS/server/services/learning-progress.service.js`
- Modify: `LMS/server/app.js`
- Modify: `LMS/server/README.md`
- Test: `LMS/server/tests/learning-progress.test.js`

- [ ] **Step 1: Write failing dashboard tests for active enrollment filtering, safe course cards, sorting, and zero-lecture courses.**

```js
it('lists only the current student’s active courses ordered by last activity', async () => {
  const response = await activeStudent.get('/api/v1/me/learning').expect(200);
  expect(response.body.learning).to.have.length(2);
  expect(response.body.learning[0]).to.include.keys('course', 'completionPercent', 'completedLectures', 'totalLectures', 'lastWatchedAt');
  expect(response.body.learning[0].course).to.not.have.any.keys('lectures', 'instructor');
});

it('reports zero progress for an enrolled course with no lectures', async () => {
  const response = await activeStudent.get('/api/v1/me/learning').expect(200);
  const empty = response.body.learning.find((item) => item.course.id === String(emptyCourse._id));
  expect(empty).to.include({ totalLectures: 0, completedLectures: 0, completionPercent: 0, lastWatchedAt: null });
});
```

- [ ] **Step 2: Run the focused dashboard tests and confirm the endpoint is absent.**

Run: `npm test -- --grep "My Learning"`

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement the dashboard service using active enrollments as the source of accessible courses.**

```js
const enrollments = await Enrollment.find({ student: studentId, status: 'ACTIVE' })
  .populate({ path: 'course', select: 'title category thumbnail accessType price lectures' })
  .lean();

const progressRows = await LectureProgress.find({ student: studentId, course: { $in: courseIds } }).lean();
const byCourse = new Map(progressRows.map((row) => [`${row.course}`, row]));
```

For each still-existing course, count a lecture only when a progress row with the same `lectureId` has `completed: true`; divide by `course.lectures.length`, returning `0` for empty courses. Expose only `{ id, title, category, thumbnail, accessType, price }` for the course card. Use the latest `lastWatchedAt` among valid lecture rows; sort descending by it, placing `null` values after active courses, and use `enrolledAt` descending as the deterministic tie-breaker.

- [ ] **Step 4: Mount the protected dashboard route.**

```js
const { getMyLearning } = require('../controller/learning-progress.controller');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const router = require('express').Router();

router.get('/learning', isLoggedIn, requireRole('STUDENT'), getMyLearning);
module.exports = router;
```

In `app.js`, mount it as `app.use('/api/v1/me', learningProgressRouter);` after authentication-related routes and before the 404 handler.

- [ ] **Step 5: Document client behavior and run all tests.**

Add a `Student learning progress` section to `LMS/server/README.md` documenting:

```text
PATCH /api/v1/courses/:courseId/lectures/:lectureId/progress
POST  /api/v1/courses/:courseId/lectures/:lectureId/complete
GET   /api/v1/courses/:courseId/progress
GET   /api/v1/me/learning
```

State that the video client sends `watchedSeconds` and `durationSeconds` every 15 seconds and also on pause, video end, and page exit; the server never lowers saved progress and automatically completes at 90%.

Run: `npm test`

Expected: PASS with the existing 94 passing tests plus the new learning-progress coverage.

- [ ] **Step 6: Check whitespace and commit the dashboard slice.**

Run: `git diff --check`

Expected: no output and exit code 0.

```bash
git add LMS/server/app.js LMS/server/controller/learning-progress.controller.js LMS/server/routes/learning-progress.route.js LMS/server/services/learning-progress.service.js LMS/server/README.md LMS/server/tests/learning-progress.test.js
git commit -m "feat: add student learning dashboard"
```

### Task 4: Final integration verification and review

**Files:**
- Verify: `LMS/server/tests/learning-progress.test.js`
- Verify: `LMS/server/tests/lecture-progress-model.test.js`
- Verify: `LMS/server/app.js`

- [ ] **Step 1: Run the complete automated test suite.**

Run: `npm test`

Expected: all existing payment, access-control, course, and new learning-progress tests pass with zero failures.

- [ ] **Step 2: Check the final diff for accidental secrets and formatting errors.**

Run: `git diff --check; git status --short`

Expected: no whitespace errors; only intentional progress files, documentation, and any pre-existing user changes appear.

- [ ] **Step 3: Perform review checkpoints.**

Review against `docs/superpowers/specs/2026-10-06-student-learning-progress-design.md` and confirm:

```text
- Students cannot write or read progress without an ACTIVE enrollment.
- A progress write cannot lower watched seconds or percent.
- 90% automatically completes; manual complete is permanently 100%.
- Course/dashboard totals ignore deleted lectures and handle zero lectures.
- Responses omit media URLs, signatures, payment details, and other students’ data.
```
