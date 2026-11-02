# LMS server

The API requires Node.js (use a current Node.js LTS release) and a reachable MongoDB instance. Create a local `.env` from `.env.example` before starting it. The `.env` file is local and ignored by Git; never commit secrets.

## Local commands

Run these commands from the `backend` directory:

```bash
npm install
npm test
npm run dev
```

With the API running, check its health endpoint:

```bash
curl http://localhost:5000/health
```

The expected response is:

```json
{ "success": true, "status": "ok" }
```

## Environment

Copy `.env.example` to `.env` and replace its placeholders locally with your own values. Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (the local example uses `5000`). |
| `DB_URL` | MongoDB connection string. MongoDB must be running and reachable before `npm run dev`; paid-payment verification requires a transaction-capable replica set (including a single-node replica set). |
| `JWT_SECRET` | Canonical signing secret required at startup. Use a strong local secret. |
| `JWT_EXPIRY` | JWT expiration period, for example `7d`. |
| `FRONTEND_URL` | Allowed frontend origin for credentialed CORS requests. |
| `TRUST_PROXY` | Keep `false` by default. Set to `true` only when a known reverse proxy or load balancer is trusted and configured correctly. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for media storage. |
| `CLOUDINARY_CLOUD_API_KEY` | Cloudinary API key for media storage. |
| `CLOUDINARY_CLOUD_API_SECRET` | Cloudinary API secret for media storage. |
| `R2_ENABLED` | Enables private Cloudflare R2 storage only when exactly `true`; defaults to `false`, preserving existing Cloudinary flows. |
| `R2_ACCOUNT_ID` | Server-only Cloudflare account ID; required only when `R2_ENABLED=true`. |
| `R2_BUCKET_NAME` | Server-only private R2 bucket name; required only when `R2_ENABLED=true`. |
| `R2_ACCESS_KEY_ID` | Server-only R2 S3 API access key ID; required only when `R2_ENABLED=true`. |
| `R2_SECRET_ACCESS_KEY` | Server-only R2 S3 API secret; required only when `R2_ENABLED=true`. |
| `R2_ENDPOINT` | Optional server-only S3 endpoint override; defaults to `https://&lt;R2_ACCOUNT_ID&gt;.r2.cloudflarestorage.com`. |
| `R2_SIGNED_URL_TTL_SECONDS` | Short-lived signed GET URL lifetime; integer from `60` through `3600`, default `600` when R2 is enabled. |
| `SMTP_EMAIL` | SMTP sender/account email for application email. |
| `SMTP_PASSWORD` | SMTP password or provider app password. |
| `RAZORPAY_KEY_ID` | Razorpay **Test Mode** key ID for local development only. |
| `RAZORPAY_KEY_SECRET` | Razorpay **Test Mode** key secret for local development only. |
| `RAZORPAY_PLAN_ID` | Razorpay plan ID used by the legacy subscription endpoints. |

`DB_URL`, `JWT_SECRET`, `JWT_EXPIRY`, and `FRONTEND_URL` are validated during server startup. The Cloudinary, SMTP, and Razorpay values are supplied locally when using their corresponding integrations. Keep Razorpay Test Mode credentials only in your uncommitted local `.env`; no real credentials belong in this repository.

### Private Cloudflare R2 setup

R2 is opt-in and disabled by default. Set `R2_ENABLED=true` only after configuring a private bucket and a bucket-scoped Object Read & Write API token. Keep all `R2_*` settings in the backend's uncommitted local `.env`; they must never be included in frontend configuration, API responses, source code, logs, or committed environment files. An `.env.example` may list placeholder variable names, but it must never contain real values or secrets. When enabled, the backend requires the account ID, bucket name, access key ID, and secret access key. It derives the Cloudflare R2 endpoint from the account ID unless a server-only `R2_ENDPOINT` override is supplied.

### Production R2 rollout runbook

Use this sequence for a production rollout. It is an operational checklist, not a substitute for the automated tests below. Do not expose the R2 bucket publicly and do not put an R2 key, secret, endpoint, bucket name, signed URL, or object key in browser configuration or source code.

