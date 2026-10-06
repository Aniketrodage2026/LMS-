# Backend Foundation and Course Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a secure, testable LMS backend with Student, Instructor, and Admin roles; instructor-owned free/paid courses; public previews; and free-course enrolment.

**Architecture:** Keep Express and Mongoose, but separate app construction from database/server startup so HTTP routes can be integration-tested. Add focused models for enrolment and restructure course access around a single authorization service used by lecture, quiz, assignment, and future purchase routes. Paid-course purchase creation is intentionally deferred to the next milestone; its future verified purchase will create the same enrolment record used here.

**Tech Stack:** Node.js, Express 5, MongoDB/Mongoose, JSON Web Tokens, httpOnly cookies, Multer, Cloudinary, Node's built-in test runner, Supertest, and mongodb-memory-server.

---

## Milestone boundary

This plan delivers a working catalogue and learning-access foundation:

- New registrations become `STUDENT` accounts.
- An admin can promote an account to `INSTRUCTOR`.
- Instructors own and immediately publish their own courses.
- Courses are `FREE` or `PAID`; paid courses require a positive INR price.
- Every course exposes one public preview lecture.
- Signed-in students can create one free enrolment per free course.
- Enrolled students can access protected lessons. A later verified payment will create paid-course enrolments.

It does not implement Razorpay one-time Orders, video progress, quizzes, assignments, certificates, notifications, or analytics. Those are separate backend milestones to avoid combining unrelated subsystems.

## Planned file structure

| File | Responsibility |
| --- | --- |
| `server/app.js` | Create and configure the Express application without starting MongoDB. |
| `server/server.js` | Configure Cloudinary, connect MongoDB, then listen. |
| `server/config/env.js` | Read and validate required runtime configuration with one canonical JWT variable name. |
| `server/config/dbConnect.js` | Export a connection function that throws connection failures to the process entry point. |
| `server/models/user.schema.js` | User identity and the three role values. |
| `server/models/course.schema.js` | Course metadata, ownership, visibility, price, and preview status. |
| `server/models/enrollment.schema.js` | Unique student-course access record for free enrolment and future verified purchase. |
| `server/services/course-access.service.js` | Reusable public-preview and enrolled-student access decisions. |
| `server/middleware/auth.middleware.js` | JWT authentication and role/ownership guards. |
| `server/middleware/error.middleware.js` | Consistent safe client errors and server-only error logging. |
| `server/middleware/multer.middleware.js` | Collision-safe upload storage and media validation. |
| `server/controller/user.controller.js` | Authentication and role-management behaviour. Rename the existing misspelled controller file. |
| `server/controller/course.controller.js` | Catalogue, instructor course builder, lecture, and enrolment handlers. |
| `server/routes/user.route.js` | Authentication, profile, and admin role-management routes. |
| `server/routes/course.route.js` | Public catalogue, instructor content, public preview, enrolment, and protected learning routes. |
| `server/routes/instructor-course.route.js` | Instructor-owned course and lecture mutation routes mounted separately from the public catalogue. |
| `server/tests/helpers/app.js` | Test application factory and Cloudinary stub. |
| `server/tests/helpers/db.js` | Per-suite in-memory MongoDB setup and teardown. |
| `server/tests/auth.test.js` | Authentication and role-guard integration coverage. |
| `server/tests/course-access.test.js` | Course visibility, preview, ownership, and enrolment integration coverage. |
| `server/.env.example` | Non-secret list of required environment variables. |
| `server/package.json` | Test and start scripts plus test dependencies. |

### Route contract after this milestone

