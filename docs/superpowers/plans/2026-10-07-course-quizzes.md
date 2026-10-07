# Course Quizzes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver secure course-level, unlimited-attempt, single-answer multiple-choice quizzes for instructors and actively enrolled students.

**Architecture:** Keep quiz content, answer validation, and attempt grading in focused Mongoose models and a quiz service. Separate instructor management and student learning controllers so instructor responses may contain answer keys while every student-facing response is explicitly shaped without them. Reuse `requireCourseManager` for instructor authorization and the established ACTIVE `Enrollment` query for student access.

**Tech Stack:** Node.js, Express, Mongoose, MongoDB, JWT cookie authentication, Node test runner, Supertest, mongodb-memory-server.

---

## File structure

- Create: `LMS/server/models/quiz.schema.js` — quiz/question persistence and model-level validation.
- Create: `LMS/server/models/quiz-attempt.schema.js` — immutable student attempt persistence and indexes.
- Create: `LMS/server/services/quiz.service.js` — safe serializers, grading, and access helpers.
- Create: `LMS/server/controller/instructor-quiz.controller.js` — authorized quiz authoring operations.
- Create: `LMS/server/controller/student-quiz.controller.js` — enrolled-student quiz reading, submission, and history.
- Create: `LMS/server/routes/instructor-quiz.route.js` — nested instructor course quiz routes.
- Create: `LMS/server/routes/student-quiz.route.js` — course quiz learning routes.
- Modify: `LMS/server/routes/instructor-course.route.js` — mount quiz authoring routes under an existing course manager boundary.
- Modify: `LMS/server/routes/course.route.js` — mount student quiz routes before generic `/:courseId` routes.
- Modify: `LMS/server/README.md` — document quiz endpoint contracts and answer-key secrecy.
- Create: `LMS/server/tests/quiz-model.test.js` — model and grading unit tests.
- Create: `LMS/server/tests/quiz-flow.test.js` — instructor/student integration tests.

### Task 1: Quiz and attempt models with deterministic grading

**Files:**
- Create: `LMS/server/models/quiz.schema.js`
- Create: `LMS/server/models/quiz-attempt.schema.js`
- Create: `LMS/server/services/quiz.service.js`
- Test: `LMS/server/tests/quiz-model.test.js`

- [ ] **Step 1: Write failing validation and grading tests.**

```js
test('a quiz requires 2-6 distinct options and a correct index in range', async () => {
  await assert.rejects(Quiz.create({
    course, title: 'JavaScript basics', passMark: 70,
    questions: [{ prompt: 'Which is valid?', options: ['let', 'let'], correctOptionIndex: 2 }]
  }), /options|correctOptionIndex/);
});

test('gradeAttempt accepts null answers and calculates an integer percentage server-side', () => {
  const result = gradeAttempt(quiz, [0, null, 1]);
  assert.deepEqual(result, { correctAnswers: 2, totalQuestions: 3, score: 2, percentage: 67, passed: false });
});
```

- [ ] **Step 2: Run the focused test and confirm missing modules cause the failure.**

Run: `node --test tests/quiz-model.test.js`

Expected: FAIL with missing quiz model/service imports.

- [ ] **Step 3: Create the quiz model and its question validator.**

```js
const questionSchema = new mongoose.Schema({
  prompt: { type: String, required: true, trim: true },
  options: [{ type: String, required: true, trim: true }],
  correctOptionIndex: { type: Number, required: true, min: 0 },
  explanation: { type: String, trim: true, default: '' }
}, { _id: true });

questionSchema.pre('validate', function validateQuestion(next) {
  const normalized = this.options.map((option) => option.trim().toLowerCase());
  if (this.options.length < 2 || this.options.length > 6 || new Set(normalized).size !== this.options.length) {
    this.invalidate('options', 'Questions require 2 through 6 distinct options');
  }
  if (!Number.isInteger(this.correctOptionIndex) || this.correctOptionIndex < 0 || this.correctOptionIndex >= this.options.length) {
    this.invalidate('correctOptionIndex', 'correctOptionIndex must select an option');
  }
  next();
});
```

`Quiz` must require `course`, a non-empty `title`, passMark integer 1–100, at least one question, and status enum `DRAFT`/`PUBLISHED` defaulting to `DRAFT`. Add `{ course: 1, status: 1 }` and `{ course: 1 }` indexes.

- [ ] **Step 4: Create an immutable attempt model and pure grading helper.**

```js
function gradeAttempt(quiz, answers) {
  const correctAnswers = quiz.questions.reduce((count, question, index) => (
    answers[index] === question.correctOptionIndex ? count + 1 : count
  ), 0);
  const totalQuestions = quiz.questions.length;
  const percentage = Math.round((correctAnswers / totalQuestions) * 100);
  return { correctAnswers, totalQuestions, score: correctAnswers, percentage, passed: percentage >= quiz.passMark };
}
```

