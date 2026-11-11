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
const Quiz = require('../models/quiz.schema');
const Assignment = require('../models/assignment.schema');
const AIStudyPlan = require('../models/ai-study-plan.schema');

const now = new Date('2026-11-09T12:00:00.000Z');
let app;
let student;
let otherStudent;
let instructor;

function id() {
  return new mongoose.Types.ObjectId();
}

function cookie(user) {
  return `token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
}

async function setUpCourse() {
  const completedLecture = id();
  const nextLecture = id();
  const course = await Course.create({
    title: 'Practical JavaScript course', description: 'Learn JavaScript through practical lessons.', category: 'Programming',
    instructor: instructor._id, thumbnail: { public_id: 'PRIVATE_THUMBNAIL', secure_url: 'https://example.test/cover.png' },
    lectures: [
      { _id: completedLecture, title: 'Introduction', lecture: { public_id: 'PRIVATE_VIDEO_ONE', secure_url: 'https://example.test/one.mp4' } },
      { _id: nextLecture, title: 'Functions and scope', lecture: { public_id: 'PRIVATE_VIDEO_TWO', secure_url: 'https://example.test/two.mp4' } }
    ]
  });
  const quiz = await Quiz.create({
    course: course._id, title: 'Functions knowledge check', status: 'PUBLISHED', passMark: 70,
    questions: [{ prompt: 'PRIVATE_QUIZ_PROMPT', options: ['One', 'Two'], correctOptionIndex: 0 }]
  });
  const assignment = await Assignment.create({
    course: course._id, title: 'Build a function', instructions: 'PRIVATE_ASSIGNMENT_INSTRUCTIONS', status: 'PUBLISHED',
    dueDate: new Date('2026-11-10T12:00:00.000Z'), maxMarks: 100
  });
  await Promise.all([
    Enrollment.create({ student: student._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' }),
    LectureProgress.create({ student: student._id, course: course._id, lectureId: completedLecture, completed: true, watchedPercent: 100 }),
    AIStudyPlan.create({
      student: student._id, weekStart: new Date('2026-11-09T00:00:00.000Z'), timeZone: 'UTC', totalAvailableMinutes: 240,
      sessions: [{ kind: 'LESSON', course: course._id, source: nextLecture, courseTitle: course.title,
        title: 'Study lesson: Functions and scope', scheduledAt: new Date('2026-11-09T09:00:00.000Z'),
        dueAt: null, minutes: 30, position: 0 }]
    })
  ]);
  return { course, nextLecture, quiz, assignment };
}

test.before(async () => {
  process.env.JWT_SECRET = 'learning-coach-test-secret';
  await connectTestDb();
  await Promise.all([Enrollment.init(), LectureProgress.init(), AIStudyPlan.init()]);
  [student, otherStudent, instructor] = await Promise.all(['STUDENT', 'STUDENT', 'INSTRUCTOR'].map((role, index) =>
    User.create({ fullName: `Coach user ${index}`, email: `coach-${index}@example.test`, password: 'password123', role })));
});

test.beforeEach(async () => {
  await Promise.all([
    Course.deleteMany({}), Enrollment.deleteMany({}), LectureProgress.deleteMany({}), Quiz.deleteMany({}),
    Assignment.deleteMany({}), AIStudyPlan.deleteMany({})
  ]);
  app = createTestApp({ ai: { now: () => new Date(now) } });
});

test.after(disconnectTestDb);

test('returns bounded, prioritized owner-only next steps from current facts and today saved plan', async () => {
  const { course, nextLecture, quiz, assignment } = await setUpCourse();
  const before = await AIStudyPlan.findOne({ student: student._id }).lean();
  const response = await request(app).get('/api/v1/ai/coach').set('Cookie', cookie(student));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(response.body.coach.actions.map((item) => item.kind), [
    'PREPARE_ASSIGNMENT', 'CONTINUE_LESSON', 'REVIEW_QUIZ'
  ]);
  assert.equal(response.body.coach.actions[0].courseId, String(course._id));
  assert.equal(response.body.coach.actions[0].sourceId, String(assignment._id));
  assert.equal(response.body.coach.actions[1].sourceId, String(nextLecture));
  assert.equal(response.body.coach.actions[1].scheduledToday, true);
  assert.equal(response.body.coach.actions[2].sourceId, String(quiz._id));
  assert.equal(response.body.coach.actions[1].minutes, 30);
  assert.match(response.body.coach.actions[0].reason, /due soon/i);
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_|secure_url|instructions|correctOption/i);
  assert.deepEqual(await AIStudyPlan.findOne({ student: student._id }).lean(), before, 'coach does not mutate saved plans');
});

test('returns an explanatory empty state for a learner with no active course tasks', async () => {
  const response = await request(app).get('/api/v1/ai/coach').set('Cookie', cookie(otherStudent));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.coach.actions, []);
  assert.match(response.body.coach.message, /no active course tasks/i);
});

test('does not expose another learner data and requires a signed-in student', async () => {
  const { course } = await setUpCourse();
  const other = await request(app).get('/api/v1/ai/coach').set('Cookie', cookie(otherStudent));
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.coach.actions, []);
  assert.doesNotMatch(JSON.stringify(other.body), new RegExp(String(course._id)));

  const guest = await request(app).get('/api/v1/ai/coach');
  const instructorResponse = await request(app).get('/api/v1/ai/coach').set('Cookie', cookie(instructor));
  assert.equal(guest.status, 401);
  assert.equal(instructorResponse.status, 403);
});
