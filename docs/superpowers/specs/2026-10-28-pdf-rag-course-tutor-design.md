# PDF RAG Course Tutor — Design

## Intent

Extend the existing student-only Learning compass into a trustworthy course tutor. Instructors can upload a PDF to either the whole course or a particular lecture. An actively enrolled student can ask a question scoped to that course or lecture and receive an answer grounded only in retrieved text from published materials, with citations that identify the file and page range. When retrieval is insufficient, the tutor must say so rather than infer an answer.

## Goals

- Support private instructor PDF upload at both course and lecture scope.
- Preserve the private R2 media model; documents are never made public or delivered directly to Gemini as R2 URLs.
- Extract embedded PDF text, split it into bounded page-aware chunks, create server-side Gemini embeddings, and retrieve with MongoDB Atlas Vector Search.
- Allow only active students enrolled in a published course to retrieve/ask from that course's published materials.
- Provide cited, source-grounded answers and an explicit no-answer state.
- Keep all Gemini credentials and provider calls in the backend.
- Preserve current Phase 1 profile, recommendation, progress, assessment, and certificate behavior.

## Non-goals for this milestone

- Video transcription, OCR/scanned-PDF reading, DOCX/slide/note-file upload, live classes, instructor AI grading, or automated assessment authoring.
- A general web-search assistant, cross-course retrieval, auto-purchase, auto-enrollment, or mutation of learning records by AI output.
- Persistent free-form chat history, background worker infrastructure, or migration of existing media.

## Chosen approach and alternatives

The selected approach is **semantic RAG using Gemini text embeddings and MongoDB Atlas Vector Search**. It combines the existing private Cloudflare R2 storage with MongoDB material/chunk records. Gemini receives only a student's question plus the few server-authorized retrieved chunks; it never receives database credentials, R2 object keys/URLs, payment data, or other students' facts.

Considered alternatives:

1. Keyword-only Mongo text search: lowest setup cost but poor semantic recall when a student's wording differs from the PDF.
2. External vector database: capable but introduces an additional account, bill, operational surface, and access boundary.
3. Gemini File Search: managed retrieval but weakens the LMS's control over per-course authorization, source lifecycle, and migration boundaries.

MongoDB Vector Search is selected because Atlas already stores LMS data, supports pre-filtering by course/material scope, and keeps retrieval authorization in the backend. Gemini's current `gemini-embedding-2` supports text embeddings and configurable dimensions; this design fixes output dimension to **768** and records model/dimension per chunk, so a future model change requires explicit re-indexing. Google documents 768 as a recommended reduced dimension; MongoDB Vector Search supports vector fields and metadata pre-filters. [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings), [MongoDB Vector Search overview](https://www.mongodb.com/docs/vector-search/)

## User experience

### Instructor

In an existing instructor course workspace, add a **Materials** section:

- Choose `Course material` or select one lecture from that course.
- Enter a title and upload one PDF.
- New material starts as `DRAFT`; instructor sees `PROCESSING`, `READY`, `PUBLISHED`, or a safe failure message.
- Instructor explicitly publishes/unpublishes a `READY` item, replaces it by uploading a new item, and may delete it. `PUBLISHED` is the only student-searchable state; unpublishing returns it to `READY` without re-embedding.
- Changing/deleting/unpublishing material removes its chunks from retrieval immediately. Any browser URL previously issued can remain usable only until its deliberately short signed-URL TTL expires; no new URL is issued after revocation.

### Student

The Learning compass gains a **Ask course materials** mode after the student chooses one of their active courses. A lecture selector narrows the question to that lecture's materials, while Course scope searches both course-wide materials and the selected course's published lecture materials.

The answer displays:

- backend-rendered answer text;
- up to three citations (`material title`, optional lecture title, page number/range);
- an internal LMS material-link action only when the caller is authorized;
- a clear “I could not find this in the available course materials” response when no chunk clears the relevance threshold.

Student questions, material title, page references, and cited excerpts are visible only for the caller's active enrollment/course. No R2 object URL, raw object key, full PDF, or internal embedding appears in student API output.

## Data model

### CourseMaterial

