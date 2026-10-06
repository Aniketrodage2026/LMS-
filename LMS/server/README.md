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
| `DB_URL` | MongoDB connection string. MongoDB must be running and reachable before `npm run dev`. |
| `JWT_SECRET` | Canonical signing secret required at startup. Use a strong local secret. |
| `JWT_EXPIRY` | JWT expiration period, for example `7d`. |
| `FRONTEND_URL` | Allowed frontend origin for credentialed CORS requests. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for media storage. |
| `CLOUDINARY_CLOUD_API_KEY` | Cloudinary API key for media storage. |
| `CLOUDINARY_CLOUD_API_SECRET` | Cloudinary API secret for media storage. |
| `SMTP_EMAIL` | SMTP sender/account email for application email. |
| `SMTP_PASSWORD` | SMTP password or provider app password. |
| `RAZORPAY_KEY_ID` | Razorpay key ID reserved for the next individual-course payment milestone. |
| `RAZORPAY_KEY_SECRET` | Razorpay key secret reserved for the next individual-course payment milestone. |
| `RAZORPAY_PLAN_ID` | Razorpay plan ID reserved for the next individual-course payment milestone. |

`DB_URL`, `JWT_SECRET`, `JWT_EXPIRY`, and `FRONTEND_URL` are validated during server startup. The Cloudinary, SMTP, and Razorpay values are supplied locally when using their corresponding integrations. Razorpay variables are reserved for the next individual-course payment milestone; no real Razorpay credentials are committed to this repository.

### JWT legacy-name migration

`JWT_SECRET` is the required canonical name. An existing local `.env` that has only the legacy `JWT_Secret` spelling will fail startup by default. For a temporary migration only, set `ALLOW_LEGACY_JWT_SECRET=true`, rename `JWT_Secret` to `JWT_SECRET`, then remove the opt-in flag. Runtime code uses the canonical `JWT_SECRET` name.
