# SkillForge AI Assistant — Next Features Implementation Plan

**Goal:** Extend Ask SkillForge in small, independently testable releases, beginning with a useful weekly study plan and then adding practice, progress, course-context, instructor, pathway, and accessibility capabilities.

**Current baseline:** The site-wide chatbot is implemented for guests and signed-in users. Students can receive their own progress context and route a selected active course question through the authorized PDF tutor. Automated implementation checks pass; live chatbot staging acceptance is still pending in `frontend/roadmap.md`.

**Architecture:** Keep policy, authorization, catalog/progress facts, scheduling, and scoring in backend services. The frontend calls the Express API using the existing credentialed client and renders allowlisted DTOs. Use Gemini only where generation adds value; validate structured output against backend-owned facts and return deterministic fallbacks. Each feature is introduced behind its own narrow API/UI surface and regression tests.

**Tech stack:** Express, Mongoose/MongoDB Atlas, existing AI provider and PDF/RAG services, React, TanStack Query, Vitest, Node test runner, and Supertest.

## Product and Safety Constraints

- Preserve existing authentication, enrollment, payment, course, assessment, certificate, media, chatbot, and PDF tutor behavior.
- Authentication and role checks in the backend remain authoritative; UI hiding or route guards are not access control.
- Never expose another learner's data, unpublished courses/materials, private storage details, provider credentials, raw prompts, or provider diagnostics.
- A study plan is advisory. It never enrolls, purchases, submits, grades, publishes, or changes progress on behalf of a user.
- A practice quiz is supplemental and ungraded. It is not an official quiz attempt and must not affect certificates or course completion.
- Instructor-generated content remains a draft until the instructor explicitly reviews and saves/publishes it using existing authorized flows.
- Keep personal data minimized. Do not retain free-text chats or generated content unless a feature explicitly needs durable user-owned state and the user chooses to save it.
- Put budgets, request limits, timeouts, output bounds, and safe fallbacks on every new provider-backed endpoint. Do not imply that per-user limits cap project-wide provider spend.
- Ship one feature at a time: complete its focused tests, full relevant checks, documentation, and acceptance criteria before starting the next feature.

## Feature Order

### Task 0: Verify the chatbot staging baseline

**Purpose:** Confirm the existing chatbot before building on top of it.

- [ ] Test as a guest: general learning questions and published catalog questions work; no personal context is returned.
- [ ] Test as a student: progress answers reflect only that student's recorded data.
- [ ] Test as an enrolled student: selected-course questions return citations from currently published PDFs.
- [ ] Test as an unenrolled student, instructor, and admin: course-material access is denied; no source or provider work occurs.
- [ ] Check provider-unavailable and rate-limit behavior; confirm safe messages and no credentials/provider diagnostics in responses or logs.
- [ ] Update `frontend/roadmap.md` only after these checks pass.

**Exit criteria:** The remaining live-staging checkbox is supported by observed results. This is a gate, not a prerequisite for local implementation of Task 1.

### Task 1: Personalized weekly study plan

**Goal:** Give a student a manageable, editable seven-day plan based on their available study hours, active courses, recorded progress, next lessons, and upcoming published assessment deadlines.

**Initial behavior:**

- Build a deterministic schedule from backend facts; use AI only for a short explanation, not to choose course facts, deadlines, or schedule arithmetic.
- Show dates, estimated minutes, course, and a safe task label for each suggested session. Highlight deadline proximity without promising completion.
- Let the student review, reorder, edit, or remove suggested sessions before explicitly saving. A saved plan is private to its owner and can be replaced or deleted.
- If profile availability or course data is missing, explain what is missing and offer a useful empty state rather than inventing a schedule.
- Define the initial schedule window as the next seven calendar days using the browser's local timezone for display; send validated dates/timezone to the backend and store timestamps consistently. Confirm the timezone contract in tests.

**Likely surfaces:**

- Backend: a study-plan service, owner-scoped plan schema if persistence is approved by tests, controller/route, safe DTO, and focused service/route tests.
- Frontend: a student-facing plan panel, API model/hook, loading/error/empty states, edit/reorder controls, and focused UI tests.
- Documentation: explain plan inputs, user-controlled saving, and advisory-only behavior.

**Acceptance:** Session estimates fit the student's stated weekly availability; only the student's active published courses and published assessments appear; invalid/expired course facts are omitted; plans never mutate LMS progress or official assessment records; owner isolation is tested.

