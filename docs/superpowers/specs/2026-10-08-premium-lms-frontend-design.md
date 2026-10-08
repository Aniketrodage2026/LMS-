# Premium LMS Frontend Design

## Purpose

Create a portfolio-ready frontend design for the existing self-paced LMS backend. The product must feel like a credible, premium learning platform rather than a simple video-course project.

## Visual direction

- Premium professional: off-white surfaces, deep navy text, indigo primary actions, teal success/progress states, and amber pending states.
- Spacious layouts, rounded cards, subtle shadows, accessible contrast, and clear typography.
- Responsive desktop, tablet, and mobile views.
- Use realistic course, instructor, assessment, purchase, and certificate content rather than placeholder-only screens.

## Product scope

The UI represents the backend features already implemented:

- Public catalogue with separate free and paid courses.
- Public course preview lecture.
- Individual paid-course purchases in INR and free-course enrolment.
- Student My Learning dashboard and 90% lecture-completion progress.
- Unlimited-attempt quizzes with immediate results.
- Assignment submissions, feedback, grading, and resubmission requests.
- Certificate eligibility, claim, and public verification.
- Instructor course, curriculum, assessment, and grading management.

Live classes, subscriptions, social features, and native mobile apps are outside this design scope.

## Required screens

1. Public course catalogue: featured courses, categories, distinct free-course section, paid prices, course cards, filters, and preview actions.
2. Course detail and checkout: overview, instructor, curriculum, preview lecture, outcomes, pricing in INR, and context-aware enrol or buy actions.
3. Student dashboard: My Learning, progress, continue-learning actions, assessment status, purchases, and certificates.
4. Learning player: video focus area, curriculum sidebar, lesson progress, resources, and quiz/assignment entry points.
5. Assessment centre: quiz attempts/results and assignment submission history, upload, feedback, marks, and resubmission state.
6. Achievements: certificate eligibility checklist, certificate card, verification details, and download/share controls.
7. Instructor workspace: course builder, access type and price configuration, preview selector, curriculum uploads, quiz builder, assignment builder, and grading queue.

## UX rules

- Show actions based on the learner state: visitor, signed-in student, enrolled student, purchaser, or instructor.
- Clearly distinguish free enrolment from paid checkout.
- Do not show protected lessons, quizzes, assignments, grades, or certificate claim actions as accessible until the API confirms access.
- Use explicit states for draft, published, pending review, graded, resubmission requested, passed, failed, eligible, and locked.
- Make progress and next actions prominent: Continue Learning, Take Quiz, Submit Assignment, Review Feedback, and Claim Certificate.

## Frontend handoff

The first frontend implementation will connect these screens to the Express API. The backend remains the authority for role, course access, payment verification, progress, assessment outcomes, and certificate eligibility.
