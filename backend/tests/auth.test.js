const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const User = require('../models/user.schema');
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

function assertErrorResponse(response, statusCode, message) {
  assert.equal(response.status, statusCode);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, message);
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

test('a STUDENT cannot change another user role', async () => {
  const student = await createUser({ email: 'role.student@example.com' });
  const target = await createUser({ email: 'role.target@example.com' });
  const agent = await loginAs(student.email);

  const response = await agent
    .patch(`/api/v1/admin/users/${target.id}/role`)
    .send({ role: 'INSTRUCTOR' });

  assertErrorResponse(response, 403, 'You do not have access to this route');
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
