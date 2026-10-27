# Hybrid AI Learning Assistant — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a student-only hybrid AI assistant that collects a learning profile, ranks real courses transparently, and provides safe progress-aware course guidance through Gemini with deterministic fallbacks.

**Architecture:** New AI models and services remain separate from existing LMS domains. Recommendation and authorization decisions occur entirely in backend services; Gemini receives only bounded safe context for conversational explanation. A protected Express AI router exposes narrow DTOs consumed by dashboard components through the existing TanStack Query API client.

**Tech Stack:** Node.js/Express, Mongoose/MongoDB Atlas, Node built-in `fetch`, Gemini Developer API, React, TanStack Query/Router, Vitest, Node test runner, Supertest.

**Spec:** `docs/superpowers/specs/2026-10-26-hybrid-ai-learning-assistant-design.md`

## Global Constraints

- Preserve all existing authentication, purchase, course, assessment, progress, certificate, and media behavior.
- Every AI endpoint requires `isLoggedIn` and `requireRole('STUDENT')`.
- Course recommendations query only published courses and exclude active enrollments.
- Scores are deterministic backend integers in the range 0–100; an LLM never selects courses or invents scores.
- Prerequisite evidence is only completed LMS courses and explicitly self-reported skills; interests are never evidence.
- Never send passwords, email addresses, JWTs, cookies, payment data, R2 keys/object keys, raw assignments, or another student’s data to Gemini.
- Gemini keys and provider configuration exist only in backend environment variables.
- Gemini failure, malformed output, timeout, or quota exhaustion must return safe deterministic guidance without provider details.
- Phase 1 excludes RAG, embeddings, content ingestion, video transcription, instructor material upload, and AI assessment publishing.
- Do not auto-purchase, auto-enroll, grade, publish, or mutate LMS records from AI output.

## Review Focus

- Course-specific chat for a course the caller is not actively enrolled in must be rejected before context/provider work; Task 4 tests this.
- A catalog with no eligible published courses must return an empty safe recommendation result, not invented advice; Task 2 tests this.
- A Gemini response that contains an unknown course ID, unsupported claim, or oversized output must be discarded in favor of backend-safe copy; Task 3 tests this.
- A profile with only interests must not satisfy prerequisites; Task 2 tests this.
- Provider quota/outage must not expose provider errors or block deterministic recommendations and progress guidance; Tasks 3–4 test this.

---

## File Structure

- Create: `backend/models/learning-profile.schema.js` — one validated profile per student.
- Create: `backend/models/ai-conversation.schema.js` — bounded safe student conversation history.
- Create: `backend/models/ai-usage-log.schema.js` — redacted immutable AI operational usage records.
- Modify: `backend/models/course.schema.js` — optional instructor-owned learning metadata only.
- Create: `backend/services/ai/learning-profile.service.js` — profile normalization and DTOs.
- Create: `backend/services/ai/recommendation.service.js` — deterministic published-course scoring.
- Create: `backend/services/ai/student-context.service.js` — bounded caller-owned learning facts.
- Create: `backend/services/ai/providers/gemini.provider.js` — backend-only Gemini adapter.
- Create: `backend/services/ai/assistant.service.js` — orchestration, validation, usage/budget fallback.
- Create: `backend/controller/ai.controller.js` and `backend/routes/ai.route.js` — protected API handlers/router.
- Modify: `backend/app.js` and `backend/.env.example` — mount router and document non-secret AI configuration names.
- Create: `backend/tests/ai-*.test.js` — model, recommendation, assistant, and route behavior tests.
- Create: `frontend/src/components/skillforge/ai-assistant.tsx` — profile/recommendation/guidance/chat UI.
- Modify: `frontend/src/components/skillforge/student-pages.tsx`, `frontend/src/components/skillforge/shared.tsx`, `frontend/src/lib/api/hooks.ts`, `frontend/src/lib/api/models.ts`, `frontend/src/lib/errors/present.ts` — dashboard placement, student nav, API hooks/types, and safe error copy.
- Create: `frontend/src/components/skillforge/ai-assistant.test.tsx` — UI contract tests.

### Task 1: Persist Safe AI Profile and Course Recommendation Metadata

**Files:**
- Create: `backend/models/learning-profile.schema.js`
- Create: `backend/models/ai-conversation.schema.js`
- Create: `backend/models/ai-usage-log.schema.js`
- Modify: `backend/models/course.schema.js`
- Test: `backend/tests/ai-models.test.js`

**Interfaces:**
- Produces `LearningProfile`, `AIConversation`, and `AIUsageLog` Mongoose models.
- Produces optional `course.learningMetadata = { level, skills, prerequisites }` without invalidating existing course documents.

- [ ] **Step 1: Write failing model tests**

