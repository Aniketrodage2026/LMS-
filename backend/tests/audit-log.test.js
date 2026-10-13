const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');
const request = require('supertest');

const AuditLog = require('../models/audit-log.schema');
const User = require('../models/user.schema');
const { recordAudit, recordAuditSafely } = require('../services/audit-log.service');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createTestApp } = require('./helpers/app');

const app = createTestApp();
let userSequence = 0;

test.before(async () => {
  process.env.JWT_SECRET = 'audit-log-test-secret';
  process.env.JWT_EXPIRY = '1h';
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
});

test.beforeEach(async () => {
  await Promise.all([AuditLog.collection.deleteMany({}), User.deleteMany({})]);
});

async function createUser(role = 'STUDENT') {
  userSequence += 1;
  return User.create({
    fullName: `Audit User ${userSequence}`,
    email: `audit-${userSequence}@example.com`,
    password: 'password123',
    role
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

function auditInput(overrides = {}) {
  return {
    actor: new mongoose.Types.ObjectId(),
    action: 'COURSE_CREATED',
    target: { type: 'COURSE', id: new mongoose.Types.ObjectId() },
    summary: { courseTitle: 'Safe course title' },
    ...overrides
  };
}

function assertInvalidAuditRequest(response) {
  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Check the audit-log paging details and try again.');
  assert.deepEqual(response.body.error, {
    code: 'AUDIT_INVALID_REQUEST',
    message: 'Check the audit-log paging details and try again.'
  });
}

test('recordAudit persists valid immutable audit data and rejects unsafe summaries without persistence', async () => {
  const valid = auditInput();
  const entry = await recordAudit(valid);

  assert.equal(String(entry.actor), String(valid.actor));
  assert.equal(entry.action, 'COURSE_CREATED');
  assert.equal(entry.target.type, 'COURSE');
  assert.equal(String(entry.target.id), String(valid.target.id));
  assert.equal(entry.summary.get('courseTitle'), 'Safe course title');
  assert.ok(entry.createdAt instanceof Date);
  assert.equal(await AuditLog.countDocuments(), 1);

  for (const summary of [
    { password: 'do-not-store' },
    { score: 100 },
    { tags: ['one'] },
    { nested: { value: 'not-flat' } }
  ]) {
    await assert.rejects(
      recordAudit(auditInput({ summary })),
      /safe audit summary/i
    );
  }

  assert.equal(await AuditLog.countDocuments(), 1);
});

test('AuditLog records reject document, update, replacement, and deletion mutations after creation', async () => {
  const entry = await AuditLog.create({
    ...auditInput(),
    summary: { fromRole: 'STUDENT' }
  });

  entry.summary.set('fromRole', 'changed');
  await assert.rejects(entry.save(), /append-only/i);

  const operations = [
    () => AuditLog.updateOne({ _id: entry._id }, { $set: { 'summary.fromRole': 'changed' } }),
    () => AuditLog.updateMany({ _id: entry._id }, { $set: { 'summary.fromRole': 'changed' } }),
    () => AuditLog.findOneAndUpdate({ _id: entry._id }, { $set: { 'summary.fromRole': 'changed' } }),
    () => AuditLog.replaceOne({ _id: entry._id }, {
      ...entry.toObject(),
      summary: { fromRole: 'changed' }
    }),
    () => AuditLog.findOneAndReplace({ _id: entry._id }, {
      ...entry.toObject(),
      summary: { fromRole: 'changed' }
    }),
    () => AuditLog.deleteOne({ _id: entry._id }),
    () => AuditLog.deleteMany({ _id: entry._id }),
    () => AuditLog.findOneAndDelete({ _id: entry._id })
  ];

  for (const operation of operations) {
    await assert.rejects(operation(), /append-only/i);
  }

  const persisted = await AuditLog.findById(entry._id).lean();
  assert.equal(persisted.summary.fromRole, 'STUDENT');
  assert.equal(await AuditLog.countDocuments(), 1);
});

test('AuditLog rejects bulk update, replacement, and deletion operations after creation', async () => {
  const entry = await AuditLog.create({
    ...auditInput(),
    summary: { fromRole: 'STUDENT' }
  });

  const operations = [
    [{ updateOne: { filter: { _id: entry._id }, update: { $set: { 'summary.fromRole': 'changed' } } } }],
    [{ replaceOne: {
      filter: { _id: entry._id },
      replacement: { ...entry.toObject(), summary: { fromRole: 'changed' } }
    } }],
    [{ deleteOne: { filter: { _id: entry._id } } }]
  ];

  for (const operation of operations) {
    await assert.rejects(AuditLog.bulkWrite(operation), /append-only/i);
  }

  const persisted = await AuditLog.findById(entry._id).lean();
  assert.equal(persisted.summary.fromRole, 'STUDENT');
  assert.equal(await AuditLog.countDocuments(), 1);
});

test('recordAuditSafely returns null and writes one redacted warning when storage fails', async (t) => {
  const warnings = [];
  const injectedSecret = 'database-password-secret-must-not-leak';
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  t.mock.method(AuditLog, 'create', async () => {
    throw new Error(injectedSecret);
  });

  try {
    const result = await recordAuditSafely({
      ...auditInput({ summary: { harmless: 'value' } }),
      requestId: 'request-123'
    });
    assert.equal(result, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], new RegExp(injectedSecret));
  const warning = JSON.parse(warnings[0]);
  assert.deepEqual(warning, {
    event: 'audit_log_failure',
    requestId: 'request-123',
    action: 'COURSE_CREATED'
  });
  assert.deepEqual(Object.keys(warning).sort(), ['action', 'event', 'requestId']);
});

test('GET /api/v1/admin/audit-logs is authenticated and ADMIN-only', async () => {
  const student = await createUser();
  const admin = await createUser('ADMIN');

  const unauthenticated = await request(app).get('/api/v1/admin/audit-logs');
  assert.equal(unauthenticated.status, 401);

  const studentResponse = await (await login(student)).get('/api/v1/admin/audit-logs');
  assert.equal(studentResponse.status, 403);
  assert.equal(studentResponse.body.error.code, 'AUTH_ROLE_FORBIDDEN');

  const adminResponse = await (await login(admin)).get('/api/v1/admin/audit-logs');
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.body.success, true);
  assert.deepEqual(adminResponse.body.entries, []);
  assert.equal(adminResponse.body.nextCursor, null);
});

test('GET /api/v1/admin/audit-logs returns newest-first opaque cursor pages without PII', async () => {
  const admin = await createUser('ADMIN');
  const actor = await createUser();
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  const oldestId = new mongoose.Types.ObjectId('000000000000000000000011');
  const middleId = new mongoose.Types.ObjectId('000000000000000000000012');
  const newestId = new mongoose.Types.ObjectId('000000000000000000000013');

  await AuditLog.create([
    {
      _id: oldestId,
      actor: actor._id,
      action: 'COURSE_CREATED',
      target: { type: 'COURSE', id: new mongoose.Types.ObjectId() },
      summary: { label: 'oldest' },
      createdAt: timestamp
    },
    {
      _id: middleId,
      actor: actor._id,
      action: 'COURSE_UPDATED',
      target: { type: 'COURSE', id: new mongoose.Types.ObjectId() },
      summary: { label: 'middle' },
      createdAt: timestamp
    },
    {
      _id: newestId,
      actor: actor._id,
      action: 'COURSE_PUBLISHED',
      target: { type: 'COURSE', id: new mongoose.Types.ObjectId() },
      summary: { label: 'newest' },
      createdAt: timestamp
    }
  ]);

  const agent = await login(admin);
  const first = await agent.get('/api/v1/admin/audit-logs?limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.entries.length, 1);
  assert.equal(first.body.entries[0].id, String(newestId));
  assert.equal(first.body.entries[0].actor, String(actor._id));
  assert.deepEqual(Object.keys(first.body.entries[0]).sort(), [
    'action', 'actor', 'createdAt', 'id', 'summary', 'target'
  ]);
  assert.deepEqual(Object.keys(first.body.entries[0].target).sort(), ['id', 'type']);
  assert.match(first.body.nextCursor, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(JSON.stringify(first.body.entries[0]), new RegExp(actor.email));
  assert.doesNotMatch(JSON.stringify(first.body.entries[0]), /password|token|fullName|email/i);

  const second = await agent.get(`/api/v1/admin/audit-logs?limit=1&cursor=${first.body.nextCursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.entries.length, 1);
  assert.equal(second.body.entries[0].id, String(middleId));
  assert.match(second.body.nextCursor, /^[A-Za-z0-9_-]+$/);

  const third = await agent.get(`/api/v1/admin/audit-logs?limit=1&cursor=${second.body.nextCursor}`);
  assert.equal(third.status, 200);
  assert.equal(third.body.entries.length, 1);
  assert.equal(third.body.entries[0].id, String(oldestId));
  assert.equal(third.body.nextCursor, null);
});

test('GET /api/v1/admin/audit-logs rejects invalid paging details without leaking parser metadata', async () => {
  const admin = await createUser('ADMIN');
  const agent = await login(admin);

  for (const query of [
    'cursor=not-a-valid-cursor',
    `cursor=${Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'not-an-id' })).toString('base64url')}`,
    'limit=0',
    'limit=51',
    'limit=1.5',
    'limit=one'
  ]) {
    const response = await agent.get(`/api/v1/admin/audit-logs?${query}`);
    assertInvalidAuditRequest(response);
    assert.doesNotMatch(JSON.stringify(response.body), /CastError|BSON|not-a-valid-cursor|not-an-id|not-a-date/i);
  }
});

test('GET /api/v1/admin/audit-logs uses null nextCursor when the first page has no continuation', async () => {
  const admin = await createUser('ADMIN');
  await recordAudit(auditInput({ actor: admin._id }));

  const response = await (await login(admin)).get('/api/v1/admin/audit-logs?limit=25');
  assert.equal(response.status, 200);
  assert.equal(response.body.entries.length, 1);
  assert.equal(response.body.nextCursor, null);
});
