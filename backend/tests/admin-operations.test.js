const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');
const request = require('supertest');

const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const AuditLog = require('../models/audit-log.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const Purchase = require('../models/purchase.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createTestApp } = require('./helpers/app');

const app = createTestApp();
let userSequence = 0;

test.before(async () => {
  process.env.JWT_SECRET = 'admin-operations-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
});

test.beforeEach(async () => {
  await Promise.all([
    AuditLog.collection.deleteMany({}), LectureProgress.deleteMany({}), Enrollment.deleteMany({}),
    Purchase.deleteMany({}), Course.deleteMany({}), User.deleteMany({})
  ]);
});

async function createUser(overrides = {}) {
  userSequence += 1;
  return User.create({
    fullName: `Directory User ${userSequence}`,
    email: `directory-${userSequence}@example.com`,
    password: 'password123',
    role: 'STUDENT',
    ...overrides
  });
}

async function createCourse(instructor, overrides = {}) {
  return Course.create({
    title: 'Administrative Course Directory',
    description: 'A course used to exercise the administrative directory.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: {
      public_id: 'private-thumbnail-id',
      secure_url: 'https://cdn.example/course.png'
    },
    ...overrides
  });
}

async function createPurchase(student, course, overrides = {}) {
  const suffix = new mongoose.Types.ObjectId().toString();
  return Purchase.create({
    student: student._id,
    course: course._id,
    amount: 1000,
    receipt: `admin-report-${suffix}`,
    razorpayOrderId: `order_admin_report_${suffix}`,
    ...overrides
  });
}

async function login(user) {
  const agent = request.agent(app);
  const response = await agent.post('/api/v1/auth/login').send({
    email: user.email,
    password: 'password123'
  });
  assert.equal(response.status, 200);
  return agent;
}

function assertInvalidRequest(response) {
  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Check the admin filters or paging details and try again.');
  assert.deepEqual(response.body.error, {
    code: 'ADMIN_INVALID_REQUEST',
    message: 'Check the admin filters or paging details and try again.'
  });
}

test('GET /api/v1/admin/users is denied to guests and non-admin users', async () => {
  const student = await createUser();

  const guest = await request(app).get('/api/v1/admin/users');
  assert.equal(guest.status, 401);

  const denied = await (await login(student)).get('/api/v1/admin/users');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'AUTH_ROLE_FORBIDDEN');
});

test('GET /api/v1/admin/users filters users and returns only directory-safe fields', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const matchingStudent = await createUser({
    fullName: 'Alice Directory',
    email: 'alice@example.com',
    avatar: { secure_url: 'https://cdn.example/alice.png', public_id: 'internal-avatar-id' },
    forgotPasswordToken: 'secret-reset-token',
    forgotPasswordExpiry: new Date('2030-01-01T00:00:00.000Z'),
    subscription: { id: 'subscription-secret', status: 'active' }
  });
  await createUser({ fullName: 'Unrelated Person', email: 'other@example.com', role: 'INSTRUCTOR' });
  await createUser({ fullName: 'Admin Example', email: 'admin-search@example.com', role: 'ADMIN' });

  const response = await (await login(admin)).get('/api/v1/admin/users?role=STUDENT&query=%20alice%20');
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.users.length, 1);
  assert.equal(response.body.nextCursor, null);
  assert.deepEqual(response.body.users[0], {
    id: String(matchingStudent._id),
    name: 'alice directory',
    email: 'alice@example.com',
    avatar: 'https://cdn.example/alice.png',
    role: 'STUDENT',
    createdAt: matchingStudent.createdAt.toISOString()
  });
  assert.deepEqual(Object.keys(response.body.users[0]).sort(), [
    'avatar', 'createdAt', 'email', 'id', 'name', 'role'
  ]);
  assert.doesNotMatch(JSON.stringify(response.body.users[0]), /password|reset|subscription|public_id/i);

  const emailQuery = await (await login(admin)).get('/api/v1/admin/users?query=ADMIN-SEARCH%40EXAMPLE.COM');
  assert.equal(emailQuery.status, 200);
  assert.equal(emailQuery.body.users.length, 1);
  assert.equal(emailQuery.body.users[0].role, 'ADMIN');
});

