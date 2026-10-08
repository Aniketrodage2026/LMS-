# Lovable Frontend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the Lovable SkillForge frontend into `LMS/client` and make its implemented student and instructor workflows conform to the existing LMS Express API.

**Architecture:** Keep the Lovable React/TanStack application as a standalone client project. Centralize Express response/request adaptation in `src/lib/api/models.ts` and narrow screen-level payload changes to the affected workflows. The existing Express backend remains authoritative for session cookies, roles, access, pricing, assessment outcomes, and certificates.

**Tech Stack:** React 19, TypeScript, TanStack Start/Router/Query, Vite, Vitest, Express, Mongoose, Razorpay Test Mode.

---

## Fixed backend contract

- The API base is `${VITE_API_BASE_URL}/api/v1`; authenticated browser calls use `credentials: 'include'`.
- Registration and profile update use `fullName`, never `name`.
- A course price is integer paise. The UI converts rupees to paise when saving and paise to rupees when displaying.
- A lecture video is at `lecture.secure_url`; its duration is `durationSeconds`.
- Progress writes `{ watchedSeconds, durationSeconds }`; course-progress reads `completionPercent` and `lectures`.
- Student assignment content uses `writtenAnswer`; assignment file URLs are `file.secureUrl`.
- Instructor assignment review uses either `{ action: 'GRADE', marks, feedback }` or `{ action: 'REQUEST_RESUBMISSION', feedback }`.
- Quiz questions use `prompt`, not `question`.
- The current admin API accepts only `STUDENT` or `INSTRUCTOR` for `PATCH /api/v1/admin/users/:userId/role`.
- The backend has no instructor-owned-course list endpoint. The client must not claim that drafts are listed; a backend endpoint is a separate future task.

## File structure

- `LMS/client/`: imported Lovable project.
- `LMS/client/src/lib/api/models.ts`: document normalization, API payload adapters, money/file helpers, and pure contract helpers.
- `LMS/client/src/lib/api/models.test.ts`: unit tests for adapters and contract helpers.
- `LMS/client/src/lib/api/hooks.ts`: course, learning, purchase, and Razorpay queries.
- `LMS/client/src/components/skillforge/auth-pages.tsx`: register/profile request-field corrections.
- `LMS/client/src/components/skillforge/assessment-pages.tsx`: player/progress, quiz display, and student assignment corrections.
- `LMS/client/src/components/skillforge/instructor-pages.tsx`: course, lecture, quiz, assignment, and grading request corrections.
- `LMS/client/src/components/skillforge/admin-pages.tsx`: truthful role options.
- `LMS/client/src/test/backend-contract.test.ts`: API route/payload regression tests using mocked fetch.
- `LMS/client/README.md`: local setup, environment, supported API scope, and backend limitations.

### Task 1: Import a clean frontend project and establish a test baseline

**Files:**
- Create: `LMS/client/` from `C:\Users\anike\Downloads\b131161a-3ef6-46a9-95d8-e2a0bca59c15.zip`
- Modify: `LMS/client/README.md`
- Test: `LMS/client/src/test/app-routing.test.tsx`

- [ ] **Step 1: Import the archive without dependency folders or local secrets**

Extract the supplied ZIP into `LMS/client`. Preserve source, assets, configuration, tests, `.env.example`, and `.gitignore`; do not import `node_modules`, `.env`, or the Lovable archive itself.

- [ ] **Step 2: Add the frontend setup contract to the README**

Document the command sequence and environment variable:

```markdown
cd LMS/client
npm install
copy .env.example .env
# Set VITE_API_BASE_URL to the local Express server origin.
npm test
npm run lint
npm run build
```

State that the backend `FRONTEND_URL` must exactly match the Vite browser origin and that cookie sessions require `credentials: 'include'`.

- [ ] **Step 3: Run the imported routing test before any feature modifications**

Run: `npm test -- src/test/app-routing.test.tsx`

Expected: a passing route-tree test once dependencies install. If the command fails because dependencies cannot be installed, report that environmental blocker before changing application behavior.

### Task 2: Add contract adapters and correct authentication/course data

**Files:**
- Create: `LMS/client/src/lib/api/models.test.ts`
- Modify: `LMS/client/src/lib/api/models.ts`
- Modify: `LMS/client/src/components/skillforge/auth-pages.tsx`
- Modify: `LMS/client/src/components/skillforge/student-pages.tsx`

- [ ] **Step 1: Write failing adapter tests**

Test the real backend shapes:

```ts
it('normalizes an Express lecture with secure_url and durationSeconds', () => {
  expect(toLecture({ _id: 'l1', title: 'Intro', lecture: { secure_url: 'https://media.example/intro.mp4' }, durationSeconds: 120 })).toMatchObject({
    id: 'l1', videoUrl: 'https://media.example/intro.mp4', duration: 120
  });
});

it('converts a ₹1,499 display price to 149900 paise and back', () => {
  expect(toPaise(1499)).toBe(149900);
  expect(inr(149900)).toBe('₹1,499');
});
```

- [ ] **Step 2: Run the adapter test and confirm it fails for the current source assumptions**

Run: `npm test -- src/lib/api/models.test.ts`

