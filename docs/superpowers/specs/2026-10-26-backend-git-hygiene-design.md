# Backend Git Hygiene and Secret Exposure Remediation — Design

## Intent

Make the nested `backend` repository safe and maintainable for deployment by
stopping generated dependencies and local secrets from being tracked by Git.

## Goals

- Add a backend-specific `.gitignore` for `node_modules/`, `.env`, test output,
  and other local-only artifacts.
- Remove the already tracked `node_modules/` and `.env` paths from the Git
  index without deleting the user's local files.
- Preserve `package.json`, `package-lock.json`, `.env.example`, source files,
  tests, and deployment configuration.
- Provide an explicit post-commit secret-rotation checklist for all credentials
  that may have appeared in `.env` or prior Git history.

## Non-goals

- Do not delete local dependency installations or environment files.
- Do not rewrite Git history, force-push, or deploy in this task.
- Do not rotate secrets automatically or expose any secret values.
- Do not mix unrelated R2 migration, test, README, or dependency changes into
  the hygiene commit.

## Constraints

- `backend` is an independent nested Git repository; commands run from
  `C:\Users\anike\Desktop\LMS\backend`.
- The removal from Git tracking must use `git rm --cached`, never a filesystem
  delete.
- The final commit must contain only `backend/.gitignore` and index removals
  for `backend/.env` and `backend/node_modules/`.

## Approaches considered

1. **Full safety cleanup (selected):** ignore and untrack both generated
   dependencies and `.env`, then rotate potentially exposed secrets. This
   removes ongoing accidental disclosure risk while preserving the local
   development environment.
2. **Generated dependencies only:** smaller change, but leaves `.env` exposed
   in current and future commits. Rejected as unsafe for a deployed LMS.
3. **Audit-only:** no protection against future accidental commits. Rejected.

## Proposed implementation

1. Inspect the backend repository's tracked paths and confirm the exact `.env`
   and `node_modules` targets.
2. Add a focused `.gitignore` without ignoring templates such as `.env.example`
   or dependency manifests.
3. Use index-only untracking for `.env` and `node_modules`; verify their local
   files still exist and Git now reports them as ignored.
4. Inspect the staged diff to ensure it contains no application-source changes
   and no file contents from `.env`.
5. Provide safe commit/push commands and a manual rotation checklist for JWT,
   MongoDB, R2, Razorpay, Cloudinary legacy credentials, SMTP, and any other
   credential stored in the old environment file.

## Acceptance criteria

- `git check-ignore` confirms both `.env` and `node_modules` are ignored.
- `git ls-files` returns no tracked paths beneath `node_modules` and no `.env`.
- The local `.env` and installed `node_modules` directory still exist.
- The index-only cleanup is ready for a narrow commit without staging unrelated
  working-tree changes.