test('GET /api/v1/admin/users treats query regex metacharacters as literal text', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const literalMatch = await createUser({ fullName: 'Literal a+b User', email: 'literal@example.com' });
  await createUser({ fullName: 'Broad Match User', email: 'broad@example.com' });

  const agent = await login(admin);
  const plusQuery = await agent.get('/api/v1/admin/users?query=a%2Bb');
  assert.equal(plusQuery.status, 200);
  assert.deepEqual(plusQuery.body.users.map((user) => user.id), [String(literalMatch._id)]);

  const wildcardQuery = await agent.get('/api/v1/admin/users?query=.*');
  assert.equal(wildcardQuery.status, 200);
  assert.deepEqual(wildcardQuery.body.users, []);
});

test('GET /api/v1/admin/users paginates newest-first with deterministic id tie ordering', async () => {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  const admin = await createUser({
    role: 'ADMIN',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z')
  });
  const oldestId = new mongoose.Types.ObjectId('000000000000000000000011');
  const middleId = new mongoose.Types.ObjectId('000000000000000000000012');
  const newestId = new mongoose.Types.ObjectId('000000000000000000000013');

  await User.create([
    { _id: oldestId, fullName: 'Oldest Directory', email: 'oldest@example.com', password: 'password123', createdAt: timestamp, updatedAt: timestamp },
    { _id: middleId, fullName: 'Middle Directory', email: 'middle@example.com', password: 'password123', createdAt: timestamp, updatedAt: timestamp },
    { _id: newestId, fullName: 'Newest Directory', email: 'newest@example.com', password: 'password123', createdAt: timestamp, updatedAt: timestamp }
  ]);

  const agent = await login(admin);
  const first = await agent.get('/api/v1/admin/users?limit=1&role=STUDENT');
  assert.equal(first.status, 200);
  assert.equal(first.body.users.length, 1);
  assert.equal(first.body.users[0].id, String(newestId));
  assert.match(first.body.nextCursor, /^[A-Za-z0-9_-]+$/);

  const second = await agent.get(`/api/v1/admin/users?limit=1&role=STUDENT&cursor=${first.body.nextCursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.users[0].id, String(middleId));
  assert.match(second.body.nextCursor, /^[A-Za-z0-9_-]+$/);

  const third = await agent.get(`/api/v1/admin/users?limit=1&role=STUDENT&cursor=${second.body.nextCursor}`);
  assert.equal(third.status, 200);
  assert.equal(third.body.users[0].id, String(oldestId));
  assert.equal(third.body.nextCursor, null);
});

test('GET /api/v1/admin/users rejects malformed filters and cursor details safely', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const agent = await login(admin);
  const extraCursorField = Buffer.from(JSON.stringify({
    at: '2026-01-01T00:00:00.000Z',
    id: '000000000000000000000001',
    extra: true
  })).toString('base64url');

  for (const query of [
    'limit=0',
    'limit=51',
    'limit=1.5',
    'limit=one',
    'cursor=not-a-valid-cursor',
    `cursor=${extraCursorField}`,
    `cursor=${Buffer.from(JSON.stringify({ at: '2026-01-01', id: '000000000000000000000001' })).toString('base64url')}`,
    'role=OWNER',
    `query=${'a'.repeat(101)}`
  ]) {
    const response = await agent.get(`/api/v1/admin/users?${query}`);
    assertInvalidRequest(response);
    assert.doesNotMatch(JSON.stringify(response.body), /CastError|BSON|not-a-valid-cursor|OWNER/i);
  }
});

test('GET /api/v1/admin/courses is admin-only and returns filtered directory-safe courses', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const instructor = await createUser({
    role: 'INSTRUCTOR',
    fullName: 'Course Teacher',
    email: 'teacher@example.com',
    avatar: { secure_url: 'https://cdn.example/teacher.png', public_id: 'private-avatar-id' }
  });
  const student = await createUser();
  const included = await createCourse(instructor, {
    title: 'Literal a+b Course',
    status: 'UNPUBLISHED',
    accessType: 'PAID',
    price: 2500,
    numberOflectures: 4,
    lectures: [{
      title: 'Hidden lecture', description: 'hidden',
      lecture: { public_id: 'private-video-id', secure_url: 'https://cdn.example/video.mp4' }
    }]
  });
  await createCourse(instructor, { title: 'Published other course', status: 'PUBLISHED' });

  const guest = await request(app).get('/api/v1/admin/courses');
  assert.equal(guest.status, 401);
  const denied = await (await login(student)).get('/api/v1/admin/courses');
  assert.equal(denied.status, 403);

  const response = await (await login(admin)).get('/api/v1/admin/courses?status=UNPUBLISHED&query=a%2Bb');
  assert.equal(response.status, 200);
  assert.equal(response.body.nextCursor, null);
  assert.deepEqual(response.body.courses, [{
    id: String(included._id),
    title: 'Literal a+b Course',
    description: included.description,
    thumbnail: 'https://cdn.example/course.png',
    instructor: {
      id: String(instructor._id), name: 'course teacher', email: 'teacher@example.com', avatar: 'https://cdn.example/teacher.png'
    },
    accessType: 'PAID', price: 2500, currency: 'INR', status: 'UNPUBLISHED', lectureCount: 4,
    createdAt: included.createdAt.toISOString(), updatedAt: included.updatedAt.toISOString()
  }]);
  assert.doesNotMatch(JSON.stringify(response.body.courses[0]), /public_id|lectures|private-|video/i);

  for (const query of ['status=DRAFT', 'status=published', `query=${'a'.repeat(101)}`]) {
    assertInvalidRequest(await (await login(admin)).get(`/api/v1/admin/courses?${query}`));
  }
});

test('GET /api/v1/admin/courses uses the shared opaque cursor in newest-first order', async () => {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  const admin = await createUser({ role: 'ADMIN' });
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const olderId = new mongoose.Types.ObjectId('000000000000000000000021');
  const newerId = new mongoose.Types.ObjectId('000000000000000000000022');
  await Course.create([
    {
      _id: olderId, title: 'Older course directory', description: 'Older course description.', category: 'Programming',
      instructor: instructor._id, thumbnail: { public_id: 'older-private', secure_url: 'https://cdn.example/older.png' },
      createdAt: timestamp, updatedAt: timestamp
    },
    {
      _id: newerId, title: 'Newer course directory', description: 'Newer course description.', category: 'Programming',
      instructor: instructor._id, thumbnail: { public_id: 'newer-private', secure_url: 'https://cdn.example/newer.png' },
      createdAt: timestamp, updatedAt: timestamp
    }
  ]);

  const agent = await login(admin);
  const first = await agent.get('/api/v1/admin/courses?limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.courses[0].id, String(newerId));
  assert.match(first.body.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = await agent.get(`/api/v1/admin/courses?limit=1&cursor=${first.body.nextCursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.courses[0].id, String(olderId));
  assert.equal(second.body.nextCursor, null);
});

test('GET /api/v1/admin/courses applies its own default limit and rejects malformed paging and status filters', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  await Course.create(Array.from({ length: 26 }, (_, index) => ({
    title: `Directory default course ${index}`,
    description: 'A course for testing the administrative default page size.',
    category: 'Programming',
    instructor: instructor._id,
    thumbnail: { public_id: `private-${index}`, secure_url: `https://cdn.example/${index}.png` }
  })));
  const agent = await login(admin);

  const defaultPage = await agent.get('/api/v1/admin/courses');
  assert.equal(defaultPage.status, 200);
  assert.equal(defaultPage.body.courses.length, 25);
  assert.match(defaultPage.body.nextCursor, /^[A-Za-z0-9_-]+$/);

  for (const query of ['cursor=not-a-valid-cursor', 'limit=0', 'limit=51', 'limit=1.5', 'status=DRAFT', 'status=published']) {
    assertInvalidRequest(await agent.get(`/api/v1/admin/courses?${query}`));
  }
});

