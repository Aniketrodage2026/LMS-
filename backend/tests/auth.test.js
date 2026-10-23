const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

// Replace only email delivery; reset-token generation and persistence remain real.
require('../utils/sendEmail');
const sendEmail = test.mock.method(
  require.cache[require.resolve('../utils/sendEmail')],
  'exports',
  async () => {}
);

const User = require('../models/user.schema');
const AuditLog = require('../models/audit-log.schema');
const { authorizedSubscriber } = require('../middleware/auth.middleware');
const errorMiddleware = require('../middleware/error.middleware');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createTestApp } = require('./helpers/app');

const app = createTestApp();

test.before(async () => {
  process.env.JWT_SECRET = 'auth-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
  test.mock.restoreAll();
});

test.beforeEach(() => {
  sendEmail.mock.resetCalls();
  sendEmail.mock.mockImplementation(async () => {});
});

test.afterEach(async () => {
  await AuditLog.collection.deleteMany({});
});

async function createUser(overrides = {}) {
  return User.create({
    fullName: 'Auth Test User',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'password123',
    ...overrides
  });
}

async function loginAs(email, password = 'password123') {
  const agent = request.agent(app);
  const response = await agent.post('/api/v1/auth/login').send({ email, password });
  assert.equal(response.status, 200);
  return agent;
}

function assertPrivateFieldsAbsent(user) {
  for (const field of ['password', 'forgotPasswordToken', 'forgotPasswordExpiry', 'subscription']) {
    assert.equal(Object.hasOwn(user, field), false, `${field} must not be returned`);
  }
}

function assertErrorResponse(response, statusCode, message, code) {
  assert.equal(response.status, statusCode);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, message);
  if (code) assert.deepEqual(response.body.error, { code, message });
}

test('POST /api/v1/auth/register creates a STUDENT despite a requested ADMIN role and issues an HttpOnly cookie without exposing a token', async () => {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({
      fullName: 'Registered Student',
      email: 'registered.student@example.com',
      password: 'password123',
      role: 'ADMIN'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.user.role, 'STUDENT');
  assert.equal(response.body.token, undefined);
  assertPrivateFieldsAbsent(response.body.user);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/i);
});

test('an invalid avatar leaves no account behind and the same email can be registered again', async () => {
  const email = `invalid-avatar-${Date.now()}@example.com`;
  const rejected = await request(app)
    .post('/api/v1/auth/register')
    .field('fullName', 'Invalid Avatar Student')
    .field('email', email)
    .field('password', 'password123')
    .attach('avatar', Buffer.from('not an image'), { filename: 'avatar.jpg', contentType: 'image/jpeg' });

  assert.equal(rejected.status, 400);
  assert.equal(await User.exists({ email }), null);

  const retried = await request(app).post('/api/v1/auth/register').send({
    fullName: 'Invalid Avatar Student', email, password: 'password123'
  });
  assert.equal(retried.status, 201);
});

test('a failed user presentation sends no authentication cookie', async (t) => {
  const environmentNames = [
    'R2_ENABLED', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'
  ];
  const previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  process.env.R2_ENABLED = 'true';
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_BUCKET_NAME;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const response = await request(app).post('/api/v1/auth/register').send({
    fullName: 'Presentation Failure Student',
    email: `presentation-failure-${Date.now()}@example.com`,
    password: 'password123'
  });

  assert.equal(response.status, 500);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('login returns a public user without a token and its cookie authenticates getprofile', async () => {
  const user = await createUser({
    fullName: 'Login Student',
    email: 'login.student@example.com',
    forgotPasswordToken: 'stored-reset-token-hash',
    forgotPasswordExpiry: new Date(Date.now() + 60_000),
    subscription: { id: 'sub-login', status: 'active' }
  });
  const agent = request.agent(app);

  const loginResponse = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: 'password123' });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.success, true);
  assert.equal(loginResponse.body.token, undefined);
  assertPrivateFieldsAbsent(loginResponse.body.user);
  assert.equal(loginResponse.body.user.role, 'STUDENT');

  const profileResponse = await agent.get('/api/v1/auth/getprofile');

  assert.equal(profileResponse.status, 200);
  assert.equal(profileResponse.body.success, true);
  assert.equal(profileResponse.body.user.email, user.email);
  assertPrivateFieldsAbsent(profileResponse.body.user);
});

