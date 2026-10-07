# Assignments, Submissions, and Instructor Feedback: Design

## Goal

Add a course-level project-assessment workflow where instructors publish assignments, enrolled students submit practical work, and instructors grade or request resubmission with written feedback.

## Scope

- Instructors and admins who manage a course can create multiple course-level assignments.
- An assignment has a title, instructions, optional due date, instructor-defined maximum marks, and `DRAFT` or `PUBLISHED` status.
- Active enrolled students can list and open only published assignments for their course.
- A submission supports optional written text, optional project URL, and one optional file.
- Accepted file types are PDF, DOCX, ZIP, PNG, and JPG/JPEG.
- A student can create or replace their active work until it is graded.
- An instructor can grade a submission with marks and feedback, or request resubmission.
- A late submission remains allowed and is server-marked from the assignment due date.
- Students can read only their own submission history, feedback, grade, and resubmission status.

Not in this milestone: group assignments, multiple file uploads, rubrics, inline annotations, plagiarism detection, automatic code execution, due-date extensions, notifications, frontend screens, and certificate issuance.

## Data model

### Assignment

`Assignment` contains:

- `course`: required Course ObjectId.
- `title`: required trimmed text.
- `instructions`: required trimmed text.
- `dueDate`: optional Date.
- `maxMarks`: required positive integer.
- `status`: `DRAFT` or `PUBLISHED`, default `DRAFT`.
- `submissionCount`: nonnegative server-maintained integer, default `0`.

Indexes are `{ course, status }` for student listings and `{ course }` for instructor management. A client may never set `submissionCount`.

### Submission

`Submission` represents one version of work and contains:

- `assignment`, `course`, and `student` ObjectIds.
- `version`: a positive integer unique for a student-assignment pair.
- `writtenAnswer`: optional trimmed text.
- `projectUrl`: optional validated `http` or `https` URL.
- `file`: optional safe metadata: Cloudinary `public_id`, `secure_url`, original filename, MIME type, and byte size.
- `late`: server-calculated boolean.
- `status`: `SUBMITTED`, `GRADED`, or `RESUBMISSION_REQUESTED`.
- `marks`, `feedback`, `gradedAt`, and `gradedBy`; only the server/instructor may set these.
- normal timestamps.

Each submission must contain at least one of written answer, project URL, or file. A unique `{ assignment, student, version }` index preserves immutable version history; `{ assignment, student, createdAt: -1 }` supports student history and instructor review.

## Lifecycle

```text
Instructor creates DRAFT assignment
  -> Instructor publishes assignment
  -> Active student submits version 1 (late flag calculated by server)
  -> Student may replace active SUBMITTED work, creating a new version
  -> Instructor grades latest work OR requests resubmission
  -> GRADED closes student submission
  -> RESUBMISSION_REQUESTED permits a new version
```

- Replacing active work does not overwrite a record; it creates the next version and leaves history intact.
- A `GRADED` submission is final for this milestone.
- `RESUBMISSION_REQUESTED` permits exactly a new student version; the instructor may request it again after reviewing that version.
- Once `submissionCount > 0`, assignment title, instructions, due date, and max marks are immutable. The manager may only publish or unpublish it.
- Deleting an assignment with submissions is rejected. An unsubmitted assignment may be deleted by its course manager.

## File handling

- Only one optional submission file is accepted.
- The server accepts `.pdf`, `.docx`, `.zip`, `.png`, `.jpg`, and `.jpeg` only when both extension and matching MIME type are allowed.
- The maximum file size is 25 MB.
- A successful upload is stored in Cloudinary with `resource_type: 'raw'` except images, which use `resource_type: 'image'`.
- Temporary local upload files are removed whether processing succeeds or fails.
- If database persistence fails after Cloudinary upload, the new Cloudinary asset is destroyed.
- Replacing a submission file retains previous-version assets for historical review; deleting an unsubmitted assignment has no submission asset to clean up.

## Roles and access

- ADMIN may manage assignments and review submissions for any course.
- INSTRUCTOR may manage assignments and review submissions only for a course they own.
- STUDENT must have an ACTIVE enrollment to list, view, create, or view their own submissions for a course assignment.
- Student assignment cards and detail responses never expose another student, instructor-only submission data, or Cloudinary `public_id` values.
- Instructor submission queues may include a student's public profile information needed for grading, but never password, tokens, or private auth fields.

## API contract

| Endpoint | Role | Behavior |
| --- | --- | --- |
| `POST /api/v1/instructor/courses/:courseId/assignments` | Instructor/Admin course manager | Creates a draft assignment. |
| `GET /api/v1/instructor/courses/:courseId/assignments` | Instructor/Admin course manager | Lists course assignments. |
| `PATCH /api/v1/instructor/courses/:courseId/assignments/:assignmentId` | Instructor/Admin course manager | Updates an unsubmitted assignment, or status only after submissions. |
| `DELETE /api/v1/instructor/courses/:courseId/assignments/:assignmentId` | Instructor/Admin course manager | Deletes only assignments without submissions. |
| `GET /api/v1/instructor/courses/:courseId/assignments/:assignmentId/submissions` | Instructor/Admin course manager | Lists student submission histories for grading. |
| `PATCH /api/v1/instructor/courses/:courseId/assignments/:assignmentId/submissions/:submissionId/review` | Instructor/Admin course manager | Grades or requests resubmission. |
| `GET /api/v1/courses/:courseId/assignments` | Active enrolled student | Lists published assignment cards. |
| `GET /api/v1/courses/:courseId/assignments/:assignmentId` | Active enrolled student | Returns one published assignment. |
| `POST /api/v1/courses/:courseId/assignments/:assignmentId/submissions` | Active enrolled student | Creates the next allowed submission version. |
| `GET /api/v1/courses/:courseId/assignments/:assignmentId/submissions` | Active enrolled student | Returns only the caller's submission history. |

## Validation and error rules

- Invalid identifiers return 400; missing or cross-course assignment/submission resources return 404.
- A student without active enrollment receives 403.
- A draft or unpublished assignment appears as 404 to students.
- The submission endpoint rejects an empty submission, invalid project URL, unsupported file, client-supplied status/marks/feedback, and submissions when the latest submission is `GRADED`.
- Instructor review requires either `{ action: 'GRADE', marks, feedback }` with marks from 0 through assignment `maxMarks`, or `{ action: 'REQUEST_RESUBMISSION', feedback }` with non-empty feedback.
- The server calculates `late`, version, status transitions, marks, and grader identity. It never trusts those values from a client.

## Testing

Automated tests cover assignment/submission validation, manager ownership, active enrollment, draft secrecy, student isolation, assignment immutability/deletion after first submission, concurrent submission-count protection, submission versioning and late marking, allowed file validation, Cloudinary/local-file cleanup, grade bounds, review transitions, resubmission, and safe response shapes.