1. In Cloudflare, create or select a **private** R2 bucket. Do not enable a public bucket/custom-domain delivery path for LMS media.
2. Create an R2 S3 API token scoped to that bucket with only **Object Read & Write** permission. Store its access key ID and secret only in the deployment secret manager and the backend environment.
3. Set the backend-only `R2_*` deployment variables: `R2_ENABLED`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and, if needed, `R2_ENDPOINT` and `R2_SIGNED_URL_TTL_SECONDS`. Never prefix these with `VITE_`. An `.env.example` may contain placeholder names only; never commit real values or secrets to it or any repository file.
4. Confirm production `FRONTEND_URL` exactly matches the HTTPS browser origin, `VITE_API_BASE_URL` points to the backend origin without `/api/v1`, and CORS allows that one frontend origin with credentials. The frontend needs no R2 credentials because it uses backend API responses and signed URLs only. CORS alone does not guarantee cookies will work across sites: prefer same-site HTTPS subdomains such as `app.example.com` and `api.example.com`, and test real login/session persistence in a production-like browser before rollout because third-party-cookie policies can block a cross-site cookie.
5. Deploy with `R2_ENABLED=false` first if existing Cloudinary media must remain the active path. Enable R2 only after the private bucket, secret configuration, health checks, and rollback owner are ready. Existing records without `storage` metadata continue to use Cloudinary.
6. In a non-production environment with the same private-bucket policy, test uploads for an avatar, course thumbnail, preview lecture, paid lecture, and assignment submission. Confirm rejected type/size/signature cases show safe application errors and leave no orphaned object.
7. Verify access controls before enabling production traffic: an unsigned/direct R2 object URL must fail; a preview lecture must play while logged out; a paid lecture must play only for an enrolled or purchasing student; and an assignment file must download only for its owner, the course instructor/manager, or an admin. Confirm an unrelated student is denied before a signed URL is issued.
8. Keep Cloudinary configured during the migration window. Run the R2 migration dry run, review every summary and failure, then schedule the real run only after approval. The migration never deletes Cloudinary originals; this retained source is the rollback window. The current migration excludes/skips legacy Cloudinary `AUTHENTICATED` paid, non-preview video records because it cannot fetch their authenticated source URLs. They need a separately approved authenticated-source migration path. Do not retire Cloudinary while any such legacy records remain. If R2 rollout verification fails, set `R2_ENABLED=false` and use the still-present Cloudinary media while investigating.

Use a MongoDB Atlas URI backed by a least-privilege, read-only database user for the migration dry run. Use the normal controlled migration credential only for the approved real migration, and rotate or revoke temporary access after the operation if it is no longer required.

### Cloudinary-to-R2 media migration

The migration tool copies eligible legacy Cloudinary avatars, course thumbnails, course lectures, and assignment files into private R2 storage. It does **not** delete or alter the original Cloudinary object, so the original record remains available as a rollback source. Each MongoDB change is conditional: if a record changes while the copy is in progress, the new R2 object is removed and that record is skipped. The current tool intentionally excludes/skips Cloudinary `AUTHENTICATED` paid, non-preview video records: it cannot fetch those authenticated source URLs. Migrate those records only through a separately designed, reviewed, and approved authenticated-source path.

Before a real migration, run the dry run from the `backend` directory:

```bash
node scripts/migrate-cloudinary-media-to-r2.js --dry-run
```

The dry run may read MongoDB Atlas and reports eligible/skipped records, but the CLI does not modify MongoDB, download or alter Cloudinary objects, upload or inspect R2 objects, or delete anything. For defense in depth, use a MongoDB database user/URI with read-only permissions when running the dry run. Review the output first. It needs only `DB_URL` and `CLOUDINARY_CLOUD_NAME`; it does not require the normal API environment variables or R2 settings.

For the real migration, first set `R2_ENABLED=true` and configure all required server-only `R2_*` environment variables. Then run:

```bash
node scripts/migrate-cloudinary-media-to-r2.js
```

The real command additionally requires `R2_ENABLED=true`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` (with optional `R2_ENDPOINT` and `R2_SIGNED_URL_TTL_SECONDS`). The command accepts no other options. It exits nonzero if any individual file fails after continuing with later records. Its logs contain only record type, record ID, and outcome; they never contain media URLs, R2 keys, or credentials.

Run the real migration only after the production verification order above is complete and the dry-run report is approved. Do not remove Cloudinary credentials or objects immediately afterwards: retain them for the agreed rollback window, monitor uploads and signed delivery, then retire legacy media through a separately approved cleanup process. As a pre- and post-rollout audit gate, identify any remaining legacy `AUTHENTICATED` paid, non-preview videos; do not retire Cloudinary until each is either retained intentionally or migrated through the separately approved authenticated-source process.

### Premium video delivery setup and migration

For authenticated Cloudinary delivery of paid, non-preview videos, set `CLOUDINARY_AUTH_TOKEN_KEY` only in your uncommitted local `.env`. Generate and use a strong, provider-compatible secret; never place it in source code, client-side configuration, logs, or committed example values. Set `CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS` to the intended token lifetime in seconds. It must be an integer from `60` through `3600`; when omitted, it defaults to `600` seconds.

After configuring the local database and Cloudinary credentials, inspect the migration's proposed changes first from the `backend` directory:

```bash
node scripts/migrate-premium-video-delivery.js --dry-run
```

Review the dry-run output carefully, including every listed course and lecture, before running the migration. Only after that review, run:

```bash
node scripts/migrate-premium-video-delivery.js
```

The migration changes paid, non-preview video delivery records; do not run the non-dry-run command until its scope has been reviewed and approved for the target environment.

### Frontend origin and authentication cookies

Set `VITE_API_BASE_URL` in `frontend/.env` to the backend origin, such as `http://localhost:5000`, without `/api/v1`; the client adds that path. Set `FRONTEND_URL` in `backend/.env` to the exact frontend browser origin, such as `http://localhost:5173`. These variables refer to opposite ends of the connection, so their values normally differ.