test('duplicate signup normalizes email and returns only safe conflict guidance', async () => {
  const existingUser = await createUser({ email: 'duplicate.signup@example.com' });

  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({
      fullName: 'Duplicate Signup',
      email: '  DUPLICATE.Signup@EXAMPLE.COM  ',
      password: 'password123'
    });

  assertErrorResponse(response, 409, 'An account already exists for this email. Sign in instead, or reset your password if you do not remember it.', 'AUTH_EMAIL_EXISTS');
  assert.equal(response.body.user, undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  const publicBody = JSON.stringify(response.body);
  for (const privateValue of [existingUser.id, existingUser.fullName, existingUser.email]) {
    assert.equal(publicBody.includes(privateValue), false);
  }
  assert.equal(await User.countDocuments({ email: existingUser.email }), 1);
});

test('duplicate signup handles an insert-time email conflict with the same safe 409', async (t) => {
  await User.init();
  const existingUser = await createUser({ email: 'signup.race@example.com' });
  // Simulate a stale availability check while keeping the unique-index failure real.
  t.mock.method(User, 'findOne', async () => null);

  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ fullName: 'Concurrent Signup', email: existingUser.email, password: 'password123' });

  assertErrorResponse(response, 409, 'An account already exists for this email. Sign in instead, or reset your password if you do not remember it.', 'AUTH_EMAIL_EXISTS');
  assert.equal(response.body.user, undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(JSON.stringify(response.body).includes(existingUser.email), false);
  assert.equal(await User.countDocuments({ email: existingUser.email }), 1);
});

test('wrong-password and unknown-user login return identical safe credential errors', async (t) => {
  const user = await createUser({ email: 'invalid.login@example.com' });
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const wrongPassword = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: 'wrong-password' });
  const unknown = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'unknown.login@example.com', password: 'wrong-password' });

  for (const response of [wrongPassword, unknown]) {
    assertErrorResponse(response, 401, 'We couldn’t sign you in with that email and password. Check your details or reset your password.', 'AUTH_INVALID_CREDENTIALS');
    assert.equal(response.body.user, undefined);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.deepEqual(unknown.body, wrongPassword.body);
});

test('register reports missing required fields with an explicit validation code', async () => {
  const fullName = 'Required Fields';
  const email = 'required.register@example.com';
  const password = 'password123';

  for (const body of [
    { email, password },
    { fullName, password },
    { fullName, email },
    { fullName, email: '   ', password },
    { fullName: '   ', email, password }
  ]) {
    const response = await request(app).post('/api/v1/auth/register').send(body);
    assertErrorResponse(response, 400, 'Full name, email, and password are required.', 'VALIDATION_REQUIRED');
  }
  assert.equal(await User.countDocuments({ email }), 0);
});

test('login reports missing required fields with an explicit validation code', async () => {
  for (const body of [
    { email: 'required.login@example.com' },
    { password: 'password123' },
    { email: '   ', password: 'password123' }
  ]) {
    const response = await request(app).post('/api/v1/auth/login').send(body);
    assertErrorResponse(response, 400, 'Email and password are required.', 'VALIDATION_REQUIRED');
  }
});

test('login and registration without a request body report required-field validation', async () => {
  const login = await request(app).post('/api/v1/auth/login');
  const register = await request(app).post('/api/v1/auth/register');

  assertErrorResponse(login, 400, 'Email and password are required.', 'VALIDATION_REQUIRED');
  assertErrorResponse(register, 400, 'Full name, email, and password are required.', 'VALIDATION_REQUIRED');
});

test('known and unknown password-reset emails receive the exact same public response', async () => {
  const user = await createUser({ email: 'reset.privacy@example.com' });
  const known = await request(app)
    .post('/api/v1/auth/reset')
    .send({ email: '  RESET.PRIVACY@EXAMPLE.COM  ' });
  const unknown = await request(app)
    .post('/api/v1/auth/reset')
    .send({ email: 'unknown.reset@example.com' });
  const expected = {
    success: true,
    message: 'If an account exists for this email, a reset link is on its way.'
  };

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.body, expected);
  assert.deepEqual(unknown.body, expected);
  assert.equal(sendEmail.mock.callCount(), 1);
  const email = sendEmail.mock.calls[0].arguments[0];
  assert.equal(email.email, user.email);
  assert.equal(email.subject, 'Reset Password');
  const token = email.message.match(/\/rest-password\/([a-f0-9]{40})/)[1];
  const updatedUser = await User.findById(user.id);
  assert.equal(updatedUser.forgotPasswordToken, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(updatedUser.forgotPasswordExpiry.getTime() > Date.now());
});

test('expired and unknown password-reset tokens return safe reset-link guidance', async () => {
  const expiredToken = 'expired-reset-token';
  await createUser({
    email: 'expired.reset@example.com',
    forgotPasswordToken: crypto.createHash('sha256').update(expiredToken).digest('hex'),
    forgotPasswordExpiry: new Date(Date.now() - 60_000)
  });

  for (const token of [expiredToken, 'unknown-reset-token']) {
    const response = await request(app)
      .post(`/api/v1/auth/reset/${token}`)
      .send({ password: 'replacement-password' });
    assertErrorResponse(response, 400, 'This reset link has expired. Request a new one to continue.', 'AUTH_RESET_TOKEN_INVALID');
  }
});

