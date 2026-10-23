# Free Staging Deployment Checklist

> **For agentic workers:** This is an operations checklist, not an application-code feature. Execute one task at a time and stop for approval before moving to the next task.

**Goal:** Deploy a public, test-only version of the LMS without a custom domain, while preserving MongoDB Atlas, private Cloudflare R2 media, and Razorpay Test Mode.

**Architecture:** Deploy the existing TanStack Start frontend to Cloudflare Workers at a temporary `*.workers.dev` URL. Deploy the existing Express backend to Render at a temporary `*.onrender.com` URL. MongoDB Atlas and the private R2 bucket remain external managed services. Because those temporary URLs are cross-site, successful browser login/session persistence is an explicit staging gate, not an assumption.

**Tech Stack:** Cloudflare Workers, Render Node.js Web Service, MongoDB Atlas, Cloudflare R2, Razorpay Test Mode, SMTP provider.

## Global Constraints

- Never commit, paste, upload, or expose any `.env` file, database URI, JWT secret, R2 key, SMTP password, or Razorpay secret.
- Keep `R2_ENABLED=true`; the existing bucket `lms-media-private` must remain private.
- Use Razorpay Test Mode keys only; do not accept live customer payments in staging.
- Deploy the root repository, but configure backend commands with `backend` as Render's root directory and frontend commands with `frontend` as the Cloudflare deployment directory.
- Do not enable public R2 access or change the backend's authorization logic merely to simplify staging.
- Do not promote staging as production until the browser cookie/session gate passes.

## Review Focus

- Browser blocks the cross-site authentication cookie between `workers.dev` and `onrender.com`; prove register, login, refresh, protected API call, and logout in an ordinary browser.
- A mismatched `FRONTEND_URL` causes credentialed CORS failures; use the exact Cloudflare URL including `https://` and no trailing slash.
- A wrong build-time `VITE_API_BASE_URL` leaves the browser calling `localhost`; rebuild/redeploy the frontend after its value changes.
- Missing R2 variables make uploads silently fall back or fail; confirm a new upload appears in the private bucket and is readable only through LMS authorization.
- Unrestricted Atlas network access or leaked secrets expose user data; retain a database backup/export and restrict Atlas access once the Render outbound IP strategy is known.

---

### Task 1: Pre-deployment baseline and secret inventory

**Files:**
- Review: `.gitignore`
- Review: `backend/.env.example`
- Review: `backend/README.md`

**Produces:** A local, private list of the staging variables to enter in provider dashboards. No secrets are added to Git.

- [ ] Confirm `git status` is clean after the latest commit.
- [ ] Run locally: `cd backend; npm test`.
- [ ] Run locally: `cd frontend; npm test; npm run build`.
- [ ] In MongoDB Atlas, create a backup/export point before inviting any external testers.
- [ ] Confirm the local backend `.env` has non-placeholder values for `DB_URL`, `JWT_SECRET`, `R2_ENABLED`, all required `R2_*` variables, SMTP variables, and Razorpay **test** keys.
- [ ] Generate a new, strong staging `JWT_SECRET`; do not reuse a value that was ever posted or shared.

**Verification:** Local tests and production build pass; no `.env` file appears in `git status`.

### Task 2: Deploy the Express backend to Render

**Files:**
- Deploy from: `backend/`
- Entry point: `backend/server.js`
- Health endpoint: `GET /health`
- Readiness endpoint: `GET /ready`

**Produces:** A Render URL in the form `https://<staging-api-name>.onrender.com`.

- [ ] Create a Render Web Service connected to the GitHub repository.
- [ ] Set the Render root directory to `backend`.
- [ ] Set build command to `npm ci` and start command to `npm start`.
- [ ] Configure health check path as `/health`.
- [ ] Add server-only environment variables in Render: `NODE_ENV=production`, `PORT` (only if Render requires an explicit value), `TRUST_PROXY=true`, `DB_URL`, `JWT_SECRET`, `R2_ENABLED=true`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` if used locally, `R2_SIGNED_URL_TTL_SECONDS=600`, SMTP variables, `RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET`.
- [ ] Set the required `FRONTEND_URL` initially to a harmless placeholder such as `https://placeholder.invalid`; replace it in Task 3 with the exact Cloudflare URL. Do not set `*` as a CORS origin.
- [ ] After deployment, open `https://<staging-api-name>.onrender.com/health` and `/ready`; both must return HTTP 200.

