# Admin Operations and Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure, real-data Admin workspace for platform overview, user search, course moderation, verified-purchase reporting, and audit activity.

**Architecture:** New Admin-only Express endpoints are isolated in an operations router and focused controllers. Their cursor pagination and safe response mappers prevent accidental leakage of secrets. The React Admin workspace consumes typed API helpers and always refreshes from the server after a mutation, while the current audit endpoint remains unchanged.

**Tech Stack:** Express 5, Mongoose 8, Node.js test runner, Supertest, React, TanStack Router, Vitest, Testing Library.

---

## File structure

- Create: `backend/utils/admin-pagination.js` — opaque cursor parsing/encoding and bounded query parsing.
- Create: `backend/controller/admin-user.controller.js` — safe Admin user directory.
- Create: `backend/controller/admin-course.controller.js` — safe course directory and atomic publish/unpublish moderation.
- Create: `backend/controller/admin-report.controller.js` — overview and verified-purchase reporting.
- Create: `backend/routes/admin-operations.route.js` — Admin-only operations routes.
- Create: `backend/tests/admin-operations.test.js` — API integration, privacy, reporting, and concurrency tests.
- Modify: `backend/app.js` — mount the new router before the existing Admin role router.
- Modify: `frontend/src/lib/api/models.ts` — Admin response contracts.
- Create: `frontend/src/lib/api/admin.ts` — typed Admin API calls.
- Modify: `frontend/src/lib/errors/present.ts` — approved Admin invalid-input recovery guidance.
- Modify: `frontend/src/components/skillforge/admin-pages.tsx` — replace placeholders with live Admin screens.
- Create: `frontend/src/test/admin-operations.test.tsx` — workspace behavior and user-facing-state tests.
- Modify: `backend/README.md` and `frontend/README.md` — document Admin routes and local checks.

### Task 1: Build shared Admin pagination and safe user directory

**Files:**
- Create: `backend/utils/admin-pagination.js`
- Create: `backend/controller/admin-user.controller.js`
- Create: `backend/routes/admin-operations.route.js`
- Modify: `backend/app.js`
- Create: `backend/tests/admin-operations.test.js`

- [ ] **Step 1: Write failing API tests for Admin-only safe user pages.**

Add tests that create an Admin, Student, and Instructor, then assert an Admin can call:

```js
const page = await adminAgent.get('/api/v1/admin/users?query=learn&role=STUDENT&limit=1');
assert.equal(page.status, 200);
assert.equal(page.body.users.length, 1);
assert.equal(page.body.users[0].role, 'STUDENT');
assert.equal(page.body.users[0].password, undefined);
assert.equal(page.body.users[0].forgotPasswordToken, undefined);
assert.equal(page.body.users[0].subscription, undefined);
assert.equal(page.body.nextCursor, null);

const denied = await studentAgent.get('/api/v1/admin/users');
assert.equal(denied.status, 403);
```

Add a two-page test that passes `nextCursor` back unchanged, verifies newest-first order with `_id` tie-breaking, and confirms invalid `limit`, `cursor`, and `role` return `400` with `ADMIN_INVALID_REQUEST`.

- [ ] **Step 2: Run the focused test and confirm it fails because the route does not exist.**

Run from `backend`:

```powershell
npm test -- --test-name-pattern="safe user pages"
```

Expected: FAIL with `404` or a missing route assertion.

- [ ] **Step 3: Implement reusable opaque cursor parsing.**

Create `backend/utils/admin-pagination.js`. It must accept a default limit of 25 and an integer limit from 1 through 50, use a base64url JSON cursor containing only `at` (an ISO timestamp) and `id`, and reject invalid data with this factory:

```js
const AppError = require('./appError');

function invalidAdminRequest() {
  return new AppError(
    'Check the admin filters or paging details and try again.',
    400,
    'ADMIN_INVALID_REQUEST'
  );
}
```

Export `parseLimit`, `parseCursor`, `encodeCursor`, and `invalidAdminRequest`. `parseCursor` must verify an ObjectId and an ISO timestamp exactly as the existing audit cursor does. `encodeCursor(entry, timestamp)` receives the date used by its caller's sort order. Do not accept a raw MongoDB sort/filter object from query text.