```
course: ObjectId (required, indexed)
lecture: ObjectId | null (null = course-wide; otherwise must belong to course)
title: string (1–120, normalized)
originalFilename: string (safe display only)
storage: provider-neutral media descriptor (R2 required when R2 is enabled)
contentType: application/pdf
size: integer bytes
status: DRAFT | PROCESSING | READY | PUBLISHED | FAILED
contentHash: sha256 string
pageCount: integer
extractedCharacterCount: integer
failureCode: safe allowlisted code | null
uploadedBy: instructor ObjectId
createdAt, updatedAt
```

Indexes: `{ course, lecture, status }`, `{ course, createdAt }`; unique partial index on `{ course, lecture, contentHash }` for non-deleted source duplicates.

### CourseMaterialChunk

```
material: ObjectId (required, indexed)
course: ObjectId (required, indexed/vector-filtered)
lecture: ObjectId | null (vector-filtered)
ordinal: integer
pageStart, pageEnd: positive integers
text: bounded extracted source text
embedding: [number] exactly 768 values
embeddingModel: gemini-embedding-2
embeddingDimension: 768
createdAt
```

Unique index `{ material, ordinal }`. Atlas vector index filters `course`, `lecture`, and `material`, and indexes `embedding` with 768 dimensions and cosine similarity. The server verifies vector length before storage/query.

## Upload and ingestion pipeline

V1 accepts only a real `application/pdf` file with PDF signature validation. It rejects a missing/renamed/non-PDF file, PDFs over **10 MB**, more than **100 pages**, encrypted PDFs, and PDFs with no embedded extractable text. Scanned/image-only PDF OCR is explicitly later work. Limits keep request-time processing bounded in the current Render API deployment.

1. Instructor/course-manager authorization and lecture ownership validation happen before reading/uploading the file.
2. Multer stores a temporary file with a dedicated material-only filter/limit.
3. Backend validates signature, parses text page-by-page, rejects unsafe/no-readable content, computes SHA-256, then uploads the original to private R2 under `materials/<courseId>/<materialId>/source.pdf`.
4. Backend creates/updates a `PROCESSING` material, splits text into deterministic page-aware chunks (target 800–1,200 words; bounded overlap), embeds each document chunk using `gemini-embedding-2` at 768 dimensions, then writes chunks and marks the material `READY`.
5. Failure always deletes the temporary file and partial chunks. Once an original PDF reached private R2, it is retained with a server-safe `FAILED` state so the instructor-only retry can reprocess the same source; only an explicit delete removes it. If the original upload itself fails, no material source record is retained. A retry endpoint is instructor-only and reprocesses the same authorized source.
6. Publishing is a separate explicit action. Only `PUBLISHED` + `READY` material is searchable by students.

At launch, material processing runs synchronously for these deliberately small limits. If uploads routinely approach the limit or API latency becomes unacceptable, the next scale step is a leased database job plus a separate worker; it is not silently introduced here.

## Retrieval and answer flow

1. `POST /api/v1/ai/course-tutor` accepts `courseId`, optional `lectureId`, and a bounded question.
2. Middleware requires `isLoggedIn` and `requireRole('STUDENT')`.
3. Service validates IDs, verifies an `ACTIVE` enrollment and published course, and verifies optional lecture membership before any material or provider lookup.
4. It embeds a normalized question using the same model/dimension, then runs `$vectorSearch` filtered to the authorized course and published/ready material IDs. A selected lecture restricts results to that lecture; course scope permits both course-wide and course lecture materials.
5. Server applies an explicit relevance threshold and returns at most five chunks / a bounded character budget. No sufficient evidence returns `NO_RELEVANT_SOURCE` without a generative answer.
6. Gemini receives the question and bounded numbered excerpts with material/page metadata. Its response must be strict JSON containing answer text and only source IDs/page references from the supplied list. The backend verifies every citation, renders safe final copy, and returns at most three citations. Citation validation proves that references are from retrieved material; it cannot prove every generated sentence is factually entailed, so the UI labels answers as material-grounded and shows the cited source/page provenance.
7. Provider errors, quota limits, malformed responses, unknown citations, or unsafe output result in a safe fallback stating that a grounded answer is unavailable; no provider detail is exposed.

The tutor uses a separate daily RAG request budget, not the Phase 1 metadata-assistant counter, because embedding plus answer requests have different quota/cost behavior. It uses the same durable per-student UTC-day reservation pattern and immutable minimized operational logs.

