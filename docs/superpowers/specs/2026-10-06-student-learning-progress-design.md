# Student Learning Progress: Design

## Goal

Track a student's recorded-lesson progress accurately, support 90% automatic completion and manual completion, and provide the backend data required for My Learning and future certificates.

## Scope

- Per-student, per-lecture progress records.
- Progress updates every 15 seconds plus pause, finish, and page-leave events.
- Backend-enforced 90% automatic completion.
- Manual lesson completion.
- Student course-progress and My Learning APIs.

Not in this milestone: frontend video player, quizzes, assignments, certificates, instructor analytics, progress resets, and real-time notifications.

## Data Model

`LectureProgress` contains:

- `student`, `course`, and `lectureId`.
- `watchedSeconds`, `watchedPercent`, and `durationSeconds`.
- `completed` and `completedAt`.
- `lastWatchedAt` and timestamps.

The compound `{ student, lectureId }` is unique. Indexes support dashboard lookups by `{ student, course }` and recent learning by `{ student, lastWatchedAt }`.

## Rules

- Only active enrolled students can create or update their own progress.
- The lesson must belong to the submitted course.
- `watchedSeconds` and `watchedPercent` only move forward; stale browser events cannot reduce them.
- The server calculates percentage from watched seconds and declared duration.
- At 90% or more, the server marks the lecture complete and sets `completedAt` once.
- Students can manually complete a lesson; manual completion is permanent in this milestone.
- Progress APIs never return another student's data.

## APIs

| Endpoint | Access | Behaviour |
| --- | --- | --- |
| `PATCH /api/v1/courses/:courseId/lectures/:lectureId/progress` | Enrolled student | Saves highest valid watched position and performs automatic completion. |
| `POST /api/v1/courses/:courseId/lectures/:lectureId/complete` | Enrolled student | Permanently marks the student’s lesson complete. |
| `GET /api/v1/courses/:courseId/progress` | Enrolled student | Returns per-lecture progress and calculated course completion. |
| `GET /api/v1/me/learning` | Student | Returns accessible courses with progress, last watched lesson, and Continue Learning details. |

## Dashboard Calculations

Course completion percentage is `completed lectures / total lectures * 100`, rounded to a whole number. A course with no lectures returns `0`. The last watched lesson is selected from the most recent `lastWatchedAt`; My Learning is sorted by the same timestamp, then by enrollment time for courses without progress.

## Validation and Errors

- Course and lecture identifiers must be valid MongoDB ObjectIds.
- `durationSeconds` must be positive; `watchedSeconds` must be zero or greater and cannot exceed duration.
- The backend rejects lectures that are not in the specified course.
- Unauthenticated requests return 401; unentitled or cross-student access returns 403; missing course/lecture returns 404.
- Responses expose only progress state and safe course/lecture metadata.

## Testing

Integration tests with MongoMemoryReplSet prove:

1. Only entitled students can save/read progress.
2. Progress is monotonic and 90% triggers completion once.
3. Manual completion works below 90%.
4. Cross-course lesson identifiers and invalid positions are rejected.
5. Course totals and empty-course behavior are correct.
6. My Learning excludes other users, orders courses correctly, and does not expose protected media beyond existing access rules.
