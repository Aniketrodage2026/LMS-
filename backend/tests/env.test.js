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

test('loadEnv reads a bounded optional Cloudinary token duration', () => {
  const config = loadEnv(baseEnvironment({
    JWT_SECRET: 'canonical-jwt-secret',
    CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS: '900'
  }));

  assert.equal(config.cloudinaryAuthTokenDurationSeconds, 900);
});

test('loadEnv defaults the optional Cloudinary token duration to 600', () => {
  const config = loadEnv(baseEnvironment({ JWT_SECRET: 'canonical-jwt-secret' }));

  assert.equal(config.cloudinaryAuthTokenDurationSeconds, 600);
});

test('loadEnv rejects invalid Cloudinary token durations', () => {
  for (const duration of ['nope', '59', '3601']) {
    assert.throws(
      () => loadEnv(baseEnvironment({
        JWT_SECRET: 'canonical-jwt-secret',
        CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS: duration
      })),
      new Error('CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS must be an integer between 60 and 3600')
    );
  }
});

test('loadEnv returns validated private R2 configuration when R2 is enabled', () => {
  const config = loadEnv(baseEnvironment({
    JWT_SECRET: 'canonical-jwt-secret',
    R2_ENABLED: 'true',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_BUCKET_NAME: 'lms-media-private',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_SIGNED_URL_TTL_SECONDS: '600'
  }));

  assert.deepEqual(config.r2, {
    enabled: true,
    accountId: '0123456789abcdef0123456789abcdef',
    bucketName: 'lms-media-private',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    signedUrlTtlSeconds: 600
  });
});

test('loadEnv keeps R2 disabled by default without requiring R2 credentials', () => {
  const config = loadEnv(baseEnvironment({ JWT_SECRET: 'canonical-jwt-secret' }));

  assert.deepEqual(config.r2, { enabled: false });
});

test('loadEnv requires complete R2 credentials only when R2 is enabled', () => {
  assert.throws(
    () => loadEnv(baseEnvironment({
      JWT_SECRET: 'canonical-jwt-secret',
      R2_ENABLED: 'true',
      R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef'
    })),
    new Error('Missing R2 environment variables: R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY')
  );
});

test('loadEnv rejects invalid R2 signed URL TTL values', () => {
  for (const ttl of ['not-a-number', '59', '3601', '600.5']) {
    assert.throws(
      () => loadEnv(baseEnvironment({
        JWT_SECRET: 'canonical-jwt-secret',
        R2_ENABLED: 'true',
        R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        R2_BUCKET_NAME: 'lms-media-private',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        R2_SIGNED_URL_TTL_SECONDS: ttl
      })),
      new Error('R2_SIGNED_URL_TTL_SECONDS must be an integer between 60 and 3600')
    );
  }
});

test('loadEnv rejects an R2 account ID that could alter the derived endpoint host', () => {
  assert.throws(
    () => loadEnv(baseEnvironment({
      JWT_SECRET: 'canonical-jwt-secret',
      R2_ENABLED: 'true',
      R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef/attacker.example',
      R2_BUCKET_NAME: 'lms-media-private',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret'
    })),
    new Error('R2_ACCOUNT_ID must be a 32-character hexadecimal Cloudflare account ID')
  );
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
