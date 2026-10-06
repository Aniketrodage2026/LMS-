# LMS server

The API requires Node.js (use a current Node.js LTS release) and a reachable MongoDB instance. Create a local `.env` from `.env.example` before starting it. The `.env` file is local and ignored by Git; never commit secrets.

## Local commands

Run these commands from this `server` directory:

```bash
npm install
npm test
npm run dev
```

With the API running, check its health endpoint:

```bash
curl http://localhost:5000/health
```

The expected response is:

```json
{ "success": true, "status": "ok" }
```

## Environment

Copy `.env.example` to `.env` and replace its placeholders locally with your own values. Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (the local example uses `5000`). |
| `DB_URL` | MongoDB connection string. MongoDB must be running and reachable before `npm run dev`; paid-payment verification requires a transaction-capable replica set (including a single-node replica set). |
| `JWT_SECRET` | Canonical signing secret required at startup. Use a strong local secret. |
| `JWT_EXPIRY` | JWT expiration period, for example `7d`. |
| `FRONTEND_URL` | Allowed frontend origin for credentialed CORS requests. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for media storage. |
| `CLOUDINARY_CLOUD_API_KEY` | Cloudinary API key for media storage. |
| `CLOUDINARY_CLOUD_API_SECRET` | Cloudinary API secret for media storage. |
| `SMTP_EMAIL` | SMTP sender/account email for application email. |
| `SMTP_PASSWORD` | SMTP password or provider app password. |
| `RAZORPAY_KEY_ID` | Razorpay **Test Mode** key ID for local development only. |
| `RAZORPAY_KEY_SECRET` | Razorpay **Test Mode** key secret for local development only. |
| `RAZORPAY_PLAN_ID` | Razorpay plan ID used by the legacy subscription endpoints. |

`DB_URL`, `JWT_SECRET`, `JWT_EXPIRY`, and `FRONTEND_URL` are validated during server startup. The Cloudinary, SMTP, and Razorpay values are supplied locally when using their corresponding integrations. Keep Razorpay Test Mode credentials only in your uncommitted local `.env`; no real credentials belong in this repository.

## Student learning progress

Student-only learning progress endpoints require an active course enrollment:

```text
PATCH /api/v1/courses/:courseId/lectures/:lectureId/progress
POST  /api/v1/courses/:courseId/lectures/:lectureId/complete
GET   /api/v1/courses/:courseId/progress
GET   /api/v1/me/learning
```

The video client sends `watchedSeconds` and `durationSeconds` every 15 seconds and again on pause, video end, and page exit. The backend never lowers saved progress and automatically completes a lecture at 90% watched.

## Paid-course purchases (Test Mode)

Individual paid-course purchases use Razorpay Orders with Test Mode keys named `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`; they do not use `RAZORPAY_PLAN_ID`. The automated tests use a mocked Razorpay service; they do not exercise a live checkout. Successful payment verification requires MongoDB transaction support from Atlas or a local replica set (including a single-node replica set). A standalone MongoDB deployment returns a safe `503` for payment verification instead of granting partial access.

Live payments, refunds, and webhooks are outside this implementation and require separate operational review before being enabled.

### JWT legacy-name migration

`JWT_SECRET` is the required canonical name. An existing local `.env` that has only the legacy `JWT_Secret` spelling will fail startup by default. For a temporary migration only, set `ALLOW_LEGACY_JWT_SECRET=true`, rename `JWT_Secret` to `JWT_SECRET`, then remove the opt-in flag. Runtime code uses the canonical `JWT_SECRET` name.
