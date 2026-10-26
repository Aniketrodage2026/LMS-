# Backend Dependency Security Remediation — Design

## Intent

Remove the backend runtime dependency vulnerabilities that block a real paid
production launch, without changing LMS features or destabilizing the working
staging deployment.

## Goals

- Update backend dependencies only when they address the reported production
  audit findings and can be validated against the existing automated suite.
- Refresh `backend/package-lock.json` so Render installs the reviewed versions
  reproducibly with `npm ci`.
- Move `nodemon` to `devDependencies`; production starts with `node server.js`
  and does not need the development watcher.
- Verify the backend test suite, production dependency audit, and application
  startup/smoke behavior after the update.

## Non-goals

- No frontend dependency update or frontend lockfile in this task.
- No API, database schema, authentication, payment, R2, upload, or UI changes.
- No use of `npm audit fix --force`, broad "upgrade everything" changes, or
  unreviewed major-version upgrades.
- No production deployment or secret changes in this task.

## Constraints

- Preserve the current Node/Express/Mongoose/Razorpay/R2 behavior.
- Do not commit environment files or credentials.
- Every package change must be represented in `package.json` and the lockfile,
  and verified before handoff.

## Approaches considered

1. **Targeted safe update (selected):** identify direct and transitive paths
   behind the audit findings, update only compatible packages/lockfile entries,
   and move `nodemon` to development dependencies. This offers the best balance
   of risk reduction and stability for the already deployed LMS.
2. **Full backend modernization:** update all packages to current releases.
   Rejected for this task because it introduces unnecessary compatibility risk
   in payment, upload, database, and media workflows.
3. **Audit-only:** document the findings but make no changes. Rejected because
   it leaves the production security blocker unresolved.

## Proposed implementation

1. Capture the current production audit and dependency paths for each
   high/critical finding.
2. Select minimal compatible direct dependency updates and regenerate the
   backend lockfile using npm; manually review the resulting package and
   lockfile diff.
3. Relocate `nodemon` from `dependencies` to `devDependencies`.
4. Run `npm audit --omit=dev --audit-level=high`, the complete isolated backend
   test suite, and startup/smoke checks. Any unexpected functional regression
   stops the task for investigation instead of being silently worked around.
5. Report residual vulnerabilities accurately. If a finding has no safe
   remediation within the selected scope, leave it documented rather than
   applying a breaking forced upgrade.

## Builder review

This is a deliberately narrow maintenance task. No product behavior changes
are expected; the existing comprehensive backend tests and staging smoke checks
are the acceptance criteria. A separate future task will address frontend
lockfile/reproducibility and its own dependency audit.
