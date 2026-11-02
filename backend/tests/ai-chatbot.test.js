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
const LearningProfile = require('../models/learning-profile.schema');
const AIUsageLog = require('../models/ai-usage-log.schema');
const AIUsageBudget = require('../models/ai-usage-budget.schema');
const { createChatbotService } = require('../services/ai/chatbot.service');

const base = '/api/v1/ai/chatbot';
const config = {
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'SERVER_ONLY_CHATBOT_KEY',
  GEMINI_MODEL: 'gemini-chatbot-test',
  AI_MAX_OUTPUT_TOKENS: '500',
  AI_DAILY_REQUEST_LIMIT: '20',
  AI_REQUEST_TIMEOUT_MS: '1000',
};
let student;
let otherStudent;
let instructor;
let app;
let providerCalls;
let capturedPayload;

function providerReply(message = 'Try a short daily study session.') {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: message }] } }],
    usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 8 },
  }), { status: 200 });
}

function makeApp({ fetchImpl = async (_url, init) => {
  providerCalls += 1;
  capturedPayload = JSON.parse(init.body);
  return providerReply();
}, security } = {}) {
  return createTestApp({ ai: { config, fetchImpl }, security });
}

function cookie(user) {
  return `token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
}

function course(changes = {}) {
  return Course.create({
    title: 'JavaScript foundations',
    description: 'Learn JavaScript fundamentals.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: { public_id: 'RAW_STORAGE_KEY', secure_url: 'https://image.example/course.png' },
    ...changes,
  });
}

test.before(async () => {
  process.env.JWT_SECRET = 'chatbot-test-secret';
  await connectTestDb();
  await Promise.all([Enrollment.init(), LearningProfile.init(), AIUsageLog.init(), AIUsageBudget.init()]);
  [student, otherStudent, instructor] = await Promise.all(['STUDENT', 'STUDENT', 'INSTRUCTOR'].map((role, index) =>
    User.create({ fullName: `Chatbot user ${index}`, email: `chatbot-${index}@example.com`, password: 'password123', role })));
});

test.beforeEach(async () => {
  await Promise.all([
    Course.deleteMany({}),
    Enrollment.deleteMany({}),
    LearningProfile.deleteMany({}),
    AIUsageBudget.deleteMany({}),
    AIUsageLog.collection.deleteMany({}),
  ]);
  providerCalls = 0;
  capturedPayload = undefined;
  app = makeApp();
});

test.after(disconnectTestDb);

test('course-scoped chatbot forwards the lesson ID and never mixes general chat history into tutor input', async () => {
  const calls = [];
  const service = createChatbotService({
    tutor: {
      async answerCourseQuestion(input) {
        calls.push(input);
        return { answer: 'Lesson-grounded answer.', citations: [] };
      },
    },
  });
  const studentId = new mongoose.Types.ObjectId();
  const courseId = '444444444444444444444444';
  const lectureId = '555555555555555555555555';

  const reply = await service.respond({
    studentId,
    courseId,
    lectureId,
    message: 'Explain this lesson.',
    plainLanguage: true,
    history: [{ role: 'user', message: 'A prior general-chat question.' }],
  });

  assert.deepEqual(calls, [{ studentId, courseId, lectureId, question: 'Explain this lesson.', plainLanguage: true }]);
  assert.deepEqual(reply, { message: 'Lesson-grounded answer.', citations: [] });
});

test('guests can ask general questions using only published catalog context', async () => {
  await course();
  const response = await request(app).post(base).set('Cookie', 'token=invalid').send({ message: 'Tell me about JavaScript.' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    chatbot: { message: 'Try a short daily study session.', citations: [] },
  });
  const requestContext = JSON.parse(capturedPayload.contents[0].parts[0].text);
  assert.equal(requestContext.message, 'Tell me about JavaScript.');
  assert.equal(requestContext.context.catalog[0].title, 'JavaScript foundations');
  assert.equal(Object.hasOwn(requestContext.context, 'student'), false);
  assert.doesNotMatch(JSON.stringify(requestContext), /RAW_STORAGE_KEY|image\.example|chatbot-\d@|password123/);
  assert.equal(await AIUsageLog.countDocuments(), 0);
});

test('course discovery uses recent user interests to find matching published courses', async () => {
  const matching = await course({
    title: 'Cloud and AI Foundations',
    category: 'Technology',
    description: 'Learn cloud infrastructure and artificial intelligence fundamentals.',
  });
  await course({ title: 'Graphic Design Basics', category: 'Design', description: 'Learn visual design.' });
  const response = await request(app).post(base).send({
    message: 'Which course should I choose?',
    history: [
      { role: 'user', message: 'I am interested in artificial intelligence and cloud infrastructure.' },
      { role: 'assistant', message: 'What are your learning interests?' },
    ],
  });

  assert.equal(response.status, 200);
  const requestContext = JSON.parse(capturedPayload.contents[0].parts[0].text);
  assert.ok(requestContext.context.catalog.some((item) => item.title === matching.title));
  assert.doesNotMatch(JSON.stringify(requestContext.context.catalog), /Graphic Design Basics/);
  assert.match(capturedPayload.systemInstruction.parts[0].text, /recommend only matching courses/i);
  assert.match(capturedPayload.systemInstruction.parts[0].text, /ask a brief follow-up/i);
});

test('plain-English chatbot style is bounded, explicit, and does not widen catalog context', async () => {
  const response = await request(app).post(base).send({ message: 'Explain a programming concept.', plainLanguage: true });
  assert.equal(response.status, 200);
  assert.match(capturedPayload.systemInstruction.parts[0].text, /plain English/i);
  assert.match(capturedPayload.systemInstruction.parts[0].text, /numeric facts exactly/i);
  assert.equal(JSON.parse(capturedPayload.contents[0].parts[0].text).context.catalog.length, 0);
});

test('students get only their own minimized profile/progress context and a durable usage record', async () => {
  const item = await course({ lectures: [{ title: 'JavaScript variables', lecture: {
    public_id: 'RAW_VIDEO_KEY', secure_url: 'https://video.example/variables.mp4',
  } }] });
  await Enrollment.create({ student: student._id, course: item._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });
  await LearningProfile.create({
    student: student._id,
    careerGoal: 'Web developer',
    interests: ['web'],
    selfReportedSkills: ['javascript'],
    experienceLevel: 'BEGINNER',
    weeklyAvailabilityHours: 4,
  });
  await LearningProfile.create({
    student: otherStudent._id,
    careerGoal: 'other-student-private-goal',
    interests: ['private-interest'],
    selfReportedSkills: [],
    experienceLevel: 'ADVANCED',
    weeklyAvailabilityHours: 40,
  });

  const response = await request(app).post(base).set('Cookie', cookie(student)).send({ message: 'What should I learn next?' });
  assert.equal(response.status, 200);
  const requestContext = JSON.parse(capturedPayload.contents[0].parts[0].text);
  assert.equal(requestContext.context.student.profile.careerGoal, 'Web developer');
  assert.equal(requestContext.context.student.activeCourses[0].title, 'JavaScript foundations');
  assert.equal(requestContext.context.student.activeCourses[0].nextLesson, 'JavaScript variables');
  assert.doesNotMatch(JSON.stringify(requestContext), /other-student-private-goal|private-interest|password123|chatbot-\d@/);
  assert.equal(await AIUsageLog.countDocuments({ student: student._id, feature: 'CHATBOT', outcome: 'SUCCESS' }), 1);
  assert.equal((await AIUsageBudget.findOne({ student: student._id })).used, 1);
  const log = await AIUsageLog.findOne({ student: student._id }).lean();
  assert.deepEqual(Object.keys(log).filter((key) => !['_id', 'createdAt'].includes(key)).sort(),
    ['feature', 'inputTokens', 'modelAlias', 'outcome', 'outputTokens', 'provider', 'student']);
  assert.equal(JSON.stringify(log).includes('What should I learn next?'), false);
});

test('course-material questions require a student and active enrollment before tutor work', async () => {
  const item = await course();
  const guest = await request(app).post(base).send({ message: 'Explain the PDF.', courseId: String(item._id) });
  assert.equal(guest.status, 401);
  assert.equal(guest.body.error.code, 'AUTH_REQUIRED');

  const forbiddenRole = await request(app).post(base).set('Cookie', cookie(instructor))
    .send({ message: 'Explain the PDF.', courseId: String(item._id) });
  assert.equal(forbiddenRole.status, 403);
  assert.equal(forbiddenRole.body.error.code, 'AUTH_ROLE_FORBIDDEN');

  const notEnrolled = await request(app).post(base).set('Cookie', cookie(student))
    .send({ message: 'Explain the PDF.', courseId: String(item._id) });
  assert.equal(notEnrolled.status, 403);
  assert.equal(notEnrolled.body.error.code, 'AI_ENROLLMENT_REQUIRED');
  assert.equal(providerCalls, 0);
  assert.equal(await AIUsageLog.countDocuments(), 0);
});

test('lesson-scoped chatbot requests preserve lesson validation in the PDF tutor', async () => {
  const item = await course({ lectures: [{ title: 'Authorized lesson', lecture: {
    public_id: 'LESSON_VIDEO', secure_url: 'https://video.example/lesson.mp4',
  } }] });
  await Enrollment.create({ student: student._id, course: item._id, source: 'FREE_ENROLLMENT', status: 'ACTIVE' });
  const response = await request(app).post(base).set('Cookie', cookie(student)).send({
    message: 'Explain this lesson.',
    courseId: String(item._id),
    lectureId: '555555555555555555555555',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'AI_TUTOR_INVALID');
  assert.equal(providerCalls, 0);
});

test('chatbot input is bounded and anonymous requests have a dedicated rate limit', async () => {
  const invalid = await request(app).post(base).send({ message: '   ', history: [] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'AI_CHAT_INVALID');
  for (const body of [
    { message: 'Explain the lesson.', lectureId: '555555555555555555555555' },
    { message: 'Explain the lesson.', courseId: '444444444444444444444444', lectureId: 'bad' },
    { message: 'Explain the lesson.', plainLanguage: 'true' },
  ]) {
    const invalidScope = await request(app).post(base).set('Cookie', cookie(student)).send(body);
    assert.equal(invalidScope.status, 400);
    assert.equal(invalidScope.body.error.code, 'AI_CHAT_INVALID');
  }

  app = makeApp({ security: { enabled: true, chatbotMax: 1 } });
  assert.equal((await request(app).post(base).send({ message: 'How do I study?' })).status, 200);
  const limited = await request(app).post(base).send({ message: 'How do I study?' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'SECURITY_RATE_LIMITED');
  assert.equal(providerCalls, 1);
});

test('provider failures return a safe fallback without exposing error details', async () => {
  app = makeApp({ fetchImpl: async () => {
    providerCalls += 1;
    throw new Error('SECRET_PROVIDER_DETAIL');
  } });
  const response = await request(app).post(base).send({ message: 'Explain recursion.' });
  assert.equal(response.status, 200);
  assert.match(response.body.chatbot.message, /could not respond/i);
  assert.doesNotMatch(JSON.stringify(response.body), /SECRET_PROVIDER_DETAIL|SERVER_ONLY_CHATBOT_KEY/);
});