test('PATCH /api/v1/admin/courses/:courseId/status is denied to guests and non-admins', async () => {
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const student = await createUser();
  const course = await createCourse(owner, { status: 'UNPUBLISHED' });

  const guest = await request(app).patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'PUBLISHED' });
  assert.equal(guest.status, 401);
  const denied = await (await login(student)).patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'PUBLISHED' });
  assert.equal(denied.status, 403);
  assert.equal((await Course.findById(course._id)).status, 'UNPUBLISHED');
});

test('PATCH /api/v1/admin/courses/:courseId/status atomically changes only PUBLISHED or UNPUBLISHED and audits actual changes', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(owner, { status: 'UNPUBLISHED' });
  const agent = await login(admin);

  const published = await agent.patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'PUBLISHED' });
  assert.equal(published.status, 200);
  assert.equal(published.body.course.status, 'PUBLISHED');
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': course._id }), 1);
  const publishAudit = await AuditLog.findOne({ action: 'COURSE_PUBLISHED', 'target.id': course._id }).lean();
  assert.equal(publishAudit.summary, undefined);
  assert.equal(String(publishAudit.actor), String(admin._id));

  const repeated = await agent.patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'PUBLISHED' });
  assert.equal(repeated.status, 200);
  assert.equal(await AuditLog.countDocuments({ 'target.id': course._id }), 1);

  const unpublished = await agent.patch(`/api/v1/admin/courses/${course.id}/status`).send({ status: 'UNPUBLISHED' });
  assert.equal(unpublished.status, 200);
  const update = await AuditLog.findOne({ action: 'COURSE_UPDATED', 'target.id': course._id }).lean();
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': course._id }), 1);
  assert.equal(update.summary.status, 'UNPUBLISHED');
  assert.equal(String(update.actor), String(admin._id));
  assert.equal(String((await Course.findById(course._id)).instructor), String(owner._id));

  const competing = await createCourse(owner, { status: 'UNPUBLISHED' });
  const transitions = await Promise.all(Array.from({ length: 2 }, () => (
    agent.patch(`/api/v1/admin/courses/${competing.id}/status`).send({ status: 'PUBLISHED' })
  )));
  assert.deepEqual(transitions.map((response) => response.status).sort(), [200, 200]);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': competing._id }), 1);
});