Credentialed CORS allows only the origin matching `FRONTEND_URL`, including its protocol, hostname, and port. The local frontend port must exactly match `FRONTEND_URL`; if Vite selects another port, update the configuration or restart Vite on the configured port. Use the same hostname for both local services (for example, `localhost` for both), and restart each service after changing its environment. In production, CORS cannot override browser third-party-cookie policy. Prefer same-site HTTPS subdomains such as `app.example.com` and `api.example.com`, and prove login and session persistence in a production-like browser before rollout.

The frontend API client uses `credentials: 'include'`, and the backend enables CORS credentials. Authentication uses the HTTP-only `token` cookie, never browser token storage. Development cookies use `SameSite=Lax`; production cookies use `SameSite=None` and `Secure`, requiring HTTPS.

## Production security and operations

### Release verification order

Before a deployment, run the backend automated suite from `backend`, then the frontend suite and production build from `frontend`:

```powershell
cd backend
npm test
node --check scripts/migrate-cloudinary-media-to-r2.js

cd ..\frontend
npm test
npm run build
```

Automated checks do not contact Atlas, Cloudflare R2, Cloudinary, SMTP, or Razorpay. After they pass, deploy to a non-production environment first, perform the R2 rollout checks in the order listed above, and only then schedule production enablement and migration.

Set `TRUST_PROXY=true` only behind a known reverse proxy or load balancer that is trusted and configured correctly. Leaving it enabled without that deployment configuration can make forwarded client-address headers unsafe; direct deployments should retain `TRUST_PROXY=false`.

Rate limits use an in-memory store and therefore apply to one API instance only. For each 15-minute window, authentication login and registration routes allow 10 requests, password-reset routes allow 5 requests, and all other (non-auth) `/api/v1` routes—including protected and admin routes—allow 300 requests. Use a shared, production-grade rate-limit store when running more than one API instance.

Use `GET /health` as the liveness probe; it reports that the HTTP service is running. Use `GET /ready` as the database-readiness probe; it returns `200` only when MongoDB is connected and `503` when it is not. Configure uptime checks and alerts for both endpoints, and assign an explicit owner for acknowledging and resolving every alert.

Create and regularly test database backups and restore drills (Atlas or your hosting provider). Define a safe log-retention period that meets operational and applicable legal requirements, then ensure retained logs remain access-controlled and redacted.

Never commit or log environment files, cookies, JWTs, reset tokens, payment payloads, or credentials. This includes diagnostic output, audit summaries, support exports, and third-party monitoring events.

### Administrative audit log

`GET /api/v1/admin/audit-logs` is authenticated and restricted to the `ADMIN` role. It returns newest-first pages using an opaque `cursor` (with `limit` from 1 through 50; the default is 25). Treat the cursor as opaque and pass it back unchanged to retrieve the next page.

Audit records are append-only and store only safe operational fields: actor ID, action, target type and ID, a flat safe summary, and creation time. They must not store passwords, tokens, secrets, cookies, authorization data, IP addresses, user-agent data, email addresses, request content, uploaded-file data, payment payloads, or payment signatures.

### Admin operations and moderation

The administrative workspace is available only to authenticated `ADMIN` users. Its five operational sections are Overview, Users, Courses, Payments, and Activity. The corresponding read routes are:

```text
GET /api/v1/admin/overview
GET /api/v1/admin/users
GET /api/v1/admin/courses
GET /api/v1/admin/purchases
GET /api/v1/admin/audit-logs
```

Directory and report lists are newest-first cursor pages. `limit` defaults to `25` and must be an integer from `1` through `50`; clients must return a supplied `nextCursor` unchanged. User and course directories accept a trimmed literal-text `query` of at most 100 characters (regular-expression metacharacters are not interpreted). Users may be filtered by `role` (`STUDENT`, `INSTRUCTOR`, or `ADMIN`); courses by `status` (`PUBLISHED` or `UNPUBLISHED`); purchase reports may be filtered by a valid `courseId`. Invalid filters or cursors are rejected safely.

