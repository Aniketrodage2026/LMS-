# Platform error-handling design

## Goal

Give every LMS user a clear, safe, and actionable explanation when an operation cannot be completed. The UI must never depend on raw backend wording or expose technical implementation details.

## Scope

This applies to the current authentication, course catalogue and access, uploads, purchases, learning progress, quizzes, assignments, certificates, instructor workspace, and admin role-management flows.

It does not add the unfinished admin features, change authorization rules, or change payment/certificate eligibility business rules.

## User-facing rules

- Use plain language; never show HTTP statuses, database errors, stack traces, or provider internals.
- State what happened and what the person can do next.
- Show field-specific messages beside the affected input when possible.
- Show form-level messages above a form for submission failures.
- Show a retry panel for page-data failures.
- Keep an unsuccessful form's entered values intact.
- Disable a submitting action while it is in progress, then restore it after failure.
- Do not reveal whether an email address has an account through the password-reset flow.

## Approved copy and recovery

| Situation | Message | Recovery |
| --- | --- | --- |
| Duplicate signup | An account already exists for this email. Sign in instead, or reset your password if you do not remember it. | Sign in; reset password |
| Invalid login | We couldn’t sign you in with that email and password. Check your details or reset your password. | Try again; reset password |
| Password-reset request | If an account exists for this email, a reset link is on its way. | Back to sign in |
| Expired/invalid reset token | This reset link has expired. Request a new one to continue. | Request new link |
| Authentication required | Please sign in to continue. | Sign in, preserving the requested page |
| Forbidden action | Your account does not have permission to do that. | Return to workspace |
| Paid course access | Purchase this course to unlock its lessons. | View course; buy course |
| Revoked access | Your access to this course is no longer active. | Go to My Learning |
| Upload too large | This file is too large. Choose a file smaller than the allowed limit. | Choose another file |
| Upload type unsupported | This file type is not supported. Choose one of the accepted file types. | Choose another file |
| Generic validation | Check the highlighted details and try again. | Correct form 
values |
| Network/service unavailable | We couldn’t connect to SkillForge. Check your connection and try again. | Retry |
| Missing/removed item | This item is no longer available. | Go back |
| Purchase pending | Your payment is being confirmed. Do not pay again; check your purchases shortly. | View purchases; retry safely |
| Certificate ineligible | Complete the remaining learning requirements to claim your certificate. | View requirements; keep learning |

## API error contract

All handled API failures use one public shape:

```json
{
  "success": false,
  "error": {
    "code": "AUTH_EMAIL_EXISTS",
    "message": "An account already exists for this email."
  }
}
```

`error.code` is the stable machine-readable contract. `error.message` is a safe fallback and never includes a stack trace, credentials, database details, provider response, or internal identifiers. Existing top-level `message` remains during migration so older consumers do not break.

### Error-code families

- `AUTH_*`: email exists, invalid credentials, reset token invalid/expired, authentication required, role forbidden.
- `VALIDATION_*`: missing/invalid request field, invalid identifier, invalid state transition.
- `UPLOAD_*`: missing file, invalid type, file too large, upload service failure.
- `COURSE_*`: missing/unpublished course, not enrolled, purchase required, revoked access, lecture missing.
- `PAYMENT_*`: course already owned, order pending, verification failed/conflict, provider unavailable.
- `ASSESSMENT_*`: quiz/assignment unavailable, invalid submission, locked content, review conflict.
- `CERTIFICATE_*`: eligibility incomplete, verification record missing.
- `SYSTEM_*`: service unavailable and unexpected failure.

## Backend design

1. Extend `AppError` with a public `code` and optional safe metadata.
2. Create named domain-error helpers for common codes so controllers do not handcraft inconsistent strings.
3. Normalize Mongoose duplicate keys, validation failures, invalid ObjectIds, Multer limits/types, JWT/auth failures, and provider failures in the central error middleware.
4. Keep unexpected production failures as `SYSTEM_UNEXPECTED` with a generic message; log the technical cause server-side.
5. Make password-reset requests return the same successful response for existing and unknown emails. Email delivery/provider failures return a safe service-unavailable result without exposing SMTP details.
6. Migrate controllers by domain, retaining existing status codes where their access/state semantics matter.

## Frontend design

1. Extend `ApiError` to hold `code`, safe metadata, status, and response details.
2. Add a single error-presenter/mapping module. It maps code and context to copy, severity, field targets, recovery actions, and retry behavior. It does not match message text.
3. Add reusable `FormError`, `FieldError`, `RequestFailure`, and `RecoveryLinks` components built on the existing `ErrorBox`/`Notice` styling.
4. Update auth first: duplicate signup recovery links, safe invalid-login copy, and generic forgot-password confirmation.
5. Update course/player, purchase, assessment, certificate, instructor, and admin screens to use the shared presenter instead of displaying raw error text.
6. For `AUTH_REQUIRED`, preserve the current in-app URL in a validated redirect parameter, show a sign-in action, and reject external redirect URLs.
7. For page queries, distinguish empty content from a failed request and present a retry button.

## Data flow

```text
Controller/service/Multer/Mongoose failure
  -> AppError(code, safe message, HTTP status)
  -> central error middleware
  -> { success: false, error: { code, message }, message }
  -> ApiError(status, code, message)
  -> error presenter with screen context
  -> form/page/checkout UI with the matching recovery action
```

## Testing

- Backend tests verify representative codes, safe production output, validation normalization, duplicate signup, generic password-reset response, upload errors, payment conflicts, and access errors.
- Frontend unit tests verify API envelope parsing and code-to-copy mappings.
- Component tests verify duplicate signup and invalid-login recovery links, expired reset recovery, authentication redirect safety, retry behaviour, and preserved form input.
- Existing backend and frontend suites must remain green.

## Rollout order

1. Shared backend contract and central normalization.
2. Auth and password-reset flows.
3. Shared frontend presenter/components.
4. Student course/access, uploads, and payment flows.
5. Quizzes, assignments, certificates, instructor, and admin flows.
6. Full regression, manual browser checks, and documentation update.
