# Course Certificates: Design

## Goal

Issue a single, verifiable course certificate when an enrolled student explicitly claims it after meeting meaningful learning and assessment thresholds.

## Eligibility

A claim succeeds only when all conditions are true:

- At least 80% of the course's current lectures have completed `LectureProgress` records.
- Every current `PUBLISHED` quiz has at least one passed `QuizAttempt` for the student.
- Every current `PUBLISHED` assignment has a latest student submission in `GRADED` status.
- The average percentage across each published quiz's best student attempt and each published assignment's latest awarded percentage is at least 80%.

The assessment average is 100% when the course has no published quizzes or assignments. Current course contents, not deleted quiz/assignment records, determine requirements. A revoked or inactive enrollment cannot claim a certificate.

## Certificate model

`Certificate` contains required `student` and `course` references, an immutable unique certificate number, an immutable unique random verification token, issue timestamp, and immutable eligibility snapshot. The snapshot records lecture totals/completed count, required/passed quiz count, required/graded assignment count, assessment average, and the rule version. A unique `{ student, course }` index permits one certificate per student/course.

## APIs

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/v1/courses/:courseId/certificate/eligibility` | Active enrolled student | Returns safe eligibility checklist and current calculated values. |
| `POST /api/v1/courses/:courseId/certificate/claim` | Active enrolled student | Recalculates eligibility and creates or returns the certificate. |
| `GET /api/v1/me/certificates` | Student | Lists only the caller's certificates. |
| `GET /api/v1/certificates/verify/:token` | Public | Verifies a token and returns safe certificate data. |

Claim is idempotent: an existing certificate is returned even after later course-content changes. The public response contains only learner name, course title, certificate number, issue date, and valid status. It never exposes emails, payment data, marks, answers, feedback, internal identifiers, or the eligibility snapshot.

## Testing

Tests cover 80% boundaries, no-assessment courses, incomplete lectures, missing or failed quizzes, ungraded assignments, average-score boundaries, inactive enrollment, concurrent/repeated claims, student isolation, public verification secrecy, unique fields, and stable snapshots.