test('PATCH /api/v1/admin/courses/:courseId/status advances course version so a stale status save fails', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(owner, { status: 'PUBLISHED' });
  const staleCourse = await Course.findById(course._id);

  const response = await (await login(admin))
    .patch(`/api/v1/admin/courses/${course.id}/status`)
    .send({ status: 'UNPUBLISHED' });

  assert.equal(response.status, 200);
  staleCourse.status = 'UNPUBLISHED';
  await assert.rejects(staleCourse.save(), (error) => error?.name === 'VersionError');
});

test('competing opposite admin status transitions each return their own committed status', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(owner, { status: 'UNPUBLISHED' });
  const agent = await login(admin);
  const originalFindOneAndUpdate = Course.findOneAndUpdate;
  let interleavedResponse;
  let interleaved = false;

  t.mock.method(Course, 'findOneAndUpdate', function interleaveOppositeStatus(...args) {
    const query = originalFindOneAndUpdate.apply(this, args);
    const originalExec = query.exec;
    query.exec = async function executeWithInterleaving(...execArgs) {
      const result = await originalExec.apply(this, execArgs);
      if (!interleaved) {
        interleaved = true;
        interleavedResponse = await agent
          .patch(`/api/v1/admin/courses/${course.id}/status`)
          .send({ status: 'UNPUBLISHED' });
      }
      return result;
    };
    return query;
  });

  const publishedResponse = await agent
    .patch(`/api/v1/admin/courses/${course.id}/status`)
    .send({ status: 'PUBLISHED' });

  assert.equal(publishedResponse.status, 200);
  assert.equal(publishedResponse.body.course.status, 'PUBLISHED');
  assert.equal(interleavedResponse.status, 200);
  assert.equal(interleavedResponse.body.course.status, 'UNPUBLISHED');
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_PUBLISHED', 'target.id': course._id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: 'COURSE_UPDATED', 'target.id': course._id }), 1);
});

