# Production Security Hardening Design

**Date:** 2026-10-13  
**Scope:** Backend API security and privacy-first operational auditability for the LMS.  
**Out of scope:** Live classes, Redis/distributed rate limiting, external monitoring providers, private/signed video delivery, and the full Admin product UI.

## Goal

Harden the Express API against common web abuse while giving administrators an accountable, privacy-conscious record of important LMS actions. The work must preserve the existing API contracts and friendly error handling.

## Architecture

Security controls will be installed at the API boundary in `backend/app.js`, before application routes:

1. `helmet` applies standard HTTP security headers.
2. Express JSON and URL-encoded parsers enforce a small request-body limit to reduce oversized-payload abuse.
3. Targeted rate limiters protect authentication and password-reset endpoints more strictly than ordinary public requests.
4. A general public API limiter covers remaining public traffic.
5. Each request receives a generated request ID, returned in `X-Request-Id` and used only in safe operational logs.

The first release uses the default in-memory rate-limit store. It is appropriate for the current single API instance and test/development environments. A future multi-instance deployment will replace it with a shared store such as Redis without changing client API contracts.

## Rate-limit policy

| Area | Limit | Window | Client response |
| --- | ---: | --- | --- |
| Sign-in and registration | 10 requests | 15 minutes | HTTP 429 with `SECURITY_RATE_LIMITED` and a clear retry message |
| Password-reset request and completion | 5 requests | 15 minutes | HTTP 429 with the same safe response |
| Other public API traffic | 300 requests | 15 minutes | HTTP 429 with the same safe response |

The error response will continue to use the existing envelope:

```json
{
  "success": false,
  "message": "Too many requests. Please wait a few minutes and try again.",
  "error": {
    "code": "SECURITY_RATE_LIMITED",
    "message": "Too many requests. Please wait a few minutes and try again."
  }
}
```

Failed sign-in attempts count toward the authentication limit. The application will not trust proxy-provided client IP headers by default. A deployment may enable proxy trust only through an explicit environment setting after its proxy topology is understood.

## Privacy-first audit log

Create an append-only Mongoose `AuditLog` model with:

- `actor`: the authenticated user ObjectId that caused the action.
- `action`: a controlled action name, for example `COURSE_CREATED`, `ROLE_CHANGED`, `PURCHASE_VERIFIED`, or `ASSIGNMENT_GRADED`.
- `target`: `{ type, id }` identifying the affected LMS record.
- `summary`: an optional safe, structured change summary (for example, `{ fromRole, toRole }`).
- `createdAt`: the immutable action time.

Audit records must never contain IP addresses, user-agent values, passwords, cookies, JWTs, reset tokens, raw Razorpay payloads, uploaded file data, submission text, or other sensitive request-body fields.

Record successful high-value actions only:

- administrator role changes;
- instructor course, lesson, quiz, and assignment creation, update, deletion, and publishing actions;
- instructor grading or feedback actions;
- completed purchase verification; and
- certificate generation.

Recording an audit event is best effort: an audit-storage outage must not undo a completed learner, instructor, or administrator action. The server emits a safe warning with the request ID and action name if audit recording fails; it does not log sensitive data.

An admin-only, paginated audit-log API will be delivered so the later Admin UI can query the data. The endpoint supports a bounded `limit` and cursor-based pagination and returns only the privacy-safe model fields.

## Health and safe logging

- `GET /health` remains a liveness endpoint and returns success while the process is running.
- `GET /ready` is a readiness endpoint. It returns HTTP 200 only when Mongoose has an active database connection, and HTTP 503 with a safe response otherwise.
- HTTP request logs become structured, safe records containing request ID, method, route, status, duration, and error code where applicable. They must not include cookies, authorization values, request bodies, or secrets.
- The error middleware includes the request ID in server-side logs and may include it in safe client error metadata for support correlation, without exposing stack traces in production.

## Error handling

All new failures use the existing consistent public error envelope. Oversized request bodies, malformed payloads, and rate limits have stable machine-readable codes with plain-language recovery messages. Database readiness must not disclose host names, credentials, or internal connection details.

## Testing

Automated tests will verify:

1. security headers and request-size enforcement;
2. authentication, reset, and general API rate-limit behavior and response shape;
3. liveness and database readiness behavior;
4. audit-event creation for representative sensitive actions;
5. audit-log authorization, pagination, and safe response fields;
6. absence of prohibited sensitive values in persisted audit data and structured log inputs; and
7. compatibility with the existing backend test suite.

## Operations outside code

The implementation documentation will include deployment checks for MongoDB backups, uptime checks against `/health` and `/ready`, alerts, log retention, and an explicit decision on proxy trust. These are configuration and operational responsibilities, not external services added to this milestone.

