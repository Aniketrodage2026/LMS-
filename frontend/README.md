# LMS client

The browser client is a Lovable-generated TanStack Start application that talks to the Express API in `backend`.

## Local setup

Install [Bun](https://bun.sh/) first. From the repository root, install and configure the client:

```powershell
cd frontend
bun install
Copy-Item .env.example .env
```

Set `VITE_API_BASE_URL` in `frontend/.env` to the Express server **origin** (not an API path). For the included local server configuration, use:

```dotenv
VITE_API_BASE_URL=http://localhost:5000
```

The client appends `/api/v1` itself. `VITE_API_BASE_URL` is injected at Vite build time, so changing it requires a new frontend build and redeploy (or a local dev-server restart). Start the development server with `bun run dev`.

For the backend CORS configuration, `FRONTEND_URL` in `backend/.env` must **exactly equal** the browser origin reported by Vite, including the protocol, hostname, and port (normally `http://localhost:5173`). For example:

```dotenv
FRONTEND_URL=http://localhost:5173
```

The local frontend port must exactly match `FRONTEND_URL`. If Vite selects another port, update the backend configuration or restart Vite on the configured port. `VITE_API_BASE_URL` identifies the backend origin and `FRONTEND_URL` identifies the frontend origin; they normally have different ports. Use the same hostname for both local services (for example, `localhost` for both) and restart each service after changing its environment.

Authentication uses an HTTP-only `token` cookie. The backend enables credentialed CORS only for the matching frontend origin, and the client API wrapper uses `credentials: 'include'`. Do not remove that option or try to store the token in browser storage. Development cookies use `SameSite=Lax`; production cookies use `SameSite=None` and `Secure`, requiring HTTPS. CORS does not bypass browser third-party-cookie restrictions, so prefer same-site HTTPS subdomains such as `app.example.com` and `api.example.com` and verify login/session persistence in a production-like browser before rollout.

Run the client checks from `frontend`:

```sh
bun run test
bun run lint
bun run build
```

The test and build scripts can also be run with `npm test` and `npm run build` when dependencies are installed.

## Production API and private-media configuration

The frontend is never an R2 client. Do not add R2 access keys, secrets, bucket names, object keys, endpoints, or signed URLs to `frontend/.env`, a `VITE_*` variable, source code, browser storage, or logs. R2 credentials belong exclusively in backend deployment secrets; the browser receives only the short-lived URL needed by the current authorized action.

For production, set `VITE_API_BASE_URL` to the HTTPS backend origin without `/api/v1` and set the backend `FRONTEND_URL` to the exact HTTPS frontend origin. CORS and the HTTP-only authentication cookie depend on this exact pairing, but browser third-party-cookie policy can still block cross-site sessions. Prefer same-site HTTPS subdomains and require a real production-like login/session persistence check before enabling R2. Because `VITE_API_BASE_URL` is Vite build-time injected, a change requires rebuilding and redeploying the frontend. Deploy frontend and backend with their matching environment values before enabling backend `R2_ENABLED=true`.

### Private-media release checks

After backend automated tests and this frontend build pass, use a non-production environment first. Verify the following from real browser sessions:

1. Upload an avatar and an instructor course thumbnail.
2. Upload and play a preview lecture while logged out.
3. Upload and play a paid lecture only with a purchasing/enrolled student; confirm a student without access is denied.
4. Upload an assignment file and confirm its download is available only to its owner, the course instructor/manager, and an admin.
5. Confirm a copied unsigned/direct R2 object URL is rejected rather than serving media.
6. Sign in, refresh and navigate between protected pages, then close and reopen the browser as appropriate for the intended session policy. Confirm the production-like frontend/backend origin pair preserves the HTTP-only session cookie; CORS headers alone are not proof that cross-site browser-cookie policies will permit it.

The browser should use the existing backend API contracts only. If any check fails, stop rollout and have the backend operator disable R2; legacy Cloudinary media remains available during the planned migration rollback window. The backend runbook documents the required private bucket, least-privilege Object Read & Write token, dry-run migration, and approval steps.

## API errors and password recovery

The backend error middleware returns HTTP failures with the following envelope:

```json
{
  "success": false,
  "message": "Please sign in to continue.",
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Please sign in to continue."
  }
}
```

The API client reads `error.code` and the shared error presenter maps it to safe user messages and recovery actions. Examples include signing in, requesting a new reset link, correcting assessment details, or checking purchases before retrying payment verification. Arbitrary server messages, stack traces, and provider diagnostics are not shown to users; approved validation copy and safe fallbacks cover unknown codes, network errors, and legacy failure responses without `error.code` (including the backend's unmatched-route `404`).

Successful password-reset requests show the same confirmation for known and unknown email addresses: "If an account exists for this email, a reset link is on its way." This does not confirm that an account exists or that an email was delivered. Existing accounts need the backend's SMTP configuration to receive a link. Expired or invalid reset links offer a new reset request; service failures show safe retry guidance.

## Live integration checks

The backend source is included in `backend`; see its [setup instructions](../backend/README.md). Live end-to-end checks can use a configured local or external backend at `VITE_API_BASE_URL`, with the matching `FRONTEND_URL`, a reachable MongoDB instance, and the relevant SMTP, Cloudinary, and private-R2 backend services. Paid-course verification also requires MongoDB transaction support and Razorpay **Test Mode** credentials. Automated checks mock integrations and do not verify live email, upload, checkout, or R2 behavior.

Use Razorpay Test Mode for development checkout. Live webhooks, refunds, and production payment activation are out of scope.

## Admin operations and moderation

`/admin` is an authenticated, admin-only workspace with five sections: Overview, Users, Courses, Payments, and Activity. The UI uses `/admin` for Overview, `/admin/users` for Users, `/admin/courses` for Courses, `/admin/payments` for Payments, and `/admin/analytics` for Activity.

Lists use server cursor pagination: the default `limit` is 25 and accepted values are 1–50. Treat `nextCursor` values as opaque and send them back unchanged. User and course search values are safely handled as literal text (trimmed and limited to 100 characters); the available filters are user role, course status, and purchase course ID. Invalid cursor or filter values receive safe validation errors.

Users lists and filters every role, but role changes can only switch non-admin users between Student and Instructor; the workspace cannot assign or demote Admin users. Courses provides only Publish/Unpublish moderation. Payments and Overview show verified purchase/report data only, while Activity presents audited events as read-only records. The workspace does not implement suspension or deletion, refunds, exports, charts, custom date ranges, or ownership transfer.

Admin reports and UI never display payment-provider, order, payment, or signature IDs, credentials, cookies, JWTs, password fields, or password-reset fields. For local validation, run `npm test` and `npm run build` from this directory; the API tests run with `npm test` from `backend`.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## Lovable integration

This project is connected to [Lovable](https://lovable.dev). Avoid rewriting published git history (for example, force-pushing or rebasing already-pushed commits), because that can break Lovable project history.