Test one-profile-per-student uniqueness; normalized bounded interests/skills; allowed levels; integer weekly hours 1–80; immutable redacted usage fields; bounded conversation messages; and backward-compatible optional course metadata.

- [ ] **Step 2: Run the focused model test**

Run: `node --require ./tests/test-env.js --test tests/ai-models.test.js` from `backend`.

Expected: FAIL because the AI model modules and metadata fields do not exist.

- [ ] **Step 3: Implement the schemas**

Use Mongoose validation and indexes matching existing schema conventions. Store course references and safe message text only; never store provider prompts/responses or credential-like fields.

- [ ] **Step 4: Run the focused model test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/models backend/tests/ai-models.test.js
git commit -m "feat: add AI learning profile models"
```

### Task 2: Build Deterministic Profile, Context, and Recommendation Services

**Files:**
- Create: `backend/services/ai/learning-profile.service.js`
- Create: `backend/services/ai/recommendation.service.js`
- Create: `backend/services/ai/student-context.service.js`
- Test: `backend/tests/ai-recommendation.test.js`

**Interfaces:**
- Consumes Task 1 models plus `Course`, `Enrollment`, `LectureProgress`, quizzes, assignments, and certificate services.
- Produces `saveProfile(studentId, input)`, `getRecommendations(studentId, limit = 5)`, and `buildStudentContext(studentId, courseId?)` safe DTOs.

- [ ] **Step 1: Write failing service tests**

Cover profile normalization; only published unowned courses; score bounds; tie preference for relevant free courses; no-candidate result; prerequisite rule using completed courses/self-reported skills only; and a context query that never returns another student’s progress.

- [ ] **Step 2: Run focused tests**

Run: `node --require ./tests/test-env.js --test tests/ai-recommendation.test.js`.

Expected: FAIL because service modules are absent.

- [ ] **Step 3: Implement deterministic services**

Document fixed score weights inside `recommendation.service.js`; return score signals and actual course IDs/cards before any LLM call. Use existing active-enrollment and learning-progress semantics, and bound all queried/result fields.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai backend/tests/ai-recommendation.test.js
git commit -m "feat: add deterministic AI course recommendations"
```

### Task 3: Add Provider Adapter, Safe Assistant Orchestration, and Fallbacks

**Files:**
- Create: `backend/services/ai/providers/gemini.provider.js`
- Create: `backend/services/ai/assistant.service.js`
- Modify: `backend/.env.example`
- Test: `backend/tests/ai-assistant.service.test.js`

**Interfaces:**
- Consumes Task 2 safe DTOs.
- Produces `createGeminiProvider(config, fetchImpl)` and `respondToStudent({ studentId, message, courseId? })` returning `{ message, grounding, recommendations?, guidance? }`.

- [ ] **Step 1: Write failing provider/orchestration tests**

Test no key/configured provider behavior; timeout; 429/quota; malformed JSON; unsupported provider output; safe deterministic fallback; daily per-student request ceiling; redacted usage log; and proof that forbidden PII/secret keys are absent from provider request bodies.

- [ ] **Step 2: Run focused tests**

Run: `node --require ./tests/test-env.js --test tests/ai-assistant.service.test.js`.

Expected: FAIL because the provider and assistant service are absent.

- [ ] **Step 3: Implement Gemini provider and assistant service**

Use Node `fetch` with configured model, timeout, bounded output token count, and backend-only variables `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_MAX_OUTPUT_TOKENS`, `AI_DAILY_REQUEST_LIMIT`, and `AI_REQUEST_TIMEOUT_MS`. Accept only a reply-key/reference envelope; render all final student-facing copy/cards server-side from backend facts. Use deterministic copy on every unsafe/provider failure.

- [ ] **Step 4: Document AI variables without real values**

Add variable names and conservative example limits to `backend/.env.example`; do not add a real API key.

- [ ] **Step 5: Run focused tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/ai backend/.env.example backend/tests/ai-assistant.service.test.js
git commit -m "feat: add safe Gemini assistant provider"
```

### Task 4: Expose Authorized Student AI APIs

**Files:**
- Create: `backend/controller/ai.controller.js`
- Create: `backend/routes/ai.route.js`
- Modify: `backend/app.js`
- Test: `backend/tests/ai-routes.test.js`

**Interfaces:**
- Consumes Task 2 and Task 3 interfaces.
- Produces protected routes: `GET/PUT /api/v1/ai/profile`, `GET /api/v1/ai/recommendations`, `GET /api/v1/ai/guidance`, and `POST /api/v1/ai/chat`.

- [ ] **Step 1: Write failing API tests**

Test guest/non-student denial; profile validation; safe recommendation DTO fields; active-enrollment enforcement for `courseId`; another-student isolation; quota response; Gemini fallback envelope; and no technical provider details in errors.

- [ ] **Step 2: Run focused route tests**

Run: `node --require ./tests/test-env.js --test tests/ai-routes.test.js`.

Expected: FAIL with missing route/module failures.

- [ ] **Step 3: Implement controller and router**

Mount `/api/v1/ai` in `app.js` after existing middleware. Reuse `isLoggedIn`, `requireRole('STUDENT')`, existing `AppError`, response envelopes, and request logging conventions. Derive the student only from `req.user`.

- [ ] **Step 4: Run focused route tests**

Expected: PASS.

- [ ] **Step 5: Run all backend tests**

Run: `npm --prefix backend test`.

Expected: PASS with existing LMS tests and AI tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/controller backend/routes backend/app.js backend/tests/ai-routes.test.js
git commit -m "feat: expose student AI assistant APIs"
```