**Implementation status:** Local backend and frontend implementation, focused automated coverage, and documentation are complete. Live staging acceptance remains pending and is tracked separately in `frontend/roadmap.md`.

### Task 2: PDF-grounded practice questions

**Goal:** Let an enrolled student practice course concepts using published PDF materials, with every question and answer grounded in retrieved excerpts.

**Implementation:**

- Reuse the course tutor's existing authorization-first retrieval and source validation. Do not add a path that reads arbitrary PDFs or bypasses enrollment/material publication checks.
- Add a separate provider operation with a strict bounded schema for questions, answer choices, correct answer, brief explanation, and source citations.
- Validate every citation against retrieved material/page ranges and reject malformed, unsupported, or oversized outputs.
- Present one optional practice set at a time. Initially keep attempts transient and ungraded; do not write official quiz attempts, certificate metrics, or learning progress.
- Apply a distinct explicit request/token budget and safe no-source/provider-unavailable behavior.

**Acceptance:** Cross-course, unenrolled, unpublished, and unavailable-source requests cannot generate questions; each factual item has valid citations; provider output cannot become an official assessment; no-source and provider-failure UX is clear.

**Implementation status:** Local backend and frontend implementation, focused automated coverage, and documentation are complete. Live staging acceptance remains pending and is tracked separately in `frontend/roadmap.md`.

### Task 3: Progress recap and early support

**Goal:** Provide a concise recap of completed lessons, next steps, and upcoming published work, and offer supportive actions when progress has stalled.

**Implementation:**

- Reuse authenticated student context and existing progress/assessment facts; derive any “stalled” signal from a documented, transparent threshold.
- Prefer deterministic recap facts. If Gemini writes a summary, constrain it to those facts and render numeric facts from backend DTOs.
- Avoid diagnosis, shaming, guaranteed outcomes, or claims that a learner is at risk. Let the student open the relevant course or assessment.
- Keep recap history transient unless the student explicitly saves it.

**Acceptance:** Recap values match persisted records; another student's data cannot influence it; empty/old course states are handled; suggested actions link only to existing LMS flows.

**Implementation status:** Local backend and frontend implementation, focused automated coverage, and documentation are complete. An incomplete course receives a neutral “paused” nudge after 14 days without recorded lesson activity; no-history and completed courses are handled separately. Live staging acceptance remains pending in `frontend/roadmap.md`.

### Task 4: Course-page contextual tutor

**Goal:** Make course questions easier to ask from course and lesson pages.

**Implementation:**

- Add a safe chatbot handoff containing only the current course ID and optional lecture ID, then preselect the course in the global panel.
- Keep progress/general chat available when the course is not actively enrolled; only enable the PDF tutor path when the authenticated student's authorized active-course list includes it.
- Keep the backend tutor authorization unchanged and re-check course/material availability on every request.

**Acceptance:** Direct links, stale selections, unpublished courses, revoked enrollments, and route changes cannot bypass backend checks; existing panel history does not leak between accounts.

**Implementation status:** Course and lesson pages hand off only their current IDs to the site-wide chatbot. The panel preselects a course only when the signed-in student's active-course guidance includes it; guests and unverified/non-active scopes retain general chat. Lesson scope is forwarded through the existing chatbot endpoint and validated by the existing PDF tutor authorization path. Course-scoped requests do not forward general-chat history. Focused UI and backend tests cover authorized lesson scope, inactive/malformed handoffs, and account history isolation. Live staging verification remains separate.

### Task 5: Learning pathways

**Goal:** Recommend a transparent sequence of published courses toward a student's career goal or selected skill.

**Implementation:**

- Extend deterministic recommendation logic to create ordered pathways using published course metadata, prerequisite references, completed courses, and explicitly self-reported skills.
- Treat unknown prerequisites as unknown, not completed. Never treat interests alone as evidence of skill or prerequisite completion.
- Display why each course appears, prerequisites, free/paid status, and a normal course link. Do not auto-enroll or purchase.
- Use AI only to explain a backend-generated pathway; never let the model create course IDs, order, scores, or prerequisites.

**Acceptance:** Every path item is a currently published eligible course; cycles, missing prerequisites, and empty catalogs produce safe results; ordering and match reasons are testable.