test('PATCH /api/v1/admin/courses/:courseId/status succeeds when audit storage fails and propagates its request id safely', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(owner, { status: 'UNPUBLISHED' });
  const warnings = [];
  t.mock.method(console, 'warn', (entry) => warnings.push(JSON.parse(entry)));
  t.mock.method(AuditLog, 'create', async () => { throw new Error('audit storage unavailable'); });

  const response = await (await login(admin))
    .patch(`/api/v1/admin/courses/${course.id}/status`)
    .send({ status: 'PUBLISHED' });

  assert.equal(response.status, 200);
  assert.equal(response.body.course.status, 'PUBLISHED');
  assert.equal(await AuditLog.countDocuments({ 'target.id': course._id }), 0);
  assert.deepEqual(warnings, [{
    event: 'audit_log_failure',
    requestId: response.headers['x-request-id'],
    action: 'COURSE_PUBLISHED'
  }]);
});

test('PATCH /api/v1/admin/courses/:courseId/status returns a safe unexpected error when status storage fails', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(owner, { status: 'UNPUBLISHED' });
  t.mock.method(Course, 'findOneAndUpdate', () => {
    const query = Course.findOne({ _id: course._id });
    query.exec = async () => { throw new Error('database topology private details'); };
    return query;
  });

  const response = await (await login(admin))
    .patch(`/api/v1/admin/courses/${course.id}/status`)
    .send({ status: 'PUBLISHED' });

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'SYSTEM_UNEXPECTED');
  assert.doesNotMatch(JSON.stringify(response.body), /database topology|private details/i);
});

test('PATCH /api/v1/admin/courses/:courseId/status rejects malformed ids and statuses without audit events', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const owner = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(owner);
  const agent = await login(admin);

  for (const [id, body] of [
    ['not-an-id', { status: 'PUBLISHED' }],
    [course.id, {}],
    [course.id, { status: 'DRAFT' }],
    [course.id, { status: 'published' }]
  ]) {
    assertInvalidRequest(await agent.patch(`/api/v1/admin/courses/${id}/status`).send(body));
  }
  const missing = await agent.patch(`/api/v1/admin/courses/${new mongoose.Types.ObjectId()}/status`).send({ status: 'PUBLISHED' });
  assert.equal(missing.status, 404);
  assert.equal(await AuditLog.countDocuments(), 0);
});

