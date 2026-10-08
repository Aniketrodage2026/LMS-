# LMS

A full-stack, role-based Learning Management System. The platform supports self-paced free and paid courses, individual Razorpay purchases, recorded lessons, learner progress, quizzes, assignment feedback, and certificates.

## Project layout

- `frontend` — Lovable-generated React/TanStack Start client
- `backend` — Express API, MongoDB models, and backend test suite
- `docs/superpowers/specs` — approved product design
- `docs/superpowers/plans` — implementation plan

## Local setup

```powershell
cd backend
npm install
Copy-Item .env.example .env
npm test
npm run dev
```

Configure the values in `.env` locally. Never commit it because it contains credentials.

For frontend setup and local CORS configuration, see [frontend/README.md](frontend/README.md).
