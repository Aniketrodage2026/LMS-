# Nested Backend Git Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely remove the accidental `backend/.git` repository so the root LMS repository is the only Git repository used.

**Architecture:** Export the nested Git history and working-tree changes into a timestamped, ignored root-level backup directory. Verify those artifacts and the root repository's backend tracking before deleting only the nested `.git` directory; then prove the backend resolves to the root repository and local ignored files remain available.

**Tech Stack:** Git for Windows, PowerShell, existing Node.js dependency tree.

**Spec:** `docs/superpowers/specs/2026-10-26-nested-backend-git-cleanup-design.md`

## Global Constraints

- Never delete backend source files, `.env`, `node_modules`, or any database/media data.
- Do not rewrite root `main` history or push from the nested repository.
- Create backup artifacts before deleting `backend/.git`.
- Stop immediately if backup or verification fails.
- Keep secrets out of backup manifests, patches, commits, and command output.
- Use `C:\Users\anike\Desktop\LMS` as the only future Git repository root.

## Review Focus

- Nested history includes all refs, not only the current `master` branch; verify bundle integrity in Task 1.
- Uncommitted source changes are preserved without including ignored `.env` or `node_modules`; verify patch path list in Task 1.
- Backup storage is ignored by the root repo; verify it is not staged in Task 1.
- The deletion target is exactly `backend/.git`, never the `backend` folder; resolve and print the target path in Task 2.
- After cleanup, backend Git commands resolve to root `main` and Node dependencies still resolve; verify in Task 2.

---

## File Structure

- Create: `backups/nested-backend-git-<timestamp>/backend-history.bundle` — recoverable copy of all nested Git refs.
- Create: `backups/nested-backend-git-<timestamp>/working-tree.patch` — recoverable copy of nested tracked working-tree changes only.
- Create: `backups/nested-backend-git-<timestamp>/manifest.txt` — non-secret status, recent commit IDs, and changed path inventory.
- Modify: `backend/.git` — remove only after Task 1 backup verification passes.
- No application source, dependencies, or environment file changes are expected.

### Task 1: Preserve and Verify Nested Repository State

**Files:**
- Create: `backups/nested-backend-git-<timestamp>/backend-history.bundle`
- Create: `backups/nested-backend-git-<timestamp>/working-tree.patch`
- Create: `backups/nested-backend-git-<timestamp>/manifest.txt`

**Interfaces:**
- Consumes: nested repository at `backend/.git` and root `.gitignore`.
- Produces: a verified backup directory path for Task 2.

- [ ] **Step 1: Confirm the working directory is the root LMS repository and record the nested repository identity**

Run: `git status --short --branch`, `git -C backend status --short --branch`, and `git -C backend log -3 --oneline`.

Expected: root is `main` with GitHub origin; nested repository is `master` with no remote and its current changes are visible.

- [ ] **Step 2: Create a timestamped local backup folder under `backups/` and export all nested refs**

Run `git -C backend bundle create <backup-folder>\\backend-history.bundle --all`.

Expected: the command exits successfully and writes the bundle without exposing file contents or secrets.

- [ ] **Step 3: Export only tracked working-tree changes to `working-tree.patch` and write a non-secret manifest**

Use `git -C backend diff --binary` for the patch. The manifest records branch, commit IDs, `git status --short`, and names of untracked files only—never `.env` values or dependency contents.

Expected: changed source files are recoverable; ignored `.env` and `node_modules` are absent.

- [ ] **Step 4: Verify the backup artifacts and root tracking**

Run: `git bundle verify <backup-folder>\\backend-history.bundle`; inspect the patch and manifest path lists; run `git check-ignore -v <backup-folder>` and `git ls-files backend`.

Expected: bundle verifies, root ignores `backups/`, and root tracks the backend source tree.

- [ ] **Step 5: Stop for review before removal**

Report the backup folder path, bundle verification result, concise list of preserved uncommitted paths, and any source path that differs from root tracking. Do not delete `backend/.git` until this task is accepted.

### Task 2: Remove Nested Metadata and Verify Single-Repository Behavior

**Files:**
- Modify: `backend/.git` (delete directory only after Task 1 approval)

**Interfaces:**
- Consumes: verified backup directory produced by Task 1.
- Produces: a backend directory governed by the root `LMS/.git` repository.

- [ ] **Step 1: Resolve and display the exact deletion target**

Run `Resolve-Path backend\\.git` and confirm the result is `C:\Users\anike\Desktop\LMS\backend\.git`.

Expected: target is a nested metadata directory, not the backend application directory.

- [ ] **Step 2: Remove only `backend/.git`**

Use PowerShell `Remove-Item -LiteralPath 'C:\Users\anike\Desktop\LMS\backend\.git' -Recurse -Force` only after the target check and Task 1 approval.

Expected: metadata directory no longer exists; `backend` application files remain.

- [ ] **Step 3: Verify backend now resolves to the root repository**

Run from `backend`: `git rev-parse --show-toplevel`, `git branch --show-current`, and `git status --short`.

Expected: top-level path is `C:\Users\anike\Desktop\LMS`, branch is `main`, and any formerly nested uncommitted source changes appear as root-repository changes.

- [ ] **Step 4: Verify ignored local files and dependency availability**

Run `Test-Path backend\\.env`, `Test-Path backend\\node_modules`, `git check-ignore -v backend\\.env backend\\node_modules`, and `npm --prefix backend ls --depth=0`.

Expected: `.env` and `node_modules` remain on disk, are ignored, and the dependency tree returns successfully.

- [ ] **Step 5: Final cleanliness and recovery verification**

Run `git status --short --branch`, `git diff --check`, and `git bundle verify <backup-folder>\\backend-history.bundle` one final time.

Expected: root status contains only intended changes/artifacts; no whitespace errors; recovery bundle remains valid.

- [ ] **Step 6: Commit only intentional repository metadata/documentation changes**

Do not commit the ignored backup folder, `.env`, or `node_modules`. If no tracked root file changed during Task 2, make no commit; report that cleanup was metadata-only.

## Self-Review

- **Spec coverage:** Tasks 1–2 cover backup, verification, deletion of only nested metadata, ignored local files, root-repository operation, and recovery. No source or service changes are required.
- **Step scan:** Each command has a fixed target and expected result; deletion occurs only after a dedicated target-resolution step and Task 1 review.
- **Type consistency:** Task 1 produces `<backup-folder>` and Task 2 consumes the same verified folder.
- **Review focus:** Each listed failure mode has a corresponding verification step in Task 1 or Task 2.
- **Proportion:** Two independently reviewable tasks match the two safety boundaries: preservation, then removal.
