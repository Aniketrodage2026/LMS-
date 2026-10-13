# Platform Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every implemented LMS feature return stable, safe error codes and present users with plain-language messages and recovery actions.

**Architecture:** The Express API emits a backward-compatible `{ success, message, error: { code, message } }` failure envelope. A single frontend presenter maps codes and screen context to approved copy, retry behaviour, and safe actions; screens consume the presenter rather than server text.

**Tech Stack:** Node.js, Express 5, Mongoose, Multer, Node test runner, React 19, TanStack Router/Query, TypeScript, Vitest, Testing Library.

---

## File structure

- `backend/utils/appError.js` — structured safe domain error.
- `backend/middleware/error.middleware.js` — normalizes framework/database failures into the public API envelope.
- `backend/controller/user.controller.js` — authentication and password-reset codes/messages.
- `backend/tests/error.middleware.test.js` and `backend/tests/auth.test.js` — backend contract coverage.
- `frontend/src/lib/api/client.ts` — parses public error envelope into `ApiError`.
- `frontend/src/lib/errors/present.ts` — browser-safe code-to-copy/action mapper.
- `frontend/src/lib/errors/present.test.ts` — mapper tests.
- `frontend/src/components/skillforge/shared.tsx` — reusable alert/recovery UI.
- `frontend/src/components/skillforge/auth-pages.tsx` — auth recovery links and generic reset confirmation.
- `frontend/src/test/auth-form-contract.test.ts` — auth page recovery-link contract.
- Existing domain controllers/pages — migrated one domain at a time in later tasks.

### Task 1: Establish the backwards-compatible backend error envelope

**Files:**
- Modify: `backend/utils/appError.js`
- Modify: `backend/middleware/error.middleware.js`
- Modify: `backend/tests/error.middleware.test.js`

- [ ] **Step 1: Write failing middleware tests for a public code and a normalized framework error**

Add assertions that an explicit error produces:

```js
assert.deepEqual(result.body, {
  success: false,
  message: 'Please sign in to continue.',
  error: { code: 'AUTH_REQUIRED', message: 'Please sign in to continue.' }
});
```

and that a production `new Error('database password leaked')` produces `SYSTEM_UNEXPECTED` with `Internal server error` and no stack.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/error.middleware.test.js`

Expected: FAIL because the current body has no `error.code`.

- [ ] **Step 3: Extend `AppError` without breaking existing callers**

Use this constructor contract:

```js
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'SYSTEM_UNEXPECTED', meta) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (meta !== undefined) this.meta = meta;
    Error.captureStackTrace(this, this.constructor);
  }
}
```

Existing `new AppError(message, status)` calls remain valid during migration.

- [ ] **Step 4: Normalize errors in the central middleware**

Implement a `publicError(error)` helper that returns `{ statusCode, code, message }`. It must map Multer limits to `UPLOAD_FILE_INVALID`, preserve explicit `AppError` codes, redact unknown production failures to `SYSTEM_UNEXPECTED`, and emit:

```js
{
  success: false,
  message,
  error: { code, message }
}
```

Keep development-only `stack` outside the `error` object.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `node --test tests/error.middleware.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the isolated backend contract**

```powershell
git add backend/utils/appError.js backend/middleware/error.middleware.js backend/tests/error.middleware.test.js
git commit -m "feat: add structured API error envelope"
```

### Task 2: Secure and clarify authentication failures

**Files:**
- Modify: `backend/controller/user.controller.js`
- Modify: `backend/tests/auth.test.js`

- [ ] **Step 1: Add failing authentication error-contract tests**

Add tests that verify:

```js
// duplicate signup
assert.equal(response.status, 409);
assert.equal(response.body.error.code, 'AUTH_EMAIL_EXISTS');

// unknown email and wrong password intentionally match
assert.equal(unknown.status, 401);
assert.equal(wrongPassword.status, 401);
assert.equal(unknown.body.error.code, 'AUTH_INVALID_CREDENTIALS');
assert.equal(unknown.body.message, wrongPassword.body.message);

// both known and unknown emails receive the same reset response
assert.equal(knownReset.status, 200);
assert.equal(unknownReset.status, 200);
assert.deepEqual(unknownReset.body, knownReset.body);
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test tests/auth.test.js`

Expected: FAIL because duplicate signup returns 400/no code, invalid login returns raw wording, and unknown reset email returns 400.

- [ ] **Step 3: Apply explicit auth codes in `user.controller.js`**

Use these domain errors:

```js
new AppError('An account already exists for this email.', 409, 'AUTH_EMAIL_EXISTS');
new AppError('We couldn\'t sign you in with that email and password.', 401, 'AUTH_INVALID_CREDENTIALS');
new AppError('This reset link has expired. Request a new one to continue.', 400, 'AUTH_RESET_TOKEN_INVALID');
```

Normalize the email before lookup. For `forgotPassword`, immediately return this identical body when the user is absent:

```js
res.status(200).json({
  success: true,
  message: 'If an account exists for this email, a reset link is on its way.'
});
```

Return that same body after a successful email send. Do not include the recipient email or reset token in any response.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `node --test tests/auth.test.js`