Admins can list and filter users in every role, but `PATCH /api/v1/admin/users/:userId/role` may only switch a non-admin user between `STUDENT` and `INSTRUCTOR`; `ADMIN` users cannot be assigned or demoted through this workspace. Course moderation is limited to `PATCH /api/v1/admin/courses/:courseId/status` with `PUBLISHED` or `UNPUBLISHED`: it is publish/unpublish moderation, not course editing or ownership transfer. Payments and overview revenue are limited to verified, valid INR purchase records. Activity is an audited, read-only log.

This administrative surface does not provide user suspension or deletion, refunds, data exports, charts, custom date ranges, or ownership transfer. Administrative responses and UI must never expose payment-provider, order, payment, or signature IDs; credentials; cookies; JWTs; password fields; or password-reset fields.

## API errors and password recovery

Failures handled by the error middleware retain the HTTP failure status and use this envelope:

```json
{
  "success": false,
  "message": "Please sign in to continue.",
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Please sign in to continue."
  }
}
```

The top-level `message` remains for compatibility. Clients should use `error.code` for approved user messages and recovery actions, such as signing in, requesting a new reset link, correcting input, or checking purchases before retrying payment verification. The frontend maps codes to safe copy and uses safe fallbacks for unknown codes, network failures, and legacy responses; it does not display arbitrary backend or provider diagnostics. Non-production responses may include a diagnostic `stack`; production middleware omits it and redacts unexpected server-error messages. The unmatched-route `404` currently uses the legacy `{ success: false, message }` shape.

Successful password-reset requests return the same `200` confirmation for known and unknown email addresses: "If an account exists for this email, a reset link is on its way." This confirmation does not disclose account existence. A configured SMTP service is needed to deliver a link for an existing account; delivery failures return a safe `AUTH_RESET_EMAIL_UNAVAILABLE` error. Invalid or expired links return `AUTH_RESET_TOKEN_INVALID` so the client can offer a new reset request.

## Hybrid AI Learning Assistant (Phase 1)

The student dashboard's Learning compass uses the authenticated student's learning profile, published catalog, active enrollments, course structure, and recorded progress. The site-wide chatbot opens by asking what the learner is interested in or what career goal they have; it uses only published catalog facts to discuss matching courses. The learner's answers and recent chat turns remain transient in the page and are not saved to their learning profile. Existing `/api/v1/ai` routes require a signed-in `STUDENT`; the site-wide `POST /api/v1/ai/chatbot` route is public and optionally uses a valid session cookie. Guests receive general learning help and published catalog facts. Signed-in students additionally receive their own minimized profile/progress context and can select an active course, or arrive from a course/lesson page with a course ID and optional lesson ID, to route a question through the separately authorized PDF tutor. The frontend handoff contains identifiers only and preselects a course only when current active-course guidance confirms it. Instructors and admins get general chat only. Course-material requests still require a student, active enrollment, published course, and published material; lesson-scoped requests also validate that the lesson belongs to that course. These checks are repeated for every request. The backend selects published courses excluding active enrollments, computes integer match scores from 0 to 100, returns deterministic match reasons and prerequisite states, and orders available prerequisites before dependent recommendations. A prerequisite counts as met only when every current lesson in that published course is completed by this student or the required skill is explicitly self-reported; interests are not prerequisite evidence. Missing or unpublished prerequisite references remain unknown, not completed. Courses involved in prerequisite cycles, including dependent courses that cannot be safely ordered, are omitted. Recommendations are informational and never enroll or purchase a course. Empty eligible catalogs return an empty result.

### Personalized weekly study plan

The student-only `/api/v1/ai/study-plan` endpoints return a deterministic seven-day draft from the student's weekly availability, active published courses, next incomplete lessons, unpassed published quizzes, and upcoming published assignments. `GET` and `DELETE` accept `startDate` (`YYYY-MM-DD`) and the browser's IANA `timeZone` as query parameters. `POST /study-plan/preview` accepts those fields without saving; `PUT /study-plan` saves only reviewed sessions whose task IDs came from current backend course facts. The student can edit, reorder, and remove sessions before saving, and can replace or delete their own plan. Session estimates fit the profile's stated weekly minutes, and assignment sessions cannot be scheduled after their due date.

Plans are advisory and owner-scoped. Preview does not persist; saving does not complete lessons, change progress, create quiz attempts, or submit assignments. Scheduling is deterministic and does not call Gemini. UTC timestamps preserve the selected local calendar day across daylight-saving changes. Missing availability or eligible course tasks returns an explanatory empty state rather than invented work.

### Progress recap and early support