`QuizAttempt` requires `quiz`, `course`, `student`, an `answers` array, and server-calculated `correctAnswers`, `totalQuestions`, `score`, `percentage`, `passed`, and `submittedAt`. Mark those attempt fields immutable and add `{ student: 1, quiz: 1, submittedAt: -1 }`.

- [ ] **Step 5: Run focused model tests.**

Run: `node --test tests/quiz-model.test.js`

Expected: PASS.

- [ ] **Step 6: Commit this model slice.**

```bash
git add LMS/server/models/quiz.schema.js LMS/server/models/quiz-attempt.schema.js LMS/server/services/quiz.service.js LMS/server/tests/quiz-model.test.js
git commit -m "feat: add quiz and attempt models"
```

### Task 2: Instructor quiz authoring and lifecycle enforcement

**Files:**
- Create: `LMS/server/controller/instructor-quiz.controller.js`
- Create: `LMS/server/routes/instructor-quiz.route.js`
- Modify: `LMS/server/routes/instructor-course.route.js`
- Test: `LMS/server/tests/quiz-flow.test.js`

- [ ] **Step 1: Write failing instructor integration tests.**

```js
test('only a course manager can create and list a draft quiz with answer keys', async () => {
  await otherInstructor.post(`/api/v1/instructor/courses/${course._id}/quizzes`).send(payload).expect(403);
  const created = await owner.post(`/api/v1/instructor/courses/${course._id}/quizzes`).send(payload).expect(201);
  assert.equal(created.body.quiz.status, 'DRAFT');
  assert.equal(created.body.quiz.questions[0].correctOptionIndex, 1);
});

test('attempted quizzes allow only status changes and cannot be deleted', async () => {
  await QuizAttempt.create(attemptFor(quiz));
  await owner.patch(quizPath).send({ title: 'Changed title' }).expect(409);
  await owner.patch(quizPath).send({ status: 'DRAFT' }).expect(200);
  await owner.delete(quizPath).expect(409);
});
```

- [ ] **Step 2: Run the focused test and confirm the authoring route is missing.**

Run: `node --test tests/quiz-flow.test.js --test-name-pattern="instructor quiz"`

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement authoring controller rules.**

```js
async function findManagedQuiz(req) {
  const quiz = await Quiz.findOne({ _id: req.params.quizId, course: req.course._id });
  if (!quiz) throw new AppError('Quiz not found', 404);
  return quiz;
}

async function hasAttempts(quizId) {
  return Boolean(await QuizAttempt.exists({ quiz: quizId }));
}
```

Create always sets the current `req.course._id` and ignores any client `course` field. Listing returns authoring-safe quiz objects that include `correctOptionIndex` and explanations. On update, a quiz with attempts accepts only an exact `status` field whose value is `DRAFT` or `PUBLISHED`; any question, title, instructions, or passMark change returns HTTP 409. Delete returns HTTP 409 if an attempt exists and otherwise deletes the course-scoped quiz.

- [ ] **Step 4: Mount nested manager-only routes.**

```js
router.route('/:courseId/quizzes')
  .post(isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, createQuiz)
  .get(isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, listInstructorQuizzes);
router.route('/:courseId/quizzes/:quizId')
  .patch(isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, updateQuiz)
  .delete(isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, deleteQuiz);
```

Declare these before `/:courseId` so the existing generic course route cannot intercept them.

- [ ] **Step 5: Run focused instructor tests.**

Run: `node --test tests/quiz-flow.test.js --test-name-pattern="instructor quiz"`

Expected: PASS.

- [ ] **Step 6: Commit the authoring slice.**

```bash
git add LMS/server/controller/instructor-quiz.controller.js LMS/server/routes/instructor-quiz.route.js LMS/server/routes/instructor-course.route.js LMS/server/tests/quiz-flow.test.js
git commit -m "feat: add instructor course quiz management"
```

### Task 3: Enrolled student delivery, submission, and attempt history

**Files:**
- Create: `LMS/server/controller/student-quiz.controller.js`
- Create: `LMS/server/routes/student-quiz.route.js`
- Modify: `LMS/server/routes/course.route.js`
- Modify: `LMS/server/services/quiz.service.js`
- Test: `LMS/server/tests/quiz-flow.test.js`

- [ ] **Step 1: Write failing student-flow tests.**

```js
test('an enrolled student opens a published quiz without answer keys', async () => {
  const response = await enrolledStudent.get(quizPath).expect(200);
  assert.equal(response.body.quiz.questions[0].correctOptionIndex, undefined);
  assert.equal(response.body.quiz.questions[0].explanation, undefined);
});

test('unlimited submissions are graded server-side and return review only after submission', async () => {
  const first = await enrolledStudent.post(`${quizPath}/attempts`).send({ answers: [0, null] }).expect(201);
  assert.deepEqual(first.body.attempt, { score: 1, totalQuestions: 2, percentage: 50, passed: false, correctAnswers: 1 });
  assert.equal(first.body.review[0].correctOptionIndex, 1);
  await enrolledStudent.post(`${quizPath}/attempts`).send({ answers: [1, 0] }).expect(201);
  const history = await enrolledStudent.get(`${quizPath}/attempts`).expect(200);
  assert.equal(history.body.attempts.length, 2);
  assert.equal(history.body.best.percentage, 100);
});
```

