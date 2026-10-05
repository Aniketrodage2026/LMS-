# Role-Based LMS: Product Design

## Purpose

Build a portfolio-ready, self-paced learning platform for individual learners. The platform supports students buying individual premium courses, enrolling in complete free courses, and learning from recorded lessons. It must offer real assessment, progress, feedback, and certificate workflows rather than a simple video catalogue.

## Scope and Release Boundaries

### Included in version one

- Student, Instructor, and Admin roles.
- Self-paced recorded courses only.
- Free and paid courses, with individual paid-course purchases through Razorpay.
- One public preview (normally the first lecture) for every course.
- A separate Free Courses catalogue section.
- Student progress tracking, quizzes, project submissions, instructor feedback, grades, and completion certificates.
- Role-specific student, instructor, and admin dashboards.

### Deliberately deferred

- Live classes, scheduling, attendance, and video conferencing.
- Monthly/all-access subscriptions.
- Instructor revenue sharing, payouts, coupons, and marketplace finance.
- Social discussion forums, direct messaging, and native mobile apps.

## Users and Permissions

| Role | Permissions |
| --- | --- |
| Student | Browse courses, watch public previews, enrol in free courses, purchase paid courses, learn, track progress, attempt quizzes, submit projects, read feedback, and receive certificates. |
| Instructor | Create and immediately publish courses, set free/paid access and price, upload content, create quizzes and assignments, review student work, grade, and give feedback. |
| Admin | Manage users, instructors, categories, courses, reported content, payment records, platform analytics, and course moderation. Admins can unpublish content but do not approve routine course publication. |

## Core Product Rules

1. A course has an access type of `FREE` or `PAID`.
2. Any visitor may watch the designated preview lecture. If no lecture has explicitly been marked as preview, the first published lecture is used as the preview.
3. A signed-in student enrols in a free course without payment.
4. A student gains paid-course access only after Razorpay payment verification creates a successful purchase record for that student and course.
5. A purchase gives the buyer continuing access to that course; version one has no all-access subscription.
6. Every student can access their owned and enrolled courses in My Learning / My Purchases.
7. A lecture is automatically marked complete when at least 90% of its playable duration has been watched. A student can also mark it complete manually.
8. Certificate eligibility requires all required lessons completed and all required assessment pass conditions met.
9. Instructors publish immediately. Admins retain moderation controls.

## User Experience

### Student dashboard

- My Learning cards with progress percentage, recently watched lesson, and Continue Learning action.
- My Purchases with paid-course receipt and payment status.
- Learning player with curriculum, video, resources, notes, progress, and assessment links.
- Assessment centre showing quiz attempts, project-submission status, feedback, grades, and resubmission requests.
- Achievement area for issued certificates and learning history.
- Notifications for purchase success, instructor feedback, course updates, and certificates.

### Instructor dashboard

- Course builder for title, description, category, thumbnail, access type, paid price, preview lecture, curriculum, resources, quizzes, and assignments.
- Course management for draft/published content, enrolment, sales, completion, and assessment performance.
- Grading workspace to inspect student submissions, attach feedback, grade a submission, request a resubmission, and mark it complete.

### Admin dashboard

- User, role, category, course, and content-report management.
- Payment reporting and platform-level figures such as registrations, purchases, active learners, course completions, and top courses.
- Moderation controls to unpublish or remove unsuitable content.

## Learning and Assessment Flow

```text
Discover course
  -> Watch public preview
  -> Enrol for free OR pay for individual course
  -> Course appears in My Learning
  -> Watch lessons; progress is saved
  -> Pass quizzes and submit projects
  -> Instructor grades and gives feedback
  -> Meet completion criteria
  -> Receive verifiable certificate
```

## Technical Design

### Architecture

- React frontend with protected, role-aware routes and dashboards.
- Express API layered into routes, controllers, middleware, services, and Mongoose models.
- MongoDB for application data.
- Cloudinary for thumbnails, avatar images, downloadable resources where appropriate, and recorded video.
- Razorpay Orders/Payments for one-time paid-course purchases.
- Nodemailer for transactional notifications such as password resets and optional purchase/certificate emails.

### Key domain entities