The student-only `/api/v1/ai/guidance` response includes a deterministic recap of the authenticated learner's active published courses, completed/total lessons, next lessons, unpassed published quizzes, and future-due published assignments that have not been submitted. The recap is derived from existing progress and assessment records; it is not generated by Gemini or stored as history. An incomplete course is gently marked as paused only after at least 14 days without a recorded lesson update. Courses with no activity are marked not started, and completed/no-lesson courses are not labeled paused. The 14-day threshold is an informational nudge, not a diagnosis or claim of learner risk.

### Backend-only Gemini configuration

Configure these variables only in the backend's uncommitted `.env` or deployment secrets, then restart the backend. `.env.example` leaves the key and model blank intentionally. Select a model available to your project that supports the adapter's structured JSON response; this guide does not prescribe a model or supply credentials.

| Variable | Purpose and accepted settings |
| --- | --- |
| `AI_PROVIDER` | Set to `gemini` to configure the provider adapter. Missing or unsupported configuration uses deterministic fallback. |
| `GEMINI_API_KEY` | Your backend-only API key; leave blank to run without provider calls. |
| `GEMINI_MODEL` | Model identifier selected by the backend operator; no default model is assumed. |
| `AI_MAX_OUTPUT_TOKENS` | Integer 1–1000; default/example `500`. Caps the provider's requested output. |
| `AI_DAILY_REQUEST_LIMIT` | Integer 1–100; default/example `20`. Per-student daily chat budget, distinct from Google's project quotas. |
| `AI_REQUEST_TIMEOUT_MS` | Integer 1000–30000; default/example `15000`. Provider timeout in milliseconds. |
| `GEMINI_EMBEDDING_MODEL` | RAG embedding model; fixed at `gemini-embedding-2`. |
| `RAG_EMBEDDING_DIMENSION` | RAG vector dimensions; fixed at `768`. Changing model or dimensions requires re-indexing every material. |
| `RAG_MAX_PDF_BYTES` | Fixed maximum PDF upload size in bytes (`10485760`, 10 MiB). |
| `RAG_MAX_PDF_PAGES` | Fixed maximum PDF page count (`100`). |
| `RAG_DAILY_REQUEST_LIMIT` | Course-tutor requests per student per UTC day; integer 1–100, default `10`. |
| `RAG_REQUEST_TIMEOUT_MS` | Embedding, retrieval, and generation timeout in milliseconds; integer 1000–30000, default `20000`. |
| `RAG_PRACTICE_DAILY_REQUEST_LIMIT` | Supplemental practice generations per student per UTC day; integer 1–100, default `5`. |
| `RAG_PRACTICE_MAX_OUTPUT_TOKENS` | Practice-generation output-token cap; integer 1–1000, default `1000`. |
| `RAG_PRACTICE_TIMEOUT_MS` | Practice retrieval and generation timeout in milliseconds; integer 1000–30000, default `20000`. |
| `AI_INSTRUCTOR_DRAFT_DAILY_LIMIT` | Instructor draft generations per instructor per UTC day; integer 1–100, default `5`. |
| `AI_INSTRUCTOR_DRAFT_MAX_OUTPUT_TOKENS` | Instructor draft output-token cap; integer 1–1000, default `1000`. |
| `AI_INSTRUCTOR_DRAFT_TIMEOUT_MS` | Instructor draft provider timeout in milliseconds; integer 1000–30000, default `20000`. |
| `ATLAS_VECTOR_INDEX` | Atlas Vector Search index name; default `course_material_chunks_vector`. |

Never put these settings in `frontend/.env`, a `VITE_*` variable, frontend source, browser storage, API responses, or logs. The frontend uses the existing credentialed backend API and needs no provider configuration.

### Free Tier quotas, costs, and daily budget