test('failed reset-email delivery clears reset fields and hides provider details in production', async () => {
  const user = await createUser({ email: 'reset.failure@example.com' });
  let attemptedToken;
  sendEmail.mock.mockImplementation(async () => {
    const persistedUser = await User.findById(user.id);
    attemptedToken = persistedUser.forgotPasswordToken;
    assert.ok(attemptedToken);
    assert.ok(persistedUser.forgotPasswordExpiry);
    throw new Error('SMTP provider-secret rejected reset.failure@example.com');
  });
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    const response = await request(app)
      .post('/api/v1/auth/reset')
      .send({ email: user.email });
    const persistedUser = await User.findById(user.id);

    assert.ok(attemptedToken);
    assert.equal(persistedUser.forgotPasswordToken, undefined);
    assert.equal(persistedUser.forgotPasswordExpiry, undefined);
    assertErrorResponse(response, 500, 'We couldn’t send a reset link right now. Please try again.', 'AUTH_RESET_EMAIL_UNAVAILABLE');
    assert.equal(response.body.stack, undefined);
    assert.doesNotMatch(JSON.stringify(response.body), /SMTP|provider-secret|reset\.failure@example\.com/);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});

test('a STUDENT cannot change another user role', async () => {
  const student = await createUser({ email: 'role.student@example.com' });
  const target = await createUser({ email: 'role.target@example.com' });
  const agent = await loginAs(student.email);

  const response = await agent
    .patch(`/api/v1/admin/users/${target.id}/role`)
    .send({ role: 'INSTRUCTOR' });

  assertErrorResponse(response, 403, 'Your account does not have permission to do that.', 'AUTH_ROLE_FORBIDDEN');
  const missingTarget = await agent.patch('/api/v1/admin/users/not-a-user/role').send({ role: 'INSTRUCTOR' });
  assert.deepEqual(missingTarget.body.error, response.body.error);
});

test('an ADMIN can promote a different STUDENT to INSTRUCTOR', async () => {
  const admin = await createUser({
    fullName: 'Administrator User',
    email: 'admin@example.com',
    role: 'ADMIN'
  });
  const student = await createUser({
    email: 'promotable.student@example.com',
    forgotPasswordToken: 'role-target-reset-token-hash',
    forgotPasswordExpiry: new Date(Date.now() + 60_000),
    subscription: { id: 'sub-role-target', status: 'active' }
  });
  const agent = await loginAs(admin.email);

  const response = await agent
    .patch(`/api/v1/admin/users/${student.id}/role`)
    .send({ role: 'INSTRUCTOR' });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.user.role, 'INSTRUCTOR');
  assertPrivateFieldsAbsent(response.body.user);
});

test('an ADMIN cannot change another ADMIN role', async () => {
  const admin = await createUser({ email: 'role-admin-actor@example.com', role: 'ADMIN' });
  const target = await createUser({ email: 'role-admin-target@example.com', role: 'ADMIN' });
  const agent = await loginAs(admin.email);

  const responses = await Promise.all(
    ['STUDENT', 'INSTRUCTOR'].map((role) => agent
      .patch(`/api/v1/admin/users/${target.id}/role`)
      .send({ role }))
  );

  for (const response of responses) {
    assertErrorResponse(response, 403, 'Your account does not have permission to do that.', 'AUTH_ROLE_FORBIDDEN');
    assert.equal(response.body.user, undefined);
  }

  assert.equal((await User.findById(target.id)).role, 'ADMIN');
  assert.equal(await AuditLog.countDocuments({ action: 'ROLE_CHANGED', 'target.id': target._id }), 0);
});

test('role changes audit only successful ADMIN transitions with safe role metadata', async () => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser({ role: 'STUDENT' });
  const adminAgent = await loginAs(admin.email);
  const studentAgent = await loginAs(student.email);

  const promoted = await adminAgent
    .patch(`/api/v1/admin/users/${student.id}/role`)
    .send({ role: 'INSTRUCTOR' });

  assert.equal(promoted.status, 200);
  const events = await AuditLog.find({ action: 'ROLE_CHANGED', 'target.id': student._id });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(String(event.actor), String(admin._id));
  assert.equal(event.target.type, 'USER');
  assert.equal(String(event.target.id), String(student._id));
  assert.deepEqual(Object.fromEntries(event.summary), { fromRole: 'STUDENT', toRole: 'INSTRUCTOR' });
  for (const forbiddenField of ['email', 'password', 'token', 'cookie', 'ip', 'userAgent']) {
    assert.equal(event.summary.get(forbiddenField), undefined);
  }

  const repeated = await adminAgent
    .patch(`/api/v1/admin/users/${student.id}/role`)
    .send({ role: 'INSTRUCTOR' });
  const invalid = await adminAgent
    .patch(`/api/v1/admin/users/${student.id}/role`)
    .send({ role: 'ADMIN' });
  const missing = await adminAgent
    .patch(`/api/v1/admin/users/${new mongoose.Types.ObjectId()}/role`)
    .send({ role: 'STUDENT' });
  const forbidden = await studentAgent
    .patch(`/api/v1/admin/users/${admin.id}/role`)
    .send({ role: 'INSTRUCTOR' });

  assert.equal(repeated.status, 200);
  assert.equal(invalid.status, 400);
  assert.equal(missing.status, 404);
  assert.equal(forbidden.status, 403);
  assert.equal(await AuditLog.countDocuments({ action: 'ROLE_CHANGED' }), 1);
});