| HTTP route | Access | Behaviour |
| --- | --- | --- |
| `GET /api/v1/courses` | Public | Returns only published course cards with no protected media URLs. |
| `GET /api/v1/courses/:courseId` | Public | Returns course details and its designated preview metadata. |
| `GET /api/v1/courses/:courseId/preview` | Public | Returns exactly the designated preview lecture. |
| `POST /api/v1/courses/:courseId/enroll` | Student | Creates an enrolment only when the course is free. |
| `GET /api/v1/courses/:courseId/lectures/:lectureId` | Enrolled student, owner instructor, or admin | Returns a non-preview lecture. |
| `POST /api/v1/instructor/courses` | Instructor or Admin | Creates an instructor-owned course. |
| `PATCH /api/v1/instructor/courses/:courseId` | Owner instructor or Admin | Updates course metadata and price rules. |
| `POST /api/v1/instructor/courses/:courseId/lectures` | Owner instructor or Admin | Adds a lesson and may mark it preview. |
| `PATCH /api/v1/admin/users/:userId/role` | Admin | Promotes a user to Instructor or changes role safely. |

### Data contracts

```js
// Course fields introduced by this milestone
{
  title: String,
  description: String,
  category: String,
  instructor: ObjectId,        // ref: 'User'
  accessType: 'FREE' | 'PAID',
  price: Number,               // 0 for FREE, integer paisa or INR decimal chosen consistently
  currency: 'INR',
  status: 'PUBLISHED' | 'UNPUBLISHED',
  lectures: [{
    title: String,
    description: String,
    video: { publicId: String, secureUrl: String, durationSeconds: Number },
    isPreview: Boolean,
    position: Number
  }]
}

// One document means the student may access the course.
// source is ready for a future paid purchase without duplicating access rules.
{
  student: ObjectId,           // ref: 'User'
  course: ObjectId,            // ref: 'Course'
  source: 'FREE_ENROLLMENT' | 'PURCHASE',
  status: 'ACTIVE' | 'REVOKED',
  enrolledAt: Date
}
```

## Task 1: Make the application testable and add the test harness

**Files:**
- Create: `server/config/env.js`
- Create: `server/tests/helpers/app.js`
- Create: `server/tests/helpers/db.js`
- Create: `server/tests/health.test.js`
- Create: `server/.env.example`
- Modify: `server/app.js`
- Modify: `server/server.js`
- Modify: `server/config/dbConnect.js`
- Modify: `server/package.json`

- [ ] **Step 1: Add the failing health integration test**

```js
// server/tests/health.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');

test('GET /health returns a non-secret readiness response', async () => {
  const response = await request(createTestApp()).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, status: 'ok' });
});
```

- [ ] **Step 2: Run the new test and confirm it fails because the route/app factory does not exist**

Run: `npm test -- --test-name-pattern="readiness"`

Expected: a failing module or route assertion, not a passing test.

- [ ] **Step 3: Add scripts, test dependencies, config, and app factory**

Use the following `package.json` scripts and development dependencies:

```json
{
  "scripts": {
    "dev": "nodemon server.js",
    "start": "node server.js",
    "test": "node --test tests/**/*.test.js"
  },
  "devDependencies": {
    "mongodb-memory-server": "^10.1.4",
    "supertest": "^7.0.0"
  }
}
```

Implement `createApp()` so it installs cookie parsing, JSON parsing, URL encoding, a CORS allow-list from `FRONTEND_URL`, `GET /health`, the routers, and the error middleware. Mount user/auth routes at `/api/v1/auth`, public/student course routes at `/api/v1/courses`, and instructor mutation routes at `/api/v1/instructor/courses`. Export the constructed app for production and export `createApp` for tests. Remove `connectDB()` from `app.js`; call it only in `server.js` before `app.listen`.

Use this configuration shape in `server/config/env.js`:

```js
const required = ['DB_URL', 'JWT_SECRET', 'JWT_EXPIRY', 'FRONTEND_URL'];

function loadEnv(env = process.env) {
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    dbUrl: env.DB_URL,
    jwtSecret: env.JWT_SECRET,
    jwtExpiry: env.JWT_EXPIRY,
    frontendUrl: env.FRONTEND_URL,
    nodeEnv: env.NODE_ENV || 'development'
  };
}

module.exports = { loadEnv };
```

Write `.env.example` with variable names only and placeholder values; it must not contain existing credentials. Rename local `JWT_Secret` to `JWT_SECRET` manually in the developer environment, but do not add the local `.env` file to version control.

- [ ] **Step 4: Run the health test and confirm it passes**

Run: `npm test -- --test-name-pattern="readiness"`

