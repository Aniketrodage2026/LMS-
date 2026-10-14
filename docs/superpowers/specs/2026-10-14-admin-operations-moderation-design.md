# Admin Operations and Moderation Design

**Date:** 2026-10-14
**Scope:** First complete Admin workspace for the self-paced LMS.
**Status:** Approved design; implementation not started.

## Goal

Replace the existing Admin placeholders with an operational workspace that lets an administrator understand platform activity, find users and courses, manage Student/Instructor roles, safely publish or unpublish courses, inspect verified purchase reporting, and review privacy-safe audit activity.

The backend remains authoritative for identity, roles, moderation, payment state, and metrics. The frontend never derives access or revenue from client-only data.

## Decisions

- Only authenticated `ADMIN` users can use every new Admin endpoint and screen.
- User management is limited to searching/filtering users and using the existing Student/Instructor role management flow. It does not suspend, reactivate, delete, or anonymize users.
- Course moderation is limited to `UNPUBLISHED` and `PUBLISHED` transitions. An Admin cannot delete a course, alter its instructor ownership, or edit its curriculum through this workspace.
- Payments are read-only verified-purchase reporting. Refunds, provider reconciliation, webhooks, provider IDs, and payment signatures are excluded.
- The first analytics version is an operational overview, not charting, export, custom date ranges, or advanced reporting.
- The existing immutable, privacy-safe audit-log API remains the source for audit activity.

## Backend API design

All routes are mounted below `/api/v1/admin`, require `isLoggedIn` and `requireRole('ADMIN')`, and return the current safe error envelope.

### Overview

`GET /api/v1/admin/overview` returns all-time operational totals:

- total users, with Student, Instructor, and Admin counts;
- total courses and published-course count;
- active-enrollment count;
- verified-purchase count and verified revenue in paise, grouped only as one total;
- overall completed-lecture percentage: completed lecture-progress records divided by all current lecture slots across active enrollments, with `0` when no active enrolled lecture exists;
- a bounded recent-activity list using safe audit-entry fields.

The endpoint must calculate totals server-side and return zero-valued metrics for an empty platform. It must not return internal database details, payment-provider references, cookies, tokens, or credentials.

### User directory

`GET /api/v1/admin/users` supports an opaque cursor, bounded `limit`, optional text `query`, and optional role filter (`STUDENT`, `INSTRUCTOR`, or `ADMIN`). Query matches safe name/email fields case-insensitively. Results are newest-first with a deterministic `_id` tie-breaker.

Each result contains only `id`, `name`, `email`, `avatar`, `role`, and `createdAt`. Password hashes, reset values, subscriptions, and internal account details never appear.

The existing `PATCH /api/v1/admin/users/:userId/role` stays the only Admin mutation for user roles. Existing restrictions remain: role targets are Student or Instructor, an Admin cannot change their own role, and each factual role change has a safe audit event.

### Course moderation

`GET /api/v1/admin/courses` supports cursor pagination, bounded `limit`, optional text `query`, and optional status filter (`UNPUBLISHED` or `PUBLISHED`). Results contain only safe card/moderation data: course ID, title, description, thumbnail, instructor summary, access type, price in paise, status, lecture count, and timestamps.

`PATCH /api/v1/admin/courses/:courseId/status` accepts exactly one status transition: `UNPUBLISHED` or `PUBLISHED`. A successful actual transition is persisted atomically; repeated requests for the already-current status remain successful but do not create a duplicate audit event. The normal course-publication audit action is recorded only when state changes. Invalid IDs, missing courses, invalid statuses, and unexpected storage errors use safe code/message responses.

### Verified payment reports

`GET /api/v1/admin/purchases` supports cursor pagination, bounded `limit`, and optional course filter. It returns verified purchases only, newest first, with safe fields: purchase ID, learner summary, course summary, amount in paise, currency, and verified timestamp.

It excludes Razorpay order IDs, payment IDs, signatures, raw provider payloads, and any payment secrets. It does not create, retry, refund, or otherwise mutate payments.

### Audit activity

The existing `GET /api/v1/admin/audit-logs` contract is reused unchanged: Admin-only, cursor-paginated, newest-first records containing actor ID, action, target, flat safe summary, and time. The UI must treat cursors as opaque.

## Frontend design

The current `/admin` route becomes a real workspace with these sections:

1. **Overview:** metric cards and a recent activity list backed by `GET /admin/overview`.
2. **Users:** searchable/filterable paginated table; existing role update uses a confirmation state and refreshes server data after success.
3. **Course moderation:** searchable/filterable course table with Publish/Unpublish actions. The UI waits for the server response and then refreshes rather than assuming the transition succeeded.
4. **Payments:** read-only verified-purchase table with safe amount/date/course/learner information.
5. **Activity:** existing audit-log data with a Load more control based on its cursor.

Each screen has loading, empty, retryable error, and success states. It uses the shared API client and error presenter; raw backend, database, Cloudinary, or payment-provider messages are never shown. Direct route access by guests or non-Admins retains the existing protected-route behavior.

## Privacy and audit rules

- New list/report responses contain only fields explicitly specified in this document.
- No API response, audit summary, browser log, or error UI exposes passwords, reset tokens, cookies, JWTs, payment provider IDs/signatures, raw payment payloads, IP addresses, or user-agent data.
- Only a factual course status change creates its publication/update audit record; retries and no-op moderation requests do not duplicate it.
- Read-only reporting actions do not create audit records.

## Error handling

The backend returns existing safe error envelopes for authentication/role failures and introduces explicit safe Admin codes only where needed for invalid pagination/filter/status input or unavailable reporting data. The frontend maps these through the shared presenter to corrective copy and preserves a retry action for network or temporary server failures.

## Verification

Backend integration tests cover:

- Admin-only access for every route;
- cursor pagination, filters, invalid input, and empty datasets;
- strict safe-response shapes with no private user/payment fields;
- correct all-time overview totals;
- atomic Unpublished/Published moderation transitions, no-op retries, and audit-event behavior;
- preservation of current instructor ownership and course access rules.

Frontend tests cover:

- protected Admin routes;
- loading, empty, success, and friendly error states;
- search/filter and cursor interactions;
- role-change and publish/unpublish success/failure recovery;
- safe rendering of reported data without provider or secret values.

The complete backend and frontend suites, frontend production build, and `git diff --check` must pass before the milestone is marked complete.

## Out of scope

- Account suspension, deletion, or ownership transfer;
- course deletion or curriculum editing by Admins;
- refunds, webhooks, payment reconciliation, exports, charts, custom reporting windows, or instructor payouts;
- private/signed premium-video delivery;
- ratings, discussions, notifications, notes/bookmarks, live classes, and other advanced LMS features.
