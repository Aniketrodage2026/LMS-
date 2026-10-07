# Course Quizzes: Design

## Goal

Add a course-level, automatically graded quiz system that lets instructors assess enrolled students in self-paced courses without exposing answers before a submission.

## Scope

- An instructor can create multiple quizzes for a course they own.
- A quiz is a draft or published and has a title, optional instructions, a pass mark, and single-answer multiple-choice questions.
- Each question has 2 to 6 distinct non-empty options, one server-only correct-option index, and an optional explanation.
- Students with an ACTIVE enrollment may list and open published quizzes for that course.
- Students get unlimited attempts. The server calculates and saves each score, percentage, and pass result.
- After a successful submission, the student sees their chosen answer, the correct answer, and any explanation.
- Students can see only their own attempt history and their best score for a quiz.

Not in this milestone: lecture-level quizzes, written/manual grading, quiz timers, question banks, randomization, certificates, assignments, frontend screens, analytics, or notifications.

## Data model

### Quiz

`Quiz` contains:

- `course`: required Course ObjectId.
- `title`: required trimmed text.
- `instructions`: optional trimmed text.
- `passMark`: required integer from 1 through 100.
- `status`: `DRAFT` or `PUBLISHED`, default `DRAFT`.
- `questions`: ordered array of question objects containing `prompt`, `options`, `correctOptionIndex`, and optional `explanation`.

Each question must have 2 through 6 distinct, non-empty trimmed options. `correctOptionIndex` must be a valid integer index in its own options array. The model indexes `{ course, status }` for student listing and `{ course }` for instructor management.

### QuizAttempt

`QuizAttempt` contains:

- `quiz`, `course`, and `student` ObjectIds.
- `answers`: selected option index or `null` for every quiz question, stored in question order.
- `correctAnswers`, `totalQuestions`, `score`, `percentage`, and `passed` calculated only by the server.
- `submittedAt` and normal timestamps.

Attempts are immutable after creation. An index on `{ student, quiz, submittedAt: -1 }` supports a student's attempt history and best-score calculation.

## Roles and access

- ADMIN may manage any quiz; INSTRUCTOR may manage only quizzes for courses they own.
- Students may read only `PUBLISHED` quizzes for courses where they have an ACTIVE enrollment.
- A student may access only their own attempt history and results.
- Student quiz-read responses expose question IDs, prompt, and options only; they never expose `correctOptionIndex` or explanations before submission.
- Creating, editing, publishing, unpublishing, and deleting are blocked for an instructor who does not manage the course.

## Lifecycle rules

- New quizzes begin as `DRAFT`.
- A draft may be created and edited freely by its authorized instructor or an admin.
- A published quiz is visible to entitled students.
- Once any attempt exists, its questions, options, correct answers, and pass mark are immutable. The authorized instructor/admin may only change its status between `PUBLISHED` and `DRAFT`.
- Deleting a quiz with attempts is rejected, preserving student records. A quiz with no attempts may be deleted by its manager.

## API contract

| Endpoint | Role | Behavior |
| --- | --- | --- |
| `POST /api/v1/instructor/courses/:courseId/quizzes` | Instructor/Admin course manager | Creates a draft quiz. |
| `GET /api/v1/instructor/courses/:courseId/quizzes` | Instructor/Admin course manager | Lists that course's quizzes, including answer keys. |
| `PATCH /api/v1/instructor/courses/:courseId/quizzes/:quizId` | Instructor/Admin course manager | Updates draft content or changes only status after attempts exist. |
| `DELETE /api/v1/instructor/courses/:courseId/quizzes/:quizId` | Instructor/Admin course manager | Deletes only a quiz with no attempts. |
| `GET /api/v1/courses/:courseId/quizzes` | Active enrolled student | Lists published quiz cards without answers. |
| `GET /api/v1/courses/:courseId/quizzes/:quizId` | Active enrolled student | Returns one published quiz's prompts and options without answers. |
| `POST /api/v1/courses/:courseId/quizzes/:quizId/attempts` | Active enrolled student | Validates all answers, grades server-side, stores a new attempt, and returns the review. |
| `GET /api/v1/courses/:courseId/quizzes/:quizId/attempts` | Active enrolled student | Returns only the requesting student's attempts and calculated best score. |

## Submission and grading flow

```text
Student opens a published quiz
  -> API verifies ACTIVE enrollment and does not send answer keys
  -> Student submits an answer index or null for each question
  -> API verifies quiz/course relationship and answer count/indexes
  -> API compares submitted indexes against the stored answer key
  -> API stores a new immutable QuizAttempt
  -> API returns the score, pass result, correct answers, and explanations
```

`score` is the number of correct answers. `percentage` is `Math.round(score / totalQuestions * 100)`. `passed` is true when `percentage >= passMark`. An unanswered question is incorrect. Unlimited submissions create separate attempts; no attempt overwrites another attempt.

## Errors and response safety

- Invalid course or quiz IDs return 400; a missing course/quiz or a quiz not belonging to the requested course returns 404.
- A student without active enrollment receives 403.
- A student requesting a draft/unpublished quiz receives 404.
- Invalid payloads, answer counts, or selected indexes return 400 before an attempt is saved.
- Server responses never trust client-provided marks, scores, correct answers, or pass state.
- Results and attempt history never expose another student's identity or answers.

## Testing

Automated tests cover model validation, course ownership, active-enrollment access, answer-key secrecy, draft visibility, server-side grading, blank answers, unlimited attempts, student data isolation, attempted-quiz immutability, safe status changes, deletion safeguards, and malformed/cross-course identifiers.
