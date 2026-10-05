# LMS

A role-based Learning Management System backend built with Node.js, Express, MongoDB, Cloudinary, and Razorpay.

The current backend foundation includes a testable Express application, secure authentication with Student, Instructor, and Admin roles, and database support for course enrolment. The planned platform will add free and paid individual courses, public preview lessons, learner progress, quizzes, project submissions, instructor feedback, and certificates.

## Project layout

- `LMS/server` — Express API and backend test suite
- `docs/superpowers/specs` — approved product design
- `docs/superpowers/plans` — implementation plan

## Local setup

```bash
cd LMS/server
npm install
copy .env.example .env
npm test
npm run dev
```

Configure the values in `.env` locally. Never commit it because it contains credentials.
