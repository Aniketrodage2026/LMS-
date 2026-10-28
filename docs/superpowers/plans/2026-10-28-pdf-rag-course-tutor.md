# PDF RAG Course Tutor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let instructors publish private PDF study materials at course or lecture scope and let actively enrolled students ask cited, source-grounded questions about those materials.

**Architecture:** Original PDFs remain in private Cloudflare R2. The backend extracts embedded text, writes bounded page-aware chunks and 768-dimensional Gemini Embedding 2 vectors to MongoDB, and retrieves only caller-authorized chunks using Atlas Vector Search. The current Gemini adapter gains a separate RAG provider path, durable RAG budget, strict citation validation, and safe no-source/fallback behavior; the frontend consumes safe DTOs only.

**Tech Stack:** Express 5, Mongoose/MongoDB Atlas Vector Search, Cloudflare R2 via AWS S3 SDK, Multer, a Node PDF text extractor, Node built-in fetch/crypto, Gemini Embedding 2 and content generation, React, TanStack Query/Router, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-pdf-rag-course-tutor-design.md`

## Global Constraints

- Accept only embedded-text PDFs; reject non-PDF, renamed-file, encrypted, scanned/no-readable-text, over 10 MB, or over 100-page input.
- Materials may belong to a course or one course lecture; only `PUBLISHED` + `READY` material is student searchable.
- Use private R2 only. Never expose public objects, frontend R2 variables, R2 keys/object keys, source text, vectors, or signed URLs in Gemini payloads/logs/general DTOs.
- Every student material/download/tutor operation requires login, `STUDENT` role, a published course, and the caller's `ACTIVE` enrollment before any source/vector/Gemini work.
- Instructor material operations require existing course-manager authorization. Reject lecture deletion while material is attached.
- Use `gemini-embedding-2`, exactly 768 dimensions, and record model/dimension per chunk. A model/dimension change requires explicit re-indexing.
- Provider input is only the bounded student question and bounded authorized excerpts. Never send identity, email, JWT/cookies, payment data, raw submissions, R2 data, full PDFs, or another student's data.
- A citation can only reference a retrieved chunk. It proves source provenance, not every generated sentence's factual entailment.
- Missing source/index, provider failure, malformed output, quota exhaustion, or unsafe citation returns safe no-answer/fallback copy without provider details.
- Use a separate durable per-student UTC-day RAG budget and minimized immutable RAG usage records. No auto-purchase/enrollment/grading/publishing/learning-record mutation.
- Preserve all existing Phase 1 metadata assistant behavior.

## Review Focus

- Unenrolled/revoked/cross-course students and instructors must be denied before PDF, vector, or Gemini work; Task 4 tests this.
- Fake-MIME/renamed/signature-invalid/encrypted/no-text/oversized/over-page PDFs must leave no orphaned source/chunks; Task 2 tests this.
- Unpublish/delete/retry and attached-lecture deletion must immediately remove retrieval eligibility; Task 3 tests this.
- A vector result from the wrong course/lecture or an unknown/model-invented citation must never reach a student; Task 4 tests this.
- Missing vector index, embedding/generation failure, or RAG budget exhaustion must show safe fallback/no-source behavior; Task 4 tests this.

---

## File Structure

- Create `backend/models/course-material.schema.js`, `backend/models/course-material-chunk.schema.js`, `backend/models/rag-usage-budget.schema.js`, and `backend/models/rag-usage-log.schema.js`.
- Create `backend/services/pdf-material.service.js`, `backend/services/rag-embedding.service.js`, `backend/services/course-material.service.js`, and `backend/services/course-tutor.service.js`.
- Create `backend/controller/course-material.controller.js`, `backend/controller/student-material.controller.js`, and `backend/routes/course-material.route.js`.
- Modify the existing multer/media/course/AI route/controller/application/config/README files listed in the approved design.
- Create model, ingestion, route, and tutor backend tests.
- Modify frontend API models/hooks/error mapping and instructor/assistant components; create material UI tests.

### Task 1: Add Material, Chunk, and RAG Budget Models

**Files:**
- Create: `backend/models/course-material.schema.js`
- Create: `backend/models/course-material-chunk.schema.js`
- Create: `backend/models/rag-usage-budget.schema.js`
- Create: `backend/models/rag-usage-log.schema.js`
- Test: `backend/tests/course-material-model.test.js`

**Interfaces:**
- Produces `CourseMaterial`, `CourseMaterialChunk`, `RagUsageBudget`, and `RagUsageLog`.
- Chunks reference one material/course and use `embeddingModel: 'gemini-embedding-2'` with `embeddingDimension: 768`.

- [ ] **Step 1: Write failing schema tests**

Test course/lecture relationships, title/filename bounds, allowed lifecycle states, private storage requirements, PDF-only content type, safe status transitions, chunk ordinal/page/vector model/dimension validation, material-ordinal uniqueness, UTC budget uniqueness, and immutable/redacted logs.

- [ ] **Step 2: Run test to verify it fails**

Run from `backend`: `node --require ./tests/test-env.js --test tests/course-material-model.test.js`.

Expected: FAIL because the material/RAG models do not exist.

- [ ] **Step 3: Implement models and indexes**

Use existing Mongoose guard patterns. Source materials use `DRAFT`, `PROCESSING`, `READY`, `PUBLISHED`, and `FAILED`; arbitrary query status updates must not bypass transitions. Enforce exactly 768 finite vector values and never store provider response bodies.

- [ ] **Step 4: Run focused test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

`git add backend/models backend/tests/course-material-model.test.js`

`git commit -m "feat: add course material RAG models"`

### Task 2: Build Safe PDF Ingestion and Embedding Services

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json`
- Modify: `backend/services/media-validation.service.js`, `backend/middleware/multer.middleware.js`, `backend/services/media-storage.service.js`
- Create: `backend/services/pdf-material.service.js`, `backend/services/rag-embedding.service.js`
- Test: `backend/tests/pdf-material.service.test.js`