Expected: one passing test and zero failures.

## Task 2: Repair authentication and establish the three-role model

**Files:**
- Create: `server/tests/auth.test.js`
- Modify: `server/models/user.schema.js`
- Create: `server/controller/user.controller.js`
- Delete after route import is migrated: `server/controller/user.contoller.js`
- Modify: `server/routes/user.route.js`
- Modify: `server/middleware/auth.middleware.js`
- Modify: `server/middleware/error.middleware.js`

- [ ] **Step 1: Write failing authentication/authorization tests**

```js
test('a registered account receives the STUDENT role and a protected cookie', async () => {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ fullName: 'Asha Sharma', email: 'asha@example.com', password: 'password123' });

  assert.equal(response.status, 201);
  assert.equal(response.body.user.role, 'STUDENT');
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  assert.equal(response.body.token, undefined);
});

test('only an ADMIN can promote a STUDENT to INSTRUCTOR', async () => {
  const response = await request(app)
    .patch(`/api/v1/admin/users/${studentId}/role`)
    .set('Cookie', studentCookie)
    .send({ role: 'INSTRUCTOR' });

  assert.equal(response.status, 403);
  assert.equal(response.body.message, 'You do not have access to this route');
});
```

- [ ] **Step 2: Run the auth tests and confirm they fail**

Run: `npm test -- tests/auth.test.js`

Expected: failures because routes use the old role enum and the token response/cookie rules have not been implemented.

- [ ] **Step 3: Implement canonical authentication and roles**

Set the `User.role` enum to `['STUDENT', 'INSTRUCTOR', 'ADMIN']` with `STUDENT` as the default. Generate and verify JWTs with `JWT_SECRET` only. JWT payloads contain `{ id, role }`; read current user data from MongoDB on every authenticated request so role changes take effect immediately.

Use this cookie policy in both register and login handlers:

```js
function authCookieOptions(nodeEnv) {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: nodeEnv === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}
```

Return `{ success, message, user: publicUser }`; never return JWTs, password hashes, reset hashes, or subscription fields. Add `PATCH /api/v1/admin/users/:userId/role`, validating the requested role is `STUDENT` or `INSTRUCTOR`, and keep the only ADMIN role assignment under direct database/bootstrap control.

Implement `requireRole(...roles)` exactly as:

```js
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(new AppError('You do not have access to this route', 403));
  }
  next();
};
```

Error middleware returns `{ success: false, message }` and includes a stack only when `NODE_ENV !== 'production'`.

- [ ] **Step 4: Run auth tests and lint-equivalent syntax checks**

Run: `npm test -- tests/auth.test.js && node --check controller/user.controller.js && node --check middleware/auth.middleware.js`

Expected: all auth assertions pass and both syntax checks exit zero.

## Task 3: Add course ownership, access type, and the enrolment data model

**Files:**
- Create: `server/models/enrollment.schema.js`
- Create: `server/tests/course-model.test.js`
- Modify: `server/models/course.schema.js`

- [ ] **Step 1: Write failing model tests**

```js
test('a paid course requires a positive INR price', async () => {
  const validCourse = {
    title: 'Modern JavaScript Fundamentals',
    description: 'A complete beginner course with practical lessons.',
    category: 'Programming',
    instructor: instructorId,
    accessType: 'FREE',
    price: 0,
    currency: 'INR',
    status: 'PUBLISHED'
  };
  const course = new Course({ ...validCourse, accessType: 'PAID', price: 0 });
  await assert.rejects(course.validate(), /Paid courses require a positive price/);
});

test('one student can have only one enrolment per course', async () => {
  await Enrollment.create({ student: studentId, course: courseId, source: 'FREE_ENROLLMENT' });
  await assert.rejects(
    Enrollment.create({ student: studentId, course: courseId, source: 'FREE_ENROLLMENT' }),
    /duplicate key/
  );
});
```

- [ ] **Step 2: Run model tests and confirm they fail**

Run: `npm test -- tests/course-model.test.js`

Expected: a missing Enrollment model or validation failure mismatch.