- [ ] **Step 4: Implement the safe directory controller and route.**

Create `listUsers` in `backend/controller/admin-user.controller.js` with this safe mapper:

```js
function publicAdminUser(user) {
  return {
    id: String(user._id),
    name: user.fullName,
    email: user.email,
    avatar: user.avatar?.secure_url || null,
    role: user.role,
    createdAt: user.createdAt.toISOString()
  };
}
```

Accept only a string `query` of at most 100 trimmed characters and the exact optional roles `STUDENT`, `INSTRUCTOR`, and `ADMIN`. Use a safely escaped case-insensitive regular expression over `fullName` and `email`; do not pass raw regex text through. Query `limit + 1`, sort `{ createdAt: -1, _id: -1 }`, apply the cursor's `at` timestamp as a strict older-than pair, and return:

```js
{ success: true, users: pageUsers, nextCursor }
```

Create `backend/routes/admin-operations.route.js` with an `express.Router()` protected once by:

```js
router.use(isLoggedIn, requireRole('ADMIN'));
router.get('/users', listUsers);
```

Mount it in `backend/app.js` before `userRouter.adminRouter`:

```js
app.use('/api/v1/admin', adminOperationsRouter);
app.use('/api/v1/admin', userRouter.adminRouter);
```

- [ ] **Step 5: Run focused backend tests and verify the safe shape.**

Run:

```powershell
npm test -- --test-name-pattern="safe user pages|user directory"
```

Expected: PASS. Confirm guest/non-Admin access is rejected and no password/reset/subscription fields are returned.

- [ ] **Step 6: Commit the isolated task.**

```powershell
git add backend/utils/admin-pagination.js backend/controller/admin-user.controller.js backend/routes/admin-operations.route.js backend/app.js backend/tests/admin-operations.test.js
git commit -m "feat: add admin user directory"
```

### Task 2: Add Admin course directory and atomic moderation

**Files:**
- Create: `backend/controller/admin-course.controller.js`
- Modify: `backend/routes/admin-operations.route.js`
- Modify: `backend/tests/admin-operations.test.js`

- [ ] **Step 1: Write failing course directory and moderation tests.**

Test cursor-filtered `GET /api/v1/admin/courses?status=UNPUBLISHED&query=react`, and assert each returned item contains only the contract fields. Test Admin `PATCH /api/v1/admin/courses/:courseId/status` with `{ status: 'UNPUBLISHED' }` and then `{ status: 'PUBLISHED' }`.

Add a parallel transition test:

```js
const responses = await Promise.all([
  adminAgent.patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'PUBLISHED' }),
  secondAdminAgent.patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'PUBLISHED' })
]);
assert.deepEqual(responses.map(r => r.status).sort(), [200, 200]);
assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': course._id }), 1);
```

Also assert a repeat request against an already published course returns 200 without adding an audit record; invalid statuses and malformed/missing IDs are safe 400/404 responses; a non-Admin receives 403; ownership stays unchanged.

- [ ] **Step 2: Run the new tests to prove they fail.**

```powershell
npm test -- --test-name-pattern="course directory|admin moderation|parallel admin publish"
```

Expected: FAIL because neither Admin course endpoint exists.

- [ ] **Step 3: Implement safe course listing.**

Create `listCourses` in `backend/controller/admin-course.controller.js`. It must use the shared cursor helper, accept only `PUBLISHED` or `UNPUBLISHED` for `status`, safely escape a maximum-100-character query, populate only instructor `fullName`, `email`, and avatar URL, and map results to:

```js
{
  id: String(course._id), title: course.title, description: course.description,
  thumbnail: course.thumbnail?.secure_url || null,
  instructor: course.instructor ? { id: String(course.instructor._id), name: course.instructor.fullName, email: course.instructor.email, avatar: course.instructor.avatar?.secure_url || null } : null,
  accessType: course.accessType, price: course.price, currency: course.currency,
  status: course.status, lectureCount: course.numberOflectures,
  createdAt: course.createdAt.toISOString(), updatedAt: course.updatedAt.toISOString()
}
```

