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

The client appends `/api/v1` itself. Start the development server with `bun run dev`.

For the backend CORS configuration, `FRONTEND_URL` in `backend/.env` must **exactly equal** the browser origin reported by Vite, including the protocol, hostname, and port (normally `http://localhost:5173`). For example:

```dotenv
FRONTEND_URL=http://localhost:5173
```

The local frontend port must exactly match `FRONTEND_URL`. If Vite selects another port, update the backend configuration or restart Vite on the configured port. `VITE_API_BASE_URL` identifies the backend origin and `FRONTEND_URL` identifies the frontend origin; they normally have different ports. Use the same hostname for both local services (for example, `localhost` for both) and restart each service after changing its environment.

Authentication uses an HTTP-only `token` cookie. The backend enables credentialed CORS only for the matching frontend origin, and the client API wrapper uses `credentials: 'include'`. Do not remove that option or try to store the token in browser storage. Development cookies use `SameSite=Lax`; production cookies use `SameSite=None` and `Secure`, requiring HTTPS.

Run the client checks from `frontend`:

```sh
bun run test
bun run lint
bun run build
```

The test and build scripts can also be run with `npm test` and `npm run build` when dependencies are installed.

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

The backend source is included in `backend`; see its [setup instructions](../backend/README.md). Live end-to-end checks can use a configured local or external backend at `VITE_API_BASE_URL`, with the matching `FRONTEND_URL`, a reachable MongoDB instance, and the relevant SMTP and Cloudinary services. Paid-course verification also requires MongoDB transaction support and Razorpay **Test Mode** credentials. Automated checks mock integrations and do not verify live email, upload, or checkout behavior.

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