**Verification:** Render logs show a successful MongoDB connection, `/health` returns `{ "success": true, "status": "ok" }`, and `/ready` reports `ready`.

### Task 3: Deploy the frontend to Cloudflare Workers

**Files:**
- Deploy from: `frontend/`
- Build command: `npm run build`
- Browser API configuration: `frontend/src/lib/api/client.ts`

**Produces:** A Cloudflare URL in the form `https://<staging-app-name>.workers.dev`.

- [ ] Create a Cloudflare Worker deployment connected to the GitHub repository, using `frontend` as the root directory.
- [ ] Set build command to `npm ci && npm run build` and use the generated Nitro/Workers output required by the Cloudflare deployment workflow.
- [ ] Set the build-time public variable `VITE_API_BASE_URL=https://<staging-api-name>.onrender.com` without `/api/v1`.
- [ ] Deploy and record the exact `https://<staging-app-name>.workers.dev` URL.
- [ ] In Render, set `FRONTEND_URL` to that exact Cloudflare URL, then redeploy the backend.
- [ ] Redeploy the frontend after confirming its `VITE_API_BASE_URL` value.

**Verification:** Opening the Workers URL renders the LMS and browser Network requests target the Render backend URL, never `localhost:5000`.

### Task 4: Prove cross-site authentication and core learning flows

**Files:**
- Verify: `backend/controller/user.controller.js`
- Verify: `frontend/src/lib/api/client.ts`

**Produces:** Evidence that the temporary cross-site staging URLs work in real browsers, or a documented cookie blocker that prevents public staging until a custom domain is available.

- [ ] In a normal desktop browser, register a new staging Student.
- [ ] Log in, refresh the page, and confirm the session remains authenticated.
- [ ] Open a protected route and confirm its API request succeeds with credentials.
- [ ] Log out and confirm the protected route is denied.
- [ ] Repeat login/refresh/logout on a mobile browser or a second desktop browser.
- [ ] If any browser blocks the cookie, stop the public-staging rollout. Do not weaken cookie security or store the JWT in browser storage; use a custom domain later or design a same-origin proxy separately.

**Verification:** Login, refresh, protected API request, and logout succeed in two browsers without CORS or cookie warnings.

### Task 5: Validate storage, payments, and controls

**Files:**
- Verify: `backend/services/media-storage.service.js`
- Verify: `backend/services/video-delivery.service.js`
- Verify: `backend/controller/purchase.controller.js`

**Produces:** A tested staging platform with no public R2 access and no live payment collection.

- [ ] As an Instructor, upload a new avatar, course thumbnail, preview lecture, paid lecture, and assignment attachment.
- [ ] Confirm the new objects appear in `lms-media-private` and direct object access remains denied.
- [ ] As a logged-out visitor, verify only preview media is accessible.
- [ ] As a Student without purchase, verify paid media is denied.
- [ ] Complete a Razorpay Test Mode purchase using a simulated supported test method; confirm it appears as captured in the Test Mode dashboard and grants access only after backend verification.
- [ ] Submit an assignment as the purchaser and confirm only the appropriate instructor/admin can review it.
- [ ] Review Render logs for unhandled errors and Cloudflare/Atlas dashboards for unexpected access failures.

**Verification:** Protected delivery, purchase authorization, assignment permissions, and private R2 behavior match the local flow.

### Task 6: Staging handoff and production decision

**Files:**
- Update after tests: `backend/README.md` only if an environment/deployment instruction is missing or incorrect.

**Produces:** A go/no-go decision for buying a domain and preparing production.

- [ ] Record the frontend and backend staging URLs privately.
- [ ] Record completed tests and unresolved browser/device issues.
- [ ] Keep Razorpay in Test Mode and leave all live keys absent.
- [ ] Decide whether staging is stable enough to buy a domain for reliable `app.<domain>` and `api.<domain>` subdomains.
- [ ] Only after that decision, create a separate production deployment checklist covering a custom domain, live Razorpay activation/KYC, webhook validation, backup schedule, and monitoring.

**Verification:** The platform is either accepted as a staging demo or explicitly blocked by the cookie/domain limitation; neither result is treated as a production launch.

## Execution Order

1. Task 1 — local baseline and secret inventory.
2. Task 2 — backend deployment and health checks.
3. Task 3 — frontend deployment and exact CORS configuration.
4. Task 4 — browser session gate.
5. Task 5 — protected-content and Test Mode commerce gate.
6. Task 6 — handoff and production decision.
