# Backend Dependency Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce backend production dependency vulnerabilities without changing any LMS runtime behavior.

**Architecture:** Keep the Express API and all application code unchanged. Use npm's reviewed compatible dependency resolution to update direct dependencies and the committed backend lockfile, while ensuring development-only `nodemon` is excluded from the Render production install. Verification relies on the existing isolated backend suite and production-focused `npm audit`.

**Tech Stack:** Node.js, npm, Express, MongoDB/Mongoose, AWS SDK for R2, Razorpay, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-23-backend-dependency-security-design.md`

## Global Constraints

- Preserve current Node/Express/Mongoose/Razorpay/R2 behavior.
- Do not commit environment files or credentials.
- Do not use `npm audit fix --force` or unreviewed major-version upgrades.
- Every dependency update must be represented in `backend/package.json` and `backend/package-lock.json`.
- Report residual audit findings rather than masking them with a breaking forced upgrade.

## Review Focus

- Production install excludes `nodemon`; verify it is absent from `npm ls --omit=dev nodemon`.
- Express still starts and honors proxy/security middleware behavior; cover this through the existing security and integration suite.
- R2 uploads/signed delivery retain existing behavior; run the R2-related backend tests.
- Razorpay order and verification flows retain their contracts; run the payment tests.
- Direct/transitive audit remediation does not introduce a lockfile/package manifest mismatch; verify with `npm ci` and `npm audit --omit=dev`.

---

### Task 1: Establish the dependency remediation baseline

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Test: existing `backend/tests/**/*.test.js`

**Interfaces:**
- Consumes: npm audit report and existing npm manifest/lockfile.
- Produces: an explicitly reviewed minimal package update diff.

- [ ] **Step 1: Capture production dependency paths and compatible candidate releases**

Run: `npm audit --omit=dev --json` and `npm outdated` from `backend`.
Expected: identify the direct/transitive paths behind each high/critical production finding before editing package versions.

- [ ] **Step 2: Select only non-breaking, audit-relevant direct dependency updates**

Update `backend/package.json` version ranges only where their upgrade remediates a reported production issue or permits npm to resolve a safe patched transitive dependency.

- [ ] **Step 3: Regenerate and review `backend/package-lock.json`**

Run npm's lockfile update for the selected manifest versions; inspect that no unrelated major-package churn or credentials entered the diff.

- [ ] **Step 4: Verify deterministic clean install**

Run: `npm ci` from `backend`.
Expected: exit code 0 with lockfile matching `package.json`.

### Task 2: Keep the development watcher out of production

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`

**Interfaces:**
- Consumes: the `dev` script's `nodemon` command.
- Produces: `nodemon` available for `npm run dev` but omitted from production dependencies.

- [ ] **Step 1: Move `nodemon` from `dependencies` to `devDependencies`**

Keep the exact existing `dev` script, and place the current compatible `nodemon` version in `devDependencies`.

- [ ] **Step 2: Refresh the lockfile and verify the development command resolves it**

Run: `npm ls nodemon` from `backend`.
Expected: a single valid development installation.

- [ ] **Step 3: Verify production omission**

Run: `npm ls --omit=dev nodemon` from `backend`.
Expected: nodemon is absent, while `npm start` remains `node server.js`.

### Task 3: Verify remediation and record residual risk

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Test: existing `backend/tests/**/*.test.js`

**Interfaces:**
- Consumes: Tasks 1–2 package and lockfile changes.
- Produces: evidence that the selected update preserves backend behavior and an accurate audit outcome.

- [ ] **Step 1: Run focused regression coverage for security, R2, and payments**

Run the relevant existing tests selected by filename from `backend/tests`.
Expected: PASS without production service credentials.

- [ ] **Step 2: Run the isolated full backend suite**

Run: `npm test -- --test-reporter=dot` from `backend` without parallel builds.
Expected: all tests pass; MongoMemoryServer is not competing with another resource-heavy process.

- [ ] **Step 3: Run the production audit**

Run: `npm audit --omit=dev --audit-level=high` from `backend`.
Expected: no high/critical findings within the safely remediable selected scope, or a precise report of any residual findings and why they were not forced.

- [ ] **Step 4: Review final diff and repository safety**

Run: `git diff --check` and `git status --short` at repository root.
Expected: only the reviewed package, lockfile, and planning documentation changes; no `.env` file is staged or modified.

- [ ] **Step 5: Hand off commit command without committing automatically**

Provide an exact root-repository `git add` command for only the reviewed files and a suggested commit message.

## Self-review

- **Spec coverage:** Tasks 1–3 cover safe remediation, lockfile refresh, production-only watcher removal, test/audit verification, and residual-risk reporting. Frontend and deployment changes remain explicitly excluded.
- **Step scan:** Each task produces an independently checkable outcome: reviewed dependency diff, production dependency boundary, and verified remediation.
- **Type consistency:** This plan does not add application interfaces or types.
- **Review focus:** The five material regression paths are assigned to Task 2 or Task 3 commands.
- **Proportion:** Three tightly scoped maintenance tasks correspond directly to the small approved design and avoid prescribing package versions before the live audit establishes compatibility.