Free Tier availability and limits vary by model and project and can change. Before enabling Gemini, check the project's active quotas in AI Studio and Google's [rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) and [pricing](https://ai.google.dev/gemini-api/docs/pricing). Request-per-minute, input-token-per-minute, and request-per-day limits are shared across the provider project, not allocated separately to each LMS student or API key. Do not interpret the example budget as a promise of Free Tier capacity or zero cost: verify the selected model and billing tier, and review costs before enabling billing or changing models. This application has no project-wide monetary spending cap.

The backend reserves AI chat budget in MongoDB per student and **UTC calendar day**. The public chatbot also has a dedicated per-IP limit (10 requests per 15 minutes by default, configurable through `createApp` security options); this uses the same process-local rate-limit store as the other HTTP limits and should be replaced with a shared store when running multiple backend instances. Reservations are not refunded after provider failures or crashes; historical usage records also count toward the daily gate. Some requests that do not call Gemini, such as detailed-content refusals, still create usage records and can therefore affect subsequent budget checks. Profile, recommendation, and guidance read endpoints do not call Gemini or consume this chat budget. Google's daily quota resets on its own schedule (currently midnight Pacific), independently of the LMS UTC budget.

### Data minimization and privacy limits

The provider adapter projects and bounds an allowlist of fields. The Learning Compass uses profile, course, and progress summaries; general chatbot requests use the current question, up to eight recent in-page turns, published course metadata, and (for a signed-in student) only that student's minimized profile and lesson-progress summary. Chat history is held only in the page and sent with general follow-up requests; it is not saved by the backend and is never forwarded with a course-scoped PDF tutor request. PDF questions go through the separate tutor, which sends only authorized retrieved excerpts. No student identity field, assessment answer, submission file, PDF, or storage URL is included in the public chatbot context. Recognizable email addresses, credentials, cookies, JWTs, payment data, URLs, and storage/object keys are redacted from free text. Passwords, email addresses, tokens, payment payloads, R2 keys/object keys, raw assignments, and another student's data must never be sent to Gemini.

Redaction is a limited pattern-based safeguard, not anonymization or a guarantee that arbitrary free text contains no personal data. Keep profile answers, questions, and course metadata free of sensitive, confidential, or personal information. Google's [Gemini terms](https://ai.google.dev/gemini-api/terms) describe how unpaid-service inputs and outputs may be used to improve products and reviewed by people. Review the applicable terms and deployment audience before enabling the provider; use the deterministic mode when that data sharing is unsuitable. No claim of zero retention or provider-side deletion is made here.

AI usage logs retain only the student reference, feature, provider/model alias, outcome category, optional token counts, and timestamp. They exclude question/answer text, raw prompts/responses, credentials, emails, and payment data. Guest conversations have no durable usage log; they are bounded by the per-IP limiter. Do not add raw provider diagnostics or payloads to application, audit, support, or monitoring logs. No cross-session chat memory or automatic retention/deletion policy is provided.

### Deterministic behavior and Phase 1 limits

Gemini may select only an allowlisted reply key and references to supplied course IDs. The backend validates that envelope and renders every final sentence and course card from its own facts; the model never chooses courses, computes scores, or supplies arbitrary student-facing prose. Missing/invalid configuration, invalid keys, outages, timeouts, rate/quota errors, malformed/oversized output, unsupported claims, or unknown course references discard the provider result and return deterministic profile questions, catalog recommendations, or recorded-progress guidance without provider details. Daily-budget exhaustion adds safe next-day retry copy while preserving those facts. Database/context or usage-log failures can still return a safe `503`; fallback is not a substitute for database availability.

Phase 1 does not provide video transcription or automatic lesson-content access. A separate PDF course tutor is available for instructor-published embedded-text PDFs. It uses private R2 storage and Atlas Vector Search to answer enrolled students' questions with page citations; scanned/OCR-only PDFs and unsupported questions receive a safe no-source response. AI output cannot automatically purchase, enroll, grade, publish assessments, or mutate LMS learning records. Profile saving is an explicit student action; course and lesson buttons use the normal LMS flows.

### Verification before rollout

From the repository root, run `npm --prefix backend test`, `npm --prefix frontend test`, and `npm --prefix frontend run build`. Automated tests mock provider requests and do not establish live Gemini availability, quota capacity, Atlas index state, private R2 behavior, or browser-session behavior.

### PDF course tutor (RAG)

The tutor accepts embedded-text PDFs up to 10 MiB and 100 pages. Instructors upload materials at course or lecture scope, then explicitly publish them after processing. Only `PUBLISHED` materials are searchable, and each student material list, download, or tutor request requires an active enrollment in the published course. Guest, preview-only, instructor, and revoked/unrelated accounts do not gain PDF access.

The backend sends only the bounded question and authorized retrieved excerpts to Gemini. It does not send PDFs, R2 URLs/object keys, embeddings, student identity, or payment data. Student answers contain citations to retrieved source pages; if retrieval or provider validation is insufficient, the tutor returns a safe no-source/unavailable response. Usage is separately budgeted per student and UTC day. The system does not perform OCR, retain free-form tutor history, or let AI mutate LMS records.

Enrolled students can also request one supplemental practice set with `POST /api/v1/ai/course-practice`, using a course ID, optional lecture ID, and topic. The endpoint shares the tutor's authorization-first PDF retrieval, validates every citation against retrieved pages, and has its own daily request budget and output-token cap. Answers are transient and revealed only after the student checks them; this flow never creates quiz attempts, changes grades/progress, or contributes to certificates. No-source, malformed-output, and provider-failure outcomes return safe UI copy.

### Instructor AI content drafts

Instructors can request an editable outline, practice prompts, or assignment-rubric suggestions with `POST /api/v1/instructor/courses/:courseId/ai-drafts` and `{ "kind": "OUTLINE", "focus": "..." }`. The endpoint requires the `INSTRUCTOR` role and ownership of the selected course; admins, students, guests, and other instructors are denied. It sends bounded course metadata and at most five excerpts from that course's currently published PDF materials, never student records, submissions, private storage details, or unpublished material. Generated material citations are validated against the exact excerpt and page range, and publication changes during generation invalidate the result. If no excerpts exist, the response identifies that the draft used course metadata only.

The UI allows editing and copying the returned draft, but the API does not persist or publish generated text. Instructors must review content and use existing course-authoring flows for any explicit save or publication. Per-instructor UTC-day request limits, output-token bounds, and provider timeouts are configured by the `AI_INSTRUCTOR_DRAFT_*` variables above. Failed provider calls do not expose raw provider diagnostics; budget reservations are not refunded after failures.

Keep all RAG settings and `GEMINI_API_KEY` in the backend environment only. The existing private R2 bucket configuration is required; do not make the bucket public. The embedding model, 768-dimension vector shape, and PDF limits are fixed compatibility/safety bounds. Changing embedding model or dimension requires a complete explicit re-index before serving questions.

#### Configure the Atlas Vector Search index

Create a MongoDB Atlas **Vector Search** index on the `coursematerialchunks` collection. Use the `ATLAS_VECTOR_INDEX` name (default `course_material_chunks_vector`) and this definition:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "course" },
    { "type": "filter", "path": "material" },
    { "type": "filter", "path": "lecture" },
    { "type": "filter", "path": "embeddingModel" },
    { "type": "filter", "path": "embeddingDimension" }
  ]
}
```

The filter fields support the backend's course/material authorization and model/dimension constraints. Configure a backend-only `GEMINI_API_KEY`, `AI_PROVIDER=gemini`, a supported `GEMINI_MODEL`, and the private R2 variables before enabling uploads or tutor requests. Never add these values to frontend variables or `VITE_*` settings.

After configuration, run this readiness check from `backend`:

```powershell
node scripts/verify-rag-vector-index.js --check
```

It prints only a JSON readiness result and a fixed reason code; it never prints connection strings, credentials, index definitions, source material, vectors, or raw database errors. A nonzero exit means configuration is incomplete, Atlas is unavailable, or the expected index is missing, building, or incorrectly defined. Do not enable the tutor until it returns `{"ready":true,"reason":"READY"}`.

Automated tests do not contact Atlas, R2, or Gemini. Before rollout, use synthetic course data in staging to upload and publish course-wide and lecture PDFs; verify citations for supported questions, safe no-source output for unsupported questions, guest/unenrolled/revoked access denial, daily-budget behavior, unpublish/delete/retry lifecycle, and refusal of direct public R2 access. If Atlas or Gemini is unavailable, the tutor should remain safely unavailable; retain the private source and use the material retry/rollback path rather than making media public.

## Student learning progress

Student-only learning progress endpoints require an active course enrollment:

```text
PATCH /api/v1/courses/:courseId/lectures/:lectureId/progress
POST  /api/v1/courses/:courseId/lectures/:lectureId/complete
GET   /api/v1/courses/:courseId/progress
GET   /api/v1/me/learning
```

The video client sends `watchedSeconds` and `durationSeconds` every 15 seconds and again on pause, video end, and page exit. The backend never lowers saved progress and automatically completes a lecture at 90% watched.

## Course quizzes

Instructor course managers use these endpoints to author and manage a course's quizzes:

```text
POST   /api/v1/instructor/courses/:courseId/quizzes
GET    /api/v1/instructor/courses/:courseId/quizzes
PATCH  /api/v1/instructor/courses/:courseId/quizzes/:quizId
DELETE /api/v1/instructor/courses/:courseId/quizzes/:quizId
```

Authors receive answer keys and explanations when creating or listing their own course quizzes. A new quiz starts as a draft; students can only access a published quiz. Once any student has attempted a quiz, its content cannot be edited or deleted. Its author may only publish or unpublish it by changing its status.

Students use the following endpoints:

```text
GET  /api/v1/courses/:courseId/quizzes
GET  /api/v1/courses/:courseId/quizzes/:quizId
POST /api/v1/courses/:courseId/quizzes/:quizId/attempts
GET  /api/v1/courses/:courseId/quizzes/:quizId/attempts
```

Quiz access is limited to actively enrolled students, and only published quizzes are visible. Attempts are unlimited. The submission endpoint grades answers on the server and ignores any client-provided score or pass/fail fields. Correct answers and explanations are withheld while a student is listing or opening a quiz; they are returned only after a successful submission. Attempt history is private to the student who made it.

## Course assignments and submissions

Instructor course managers use these endpoints to author assignments and review work for their own courses:

```text
POST   /api/v1/instructor/courses/:courseId/assignments
GET    /api/v1/instructor/courses/:courseId/assignments
PATCH  /api/v1/instructor/courses/:courseId/assignments/:assignmentId
DELETE /api/v1/instructor/courses/:courseId/assignments/:assignmentId
GET    /api/v1/instructor/courses/:courseId/assignments/:assignmentId/submissions
PATCH  /api/v1/instructor/courses/:courseId/assignments/:assignmentId/submissions/:submissionId/review
```

New assignments are drafts. An instructor can publish or unpublish with `status: "PUBLISHED"` or `status: "DRAFT"`. After the first submission, assignment requirements and maximum marks cannot change and deletion is blocked; only publication status may change. The review endpoint accepts exactly one of `GRADE` (integer `marks` from 0 through the assignment maximum, plus non-empty `feedback`) or `REQUEST_RESUBMISSION` (non-empty `feedback`). Reviews apply only to a student's latest unreviewed version.

Students use the following endpoints:

```text
GET  /api/v1/courses/:courseId/assignments
GET  /api/v1/courses/:courseId/assignments/:assignmentId
POST /api/v1/courses/:courseId/assignments/:assignmentId/submissions
GET  /api/v1/courses/:courseId/assignments/:assignmentId/submissions
```

Assignment access requires an `ACTIVE` enrollment. Students can see only published assignments; drafts return no assignment data. Submission history is private to the submitting student and records immutable version numbers, server-calculated late status, grading feedback/marks, and any resubmission request. A graded submission cannot be replaced; a resubmission request permits a new version.

Create a submission as multipart form data with `writtenAnswer`, `projectUrl`, and/or one `file`. The file is optional, but at least one work field is required. At most one file is accepted, up to 25 MB: `.pdf`, `.docx`, `.zip`, `.png`, `.jpg`, or `.jpeg` (with the corresponding supported MIME type). Project URLs must use HTTP or HTTPS. The server owns submission versions, late markers, grading fields, and lifecycle state, so clients cannot set them. File responses include only safe download metadata; Cloudinary `public_id` values are never returned to students.

## Course certificates

Certificates are issued only when an actively enrolled student claims one after meeting every current course requirement. Certificate records are immutable and there is at most one certificate for a student and course.

Student certificate endpoints require authentication as a `STUDENT` and an `ACTIVE` enrollment in the requested course:

```text
GET  /api/v1/courses/:courseId/certificate/eligibility
POST /api/v1/courses/:courseId/certificate/claim
GET  /api/v1/me/certificates
```

The eligibility endpoint returns the requirement checklist and its counts/percentages. Claiming returns `201` for a newly issued certificate, or `200` and the same certificate for a repeat claim; a claim made before eligibility is met returns `409` with the checklist. `GET /api/v1/me/certificates` lists only the authenticated student's certificates. Student certificate responses contain a certificate number, course title, and issue date, but never the verification token or stored eligibility snapshot.

A student is eligible only when all of these conditions hold:

- At least 80% of the course's current lectures have a completed progress record.
- Every currently published quiz has at least one passing attempt. The best percentage from each currently published quiz is used in the assessment average.
- Every currently published assignment has a latest submission whose status is `GRADED`. Its percentage is `marks / maxMarks * 100` and is used in the assessment average.
- The arithmetic average across those quiz and assignment percentages is at least 80%. If the course has no currently published quizzes or assignments, this assessment average is 100%.

Public verification needs no authentication:

```text
GET /api/v1/certificates/verify/:token
```

The endpoint accepts only the certificate's unguessable verification token. A valid token returns the certificate number, learner name, course title, issue date, and `valid: true`; a missing, malformed, or unknown token returns `404`. Public verification never reveals internal IDs, email addresses, eligibility snapshots, assessment results, or the token itself.

## Paid-course purchases (Test Mode)

Individual paid-course purchases use Razorpay Orders with Test Mode keys named `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`; they do not use `RAZORPAY_PLAN_ID`. The automated tests use a mocked Razorpay service; they do not exercise a live checkout. Successful payment verification requires MongoDB transaction support from Atlas or a local replica set (including a single-node replica set). A standalone MongoDB deployment returns a safe `503` for payment verification instead of granting partial access.

Live webhooks, refunds, and production payment activation are out of scope. Live end-to-end checks need a configured backend and frontend, a reachable MongoDB instance with transaction support for paid verification, and the relevant SMTP, Cloudinary, and Razorpay Test Mode services; automated tests do not establish that these external services work.

### JWT legacy-name migration

`JWT_SECRET` is the required canonical name. An existing local `.env` that has only the legacy `JWT_Secret` spelling will fail startup by default. For a temporary migration only, set `ALLOW_LEGACY_JWT_SECRET=true`, rename `JWT_Secret` to `JWT_SECRET`, then remove the opt-in flag. Runtime code uses the canonical `JWT_SECRET` name.