test('GET /api/v1/admin/overview is admin-only and reports exact operational metrics and safe recent activity', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const student = await createUser({ fullName: 'Overview Student' });
  const revokedStudent = await createUser({ fullName: 'Revoked Student' });
  const course = await createCourse(instructor, {
    status: 'PUBLISHED', lectures: [
      { title: 'One', description: 'one', lecture: { public_id: 'one', secure_url: 'https://cdn.example/one' } },
      { title: 'Two', description: 'two', lecture: { public_id: 'two', secure_url: 'https://cdn.example/two' } }
    ]
  });
  await createCourse(instructor, { status: 'UNPUBLISHED' });
  const deletedCourse = await createCourse(instructor, {
    title: 'Deleted Overview Course',
    lectures: [{ title: 'Ghost', description: 'ghost', lecture: { public_id: 'ghost', secure_url: 'https://cdn.example/ghost' } }]
  });
  await Enrollment.create([
    { student: student._id, course: course._id, source: 'FREE_ENROLLMENT' },
    { student: revokedStudent._id, course: course._id, source: 'FREE_ENROLLMENT', status: 'REVOKED' },
    { student: student._id, course: deletedCourse._id, source: 'FREE_ENROLLMENT' }
  ]);
  await LectureProgress.create([
    { student: student._id, course: course._id, lectureId: course.lectures[0]._id, completed: true },
    { student: student._id, course: course._id, lectureId: new mongoose.Types.ObjectId(), completed: true },
    { student: revokedStudent._id, course: course._id, lectureId: course.lectures[1]._id, completed: true },
    { student: student._id, course: deletedCourse._id, lectureId: deletedCourse.lectures[0]._id, completed: true }
  ]);
  await Course.deleteOne({ _id: deletedCourse._id });
  await createPurchase(student, course, { status: 'VERIFIED', amount: 1250 });
  await createPurchase(revokedStudent, course, { status: 'PENDING', amount: 900 });
  const activities = await Promise.all(Array.from({ length: 11 }, (_, index) => AuditLog.create({
    actor: admin._id, action: 'COURSE_UPDATED', target: { type: 'COURSE', id: course._id },
    summary: { index: String(index), secret: 'do-not-leak' }, createdAt: new Date(2026, 0, 1, 0, 0, index)
  })));

  assert.equal((await request(app).get('/api/v1/admin/overview')).status, 401);
  assert.equal((await (await login(student)).get('/api/v1/admin/overview')).status, 403);
  const response = await (await login(admin)).get('/api/v1/admin/overview');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['metrics', 'recentActivity', 'success']);
  assert.deepEqual(response.body.metrics, {
    users: { total: 4, students: 2, instructors: 1, admins: 1 },
    courses: { total: 2, published: 1 }, activeEnrollments: 2,
    purchases: { verifiedCount: 1, verifiedRevenuePaise: 1250, currency: 'INR' },
    learning: { completedLectures: 1, totalLectureSlots: 2, completionPercent: 50 }
  });
  assert.equal(response.body.recentActivity.length, 10);
  assert.equal(response.body.recentActivity[0].id, String(activities[10]._id));
  assert.deepEqual(Object.keys(response.body.recentActivity[0]).sort(), ['action', 'actor', 'createdAt', 'id', 'summary', 'target']);
  assert.deepEqual(response.body.recentActivity[0].summary, {});
  assert.doesNotMatch(JSON.stringify(response.body.recentActivity), /secret|do-not-leak/i);
  assert.equal(await AuditLog.countDocuments(), 11);
});

test('GET /api/v1/admin/overview returns zero-safe empty state and safe query failures', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const empty = await (await login(admin)).get('/api/v1/admin/overview');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.metrics, {
    users: { total: 1, students: 0, instructors: 0, admins: 1 }, courses: { total: 0, published: 0 }, activeEnrollments: 0,
    purchases: { verifiedCount: 0, verifiedRevenuePaise: 0, currency: 'INR' },
    learning: { completedLectures: 0, totalLectureSlots: 0, completionPercent: 0 }
  });
  assert.deepEqual(empty.body.recentActivity, []);
  t.mock.method(User, 'countDocuments', () => { throw new Error('private database topology'); });
  const failed = await (await login(admin)).get('/api/v1/admin/overview');
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, 'SYSTEM_UNEXPECTED');
  assert.doesNotMatch(JSON.stringify(failed.body), /private database/i);
});