- [ ] **Step 3: Implement schemas and database indexes**

Replace the current string `createdBy` course field with `instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }`. Add `accessType`, `price`, `currency`, `status`, and lecture `isPreview`, `position`, and `durationSeconds` fields. Use a course `pre('validate')` hook to enforce `price === 0` for `FREE` and `price > 0` for `PAID`; enforce only one `isPreview: true` lecture in the same hook.

Create `Enrollment` with `{ student, course, source, status, enrolledAt }`, timestamps, and a compound unique index:

```js
enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
```

Add `{ course: 1, status: 1 }` and `{ student: 1, status: 1 }` indexes to support future learner and access queries.

- [ ] **Step 4: Run model tests**

Run: `npm test -- tests/course-model.test.js`

Expected: all course and enrolment model tests pass.

## Task 4: Implement public catalogue, previews, and instructor-owned course creation

**Files:**
- Create: `server/tests/course-access.test.js`
- Create: `server/services/course-access.service.js`
- Modify: `server/controller/course.controller.js`
- Modify: `server/routes/course.route.js`
- Create: `server/routes/instructor-course.route.js`
- Modify: `server/middleware/multer.middleware.js`

- [ ] **Step 1: Write failing catalogue and ownership tests**

```js
test('a visitor receives the preview lecture but not protected lessons', async () => {
  const preview = await request(app).get(`/api/v1/courses/${courseId}/preview`);
  const protectedLecture = await request(app).get(`/api/v1/courses/${courseId}/lectures/${privateLectureId}`);

  assert.equal(preview.status, 200);
  assert.equal(preview.body.lecture._id, previewLectureId.toString());
  assert.equal(protectedLecture.status, 401);
});

test('an instructor cannot edit another instructor’s course', async () => {
  const response = await request(app)
    .patch(`/api/v1/instructor/courses/${otherInstructorCourseId}`)
    .set('Cookie', instructorCookie)
    .send({ title: 'Attempted takeover title' });

  assert.equal(response.status, 403);
});
```

- [ ] **Step 2: Run the access test and confirm it fails**

Run: `npm test -- tests/course-access.test.js`

Expected: failing route or access-control assertions.

- [ ] **Step 3: Implement one course-access service and routes**

Implement the following service functions:

```js
async function canManageCourse(user, course) {
  return user.role === 'ADMIN' || course.instructor.equals(user._id);
}

async function canLearnCourse(user, course) {
  if (!user) return false;
  if (await canManageCourse(user, course)) return true;
  return Enrollment.exists({ student: user._id, course: course._id, status: 'ACTIVE' });
}

function getPreviewLecture(course) {
  return course.lectures.find((lecture) => lecture.isPreview) || course.lectures[0] || null;
}
```

Use `canManageCourse` in every instructor course/lecture mutation. `GET /api/v1/courses` filters `status: 'PUBLISHED'`, excludes full lecture media, and supports exact `accessType` and `category` query filters. `GET /:courseId/preview` returns only the preview lecture. `GET /:courseId/lectures/:lectureId` returns a non-preview lecture only after `canLearnCourse` succeeds; return `403` with `Purchase or enrol in this course to access this lesson` otherwise.

Instructor course creation reads `accessType` and `price`, sets `instructor` from `req.user._id` instead of client input, and defaults `status` to `PUBLISHED`. Multer generates a random filename with `crypto.randomUUID()` plus the original extension and accepts images for thumbnails and MP4/WebM/MOV for lesson video uploads.

- [ ] **Step 4: Run access tests**

Run: `npm test -- tests/course-access.test.js`

Expected: catalogue, preview, and course-ownership tests pass.

## Task 5: Implement free-course enrolment and harden route behaviour

**Files:**
- Modify: `server/controller/course.controller.js`
- Modify: `server/routes/course.route.js`
- Modify: `server/tests/course-access.test.js`
- Modify: `server/app.js`

- [ ] **Step 1: Add failing enrolment and duplicate-access tests**