**Interfaces:**
- Produces `upload.material.single('file')` and `ingestMaterial({ materialId, courseId, localPath, originalName, storage, embedder })`.
- Produces `createRagEmbedder(config, fetchImpl)` with `embedDocument({ title, text })` and `embedQuery(question)`, both returning exactly 768 finite values.

- [ ] **Step 1: Write failing ingestion/embedding tests**

Cover PDF name/MIME/signature agreement, 10 MB cap, 100-page cap, encrypted/no-text rejection, SHA-256, deterministic page-aware chunks/overlap, temporary-file cleanup, partial R2/chunk cleanup, embedding request redaction, exact model/dimension, timeout/HTTP/malformed-vector failure, and no request for invalid input.

- [ ] **Step 2: Run test to verify it fails**

Run from `backend`: `node --require ./tests/test-env.js --test tests/pdf-material.service.test.js`.

Expected: FAIL because the material category, parser, and embedder do not exist.

- [ ] **Step 3: Add dependency, validation, and ingestion**

Add a server-compatible page-aware PDF text extractor. Configure a dedicated PDF-only Multer category and `materials` object-key category. Validate magic bytes before parsing. Parse/hash before durable source state, upload to private R2, chunk deterministically, embed document chunks, verify vectors, persist chunks, and mark source `READY`. Retain an uploaded source for instructor retry after processing failure; delete partial chunks and temp files on every failure.

- [ ] **Step 4: Run focused test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

`git add backend/package.json backend/package-lock.json backend/middleware backend/services backend/tests/pdf-material.service.test.js`

`git commit -m "feat: add private PDF material ingestion"`

### Task 3: Expose Instructor Material Lifecycle and Protect Course Changes

**Files:**
- Create: `backend/services/course-material.service.js`, `backend/controller/course-material.controller.js`, `backend/routes/course-material.route.js`
- Modify: `backend/routes/instructor-course.route.js`, `backend/controller/course.controller.js`, `backend/app.js`
- Test: `backend/tests/course-material-routes.test.js`

**Interfaces:**
- Produces manager endpoints under `/api/v1/instructor/courses/:courseId/materials`.
- Produces `instructorMaterialDto(material)` and `requireManagedMaterial({ user, course, materialId })`.

- [ ] **Step 1: Write failing lifecycle/guard tests**

Test guest/non-manager denial; course-manager/admin behavior; lecture ownership before upload; DRAFT → PROCESSING → READY → PUBLISHED/unpublished transitions; retry only for retained failed source; deletion cleanup/no R2 data DTO; audit event safety; and lecture deletion rejection when material is attached.

- [ ] **Step 2: Run test to verify it fails**

Run from `backend`: `node --require ./tests/test-env.js --test tests/course-material-routes.test.js`.

Expected: FAIL because no router/controller exists.