| Entity | Key responsibilities |
| --- | --- |
| User | Identity, role (`STUDENT`, `INSTRUCTOR`, `ADMIN`), avatar, account state. |
| Course | Instructor owner, metadata, access type, price, publish state, thumbnail, curriculum, preview lecture. |
| Section / Lecture | Ordered course structure, recorded media, resource attachments, duration, preview flag. |
| Enrollment | Student-course relationship for free enrolment and purchased-course access. |
| Purchase | Student, course, price paid, currency, Razorpay order/payment/signature, status, receipt reference. |
| LectureProgress | Student, lecture, watched seconds/percentage, completion state, last watched timestamp. |
| Quiz / QuizAttempt | Questions, answers, pass mark, attempt history, score, pass state. |
| Assignment / Submission | Requirements, attachments, due date, submission files, status, score, instructor feedback, resubmission history. |
| Certificate | Student, course, unique certificate number, issue date, verification token/URL. |
| Notification | In-app message type, recipient, read state, and destination reference. |

### Access-control boundary

The backend is the authority for access. The frontend may hide or show actions for a role, but the API must independently confirm the user's role, enrollment/purchase state, and preview status before returning media URLs, assessments, submissions, feedback, or certificates.

### Payment data flow

```text
Student selects paid course
  -> API creates a Razorpay order for that exact course price
  -> Frontend opens Razorpay checkout
  -> API verifies the Razorpay signature
  -> Transactionally create successful Purchase + Enrollment
  -> Return My Learning access and receipt
```

The API must reject duplicate purchase creation for a student who already owns the course and must never trust a price submitted by the browser. Course price is read from the server-side course record.

## API Surface (planned)

### Public and student endpoints

- Course browsing, filtering, details, and preview lecture playback.
- Free-course enrolment and My Learning list.
- One-time checkout-order creation and payment verification.
- Per-lecture progress save/read.
- Quiz retrieval, attempt submission, and results.
- Assignment submission, submission history, and feedback retrieval.
- Certificate list, download, and public verification.

### Instructor endpoints

- Course, section, lecture, resource, quiz, and assignment CRUD.
- Set course access type, price, and preview lecture.
- Course student/progress/assessment analytics.
- Submission queue, grade, feedback, and resubmission actions.

### Admin endpoints

- User/role management, course moderation, category management, payment reports, and aggregate analytics.

## Error Handling and Security Requirements

- Standard JSON error responses without stack traces in production.
- Validate identifiers, payloads, role permissions, course ownership, uploaded-file types/sizes, and payment signatures.
- Use unique server-generated upload filenames and remove temporary files after processing.
- Use secure, `httpOnly`, `sameSite` cookies and production HTTPS settings.
- Keep secrets in ignored environment files; do not expose private Razorpay or Cloudinary credentials.
- Use rate limiting on authentication and password-reset endpoints.
- Log actionable server errors without storing passwords, tokens, or payment secrets.

## Acceptance Criteria and Testing

1. A visitor can watch exactly the preview lecture but cannot obtain another protected paid-course lecture.
2. A signed-in learner can enrol in a free course and sees it immediately in My Learning.
3. A learner can purchase one paid course; verified payment creates one ownership record and unlocks only that course.
4. A repeat purchase request cannot create another successful purchase for an already-owned course.
5. Video completion is saved at 90% watched, and manual completion is supported.
6. A student cannot access another student's submissions or feedback.
7. An instructor can only edit their own courses and review submissions for their own assignments.
8. An admin can moderate content but a student cannot access admin or instructor operations.
9. A certificate is blocked until course, quiz, and assignment completion requirements are satisfied.
10. Unit tests cover permissions, purchase verification, progress/certificate rules, and validation; integration tests cover the primary enrolment-to-certificate flow.

## Delivery Phases

1. Backend foundation: repair existing auth, redesign roles/course access, introduce purchase/enrollment/progress data, and secure the API.
2. Student experience: authentication, catalogue, previews, course player, purchases, My Learning, and progress.
3. Assessment: quizzes, assignments, submissions, instructor feedback, and certificate issuance.
4. Instructor and admin operations: course builder, grading workspace, management dashboards, and analytics.
5. Quality: automated tests, responsive/accessibility pass, production security, error handling, and deployment documentation.

## Resume Positioning

Describe the project as: "Built a role-based Learning Management System with React, Node.js, Express, MongoDB, Cloudinary, and Razorpay, enabling instructor course publishing, individual course purchases, protected video learning, persisted progress tracking, quizzes, project grading workflows, and verifiable certificates."