```js
test('a signed-in student enrols in a free course and can then access protected lessons', async () => {
  const enrolled = await request(app)
    .post(`/api/v1/courses/${freeCourseId}/enroll`)
    .set('Cookie', studentCookie);
  const lesson = await request(app)
    .get(`/api/v1/courses/${freeCourseId}/lectures/${freePrivateLectureId}`)
    .set('Cookie', studentCookie);

  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.body.enrollment.source, 'FREE_ENROLLMENT');
  assert.equal(lesson.status, 200);
});

test('a free enrolment request for a paid course is rejected', async () => {
  const response = await request(app)
    .post(`/api/v1/courses/${paidCourseId}/enroll`)
    .set('Cookie', studentCookie);

  assert.equal(response.status, 400);
  assert.equal(response.body.message, 'This course requires payment');
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npm test -- tests/course-access.test.js`

Expected: enrolment route assertions fail.

- [ ] **Step 3: Add idempotent free enrolment and production-safe middleware configuration**

Implement `POST /api/v1/courses/:courseId/enroll` for `STUDENT` role only. Confirm the course exists and is published, then reject `PAID` with `400`. Use this idempotent write and status selection:

```js
const result = await Enrollment.updateOne(
  { student: req.user._id, course: course._id },
  {
    $setOnInsert: {
      source: 'FREE_ENROLLMENT',
      status: 'ACTIVE',
      enrolledAt: new Date()
    }
  },
  { upsert: true }
);
const enrollment = await Enrollment.findOne({ student: req.user._id, course: course._id });
return res.status(result.upsertedCount === 1 ? 201 : 200).json({ success: true, enrollment });
```

Configure CORS to allow exactly `FRONTEND_URL`, enable credentials, and set a `404` JSON response `{ success: false, message: 'Route not found' }` before the error middleware. Do not expose Cloudinary or database error objects in responses.

- [ ] **Step 4: Run the complete foundation test set**

Run: `npm test && node --check app.js && node --check controller/course.controller.js && node --check services/course-access.service.js`

Expected: all tests pass and all three syntax checks exit zero.

## Task 6: Verify the running API and document the new setup

**Files:**
- Modify: `server/.env.example`
- Modify: `server/README.md` (create this file if none exists)

- [ ] **Step 1: Document required environment variables and local commands**

Document these variables: `PORT`, `DB_URL`, `JWT_SECRET`, `JWT_EXPIRY`, `FRONTEND_URL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_CLOUD_API_KEY`, `CLOUDINARY_CLOUD_API_SECRET`, `RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET`. Label Razorpay variables as reserved for the next payment milestone. Include `npm install`, `npm test`, and `npm run dev` commands.

- [ ] **Step 2: Start the API against a developer MongoDB and verify the health endpoint**

Run: `npm run dev`

In another terminal, run: `Invoke-WebRequest -UseBasicParsing http://localhost:5000/health | Select-Object -ExpandProperty Content`

Expected response: `{"success":true,"status":"ok"}`.

- [ ] **Step 3: Record completion safely**

This workspace currently has no Git repository, so do not fabricate a commit. If the user later initializes Git, commit the completed milestone with message: `feat: establish LMS course access foundation`.

## Plan self-review

- Spec coverage: this plan implements the first delivery phase from the design document—backend foundation, role redesign, course access rules, free enrolment, and security/test setup. It intentionally excludes the three later backend subsystems stated in the milestone boundary.
- Placeholder scan: every task contains specific files, commands, API behaviour, and implementation details; no unresolved implementation marker remains.
- Type consistency: `STUDENT`, `INSTRUCTOR`, `ADMIN`, `FREE`, `PAID`, `PUBLISHED`, `UNPUBLISHED`, `ACTIVE`, `REVOKED`, `FREE_ENROLLMENT`, and `PURCHASE` use the same spelling throughout this plan.

## Deferred operational verification

- [ ] **Pending: MongoDB connectivity and live health check** — After backend and frontend development are complete, confirm that the configured `DB_URL` accepts connections, start `npm run dev`, and verify `GET http://localhost:5000/health` returns `{ "success": true, "status": "ok" }`. This was deferred because the configured MongoDB SRV host refused the connection during Task 6 verification.