- [ ] **Step 3: Implement manager-only CRUD**

Mount behind the existing instructor course manager guard. Derive authority from `req.user`, not request body. Publishing only accepts `READY`; unpublishing returns `PUBLISHED` to `READY`; retry reuses the retained source; deletion prevents new reads before cleanup. Add existing-style minimized audit events.

- [ ] **Step 4: Add lecture/course lifecycle guards**

Reject lecture deletion while any material references it. Extend course deletion with post-database-delete material cleanup using the same safe cleanup discipline as existing course media.

- [ ] **Step 5: Run focused test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Commit checkpoint**

`git add backend/controller backend/routes backend/services backend/app.js backend/tests/course-material-routes.test.js`

`git commit -m "feat: add instructor course materials"`

### Task 4: Add Authorized Student Materials and Course Tutor Retrieval

**Files:**
- Create: `backend/services/course-tutor.service.js`, `backend/controller/student-material.controller.js`
- Modify: `backend/services/ai/providers/gemini.provider.js`, `backend/controller/ai.controller.js`, `backend/routes/ai.route.js`, `backend/routes/course.route.js`
- Create: `backend/tests/course-tutor.service.test.js`
- Modify: `backend/tests/ai-routes.test.js`

**Interfaces:**
- Produces `answerCourseQuestion({ studentId, courseId, lectureId, question })` returning `{ answer, citations, outcome }`, where outcome is `ANSWERED`, `NO_RELEVANT_SOURCE`, `RAG_UNAVAILABLE`, or `RAG_LIMIT_REACHED`.
- Produces student material list/download endpoints and `POST /api/v1/ai/course-tutor`.

- [ ] **Step 1: Write failing tutor/access tests**

Test guest/instructor/unenrolled/revoked/cross-course denial before vector/provider work; published/ready-only materials; course versus lecture scope; missing vector index; relevance no-source; atomic daily RAG budget; malformed/invented citations; timeout/quota; no provider payload of R2 data/identity/raw PDF/vector/other student context; and authorized signed download only.

- [ ] **Step 2: Run focused tests to verify they fail**

Run from `backend`: `node --require ./tests/test-env.js --test tests/course-tutor.service.test.js tests/ai-routes.test.js`.

Expected: FAIL because retrieval/routes do not exist.

- [ ] **Step 3: Implement authorization-first material access and retrieval**

Student material listing/download requires published course plus active enrollment. Download validates first and returns a short-lived signed response without retaining/logging/provider-sharing its URL. Validate IDs/question before embedding. Run `$vectorSearch` first with the configured index/dimension and authorized course/lecture/material filters, apply threshold/caps, reserve the dedicated RAG budget, then generate from numbered bounded excerpts only.

- [ ] **Step 4: Implement strict grounded response validation**

Accept strict JSON only when every citation maps to supplied chunk/page. All unsafe/provider/index/budget states return safe no-answer/fallback copy with minimized logs. Existing metadata assistant reply-key behavior remains untouched.

- [ ] **Step 5: Run focused tests to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Run full backend suite**

Run: `npm --prefix backend test`.

Expected: all existing LMS/AI tests pass.

- [ ] **Step 7: Commit checkpoint**

`git add backend/controller backend/routes backend/services backend/models backend/tests`

`git commit -m "feat: add grounded course tutor"`

### Task 5: Build Instructor Materials and Student Tutor UI

**Files:**
- Modify: `frontend/src/lib/api/models.ts`, `frontend/src/lib/api/hooks.ts`, `frontend/src/lib/errors/present.ts`
- Modify: `frontend/src/components/skillforge/instructor-pages.tsx`, `frontend/src/components/skillforge/ai-assistant.tsx`
- Create: `frontend/src/components/skillforge/course-materials.test.tsx`
- Modify: `frontend/src/components/skillforge/ai-assistant.test.tsx`

**Interfaces:**
- Consumes safe material/tutor DTOs through the existing credentialed `api()` wrapper.
- Produces an instructor Materials section and student cited tutor panel.

- [ ] **Step 1: Write failing UI tests**