test('GET /api/v1/admin/purchases exposes only verified safe records with updated-time cursor pagination', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser({ fullName: 'Paid Student', email: 'paid@example.com' });
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(instructor, { title: 'Verified Purchase Course' });
  const at = new Date('2026-02-01T00:00:00.000Z');
  const older = await createPurchase(student, course, { status: 'VERIFIED', updatedAt: at, amount: 1111 });
  const newer = await createPurchase(admin, course, { status: 'VERIFIED', updatedAt: at, amount: 2222 });
  await createPurchase(student, course, { status: 'FAILED', amount: 3333 });
  assert.equal((await request(app).get('/api/v1/admin/purchases')).status, 401);
  assert.equal((await (await login(student)).get('/api/v1/admin/purchases')).status, 403);
  const agent = await login(admin);
  const first = await agent.get('/api/v1/admin/purchases?limit=1');
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ['nextCursor', 'purchases', 'success']);
  assert.equal(first.body.purchases.length, 1);
  assert.equal(first.body.purchases[0].id, String(newer._id));
  assert.deepEqual(Object.keys(first.body.purchases[0]).sort(), ['amount', 'course', 'currency', 'id', 'student', 'verifiedAt']);
  assert.doesNotMatch(JSON.stringify(first.body), /razorpay|receipt|signature|status/i);
  const second = await agent.get(`/api/v1/admin/purchases?limit=1&cursor=${first.body.nextCursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.purchases[0].id, String(older._id));
  assert.equal(second.body.nextCursor, null);
  assert.equal(await AuditLog.countDocuments(), 0);
});

test('GET /api/v1/admin/purchases applies its default 25-record page with continuation', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser();
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(instructor, { title: 'Default Purchase Page Course' });
  await Promise.all(Array.from({ length: 26 }, (_, index) => createPurchase(student, course, {
    status: 'VERIFIED', updatedAt: new Date(2026, 3, 1, 0, 0, index)
  })));
  const response = await (await login(admin)).get('/api/v1/admin/purchases');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['nextCursor', 'purchases', 'success']);
  assert.equal(response.body.purchases.length, 25);
  assert.match(response.body.nextCursor, /^[A-Za-z0-9_-]+$/);
});

test('GET /api/v1/admin/purchases filters safely, tolerates deleted courses, and masks query failures', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser();
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const kept = await createCourse(instructor, { title: 'Kept Purchase Course' });
  const deleted = await createCourse(instructor, { title: 'Deleted Purchase Course' });
  const keptPurchase = await createPurchase(student, kept, { status: 'VERIFIED' });
  const deletedPurchase = await createPurchase(admin, deleted, { status: 'VERIFIED' });
  await Course.deleteOne({ _id: deleted._id });
  const agent = await login(admin);
  const filtered = await agent.get(`/api/v1/admin/purchases?courseId=${kept._id}`);
  assert.deepEqual(filtered.body.purchases.map((purchase) => purchase.id), [String(keptPurchase._id)]);
  const all = await agent.get('/api/v1/admin/purchases');
  assert.equal(all.body.purchases.find((purchase) => purchase.id === String(deletedPurchase._id)).course, null);
  for (const query of ['courseId=bad-id', 'limit=0', 'cursor=bad']) assertInvalidRequest(await agent.get(`/api/v1/admin/purchases?${query}`));
  t.mock.method(Purchase, 'aggregate', () => { throw new Error('payment provider private data'); });
  const failed = await agent.get('/api/v1/admin/purchases');
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, 'SYSTEM_UNEXPECTED');
  assert.doesNotMatch(JSON.stringify(failed.body), /provider private/i);
});

test('GET /api/v1/admin/overview calculates learning with aggregation pipelines, not unbounded model finds', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  t.mock.method(Enrollment, 'find', () => { throw new Error('overview must not load enrollments'); });
  t.mock.method(LectureProgress, 'find', () => { throw new Error('overview must not load progress'); });
  const response = await (await login(admin)).get('/api/v1/admin/overview');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.metrics.learning, { completedLectures: 0, totalLectureSlots: 0, completionPercent: 0 });
});

test('admin reports exclude malformed raw purchases and malformed audit records without leaking or failing', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser();
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(instructor, { title: 'Raw Report Validation Course' });
  const validPurchase = await createPurchase(student, course, { status: 'VERIFIED', amount: 700 });
  const now = new Date('2026-05-01T00:00:00.000Z');
  await Purchase.collection.insertMany([
    ...[-2, 1.5, 10, '700', 9, Number.MAX_SAFE_INTEGER + 1, mongoose.Types.Decimal128.fromString('700')].map((amount, index) => ({
      _id: new mongoose.Types.ObjectId(), student: student._id, course: course._id, status: 'VERIFIED',
      currency: index === 2 ? 'USD' : 'INR', amount, updatedAt: index === 4 ? 'not-a-date' : now,
      receipt: `raw-report-receipt-${index}-${new mongoose.Types.ObjectId()}`,
      razorpayOrderId: `raw-report-order-${index}-${new mongoose.Types.ObjectId()}`
    }))
  ]);
  await Course.collection.updateOne({ _id: course._id }, { $set: { title: 123 } });
  const rawAuditId = new mongoose.Types.ObjectId();
  await AuditLog.collection.insertMany([
    {
      _id: rawAuditId, actor: admin._id, action: 'ROLE_CHANGED', target: { type: 'USER', id: student._id },
      summary: {
        fromRole: 'STUDENT', toRole: 'ADMIN', apiKey: 'never', credential: 'never', session: 'never',
        secret: 'never', tooLong: 'x'.repeat(31)
      }, createdAt: new Date('2026-05-02T00:00:00.000Z')
    },
    { _id: new mongoose.Types.ObjectId(), actor: 'invalid', action: 'ROLE_CHANGED', target: { type: 'USER', id: student._id }, summary: { fromRole: 'STUDENT' }, createdAt: now },
    { _id: new mongoose.Types.ObjectId(), actor: admin._id, action: 'ROLE_CHANGED', target: { type: 'USER', id: 'invalid' }, summary: { fromRole: 'STUDENT' }, createdAt: now },
    { _id: new mongoose.Types.ObjectId(), actor: admin._id, action: 'ROLE_CHANGED', target: { type: 'USER', id: student._id }, summary: { fromRole: 'STUDENT' }, createdAt: 'bad-date' }
  ]);
  const agent = await login(admin);
  const overview = await agent.get('/api/v1/admin/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.metrics.purchases.verifiedCount, 1);
  assert.equal(overview.body.metrics.purchases.verifiedRevenuePaise, 700);
  assert.deepEqual(overview.body.recentActivity, [{
    id: String(rawAuditId), actor: String(admin._id), action: 'ROLE_CHANGED',
    target: { type: 'USER', id: String(student._id) }, summary: { fromRole: 'STUDENT', toRole: 'ADMIN' },
    createdAt: '2026-05-02T00:00:00.000Z'
  }]);
  const purchases = await agent.get('/api/v1/admin/purchases');
  assert.deepEqual(purchases.body.purchases.map((purchase) => purchase.id), [String(validPurchase._id)]);
  assert.equal(purchases.body.purchases[0].course, null);
});

test('GET /api/v1/admin/purchases skips invalid students before cursor pagination', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser();
  const instructor = await createUser({ role: 'INSTRUCTOR' });
  const course = await createCourse(instructor, { title: 'Purchase Student Paging Course' });
  const older = await createPurchase(student, course, { status: 'VERIFIED', updatedAt: new Date('2026-06-01T00:00:00.000Z') });
  const newer = await createPurchase(student, course, { status: 'VERIFIED', updatedAt: new Date('2026-06-03T00:00:00.000Z') });
  await Purchase.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(), student: student._id, course: course._id, status: 'VERIFIED', currency: 'INR', amount: mongoose.Types.Decimal128.fromString('100'), updatedAt: new Date('2026-06-05T00:00:00.000Z'), receipt: `decimal-new-${new mongoose.Types.ObjectId()}`, razorpayOrderId: `decimal-new-order-${new mongoose.Types.ObjectId()}` },
    { _id: new mongoose.Types.ObjectId(), student: new mongoose.Types.ObjectId(), course: course._id, status: 'VERIFIED', currency: 'INR', amount: 100, updatedAt: new Date('2026-06-04T00:00:00.000Z'), receipt: `bad-student-new-${new mongoose.Types.ObjectId()}`, razorpayOrderId: `bad-student-new-order-${new mongoose.Types.ObjectId()}` },
    { _id: new mongoose.Types.ObjectId(), student: new mongoose.Types.ObjectId(), course: course._id, status: 'VERIFIED', currency: 'INR', amount: 100, updatedAt: new Date('2026-06-02T00:00:00.000Z'), receipt: `bad-student-middle-${new mongoose.Types.ObjectId()}`, razorpayOrderId: `bad-student-middle-order-${new mongoose.Types.ObjectId()}` }
  ]);
  const agent = await login(admin);
  const first = await agent.get('/api/v1/admin/purchases?limit=1');
  assert.deepEqual(first.body.purchases.map((purchase) => purchase.id), [String(newer._id)]);
  assert.match(first.body.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = await agent.get(`/api/v1/admin/purchases?limit=1&cursor=${first.body.nextCursor}`);
  assert.deepEqual(second.body.purchases.map((purchase) => purchase.id), [String(older._id)]);
  assert.equal(second.body.nextCursor, null);
});
