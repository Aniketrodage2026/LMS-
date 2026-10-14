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
| `SMTP_EMAIL` | SMTP sender/account email for application email. |
| `SMTP_PASSWORD` | SMTP password or provider app password. |
| `RAZORPAY_KEY_ID` | Razorpay **Test Mode** key ID for local development only. |
| `RAZORPAY_KEY_SECRET` | Razorpay **Test Mode** key secret for local development only. |
| `RAZORPAY_PLAN_ID` | Razorpay plan ID used by the legacy subscription endpoints. |

`DB_URL`, `JWT_SECRET`, `JWT_EXPIRY`, and `FRONTEND_URL` are validated during server startup. The Cloudinary, SMTP, and Razorpay values are supplied locally when using their corresponding integrations. Keep Razorpay Test Mode credentials only in your uncommitted local `.env`; no real credentials belong in this repository.

### Frontend origin and authentication cookies

Set `VITE_API_BASE_URL` in `frontend/.env` to the backend origin, such as `http://localhost:5000`, without `/api/v1`; the client adds that path. Set `FRONTEND_URL` in `backend/.env` to the exact frontend browser origin, such as `http://localhost:5173`. These variables refer to opposite ends of the connection, so their values normally differ.

Credentialed CORS allows only the origin matching `FRONTEND_URL`, including its protocol, hostname, and port. The local frontend port must exactly match `FRONTEND_URL`; if Vite selects another port, update the configuration or restart Vite on the configured port. Use the same hostname for both local services (for example, `localhost` for both), and restart each service after changing its environment.

The frontend API client uses `credentials: 'include'`, and the backend enables CORS credentials. Authentication uses the HTTP-only `token` cookie, never browser token storage. Development cookies use `SameSite=Lax`; production cookies use `SameSite=None` and `Secure`, requiring HTTPS.

## Production security and operations

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