test('concurrent ADMIN role changes converge on one authoritative audit transition', async () => {
  const firstAdmin = await createUser({ role: 'ADMIN' });
  const secondAdmin = await createUser({ role: 'ADMIN' });
  const student = await createUser({ role: 'STUDENT' });
  const firstAgent = await loginAs(firstAdmin.email);
  const secondAgent = await loginAs(secondAdmin.email);

  const [firstResponse, secondResponse] = await Promise.all([
    firstAgent.patch(`/api/v1/admin/users/${student.id}/role`).send({ role: 'INSTRUCTOR' }),
    secondAgent.patch(`/api/v1/admin/users/${student.id}/role`).send({ role: 'INSTRUCTOR' })
  ]);

  for (const response of [firstResponse, secondResponse]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.user.role, 'INSTRUCTOR');
  }
  assert.equal((await User.findById(student.id)).role, 'INSTRUCTOR');
  const events = await AuditLog.find({ action: 'ROLE_CHANGED', 'target.id': student._id });
  assert.equal(events.length, 1);
  assert.deepEqual(Object.fromEntries(events[0].summary), { fromRole: 'STUDENT', toRole: 'INSTRUCTOR' });
});

test('a role change succeeds when audit persistence fails', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const student = await createUser({ role: 'STUDENT' });
  const agent = await loginAs(admin.email);
  t.mock.method(AuditLog, 'create', async () => { throw new Error('audit storage unavailable'); });

  const response = await agent
    .patch(`/api/v1/admin/users/${student.id}/role`)
    .send({ role: 'INSTRUCTOR' });

  assert.equal(response.status, 200);
  assert.equal((await User.findById(student.id)).role, 'INSTRUCTOR');
  assert.equal(AuditLog.create.mock.callCount(), 1);
});

test('role management rejects an attempt to assign ADMIN', async () => {
  const admin = await createUser({
    fullName: 'Second Administrator',
    email: 'admin-two@example.com',
    role: 'ADMIN'
  });
  const student = await createUser({ email: 'not-admin.student@example.com' });
  const agent = await loginAs(admin.email);

  const response = await agent
    .patch(`/api/v1/admin/users/${student.id}/role`)
    .send({ role: 'ADMIN' });

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, 'VALIDATION_INVALID_REQUEST');
});

test('role management handles malformed ids and hides unexpected database details', async (t) => {
  const admin = await createUser({ role: 'ADMIN' });
  const agent = await loginAs(admin.email);
  const malformed = await agent.patch('/api/v1/admin/users/not-a-user/role').send({ role: 'INSTRUCTOR' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'VALIDATION_INVALID_REQUEST');
  assert.doesNotMatch(JSON.stringify(malformed.body), /CastError|Cast to ObjectId/);
  t.mock.method(User, 'findOneAndUpdate', async () => { throw new Error('MongoDB password=secret'); });
  const failed = await agent.patch(`/api/v1/admin/users/${admin.id}/role`).send({ role: 'STUDENT' });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(failed.body), /MongoDB|password=secret/);
  assert.equal(await AuditLog.countDocuments({ action: 'ROLE_CHANGED' }), 0);
});

test('missing and invalid cookies receive the same safe 401 response', async () => {
  const withoutCookie = await request(app).get('/api/v1/auth/getprofile');
  const withInvalidCookie = await request(app)
    .get('/api/v1/auth/getprofile')
    .set('Cookie', 'token=not-a-jwt');

  assertErrorResponse(withoutCookie, 401, 'Authentication required');
  assertErrorResponse(withInvalidCookie, 401, 'Authentication required');
});

test('authorizedSubscriber returns a safe 401 when no authenticated user was attached', async () => {
  const guardedApp = express();
  guardedApp.get('/subscriber-check', authorizedSubscriber, (req, res) => {
    res.status(200).json({ success: true });
  });
  guardedApp.use(errorMiddleware);

  const response = await request(guardedApp).get('/subscriber-check');

  assertErrorResponse(response, 401, 'Authentication required');
});