Expected: PASS.

- [ ] **Step 5: Commit authentication handling**

```powershell
git add backend/controller/user.controller.js backend/tests/auth.test.js
git commit -m "feat: add safe authentication error codes"
```

### Task 3: Parse codes and present safe messages on the frontend

**Files:**
- Modify: `frontend/src/lib/api/client.ts`
- Create: `frontend/src/lib/errors/present.ts`
- Create: `frontend/src/lib/errors/present.test.ts`

- [ ] **Step 1: Write failing presenter tests**

Test these mappings:

```ts
expect(presentApiError(new ApiError(409, 'AUTH_EMAIL_EXISTS'))).toMatchObject({
  message: 'An account already exists for this email.',
  actions: ['login', 'reset-password'],
});
expect(presentApiError(new ApiError(401, 'AUTH_INVALID_CREDENTIALS'))).toMatchObject({
  message: 'We couldn’t sign you in with that email and password.',
  actions: ['reset-password'],
});
expect(presentApiError(new ApiError(0, 'NETWORK_UNAVAILABLE')).retryable).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/lib/errors/present.test.ts`

Expected: FAIL because the module and `ApiError.code` do not exist.

- [ ] **Step 3: Parse the API envelope and add the presenter**

Change `ApiError` to accept `status`, `code`, `message`, and `details`. When an API response fails, read `json.error?.code` first and fall back to `SYSTEM_UNEXPECTED`. For browser network failures use `NETWORK_UNAVAILABLE`.

Define this presentation shape:

```ts
export type ErrorAction = 'login' | 'reset-password' | 'retry' | 'back' | 'purchases' | 'course';
export type ErrorPresentation = {
  message: string;
  actions: ErrorAction[];
  retryable: boolean;
};
```

Map all approved auth, network, authorization, course access, upload, payment, assessment, and certificate codes. Unknown 5xx errors map to the generic connection/service message, never server text.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run src/lib/errors/present.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the frontend error foundation**

```powershell
git add frontend/src/lib/api/client.ts frontend/src/lib/errors/present.ts frontend/src/lib/errors/present.test.ts
git commit -m "feat: map API error codes to user guidance"
```

### Task 4: Add reusable recovery UI and complete authentication pages

**Files:**
- Modify: `frontend/src/components/skillforge/shared.tsx`
- Modify: `frontend/src/components/skillforge/auth-pages.tsx`
- Modify: `frontend/src/test/auth-form-contract.test.ts`

- [ ] **Step 1: Write failing page-contract tests**

Add source-contract assertions for the duplicate and invalid-login recovery actions:

```ts
expect(authPages).toContain("actions: ['login', 'reset-password']");
expect(authPages).toContain("actions: ['reset-password']");
expect(authPages).toContain('If an account exists for this email, a reset link is on its way.');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run src/test/auth-form-contract.test.ts`

Expected: FAIL because auth pages only render a plain string error.

- [ ] **Step 3: Add `RecoveryLinks` and use the presenter in auth forms**

Add a `RecoveryLinks` component that renders TanStack `Link` elements for only the actions in the presentation. For `reset-password`, prefill the query string with the entered email only; never include a password, token, API body, or external URL.

In `LoginPage` and `RegisterPage`, retain `ApiError` state, call `presentApiError`, show `ErrorBox` with the resulting message, and render matching recovery links. Preserve the current uncontrolled form values by not resetting the form on failure.

Keep the Forgot Password success notice static and generic. Render `AUTH_RESET_TOKEN_INVALID` as a reset-link-expired message with a link to `/forgot-password`.

- [ ] **Step 4: Run focused frontend tests**

Run: `npm test -- --run src/test/auth-form-contract.test.ts src/lib/errors/present.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit auth UI recovery**

```powershell
git add frontend/src/components/skillforge/shared.tsx frontend/src/components/skillforge/auth-pages.tsx frontend/src/test/auth-form-contract.test.ts
git commit -m "feat: add auth error recovery actions"
```

### Task 5: Normalize access, upload, and purchase errors

**Files:**
- Modify: `backend/controller/course.controller.js`
- Modify: `backend/controller/learning-progress.controller.js`
- Modify: `backend/controller/purchase.controller.js`
- Modify: `backend/middleware/multer.middleware.js`
- Modify: `backend/tests/course-access.test.js`
- Modify: `backend/tests/learning-progress.test.js`
- Modify: `backend/tests/purchase-flow.test.js`
- Modify: `frontend/src/lib/api/hooks.ts`
- Modify: `frontend/src/components/skillforge/public-pages.tsx`
- Modify: `frontend/src/components/skillforge/assessment-pages.tsx`

- [ ] **Step 1: Add failing representative domain-code assertions**

Add assertions for `COURSE_PURCHASE_REQUIRED`, `COURSE_ACCESS_REVOKED`, `UPLOAD_FILE_TOO_LARGE`, `PAYMENT_ORDER_PENDING`, `PAYMENT_VERIFICATION_UNAVAILABLE`, and `PAYMENT_ALREADY_OWNED` while preserving the existing status assertions.

- [ ] **Step 2: Run the three focused backend suites and verify failure**

Run: `node --test tests/course-access.test.js tests/learning-progress.test.js tests/purchase-flow.test.js`

Expected: FAIL because current error bodies do not have those codes.

- [ ] **Step 3: Assign domain codes and safe messages at source**

Use `COURSE_PURCHASE_REQUIRED` only when a student needs ownership, `COURSE_ACCESS_REVOKED` for revoked enrollment, `UPLOAD_FILE_*` for client-correctable upload failures, and `PAYMENT_*` codes for order/verification state. Do not alter payment access/transaction logic.

- [ ] **Step 4: Present payment and access recovery in the UI**

In `useCheckout`, map pending verification to a purchases action and do not encourage a second payment. In course/player/query failure screens, use the shared presentation and retry only when `retryable` is true.

- [ ] **Step 5: Run focused backend/frontend tests**

Run: `node --test tests/course-access.test.js tests/learning-progress.test.js tests/purchase-flow.test.js`

Run: `npm test -- --run src/lib/errors/present.test.ts src/test/api-money-contract.test.ts src/test/player-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the domain migration**

