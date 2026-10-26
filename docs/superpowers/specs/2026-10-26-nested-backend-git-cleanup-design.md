# Nested Backend Git Cleanup Design

## Intent

Make `LMS` the only Git repository used for the project. The accidental
`backend/.git` repository currently creates a second, disconnected history and
caused pushes from `backend` to fail. This cleanup must retain all backend
source files, local dependencies, local environment file, and recoverable
history.

## Goals

- Preserve the nested repository's commits and current uncommitted changes in
  a local backup before removing its Git metadata.
- Verify the root `LMS` repository already tracks the backend application
  source that belongs in the main project.
- Remove only `backend/.git`, leaving `backend` itself intact.
- Keep `backend/.env` and `backend/node_modules` local and ignored.
- Use the root repository (`C:\Users\anike\Desktop\LMS`) for all future
  commits and pushes.

## Non-goals

- Do not delete backend source files, `.env`, `node_modules`, or MongoDB/R2
  data.
- Do not rewrite published Git history.
- Do not push the nested `master` branch or create a separate backend GitHub
  repository.

## Current State

- The root repository is on `main`, tracks the backend source, and has the
  GitHub `origin` remote.
- `backend` contains a nested Git repository on `master` with no remote.
- The nested repository has three local commits and uncommitted source files.
- Its latest cleanup commit stopped tracking `.env` and `node_modules`; those
  files still exist locally and are covered by `backend/.gitignore`.

## Approaches Considered

1. **Preserve then remove the nested metadata (chosen).** Create a local Git
   bundle and a patch for the nested working tree, compare important source
   paths against the root repository, then remove only `backend/.git`. This
   eliminates future Git confusion while retaining recovery artifacts.
2. **Keep both repositories.** No immediate metadata deletion, but backend
   commands continue to target a disconnected repository and may be committed
   or pushed from the wrong location.
3. **Make backend a separate repository/submodule.** This creates unnecessary
   deployment and collaboration overhead for a single LMS repository.

## Chosen Flow

1. Create a timestamped local backup directory outside `backend/.git`.
2. Export all nested references to a Git bundle and export uncommitted changes
   to a patch file. Record the nested status and recent commit IDs in a text
   manifest.
3. Confirm the backup files can be read and inspect a concise list of changed
   paths. Compare root-tracked backend paths against the nested working tree
   where necessary; do not overwrite either version.
4. Remove only `backend/.git` after the backup and comparison are successful.
5. Verify Git commands inside `backend` now resolve to the root `LMS` repo,
   `backend/.env` and `backend/node_modules` remain on disk and ignored, and
   the backend dependency tree can still be read.
6. Leave any differences that were previously uncommitted visible to the root
   repository, so they can be reviewed and committed deliberately later.

## Safety and Recovery

The cleanup is recoverable: the Git bundle can recreate the nested history,
and the patch can restore its uncommitted changes. No source file deletion is
part of the operation. If verification fails at any point, stop before
removing `backend/.git`.

## Builder Decisions

- Store the backup under a root-level ignored `backups/` directory so it is
  local and does not contain secrets in GitHub.
- Use an ISO-like timestamp in the backup folder name to avoid overwriting an
  earlier backup.
- Keep the existing root `.gitignore` and `backend/.gitignore`; no dependency
  installation or application-code change is needed.
