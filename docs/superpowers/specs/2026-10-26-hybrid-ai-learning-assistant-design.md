# Hybrid AI Learning Assistant — Phase 1 Design

## Intent

Add a student-only AI Learning Assistant to SkillForge. Before a student owns
a course, it discovers their goals and recommends real published free and paid
courses. After enrollment, it becomes a course companion that explains the
student's own progress, next lesson, course structure, assessments, and study
plan. This establishes personalized AI value without rebuilding the LMS or
pretending that video-only content is a searchable tutor corpus.

## Goals

- Ask students for career goal, interests, self-assessed level, and weekly
  availability when a profile has not been completed.
- Persist only those profile inputs that are needed for personalization.
- Rank only real, published courses from MongoDB using deterministic backend
  scoring; exclude courses the student already has active access to.
- Show both free and paid matching courses; label access type and price
  accurately, and prioritize relevant free courses in tie cases.
- Return a short, clear reason for each recommendation without asking the
  LLM to invent scores or courses.
- For enrolled courses, give guidance from the student's active enrollment,
  lecture-progress records, course/lecture titles and descriptions, published
  quizzes, assignments, and certificate requirements.
- Use Gemini only for conversational phrasing, question interpretation, and
  explanation of backend-provided facts.
- Add a dashboard AI panel that supports first-time discovery and enrolled
  learner guidance without redesigning the existing dashboard.
- Enforce student ownership and course access on every request.

## Non-goals for Phase 1

- Do not answer detailed technical questions from video contents as though the
  system has watched or transcribed the video.
- Do not upload or index PDFs, notes, transcripts, or assignment files yet.
- Do not build embeddings, vector search, an instructor content-ingestion UI,
  AI quiz generation, roadmap persistence, or performance-gap inference yet.
- Do not automatically purchase, enroll, publish, grade, or modify LMS data.
- Do not send passwords, emails, tokens, payment data, R2 object keys, raw
  assignments, or data from another student to Gemini.

## Current Reusable Foundation

- `User` provides identity and role; `STUDENT` is the only Phase 1 consumer.
- `Course` already provides title, description, category, free/paid access,
  price, publication state, lecture titles/descriptions/positions/durations.
- `Enrollment`, `Purchase`, and `LectureProgress` establish active access and
  learning state.
- Existing quiz, assignment, certificate, course-access, and learning-progress
  services provide authoritative facts for guidance.
- The React student dashboard already displays My Learning, purchases,
  progress, and a Continue Learning action.
- Existing authentication, role middleware, error envelope, audit log, request
  rate limits, and React error-presentation patterns must be reused.

## Approaches Considered

1. **Hybrid deterministic recommendations plus Gemini explanations (chosen).**
   Backend scoring selects real course IDs and computes match signals. Gemini
   receives only a bounded safe context and converts the result into helpful
   chat guidance. This preserves correctness and gives natural interaction.
2. **LLM-only recommendations.** Gemini receives course information and picks
   recommendations. This is faster initially but can invent courses, scores,
   or unsupported reasoning.
3. **Full RAG tutor first.** This meets detailed course-question needs, but
   requires material upload, extraction, embeddings, vector retrieval, and
   source citations before a trustworthy answer is possible.

The user chose approach 1 and Gemini Free Tier. The assistant must use a
provider adapter so a later provider change does not alter controllers,
recommendation rules, or frontend contracts.

## User Experience

### Student without courses

The dashboard shows an AI Learning Assistant card. It asks one focused
question at a time: goal, interests, level, then available hours per week.
Once enough fields are present, it shows 3–5 course cards from the LMS with
free/paid label, price, category, lecture-derived duration, match score, and
plain-language reason. Buttons lead to existing course detail and purchase or
free-enrollment flows; the assistant never initiates a payment.

### Enrolled student

The same card opens with a progress-aware prompt such as the next incomplete
lecture, recent assessment status, or certificate checklist. It can answer
questions about course order, lesson names/descriptions, progress, how to
navigate SkillForge, and study scheduling. For a detailed concept question
that is not grounded in existing metadata, it states that source material is
not available yet and points the student to the relevant lesson/instructor;
it must not fabricate an instructional answer.

## Backend Architecture

### New models

`LearningProfile`:

- one document per student (unique `student` reference)
- `careerGoal` (bounded string), `interests` (bounded normalized strings),
  `selfReportedSkills` (bounded normalized strings), `experienceLevel`
  (`BEGINNER`, `INTERMEDIATE`, `ADVANCED`),
  `weeklyAvailabilityHours` (integer 1–80)
- timestamps only; do not duplicate enrollment, progress, purchase, quiz, or
  assignment records.

`AIConversation`:

- one conversation per student, with a bounded latest-message window
- stores only safe role-tagged text, references to recommended course IDs, and
  timestamps; no raw provider payloads, prompts, credentials, or hidden
  system context.

`AIUsageLog`:

- immutable per-request operational record: student reference, feature
  (`DISCOVERY`, `GUIDANCE`), provider, model alias, success/failure category,
  input/output token counts where provider supplies them, and timestamp
- no question text, answer text, provider key, email, or payment data.

### Minimal course metadata extension

Add an optional instructor-owned `learningMetadata` subdocument to `Course`:
`level`, `skills`, and `prerequisites`. Existing courses remain valid; empty
metadata contributes no score. Course duration is calculated from existing
`lectures.durationSeconds`, not duplicated.