Expected: FAIL because `toLecture` does not read `lecture.secure_url` and money helpers treat paise as rupees.

- [ ] **Step 3: Implement minimal contract helpers and normalizers**

Add `toPaise`, `fromPaise`, a paise-aware `inr`, and normalizers that read `lecture.secure_url`, `durationSeconds`, `numberOflectures`, `completionPercent`, `fullName`, `writtenAnswer`, and `secureUrl` while retaining safe fallbacks for harmless presentation fields.

- [ ] **Step 4: Correct form-field names**

Update registration and profile form controls to submit `fullName`. Keep display-model property `name` if desired, but do not send it to Express.

- [ ] **Step 5: Run adapter and existing frontend tests**

Run: `npm test -- src/lib/api/models.test.ts src/test/api-rules.test.ts src/test/learning-rules.test.ts`

Expected: PASS.

### Task 3: Make learning, assessments, and certificates use the backend contract

**Files:**
- Modify: `LMS/client/src/components/skillforge/assessment-pages.tsx`
- Modify: `LMS/client/src/components/skillforge/student-pages.tsx`
- Create: `LMS/client/src/test/backend-contract.test.ts`

- [ ] **Step 1: Write failing fetch-contract tests**

Use a mocked `fetch` only at the network boundary. Cover these exact calls:

```ts
expect(requestBody).toEqual({ watchedSeconds: 90, durationSeconds: 100 });
expect(submissionForm.get('writtenAnswer')).toBe('My solution');
expect(renderedPrompt).toContain('What does HTTP mean?');
```

- [ ] **Step 2: Run the contract test and confirm it fails**

Run: `npm test -- src/test/backend-contract.test.ts`

Expected: FAIL because the existing client sends `duration`, sends assignment `answer`, and renders quiz `question` instead of `prompt`.

- [ ] **Step 3: Implement player and progress corrections**

Build the player curriculum from `GET /courses/:courseId/progress` rows because public course detail deliberately omits lectures. Fetch protected lessons only for an entitled selected lecture. Send only `{ watchedSeconds, durationSeconds }`, consume `completionPercent` and `lectures`, and preserve monotonic progress behavior.

- [ ] **Step 4: Implement assessment response/request corrections**

Send `writtenAnswer`, display `writtenAnswer` and `file.secureUrl`, use quiz `prompt` in student and instructor screens, and preserve backend-only answer grading.

- [ ] **Step 5: Run the focused test suite**

Run: `npm test -- src/test/backend-contract.test.ts src/lib/api/models.test.ts src/test/api-rules.test.ts src/test/learning-rules.test.ts`

Expected: PASS.

### Task 4: Correct instructor and admin integration behavior

**Files:**
- Modify: `LMS/client/src/components/skillforge/instructor-pages.tsx`
- Modify: `LMS/client/src/components/skillforge/admin-pages.tsx`
- Modify: `LMS/client/src/lib/api/models.ts`
- Modify: `LMS/client/src/test/backend-contract.test.ts`

- [ ] **Step 1: Write failing contract tests for instructor payloads**

```ts
expect(quizPayload.questions[0]).toMatchObject({ prompt: 'Question text', correctOptionIndex: 0 });
expect(reviewPayload).toEqual({ action: 'GRADE', marks: 85, feedback: 'Clear implementation.' });
expect(resubmissionPayload).toEqual({ action: 'REQUEST_RESUBMISSION', feedback: 'Please add tests.' });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- src/test/backend-contract.test.ts`

Expected: FAIL because the current UI uses `question` and `status` payload fields.

- [ ] **Step 3: Implement minimal instructor fixes**

Map quiz editor state to API `{ prompt, options, correctOptionIndex, explanation }`. Send only `action`, `marks`, and `feedback` for a grade, and only `action` and `feedback` for resubmission. Convert course-builder input rupees to paise before posting. Remove the nonfunctional course-level preview selector and retain per-lecture `isPreview` during video upload. Do not send unsupported `level` or `isFree` API fields.

- [ ] **Step 4: Make admin role choices truthful**

Offer only `STUDENT` and `INSTRUCTOR` in the role form. Retain the admin workspace itself for accounts that already have the server-assigned `ADMIN` role.

- [ ] **Step 5: Document the instructor course-list limitation in the UI**

Rename the view to clarify that it shows published courses visible from the current public API. Do not advertise drafts until the backend adds an authorized instructor-course-list endpoint.

- [ ] **Step 6: Run instructor/admin contract tests**

Run: `npm test -- src/test/backend-contract.test.ts`

Expected: PASS.

### Task 5: Final quality verification and handoff

**Files:**
- Modify: `LMS/client/README.md`

- [ ] **Step 1: Verify frontend quality**

Run:

```powershell
cd LMS/client
npm test
npm run lint
npm run build
```

Expected: all tests pass, lint exits 0, and the production build exits 0.

- [ ] **Step 2: Verify backend regression safety**

Run:

```powershell
cd LMS/server
npm test
```

Expected: all existing backend tests pass.

- [ ] **Step 3: Verify the repository diff**

Run: `git diff --check` and `git status --short` from the repository root.

Expected: no whitespace errors; only intended client, documentation, and test changes are present.