Return `{ success: true, courses, nextCursor }`. Never select lecture media public IDs/URLs or send full instructor documents.

- [ ] **Step 4: Implement atomic status moderation with success-only auditing.**

Implement `updateCourseStatus`. Validate only `PUBLISHED` and `UNPUBLISHED`. Use `Course.findOneAndUpdate({ _id: courseId, status: { $ne: status } }, { status }, { new: false, runValidators: true })`; if it returns a prior document, record `COURSE_PUBLISHED` for a new published status or `COURSE_UPDATED` with `{ status: 'UNPUBLISHED' }` for a factual unpublish, then return the reloaded safe course status.

If no document was changed, re-read only `_id` and `status`: return a safe 404 if absent, otherwise return 200 with the current status and no audit call. `recordAuditSafely` must use the authenticated Admin as actor, `COURSE` target, no payment/media/content data, and the request ID. Catch Cast/validation errors as `ADMIN_INVALID_REQUEST` and unexpected errors as a safe `SYSTEM_UNEXPECTED` message.

Add routes:

```js
router.get('/courses', listCourses);
router.patch('/courses/:courseId/status', updateCourseStatus);
```

- [ ] **Step 5: Run focused tests.**

```powershell
npm test -- --test-name-pattern="course directory|admin moderation|parallel admin publish|COURSE_PUBLISHED"
```

Expected: PASS, including one factual audit record for concurrent publication and none for a no-op retry.

- [ ] **Step 6: Commit the isolated task.**

```powershell
git add backend/controller/admin-course.controller.js backend/routes/admin-operations.route.js backend/tests/admin-operations.test.js
git commit -m "feat: add admin course moderation"
```

### Task 3: Add verified-purchase reports and platform overview

**Files:**
- Create: `backend/controller/admin-report.controller.js`
- Modify: `backend/routes/admin-operations.route.js`
- Modify: `backend/tests/admin-operations.test.js`

- [ ] **Step 1: Write failing reporting tests.**

Create fixtures for users, courses, active/revoked enrollments, completed/incomplete lecture progress, verified/pending/failed purchases, and audit entries. Assert `GET /api/v1/admin/overview` returns correct zero-safe totals and excludes payment/provider secrets. Assert `GET /api/v1/admin/purchases` returns only verified records, newest first, with cursor pagination and optional valid course ID filter.

Assert this public shape in purchase results:

```js
assert.deepEqual(Object.keys(page.body.purchases[0]).sort(), ['amount', 'course', 'currency', 'id', 'student', 'verifiedAt']);
assert.equal(page.body.purchases[0].razorpayOrderId, undefined);
assert.equal(page.body.purchases[0].razorpayPaymentId, undefined);
assert.equal(page.body.purchases[0].razorpaySignature, undefined);
```

Add tests for non-Admin rejection, malformed course filter/cursor/limit errors, and empty data returning zero metrics plus empty arrays.

- [ ] **Step 2: Run reporting tests and confirm they fail.**

```powershell
npm test -- --test-name-pattern="admin overview|verified purchase report"
```

Expected: FAIL because reporting routes do not exist.

- [ ] **Step 3: Implement the overview controller with precise metrics.**

Create `getOverview` in `backend/controller/admin-report.controller.js`. In parallel, count users by role, courses by status, active enrollments, and verified purchases/revenue. `verifiedRevenuePaise` is the sum of only `Purchase.status === 'VERIFIED'` amounts and must be an integer `0` if there are none.

Calculate the completion denominator by summing the current `lectures.length` of every active enrollment's existing course. Calculate the numerator by counting `LectureProgress` records that are `completed: true`, have a matching active enrollment for the same student/course, and whose `lectureId` remains in that course's current `lectures` array. Return `completionPercent` rounded to two decimals and `0` when denominator is zero.

Fetch at most ten newest audit records and map them with the existing audit controller's safe field contract. Return:

```js
{
  success: true,
  metrics: {
    users: { total, students, instructors, admins },
    courses: { total, published },
    activeEnrollments,
    purchases: { verifiedCount, verifiedRevenuePaise, currency: 'INR' },
    learning: { completedLectures, totalLectureSlots, completionPercent }
  },
  recentActivity: []
}
```

