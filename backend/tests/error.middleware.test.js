const test = require('node:test');
const assert = require('node:assert/strict');
const multer = require('multer');

const AppError = require('../utils/appError');
const errorMiddleware = require('../middleware/error.middleware');

function invokeErrorMiddleware(error, nodeEnv) {
  const previousNodeEnv = process.env.NODE_ENV;
  let statusCode;
  let body;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    }
  };

  try {
    process.env.NODE_ENV = nodeEnv;
    errorMiddleware(error, {}, response, () => {});
    return { statusCode, body };
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

test('production redacts unexpected 500 error details', () => {
  const result = invokeErrorMiddleware(new Error('database password leaked'), 'production');

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Internal server error',
    error: { code: 'SYSTEM_UNEXPECTED', message: 'Internal server error' }
  });
});

test('production preserves legacy AppError 4xx messages without a stack', () => {
  const result = invokeErrorMiddleware(new AppError('Authentication required', 401), 'production');

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Authentication required',
    error: { code: 'SYSTEM_UNEXPECTED', message: 'Authentication required' }
  });
});

test('production redacts legacy AppError server details without a stack', () => {
  const result = invokeErrorMiddleware(
    new AppError('SMTP authentication failed: internal-provider-detail', 500),
    'production'
  );

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Internal server error',
    error: { code: 'SYSTEM_UNEXPECTED', message: 'Internal server error' }
  });
});

test('production redacts default-status AppError server details without a stack', () => {
  const result = invokeErrorMiddleware(new AppError('db detail'), 'production');

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Internal server error',
    error: { code: 'SYSTEM_UNEXPECTED', message: 'Internal server error' }
  });
});

test('AppError defaults its status and public code while accepting optional safe metadata', () => {
  const defaultError = new AppError('Unexpected failure');
  assert.equal(defaultError.statusCode, 500);
  assert.equal(defaultError.code, 'SYSTEM_UNEXPECTED');
  assert.equal(Object.hasOwn(defaultError, 'meta'), false);

  const meta = { field: 'email' };
  const explicitError = new AppError('Please sign in to continue.', 401, 'AUTH_REQUIRED', meta);
  assert.equal(explicitError.code, 'AUTH_REQUIRED');
  assert.deepEqual(explicitError.meta, meta);
});

test('production preserves the supplied status, code, and message of explicit AppErrors', () => {
  const result = invokeErrorMiddleware(
    new AppError('Please sign in to continue.', 401, 'AUTH_REQUIRED', { field: 'email' }),
    'production'
  );

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Please sign in to continue.',
    error: { code: 'AUTH_REQUIRED', message: 'Please sign in to continue.' }
  });
});

test('production preserves explicit AppError server failures as safe domain errors', () => {
  const result = invokeErrorMiddleware(
    new AppError('Payment verification is temporarily unavailable.', 503, 'PAYMENT_VERIFICATION_UNAVAILABLE'),
    'production'
  );

  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Payment verification is temporarily unavailable.',
    error: {
      code: 'PAYMENT_VERIFICATION_UNAVAILABLE',
      message: 'Payment verification is temporarily unavailable.'
    }
  });
});

test('production does not trust status or code properties on unexpected errors', () => {
  const error = Object.assign(new Error('database password leaked'), {
    statusCode: 400,
    code: 'DATABASE_INTERNAL',
    meta: { password: 'secret' }
  });
  const result = invokeErrorMiddleware(error, 'production');

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Internal server error',
    error: { code: 'SYSTEM_UNEXPECTED', message: 'Internal server error' }
  });
});

for (const multerCode of [
  'MISSING_FIELD_NAME',
  'LIMIT_FILE_SIZE',
  'LIMIT_UNEXPECTED_FILE',
  'LIMIT_FILE_COUNT',
  'LIMIT_PART_COUNT',
  'LIMIT_FIELD_COUNT',
  'LIMIT_FIELD_KEY',
  'LIMIT_FIELD_VALUE'
]) {
  test(`normalizes Multer ${multerCode} to a safe client upload error`, () => {
    const error = new multer.MulterError(multerCode, 'private-field');
    error.message = 'Technical upload failure with private details';
    const result = invokeErrorMiddleware(error, 'production');

    assert.equal(result.statusCode, 400);
    const message = multerCode === 'LIMIT_FILE_SIZE' ? 'This file is too large. Choose a smaller file and try again.' : 'Invalid upload request';
    assert.deepEqual(result.body, {
      success: false,
      message,
      error: { code: multerCode === 'LIMIT_FILE_SIZE' ? 'UPLOAD_FILE_TOO_LARGE' : 'UPLOAD_FILE_INVALID', message }
    });
  });
}

test('development responses include an error stack', () => {
  const result = invokeErrorMiddleware(new Error('development failure'), 'development');

  assert.equal(result.statusCode, 500);
  assert.equal(result.body.message, 'development failure');
  assert.deepEqual(result.body.error, { code: 'SYSTEM_UNEXPECTED', message: 'development failure' });
  assert.match(result.body.stack, /development failure/);
});
