# Backend Git Hygiene and Secret Exposure Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Git from tracking backend dependencies and local secrets while preserving the local development environment.

**Architecture:** The nested `backend` repository will gain a focused `.gitignore`. Git index entries for `.env` and `node_modules/` will be removed with `git rm --cached`, which intentionally leaves the real local files in place; no source code or deployment settings change.

**Tech Stack:** Git, PowerShell, npm project conventions.

**Spec:** `docs/superpowers/specs/2026-10-26-backend-git-hygiene-design.md`

## Global Constraints

- Run repository commands from `C:\Users\anike\Desktop\LMS\backend`.
- Use `git rm --cached`; never delete the local `.env` file or `node_modules` directory.
- Do not rewrite history, force-push, deploy, or rotate credentials automatically.
- Do not stage unrelated R2 migration, test, README, package, or application-source changes.

## Review Focus

- `.env.example` remains trackable while `.env` is ignored.
- `node_modules/` is ignored without preventing npm from installing dependencies locally.
- Untracking uses index-only removal and leaves the local `.env` and dependency directory present.
- The staged diff contains only `.gitignore`, `.env`, and `node_modules/` removal entries.
- The user receives a complete manual rotation checklist for potentially exposed credentials.

---

### Task 1: Define backend ignore rules

**Files:**
- Create: `backend/.gitignore`

**Interfaces:**
- Consumes: tracked `backend/.env` and `backend/node_modules/` paths.
- Produces: ignore rules that preserve `.env.example`, package manifests, source, and test files.

- [ ] **Step 1: Create focused ignore rules**

Add `node_modules/`, `.env`, `.env.*` with an explicit `!.env.example` exception, and standard local log/coverage entries to `backend/.gitignore`.

- [ ] **Step 2: Verify ignore behavior before untracking**

Run: `git check-ignore -v .env node_modules package.json .env.example`.
Expected: `.env` and `node_modules` match ignore rules; `package.json` and `.env.example` do not.

### Task 2: Remove generated and secret files from the Git index

**Files:**
- Modify (index only): `backend/.env`
- Modify (index only): `backend/node_modules/**`

**Interfaces:**
- Consumes: Task 1 ignore rules.
- Produces: untracked-but-preserved local environment and dependency files.

- [ ] **Step 1: Confirm local targets exist**

Run: `Test-Path .env; Test-Path node_modules`.
Expected: both return `True` before the index-only cleanup.

- [ ] **Step 2: Remove index entries without deleting local files**

Run `git rm -r --cached --ignore-unmatch node_modules` and `git rm --cached --ignore-unmatch .env` from `backend`.

- [ ] **Step 3: Confirm local preservation and untracking**

Run: `Test-Path .env; Test-Path node_modules; git ls-files .env node_modules`.
Expected: both paths still exist locally and `git ls-files` produces no entries for either target.

### Task 3: Verify a narrow, safe handoff

**Files:**
- Create: `backend/.gitignore`
- Modify (index only): `backend/.env`
- Modify (index only): `backend/node_modules/**`

**Interfaces:**
- Consumes: Tasks 1–2 cleanup.
- Produces: a safe staged commit and manual secret-rotation handoff.

- [ ] **Step 1: Inspect staged scope and secret safety**

Run: `git diff --cached --stat`, `git diff --cached --name-only`, and `git diff --cached -- .gitignore`.
Expected: no application source, package manifest, R2 migration, or secret content is added to the staged diff.

- [ ] **Step 2: Verify normal install metadata remains usable**

Run: `npm ci --ignore-scripts` only if `node_modules` needs recreation; otherwise run `npm ls --depth=0`.
Expected: dependency metadata resolves independently of Git tracking.

- [ ] **Step 3: Hand off commit and rotation instructions without committing**

Provide exact commands that stage only `.gitignore`, `.env`, and `node_modules` index removals, plus rotation steps for MongoDB, JWT, R2, Razorpay, Cloudinary legacy credentials, SMTP, and any credentials kept in the historical `.env`.

## Self-review

- **Spec coverage:** The three tasks cover ignoring, index-only removal, preservation checks, narrow staging, and manual secret rotation.
- **Step scan:** Every command has a single observable safety result; no task changes LMS behavior.
- **Type consistency:** No application interfaces are introduced.
- **Review focus:** Each safety failure mode is assigned to a verification step.
- **Proportion:** This is a narrow maintenance plan appropriate for a small but security-sensitive Git cleanup.