- [ ] **Step 4: Implement verified-purchase reporting.**

Create `listVerifiedPurchases` using the shared cursor helper. Accept only a valid optional `courseId`; query `status: 'VERIFIED'`, sort `{ updatedAt: -1, _id: -1 }`, apply the cursor's `at` timestamp as a strict older-than pair, populate student/course with explicit safe select fields, and encode a cursor using `updatedAt` plus ID. Return each purchase as:

```js
{
  id: String(purchase._id),
  student: { id: String(purchase.student._id), name: purchase.student.fullName, email: purchase.student.email },
  course: purchase.course ? { id: String(purchase.course._id), title: purchase.course.title } : null,
  amount: purchase.amount,
  currency: purchase.currency,
  verifiedAt: purchase.updatedAt.toISOString()
}
```

Add `router.get('/overview', getOverview)` and `router.get('/purchases', listVerifiedPurchases)`. Read-only reporting must never write audit entries.

- [ ] **Step 5: Run focused reporting tests.**

```powershell
npm test -- --test-name-pattern="admin overview|verified purchase report|safe purchase"
```

Expected: PASS with verified-only revenue and no provider identifiers in the body.

- [ ] **Step 6: Commit the isolated task.**

```powershell
git add backend/controller/admin-report.controller.js backend/routes/admin-operations.route.js backend/tests/admin-operations.test.js
git commit -m "feat: add admin operations reporting"
```

### Task 4: Define frontend Admin contracts and error presentation

**Files:**
- Modify: `frontend/src/lib/api/models.ts`
- Create: `frontend/src/lib/api/admin.ts`
- Modify: `frontend/src/lib/errors/present.ts`
- Create: `frontend/src/test/admin-operations.test.tsx`

- [ ] **Step 1: Write failing frontend contract tests.**

Mock the reusable `api` function and assert that Admin helpers call exact endpoints and return typed data:

```ts
await listAdminUsers({ query: 'ana', role: 'STUDENT', limit: 25 });
expect(api).toHaveBeenCalledWith('/admin/users?query=ana&role=STUDENT&limit=25');

await moderateCourseStatus('course-1', 'UNPUBLISHED');
expect(api).toHaveBeenCalledWith('/admin/courses/course-1/status', { method: 'PATCH', body: { status: 'UNPUBLISHED' } });
```

Add a presentation test for `ADMIN_INVALID_REQUEST` that expects: “Check the filters or paging details and try again.” and a corrective action, not server-provided text.

- [ ] **Step 2: Run the tests to confirm they fail.**

Run from `frontend`:

```powershell
npm test -- --run src/test/admin-operations.test.tsx
```

Expected: FAIL because the Admin helpers and approved presentation mapping do not exist.

- [ ] **Step 3: Add stable Admin types and API helpers.**

Add explicit TypeScript types for `AdminUser`, `AdminCourse`, `AdminPurchase`, `AdminAuditEntry`, `AdminOverview`, and `{ nextCursor: string | null }` pages. Create `frontend/src/lib/api/admin.ts` exporting `getAdminOverview`, `listAdminUsers`, `listAdminCourses`, `moderateCourseStatus`, `listAdminPurchases`, and `listAdminAuditLogs`.

Build query strings with `URLSearchParams`, omit undefined filters, and encode route IDs with `encodeURIComponent`. Do not put response data into browser storage or log API errors.

In `present.ts`, add an allowlisted `ADMIN_INVALID_REQUEST` branch that returns the static corrective message above. Safe 5xx Admin errors continue to use the existing generic retryable connection guidance.

- [ ] **Step 4: Run contract tests.**

```powershell
npm test -- --run src/test/admin-operations.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated task.**

```powershell
git add frontend/src/lib/api/models.ts frontend/src/lib/api/admin.ts frontend/src/lib/errors/present.ts frontend/src/test/admin-operations.test.tsx
git commit -m "feat: add admin API client contracts"
```

### Task 5: Replace Admin placeholders with live, safe workspace screens

**Files:**
- Modify: `frontend/src/components/skillforge/admin-pages.tsx`
- Modify: `frontend/src/test/admin-operations.test.tsx`

- [ ] **Step 1: Write failing Admin workspace behavior tests.**

Mock Admin API helpers and test all sections:

```tsx
render(<AdminPage section="overview" />);
expect(await screen.findByText('Verified revenue')).toBeVisible();