```powershell
git add backend frontend/src/lib/api/hooks.ts frontend/src/components/skillforge/public-pages.tsx frontend/src/components/skillforge/assessment-pages.tsx
git commit -m "feat: add course upload and payment error guidance"
```

### Task 6: Normalize assessment, certificate, instructor, and admin errors

**Files:**
- Modify: `backend/controller/student-quiz.controller.js`
- Modify: `backend/controller/instructor-quiz.controller.js`
- Modify: `backend/controller/student-assignment.controller.js`
- Modify: `backend/controller/instructor-assignment.controller.js`
- Modify: `backend/controller/certificate.controller.js`
- Modify: `backend/controller/user.controller.js`
- Modify: `backend/tests/quiz-flow.test.js`
- Modify: `backend/tests/assignment-flow.test.js`
- Modify: `backend/tests/certificate-flow.test.js`
- Modify: `frontend/src/components/skillforge/assessment-pages.tsx`
- Modify: `frontend/src/components/skillforge/instructor-pages.tsx`
- Modify: `frontend/src/components/skillforge/student-pages.tsx`
- Modify: `frontend/src/components/skillforge/admin-pages.tsx`

- [ ] **Step 1: Add failing code assertions per domain**

Assert `ASSESSMENT_NOT_AVAILABLE`, `ASSESSMENT_SUBMISSION_LOCKED`, `ASSESSMENT_REVIEW_CONFLICT`, `CERTIFICATE_NOT_ELIGIBLE`, `CERTIFICATE_NOT_FOUND`, and `AUTH_ROLE_FORBIDDEN` on representative existing cases.

- [ ] **Step 2: Run focused suites and verify failure**

Run: `node --test tests/quiz-flow.test.js tests/assignment-flow.test.js tests/certificate-flow.test.js tests/auth.test.js`

Expected: FAIL because those codes are not emitted.

- [ ] **Step 3: Add only code/message normalization**

Preserve every current authorization, attempt, grading, submission-version, and certificate-eligibility rule. Replace hand-written public messages with code/message pairs that map to the approved presentation.

- [ ] **Step 4: Replace raw `errorText` usage in migrated screens**

Use the presenter for inline assessment forms, submission review, certificate eligibility/claim, instructor mutations, and role management. Retain existing success notices and page-specific field validation.

- [ ] **Step 5: Run focused suites and frontend contracts**

Run: `node --test tests/quiz-flow.test.js tests/assignment-flow.test.js tests/certificate-flow.test.js tests/auth.test.js`

Run: `npm test -- --run src/test/instructor-admin-contract.test.ts src/test/learning-rules.test.ts src/lib/errors/present.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the assessment/admin migration**

```powershell
git add backend/controller backend/tests frontend/src/components/skillforge frontend/src/lib/errors
git commit -m "feat: add assessment and certificate error guidance"
```

### Task 7: Full regression and user-flow verification

**Files:**
- Modify: `backend/README.md`
- Modify: `frontend/README.md`

- [ ] **Step 1: Document the API error envelope and local CORS requirement**

Document the `{ success, message, error: { code, message } }` failure shape, the password-reset privacy rule, and matching `FRONTEND_URL`/actual frontend origin requirements.

- [ ] **Step 2: Run all automated checks**

Run: `npm test`

Working directory: `backend`

Run: `npm test && npm run build`

Working directory: `frontend`

Expected: all backend tests, all frontend tests, and the production build PASS.

- [ ] **Step 3: Manually verify browser flows against a running local backend**

Verify duplicate signup, invalid login, unknown-password-reset email, expired reset token, guest paid-course access, rejected upload, failed/retried query, payment pending state, locked assignment, and certificate ineligibility. Confirm no browser console CORS error and no technical message reaches the UI.

- [ ] **Step 4: Commit documentation and verification changes**

```powershell
git add backend/README.md frontend/README.md
git commit -m "docs: document LMS error handling"
```
