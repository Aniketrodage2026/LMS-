const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createTestApp } = require('./helpers/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const LearningProfile = require('../models/learning-profile.schema');
const Assignment = require('../models/assignment.schema');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const Submission = require('../models/submission.schema');
const AIStudyPlan = require('../models/ai-study-plan.schema');
const { createStudyPlanService, zonedTimeToDate, dateKeyInZone } = require('../services/ai/study-plan.service');

const startDate = '2026-11-02';
const timeZone = 'America/New_York';
const base = '/api/v1/ai/study-plan';
let student;
let otherStudent;
let instructor;
let admin;
let course;
let app;
let nextLectureId;
let quizId;
let assignmentId;

function id() {
  return new mongoose.Types.ObjectId();
}

function cookie(user) {
  return `token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
}

function call(method, path, user = student) {
  const req = request(app)[method](path);
  if (user) req.set('Cookie', cookie(user));
  return req;
}

async function setUpLearner({ availability = 2, addAssessments = true } = {}) {
  nextLectureId = id();
  course = await Course.create({
    title: 'JavaScript foundations',
    description: 'Learn JavaScript fundamentals.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: { public_id: 'RAW_COVER', secure_url: 'https://image.example/cover.png' },
    lectures: [
      { _id: id(), title: 'Completed introduction', lecture: { public_id: 'RAW_VIDEO_1', secure_url: 'https://video.example/one.mp4' } },
      { _id: nextLectureId, title: 'Functions and scope', lecture: { public_id: 'RAW_VIDEO_2', secure_url: 'https://video.example/two.mp4' } },
      { _id: id(), title: 'Advanced patterns', lecture: { public_id: 'RAW_VIDEO_3', secure_url: 'https://video.example/three.mp4' } },
    ],
  });
  await Promise.all([
    Enrollment.create({ student: student._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' }),
    LearningProfile.create({
      student: student._id, careerGoal: 'Web developer', interests: ['web'], selfReportedSkills: [],
      experienceLevel: 'BEGINNER', weeklyAvailabilityHours: availability,
    }),
    LectureProgress.create({ student: student._id, course: course._id, lectureId: course.lectures[0]._id, completed: true, watchedPercent: 100 }),
  ]);
  if (addAssessments) {
    quizId = id();
    assignmentId = id();
    await Promise.all([
      Quiz.create({
        _id: quizId, course: course._id, title: 'Functions knowledge check', status: 'PUBLISHED', passMark: 70,
        questions: [{ prompt: 'What is a function?', options: ['A reusable block', 'A color'], correctOptionIndex: 0 }],
      }),
      Assignment.create({
        _id: assignmentId, course: course._id, title: 'Build a small function', instructions: 'Write a function.',
        status: 'PUBLISHED', dueDate: new Date('2026-11-05T02:00:00.000Z'), maxMarks: 100,
      }),
      Assignment.create({
        course: course._id, title: 'Draft assignment', instructions: 'Not visible.',
        status: 'DRAFT', dueDate: new Date('2026-11-03T02:00:00.000Z'), maxMarks: 100,
      }),
    ]);
  }
}

test.before(async () => {
  process.env.JWT_SECRET = 'study-plan-test-secret';
  await connectTestDb();
  await Promise.all([
    Enrollment.init(), LectureProgress.init(), LearningProfile.init(),
    AIStudyPlan.init(), Assignment.init(), Quiz.init(), QuizAttempt.init(), Submission.init(),
  ]);
  [student, otherStudent, instructor, admin] = await Promise.all(['STUDENT', 'STUDENT', 'INSTRUCTOR', 'ADMIN'].map((role, index) =>
    User.create({ fullName: `Study plan user ${index}`, email: `study-plan-${index}@example.com`, password: 'password123', role })));
});

test.beforeEach(async () => {
  await Promise.all([
    Course.deleteMany({}), Enrollment.deleteMany({}), LectureProgress.deleteMany({}),
    LearningProfile.deleteMany({}), Assignment.deleteMany({}), Quiz.deleteMany({}),
    QuizAttempt.deleteMany({}), Submission.deleteMany({}), AIStudyPlan.deleteMany({}),
  ]);
  nextLectureId = undefined;
  quizId = undefined;
  assignmentId = undefined;
  app = createTestApp({ ai: { now: () => new Date('2026-11-02T16:00:00.000Z') } });
});

test.after(disconnectTestDb);

test('builds a bounded seven-day plan from only the learner next lesson and published upcoming assessments', async () => {
  await setUpLearner();
  const response = await call('post', `${base}/preview`).send({ startDate, timeZone });

  assert.equal(response.status, 200);
  const preview = response.body.preview;
  assert.equal(preview.weekStart, startDate);
  assert.equal(preview.timeZone, timeZone);
  assert.equal(preview.availableMinutes, 120);
  assert.equal(preview.plannedMinutes, 105);
  assert.deepEqual(preview.sessions.map(({ kind }) => kind), ['ASSIGNMENT', 'LESSON', 'QUIZ']);
  assert.equal(preview.sessions.find(({ kind }) => kind === 'LESSON').sourceId, String(nextLectureId));
  assert.equal(preview.sessions.find(({ kind }) => kind === 'ASSIGNMENT').sourceId, String(assignmentId));
  assert.equal(preview.sessions.find(({ kind }) => kind === 'QUIZ').sourceId, String(quizId));
  assert.ok(preview.sessions.every(({ day, minutes }) => day >= startDate && day <= '2026-11-08' && minutes >= 15));
  assert.ok(preview.sessions.filter(({ kind }) => kind === 'ASSIGNMENT').every(({ dueDay, day }) => day <= dueDay));
  assert.doesNotMatch(JSON.stringify(preview), /RAW_|image\.example|video\.example|instructions|Draft assignment/);
  assert.equal(await AIStudyPlan.countDocuments(), 0, 'preview does not persist until the student saves');
});

test('saves edits only for generated tasks, stores local schedule times as UTC instants, and scopes plans to their owner', async () => {
  await setUpLearner();
  const preview = (await call('post', `${base}/preview`).send({ startDate, timeZone })).body.preview;
  const edited = preview.sessions.map(({ id: sessionId, day, minutes }) => ({
    id: sessionId,
    day: day === startDate ? '2026-11-03' : day,
    minutes: 15,
  })).reverse();
  const saved = await call('put', base).send({ startDate, timeZone, sessions: edited });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.plan.sessions.length, 3);
  assert.equal(saved.body.plan.sessions[0].minutes, 15);
  assert.equal(saved.body.plan.sessions[0].day, edited[0].day);
  assert.equal(saved.body.plan.plannedMinutes, 45);
  const persisted = await AIStudyPlan.findOne({ student: student._id }).lean();
  assert.equal(persisted.sessions[0].scheduledAt.toISOString(), zonedTimeToDate(edited[0].day, timeZone).toISOString());
  assert.equal(dateKeyInZone(persisted.sessions[0].scheduledAt, timeZone), edited[0].day);

  const ownRead = await call('get', `${base}?startDate=${startDate}&timeZone=${encodeURIComponent(timeZone)}`);
  assert.equal(ownRead.status, 200);
  assert.equal(ownRead.body.plan.sessions.length, 3);
  const otherRead = await call('get', `${base}?startDate=${startDate}&timeZone=${encodeURIComponent(timeZone)}`, otherStudent);
  assert.equal(otherRead.status, 200);
  assert.equal(otherRead.body.plan, null);
});

test('rejects forged tasks, invalid time zones, out-of-range dates, and availability overruns', async () => {
  await setUpLearner({ availability: 1, addAssessments: false });
  const preview = (await call('post', `${base}/preview`).send({ startDate, timeZone })).body.preview;
  const validSession = preview.sessions[0];
  const forged = await call('put', base).send({
    startDate, timeZone,
    sessions: [{ id: `LESSON:${course._id}:${id()}`, day: validSession.day, minutes: 30 }],
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error.code, 'AI_STUDY_PLAN_INVALID');

  const overBudget = await call('put', base).send({
    startDate, timeZone,
    sessions: [{ id: validSession.id, day: validSession.day, minutes: 75 }],
  });
  assert.equal(overBudget.status, 400);

  const invalidZone = await call('post', `${base}/preview`).send({ startDate, timeZone: 'Not/A_Timezone' });
  assert.equal(invalidZone.status, 400);
  const pastWeek = await call('post', `${base}/preview`).send({ startDate: '2026-10-25', timeZone });
  assert.equal(pastWeek.status, 400);
  assert.equal(await AIStudyPlan.countDocuments(), 0);
});

test('does not make a plan without profile availability or active published course tasks', async () => {
  const noProfile = await Course.create({
    title: 'JavaScript foundations', description: 'Learn JavaScript.', category: 'Programming',
    instructor: instructor._id, thumbnail: { public_id: 'RAW_COVER', secure_url: 'https://image.example/cover.png' },
  });
  await Enrollment.create({ student: student._id, course: noProfile._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });
  const noAvailability = await call('post', `${base}/preview`).send({ startDate, timeZone });
  assert.equal(noAvailability.status, 200);
  assert.equal(noAvailability.body.preview.availableMinutes, null);
  assert.equal(noAvailability.body.preview.sessions.length, 0);
  assert.match(noAvailability.body.preview.message, /weekly study availability/i);

  await LearningProfile.create({
    student: student._id, careerGoal: 'Developer', interests: ['web'], selfReportedSkills: [],
    experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 4,
  });
  await Course.updateOne({ _id: noProfile._id }, { status: 'UNPUBLISHED' });
  const noCourse = await call('post', `${base}/preview`).send({ startDate, timeZone });
  assert.equal(noCourse.body.preview.sessions.length, 0);
  assert.equal(noCourse.body.preview.message, 'No incomplete lessons or upcoming published assessments were found for your active courses.');
});

test('requires a student role and removes only the caller saved plan', async () => {
  await setUpLearner({ addAssessments: false });
  const preview = (await call('post', `${base}/preview`).send({ startDate, timeZone })).body.preview;
  const session = preview.sessions[0];
  await call('put', base).send({ startDate, timeZone, sessions: [{ id: session.id, day: session.day, minutes: 30 }] });

  for (const user of [null, instructor, admin]) {
    const response = await call('get', `${base}?startDate=${startDate}&timeZone=${encodeURIComponent(timeZone)}`, user);
    assert.equal(response.status, user ? 403 : 401);
  }
  const removed = await call('delete', `${base}?startDate=${startDate}&timeZone=${encodeURIComponent(timeZone)}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  assert.equal(await AIStudyPlan.countDocuments({ student: student._id }), 0);
  assert.equal(await LectureProgress.countDocuments({ student: student._id, completed: true }), 1);
  assert.equal(await QuizAttempt.countDocuments(), 0);
  assert.equal(await Submission.countDocuments(), 0);
});

test('handles DST offsets while preserving the requested local day and morning session time', () => {
  const springForward = zonedTimeToDate('2026-03-08', 'America/New_York');
  const fallBack = zonedTimeToDate('2026-11-01', 'America/New_York');
  assert.equal(springForward.toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(fallBack.toISOString(), '2026-11-01T14:00:00.000Z');
  assert.equal(dateKeyInZone(springForward, 'America/New_York'), '2026-03-08');
  assert.equal(dateKeyInZone(fallBack, 'America/New_York'), '2026-11-01');
});