## Authorization, privacy, and safety

- Material upload/manage/retry/publish/delete: only the instructor who manages that course, or an admin where current course-management rules permit it.
- Material listing for students, material download, retrieval, and tutor chat: only students with `ACTIVE` enrollment in that published course. Preview access never grants PDF/RAG access.
- R2 source download uses a short-lived backend-signed URL only after authorization. The browser may receive that URL as the direct response to an authorized download action, but it is never included in catalog/tutor DTOs, stored in client state, sent to Gemini, or written to logs.
- Do not send user identity/email/JWT/cookie/payment data, raw assignments/submissions, private grades, storage credentials, or another student's material/context to Gemini.
- Extracted course text is sent to Gemini during embedding at ingestion and bounded retrieved excerpts are sent during answer generation. Both are LMS-controlled course content subject to instructor rights confirmation and operator/provider data-use review; embeddings and raw source text are never exposed to students outside authorized delivery/retrieval.
- Instructors are responsible for copyright/rights to uploaded documents; upload UI and README state this.
- Audit material upload, publish/unpublish, delete, retry, and student tutor request category/source count—never full question, full PDF text, embedding, or provider body.

## Backend/API surface

Instructor course-manager endpoints:

```
POST   /api/v1/instructor/courses/:courseId/materials              multipart PDF + title + optional lectureId
GET    /api/v1/instructor/courses/:courseId/materials
PATCH  /api/v1/instructor/courses/:courseId/materials/:materialId  title/status only
POST   /api/v1/instructor/courses/:courseId/materials/:materialId/retry
DELETE /api/v1/instructor/courses/:courseId/materials/:materialId
```

Student endpoints:

```
GET  /api/v1/courses/:courseId/materials
GET  /api/v1/courses/:courseId/materials/:materialId/download
POST /api/v1/ai/course-tutor
```

All responses use safe DTOs. Instructor DTOs include processing state and safe failure code; student DTOs include only published material title, lecture association, page count, and authorized download path.

Deleting a lecture is rejected while any course material—draft, failed, ready, or published—is attached to it. The instructor must first move/delete that material; this avoids orphaned private source objects and stale chunks.

## Environment and deployment requirements

Backend-only variables:

```
GEMINI_API_KEY=
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
RAG_EMBEDDING_DIMENSION=768
RAG_MAX_PDF_BYTES=10485760
RAG_MAX_PDF_PAGES=100
RAG_DAILY_REQUEST_LIMIT=10
RAG_REQUEST_TIMEOUT_MS=20000
ATLAS_VECTOR_INDEX=course_material_chunks_vector
```

Existing private `R2_*` variables remain required. No new frontend secret or `VITE_*` variable is allowed. Before enabling RAG in deployment, create the Atlas Vector Search index and set its exact name; health/readiness should report a safe “RAG unavailable” state when it is missing, never an internal index/credential error.

## Verification

- Model validation, immutability, course/lecture consistency, and chunk bounds.
- Instructor ownership/admin behavior; student guest/instructor/unenrolled/revoked/cross-course denials before R2/Gemini calls.
- Signature/type/size/page/no-text/encrypted PDF rejection; temporary/R2/chunk cleanup on every failure point.
- Correct chunking/page citations, 768-vector validation, course/lecture vector filter, relevance/no-source behavior, and malformed-provider citation rejection.
- No secrets, R2 URLs/object keys, raw PDFs, embeddings, or unauthorized data in provider payloads/logs/responses.
- Dedicated durable RAG budget atomicity across service instances and deterministic safe provider fallback.
- Frontend loading/error/no-source/citation states; no auto-purchase/enrollment; authorized PDF download only.
- Full backend suite, full frontend suite, production build, manual synthetic-data R2/Atlas/Gemini acceptance, then deployment runbook update.

## Success criteria

An instructor can upload and publish a small embedded-text PDF at either course or lecture scope. An actively enrolled student can ask a relevant course question and receives a cited answer based only on their course's published PDF chunks. The same student gets a transparent no-source response for unsupported questions, while a guest, unenrolled student, different-course student, or instructor cannot retrieve content or cause a Gemini request.