render(<AdminPage section="courses" />);
await user.click(await screen.findByRole('button', { name: 'Unpublish' }));
expect(moderateCourseStatus).toHaveBeenCalledWith('course-1', 'UNPUBLISHED');
```

Cover loading, empty, retryable error, Users search/filter, role-change confirmation/success, Courses publish/unpublish confirmation/success, Payments verified-only table, and Activity Load more using its returned cursor. Assert no placeholder wording remains and provider IDs/signatures are never rendered.

- [ ] **Step 2: Run the screen tests to confirm they fail.**

```powershell
npm test -- --run src/test/admin-operations.test.tsx
```

Expected: FAIL because the Admin sections still display API-coming-next placeholders.

- [ ] **Step 3: Implement live Admin sections in the existing workspace component.**

Replace `ComingNext` usage in `admin-pages.tsx` with focused section components that each fetch only their own endpoint. Reuse `PageHeading`, `Status`, `ErrorGuidance`, `Notice`, `Empty`, `Button`, and the shared error context.

For status mutations, require a local confirmation state, disable the action while the request is pending, show the static success notice after a successful response, and re-fetch the relevant list/overview. For role changes, keep the server as the authority and re-fetch the matching user page after success. Do not optimistically mutate lists.

Use accessible table headings, labeled filters/search fields, semantic button names, and an explicit Load more button only when a non-null cursor exists. Preserve `ProfilePage` behavior and existing protected routing.

- [ ] **Step 4: Run focused frontend tests and production build.**

```powershell
npm test -- --run src/test/admin-operations.test.tsx src/test/permission-recovery.test.tsx
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the isolated task.**

```powershell
git add frontend/src/components/skillforge/admin-pages.tsx frontend/src/test/admin-operations.test.tsx
git commit -m "feat: connect admin operations workspace"
```

### Task 6: Document and verify the Admin milestone

**Files:**
- Modify: `backend/README.md`
- Modify: `frontend/README.md`

- [ ] **Step 1: Document safe Admin operations.**

Document the five Admin sections, Admin-only restriction, pagination/filter bounds, publish/unpublish-only moderation, verified-only reports, and the explicit exclusions: suspension/deletion, refunds, exports, charts, custom date ranges, and ownership transfer. State that payment provider IDs, signatures, credentials, cookies, JWTs, and reset values never appear in reports.

- [ ] **Step 2: Run full backend verification.**

Run from `backend`:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run full frontend verification.**

Run from `frontend`:

```powershell
npm test
npm run build
```

Expected: all tests and the production build pass.

- [ ] **Step 4: Check final diff and secret exposure.**

Run from repository root:

```powershell
git diff --check
rg -n -i "razorpay.*(order|payment|signature)|password|forgotPasswordToken|authorization:|cookie:" backend/controller/admin-* backend/routes/admin-operations.route.js frontend/src/lib/api/admin.ts frontend/src/components/skillforge/admin-pages.tsx
```

Expected: no report mapper, response serializer, UI rendering, or documentation example exposes a sensitive field. Test fixtures and import names are reviewed manually if the scan returns them.

- [ ] **Step 5: Commit documentation work.**

```powershell
git add backend/README.md frontend/README.md
git commit -m "docs: describe admin operations workspace"
```

## Plan self-review

- **Spec coverage:** Tasks 1–3 implement every agreed Admin endpoint and privacy rule; Tasks 4–5 replace the current frontend placeholders; Task 6 verifies and documents the milestone.
- **State consistency:** Existing course statuses are `PUBLISHED` and `UNPUBLISHED`; no task introduces an unsupported `DRAFT` status.
- **Safety:** All lists use allowlisted response mappers; all routes are Admin-only; payment reporting is verified-only and excludes provider data; no-op moderation creates no duplicate audit record.
- **Scope control:** The plan excludes account/course deletion, account suspension, ownership transfer, refunds, webhooks, exports, charts, custom ranges, signed video delivery, and live classes.