### Task 5: Integrate AI Assistant into the Student Dashboard

**Files:**
- Create: `frontend/src/components/skillforge/ai-assistant.tsx`
- Modify: `frontend/src/components/skillforge/student-pages.tsx`
- Modify: `frontend/src/components/skillforge/shared.tsx`
- Modify: `frontend/src/lib/api/hooks.ts`
- Modify: `frontend/src/lib/api/models.ts`
- Modify: `frontend/src/lib/errors/present.ts`
- Test: `frontend/src/components/skillforge/ai-assistant.test.tsx`

**Interfaces:**
- Consumes Task 4 API DTOs via `api()` and TanStack Query.
- Produces dashboard card/chat UI with profile capture, real course cards, progress guidance, and safe error states.

- [ ] **Step 1: Write failing frontend tests**

Test first-time profile questions, free/paid recommendation labels, explanation/score signal rendering, no automatic purchase action, enrolled guidance rendering, loading state, provider-fallback message, and safe retry/error copy.

- [ ] **Step 2: Run frontend focused test**

Run the repository’s existing frontend test command targeted at `ai-assistant.test.tsx`.

Expected: FAIL because component/hooks/types are absent.

- [ ] **Step 3: Add API types, hooks, and error presentation**

Define only safe DTOs; no Gemini or provider credentials/types appear in the frontend. Map stable AI error codes to user-actionable copy.

- [ ] **Step 4: Implement the component and dashboard placement**

Add a compact assistant section beneath dashboard metrics. Reuse `CourseCard`, `Button`, `Status`, `QueryState`, and existing student workspace navigation. Recommendation actions link to course detail; guidance actions link to My Learning/lesson; no AI response can perform a purchase or enrollment.

- [ ] **Step 5: Run focused frontend test and production build**

Run the focused frontend test, then `npm --prefix frontend run build`.

Expected: tests pass and build exits 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat: add student AI learning assistant"
```

### Task 6: End-to-End Safety Verification and Operator Documentation

**Files:**
- Modify: `backend/README.md`
- Modify: `frontend/README.md` if it documents environment/API deployment
- Test: existing backend AI test files and frontend AI test file

**Interfaces:**
- Consumes completed APIs and UI.
- Produces setup, quota, privacy, and fallback operating guidance.

- [ ] **Step 1: Add operator documentation**

Document backend-only Gemini configuration, Free Tier quota limits, per-student daily budget, data-minimization policy, fallback behavior, and the fact that Phase 1 is not a transcript/PDF tutor.

- [ ] **Step 2: Run full verification**

Run: `npm --prefix backend test` and `npm --prefix frontend run build`.

Expected: all backend tests pass and frontend build exits 0.

- [ ] **Step 3: Perform manual acceptance checks**

Verify as a new student: profile → real free/paid recommendations. Verify as an enrolled student: next lesson/progress guidance. Verify guest/instructor cannot access AI endpoints. Temporarily use an invalid Gemini key in a local environment and confirm deterministic fallback with no provider error leakage.

- [ ] **Step 4: Commit**

```bash
git add backend/README.md frontend/README.md
git commit -m "docs: document AI assistant operations"
```

## Self-Review

- **Spec coverage:** Tasks 1–2 implement minimal data and deterministic real-course ranking; Task 3 isolates Gemini, budgets, privacy, and fallback; Task 4 enforces authorization; Task 5 integrates the existing dashboard; Task 6 verifies and documents operations. RAG/tutoring ingestion remains explicitly out of scope.
- **Step scan:** Each task has a defined fileset, named interfaces, failing-test step, implementation step, focused verification, and commit boundary.
- **Type consistency:** Task 2 produces safe profile/recommendation/context DTOs; Task 3 produces assistant DTOs; Task 4 exposes them; Task 5 consumes them.
- **Review focus:** Every listed authorization, empty-state, prerequisite, malformed-provider, and outage failure mode is assigned to Tasks 2–4 tests.
- **Proportion:** Six tasks separate model/ranking/provider/API/UI/operations boundaries without turning the plan into implementation code.