Test PDF-only affordance, course/lecture selector, upload status, publish/unpublish/delete/retry, actionable errors, course/lecture tutor scope, loading/no-source/fallback state, safe citation cards/authorized download, no raw signed URL, and no purchase/enrollment action.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix frontend test -- src/components/skillforge/course-materials.test.tsx src/components/skillforge/ai-assistant.test.tsx`.

Expected: FAIL because UI/types are absent.

- [ ] **Step 3: Add safe API models/hooks/error copy**

Expose only public material states, citation fields, and stable RAG error codes. Do not expose Gemini, embedding, R2, vector, or signed URL config to the browser.

- [ ] **Step 4: Implement instructor Materials workspace**

Reuse existing course picker/forms/error components. Upload multipart PDF only, lecture association optional, and lifecycle actions only for the manager.

- [ ] **Step 5: Implement cited student tutor interaction**

Add a clearly separate “Ask course materials” flow in Learning compass. It requires an active course, optionally limits to a lecture, renders server answer/citations as text, and uses only authorized LMS download actions. Preserve existing metadata chat and course guidance.

- [ ] **Step 6: Run focused/full/build verification**

Run `npm --prefix frontend test -- src/components/skillforge/course-materials.test.tsx src/components/skillforge/ai-assistant.test.tsx`, then `npm --prefix frontend test`, then `npm --prefix frontend run build`.

Expected: all pass and build exits 0.

- [ ] **Step 7: Commit checkpoint**

`git add frontend/src`

`git commit -m "feat: add cited PDF course tutor UI"`

### Task 6: Configure Atlas Vector Search, Document Operations, and Verify

**Files:**
- Modify: `backend/.env.example`, `backend/README.md`, `frontend/README.md`
- Create: `backend/scripts/verify-rag-vector-index.js`
- Test: existing RAG backend tests and frontend material/tutor tests

**Interfaces:**
- Documents backend-only RAG variables, Atlas vector-index JSON, private-R2 prerequisites, rights notice, fallback, and rollback.
- Produces a safe readiness script that never prints secrets/source text/vectors/object keys.

- [ ] **Step 1: Write failing readiness tests or controlled module probes**

Cover required variables/index name, missing/wrong dimension safe result, and diagnostic output redaction.

- [ ] **Step 2: Run readiness check to verify it fails safely**

Run from `backend`: `node scripts/verify-rag-vector-index.js --check`.

Expected: safe non-zero/readiness-false result until configuration/index exists.

- [ ] **Step 3: Implement operations documentation/readiness check**

Document backend-only names/defaults: `GEMINI_EMBEDDING_MODEL=gemini-embedding-2`, `RAG_EMBEDDING_DIMENSION=768`, `RAG_MAX_PDF_BYTES=10485760`, `RAG_MAX_PDF_PAGES=100`, `RAG_DAILY_REQUEST_LIMIT=10`, `RAG_REQUEST_TIMEOUT_MS=20000`, and `ATLAS_VECTOR_INDEX=course_material_chunks_vector`. Include exact Atlas index fields/filters, rights notice, no-OCR limitation, re-index rule, fallback/rollback, and private R2 requirements.

- [ ] **Step 4: Run complete automation**

Run `npm --prefix backend test`, `npm --prefix frontend test`, `npm --prefix frontend run build`, and `git diff --check`.

Expected: all pass.

- [ ] **Step 5: Perform manual staging acceptance**

Using synthetic data and private R2/Atlas: upload/publish course and lecture PDFs; ask relevant/irrelevant/lecture-scoped questions; verify citations; test all role/access denials, invalid key, budget exhaustion, unpublish/delete/retry, and no direct public object access. Record safe outcomes only.

- [ ] **Step 6: Commit checkpoint**

`git add backend/.env.example backend/README.md frontend/README.md backend/scripts backend/tests`

`git commit -m "docs: document PDF RAG tutor operations"`

## Self-Review

- **Spec coverage:** Tasks 1–2 provide models and safe ingestion; Task 3 lifecycle/ownership; Task 4 authorization/retrieval/citation/budget fallback; Task 5 UI; Task 6 Atlas/R2/Gemini operations and manual proof.
- **Step scan:** Every task has a failing-test step, a precise implementation boundary, focused verification, and commit checkpoint.
- **Type consistency:** Task 1 models feed Task 2 ingestion, Task 3 lifecycle, Task 4 retrieval, and Task 5 DTOs. `answerCourseQuestion` is the single tutor entry point.
- **Review focus:** Each high-risk input/failure condition is assigned to Tasks 2–4 tests.
- **Proportion:** Six tasks cover the selected PDF-only milestone without adding OCR, video transcripts, DOCX/slides, live classes, or persistent chat history.

