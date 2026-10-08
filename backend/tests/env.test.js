const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { loadEnv } = require('../config/env');
const User = require('../models/user.schema');

function baseEnvironment(overrides = {}) {
  return {
    DB_URL: 'mongodb://127.0.0.1:27017/lms-test',
    JWT_EXPIRY: '1h',
    FRONTEND_URL: 'http://localhost:5173',
    ...overrides
  };
}

function captureWarnings(callback) {
  const originalEmitWarning = process.emitWarning;
  const warnings = [];

  process.emitWarning = (warning) => warnings.push(warning);

  try {
    return { result: callback(), warnings };
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

test('loadEnv rejects legacy JWT_Secret unless compatibility is explicitly enabled', () => {
  const environment = baseEnvironment({ JWT_Secret: 'legacy-jwt-secret' });

  assert.throws(
    () => loadEnv(environment),
    /JWT_SECRET.*rename JWT_Secret/i
  );
});

test('loadEnv normalizes legacy JWT_Secret only with explicit compatibility opt-in', () => {
  const environment = baseEnvironment({
    JWT_Secret: 'legacy-jwt-secret',
    ALLOW_LEGACY_JWT_SECRET: 'true'
  });

  const { result: config, warnings } = captureWarnings(() => loadEnv(environment));

  assert.equal(environment.JWT_SECRET, 'legacy-jwt-secret');
  assert.equal(config.jwtSecret, 'legacy-jwt-secret');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Rename JWT_Secret to JWT_SECRET/);
});

test('loadEnv reports JWT_SECRET when neither spelling is configured', () => {
  assert.throws(
    () => loadEnv(baseEnvironment()),
    /Missing environment variables: JWT_SECRET/
  );
});

test('loadEnv accepts canonical JWT_SECRET without a compatibility warning', () => {
  const { result: config, warnings } = captureWarnings(() => loadEnv(baseEnvironment({
    JWT_SECRET: 'canonical-jwt-secret'
  })));

  assert.equal(config.jwtSecret, 'canonical-jwt-secret');
  assert.equal(warnings.length, 0);
});

test('generateJWTtoken signs only id and role with the canonical JWT_SECRET', () => {
  const previousEnvironment = process.env;

  try {
    process.env = { ...previousEnvironment };
    process.env.JWT_SECRET = 'canonical-jwt-secret';
    process.env.JWT_EXPIRY = '1h';
    delete process.env.JWT_Secret;

    const user = new User({
      fullName: 'Test User',
      email: 'test@example.com',
      password: 'password123'
    });

    const token = user.generateJWTtoken();
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    assert.equal(payload.id, user.id);
    assert.equal(payload.role, 'STUDENT');
    assert.equal(payload.email, undefined);
    assert.equal(payload.subscription, undefined);
  } finally {
    process.env = previousEnvironment;
  }
});