### Services

`services/ai/learning-profile.service.js` validates and normalizes profile
inputs and returns safe DTOs.

`services/ai/recommendation.service.js` queries only published courses,
removes courses with active enrollment, and calculates an integer 0–100 score
from documented signals: category/interest overlap, goal/skill keyword
overlap, experience-level fit, prerequisite fit, and free-course tie-break.
Prerequisite fit may use only completed LMS courses and explicitly
self-reported skills; interests never count as prerequisite evidence. When
evidence is missing, the recommendation must label the prerequisite and favor
a suitable foundation course instead of claiming readiness. It returns selected
course IDs, signal labels, and score before any model call.

`services/ai/student-context.service.js` gathers safe, bounded facts for the
authenticated student: profile, selected course metadata, active enrollment,
current/next lecture, progress aggregate, published assessment summaries, and
certificate eligibility facts. It never queries another student's records.

`services/ai/providers/gemini.provider.js` implements the shared provider
contract `generate({ systemInstruction, userMessage, context, maxOutputTokens
}) -> { replyKey, referencedCourseIds, usage? }` using backend-only
`GEMINI_API_KEY`. Gemini selects only a validated reply key and optional
references from the supplied allowlist; the backend renders every
student-facing sentence and course card from authoritative facts. The provider
receives the minimum safe DTO assembled by the context service. Its model name
is configured, not hardcoded across the app.

`services/ai/assistant.service.js` decides whether to collect profile fields,
return deterministic recommendations, or request a Gemini reply-key
classification. It validates structured model output, renders safe server
copy, falls back to deterministic copy when Gemini is unavailable, writes a
redacted usage record, and applies a per-student daily request budget.

### API

All endpoints require `isLoggedIn` and `requireRole('STUDENT')`:

- `GET /api/v1/ai/profile` — safe current profile and missing fields.
- `PUT /api/v1/ai/profile` — validate and save profile answers.
- `GET /api/v1/ai/recommendations` — deterministic recommendations only,
  including score and reason signals.
- `GET /api/v1/ai/guidance` — safe next-step facts for active enrollments.
- `POST /api/v1/ai/chat` — bounded message plus optional `courseId`; verifies
  enrollment when a course is requested and returns safe assistant message,
  optional recommendation cards, and a `grounding` label (`PROFILE`,
  `CATALOG`, `COURSE_METADATA`, or `PROGRESS`).

Requests receive normal rate limits plus an AI-specific per-student daily
budget. Provider outages, invalid model output, and quota limits return safe
retry guidance without provider internals.

## Gemini Configuration and Privacy

Add backend-only environment variables:

```text
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=
AI_MAX_OUTPUT_TOKENS=500
AI_DAILY_REQUEST_LIMIT=20
AI_REQUEST_TIMEOUT_MS=15000
```

Gemini Free Tier is intentionally selected for initial cost. Its quotas can
change and requests may be used under Google's free-tier terms; therefore the
assistant must send only minimum course and learning context, enforce budgets,
and function with deterministic fallback responses. API keys remain only in
backend environment variables. Do not expose Gemini keys or raw provider
responses to the frontend or audit logs.

## Frontend Integration

Add an AI Assistant entry to the student workspace and a compact dashboard
card. Reuse existing API client, TanStack Query patterns, protected routes,
course cards, buttons, error presentation, and loading/empty states. The UI
must label AI suggestions as guidance, show recommendation reasons and score
signals, and offer links—not automatic actions—for course details, purchase,
free enrollment, or continuing a lesson.

## Safety, Authorization, and Quality Rules

- The client never chooses a student ID, enrollment ID, price, or course
  access decision; the backend derives them from the session.
- Only active, published course facts enter catalog recommendations.
- Only the requesting student's records enter assistant context.
- A requested `courseId` must be actively enrolled and must belong to the
  authenticated student before course-specific guidance is assembled.
- Cap message size, conversation history, result count, provider timeout,
  output size, retries, and daily requests.
- Reject arbitrary model prose. Accept only an allowlisted reply key and
  course IDs from the safe context, then render final copy/cards server-side.
- Strip or reject provider input/output that contains recognizable sensitive
  values, unsupported course IDs, or unsafe action instructions.
- Tests must cover authorization isolation, no-course onboarding,
  deterministic scoring, enrollment filtering, provider outage fallback,
  quota exhaustion, and no secret/PII leakage.

## Follow-on Phase: Grounded Course Tutor (RAG)

The next phase adds instructor material upload, transcript ingestion, text
extraction, chunk/version records, embeddings, course-scoped retrieval, and
source-cited answers. It will use the established assistant UI and provider
adapter but has separate authorization and storage design. It is intentionally
not included in Phase 1.

## Acceptance Criteria

- A new student can complete a profile and see only real published, unowned
  matching free/paid course recommendations.
- Match scores come from backend rules, not the LLM, and display their reason
  signals.
- An enrolled student sees trustworthy next-step guidance from their own data.
- A student cannot obtain another student's profile, conversation, progress,
  or course-specific guidance.
- Provider failures preserve a usable deterministic recommendation/guidance
  response and a helpful message.
- Existing authentication, purchase, course, assessment, progress,
  certificate, and media behavior stays unchanged.