- [ ] **Step 2: Run the focused tests and confirm student quiz endpoints are absent.**

Run: `node --test tests/quiz-flow.test.js --test-name-pattern="student quiz"`

Expected: FAIL with HTTP 404.

- [ ] **Step 3: Implement safe serializers and access helpers.**

```js
function publicQuiz(quiz) {
  return {
    id: String(quiz._id), title: quiz.title, instructions: quiz.instructions,
    passMark: quiz.passMark,
    questions: quiz.questions.map((question) => ({
      id: String(question._id), prompt: question.prompt, options: question.options
    }))
  };
}

async function requireStudentQuizAccess(studentId, courseId, quizId) {
  const enrollment = await Enrollment.exists({ student: studentId, course: courseId, status: 'ACTIVE' });
  if (!enrollment) throw new AppError('Purchase or enrol in this course to access this quiz', 403);
  const quiz = await Quiz.findOne({ _id: quizId, course: courseId, status: 'PUBLISHED' });
  if (!quiz) throw new AppError('Quiz not found', 404);
  return quiz;
}
```

Validate that `answers` is an array exactly as long as `quiz.questions`; each item must be `null` or an integer from 0 through that question's options length minus one. Ignore all client score/pass fields. Before persisting an attempt, atomically increment `Quiz.attemptCount` with a query that confirms the quiz's current `_id`, course, and `PUBLISHED` status; if that increment finds no quiz, abort without creating an attempt. This marker must be written before the attempt record so the instructor's conditional draft mutations cannot race past a submission. Then call `gradeAttempt`, persist the new attempt, and build the post-submission review from stored quiz data and the student's selected answer.

- [ ] **Step 4: Mount the student-only nested routes before generic course routes.**

```js
router.use('/:courseId/quizzes', studentQuizRouter);
```

The nested router must apply `isLoggedIn` and `requireRole('STUDENT')`, expose `GET /`, `GET /:quizId`, `POST /:quizId/attempts`, and `GET /:quizId/attempts`, and validate `courseId`/`quizId` formats before database queries.

- [ ] **Step 5: Add isolation and invalid-payload cases, then run student tests.**

```js
test('draft, cross-course, unenrolled, and foreign attempt requests reveal no quiz data', async () => {
  await unenrolledStudent.get(quizPath).expect(403);
  await enrolledStudent.get(draftQuizPath).expect(404);
  await enrolledStudent.get(crossCourseQuizPath).expect(404);
  await anotherStudent.get(`${quizPath}/attempts`).expect(403);
});

test('invalid answer counts and indexes create no attempt', async () => {
  await enrolledStudent.post(`${quizPath}/attempts`).send({ answers: [9] }).expect(400);
  assert.equal(await QuizAttempt.countDocuments({ quiz: quiz._id }), 0);
});
```

Run: `node --test tests/quiz-flow.test.js --test-name-pattern="student quiz"`

Expected: PASS.

- [ ] **Step 6: Commit the student assessment slice.**

```bash
git add LMS/server/controller/student-quiz.controller.js LMS/server/routes/student-quiz.route.js LMS/server/routes/course.route.js LMS/server/services/quiz.service.js LMS/server/tests/quiz-flow.test.js
git commit -m "feat: add enrolled student quiz attempts"
```

### Task 4: Documentation and final verification

**Files:**
- Modify: `LMS/server/README.md`
- Verify: `LMS/server/tests/quiz-model.test.js`
- Verify: `LMS/server/tests/quiz-flow.test.js`

- [ ] **Step 1: Document the quiz endpoint groups and security contract.**

Add a `Course quizzes` README section containing the four instructor URLs and four student URLs from the approved design. State that attempts are unlimited, grading occurs only on the server, draft quizzes are not student-visible, and correct answers/explanations are returned only in a successful submission result or the student's own history result.

- [ ] **Step 2: Run the complete test suite.**

Run: `npm test`

Expected: all existing access, purchase, progress, and new quiz tests pass with zero failures.

- [ ] **Step 3: Check the final diff and review the contract.**

Run: `git diff --check; git status --short`

Expected: no whitespace errors and only intended quiz documentation/code/test files.

Confirm before handoff:

```text
- Student-facing reads never expose an answer key before a submission.
- Only ACTIVE enrolled students can read, submit, or view their own attempts.
- Unlimited attempts create immutable independent records.
- The server, not the client, calculates every grade and pass result.
- Course managers cannot alter an attempted quiz except to publish or unpublish it.
- Deleting a quiz with attempts is rejected.
```

- [ ] **Step 4: Commit documentation and review corrections.**

```bash
git add LMS/server/README.md LMS/server/tests/quiz-model.test.js LMS/server/tests/quiz-flow.test.js
git commit -m "docs: document course quiz APIs"
```