**Implementation status:** The existing deterministic recommendation service now returns a prerequisite-ordered pathway, bounded match reasons, and explicit course/skill prerequisite states. Only fully completed published prerequisite courses and explicitly self-reported skills count as met; interests remain match signals only. Missing or unpublished course references are shown as unknown without revealing their IDs, and cycle members plus dependent courses are omitted. The Learning Compass displays step order, match reasons, prerequisite status, free/paid price, and ordinary catalog links; no enrollment or purchase action is added. Focused backend and frontend tests cover ordering, completion evidence, unknown prerequisites, cycles, and display behavior. Live staging verification remains separate.

### Task 6: Instructor content drafts

**Goal:** Help instructors draft course outlines, practice prompts, and assignment rubric suggestions from their own authorized course metadata and published materials.

**Implementation:**

- Add instructor-only endpoints using existing course-manager authorization and material visibility rules.
- Use only the selected instructor-managed course's published material excerpts and bounded course metadata; do not include student records or submissions.
- Return drafts in a strict schema, cite material-derived claims, and provide explicit edit/review controls.
- Never write or publish generated content automatically. Saving uses existing instructor APIs and remains a separate explicit action.

**Acceptance:** Instructors cannot access another instructor's course; admins/students/guests are denied; generated drafts are not persisted until explicit save; publication remains the existing instructor action.

**Implementation status:** Added a dedicated instructor-only API and workspace page for editable course outlines, practice prompts, and assignment-rubric suggestions. Generation uses only bounded metadata for the owned course and up to five excerpts from its published PDF materials; citations are validated against supplied material/page ranges, source changes invalidate a draft, and provider requests have a per-instructor UTC-day budget, output-token cap, and timeout. Drafts remain transient, with copy/edit controls and no automatic save or publish path. Focused backend and frontend tests cover authorization, course/source isolation, malformed citations, daily limits, transient edits, and no-save behavior. Live staging verification remains separate.

### Task 7: Language and accessibility options

**Goal:** Make assistant explanations easier to understand and available in selected languages without weakening source grounding.

**Implementation:**

- Offer plain-language explanations and a small set of explicitly supported response languages.
- Preserve course names, assessment names, citations, IDs, and numeric facts; do not translate or rewrite citations.
- Keep the original answer available and identify translated/explanatory text as a rendering, not a new source.
- Add keyboard, screen-reader, focus, contrast, and responsive-layout checks for assistant panels and practice flows.

**Acceptance:** Language/style options do not alter backend authorization or source scope; citations remain intact; unsupported languages fall back clearly; accessibility checks cover the new interactions.

**Scope decision:** The user selected English only. This release adds an optional plain-English style to the chatbot, course tutor, and practice-question generation; it does not offer translations. The standard English style remains the default. Course names, assessment names, citations, identifiers, numeric facts, and authorized source scope remain unchanged. If other languages are added later, they must be labeled as renderings and retain the original English response.

**Implementation status:** Complete locally. The API validates the optional boolean style flag and forwards it only when enabled; provider prompts preserve the existing citation/schema contracts. Accessible controls are available for the chatbot, course tutor, and practice generator. Chatbot conversation updates use a labeled polite log, and checked practice answers are announced as status updates. Focused backend and frontend tests pass; live staging verification remains separate.

## Cross-Feature Execution and Validation

For each task:

1. Inspect current APIs, models, authorization helpers, UI patterns, and prior tests before editing; preserve unrelated local changes.
2. Write focused failing backend/frontend tests for behavior, authorization, safe DTO shapes, invalid input, and failure paths.
3. Implement the smallest complete change using existing services and components. Add a new model only when durable state is necessary.
4. Run focused tests, then the complete backend suite and frontend suite/build when the change crosses those boundaries.
5. Update the relevant README and `frontend/roadmap.md`; record live staging separately from automated completion.
6. Review `git diff --check` and inspect the final diff. Do not commit unless requested.

**Required regression coverage:** guests versus roles; owner isolation; active/revoked enrollment; published/unpublished course/material; prompt injection in user/content text; provider timeout, quota, malformed output, and unsafe citations; rate limits and budgets; account switching/history clearing; and no mutation of official LMS records.

**Rollout rule:** Feature code and automated test completion do not equal live acceptance. Keep each staging checkbox open until the corresponding deployed test has been performed with separate guest, student, instructor, and unauthorized accounts as applicable.
