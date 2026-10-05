const test = require('node:test');
const assert = require('node:assert/strict');

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
    message: 'Internal server error'
  });
});

test('production preserves explicit AppError 4xx messages without a stack', () => {
  const result = invokeErrorMiddleware(new AppError('Authentication required', 401), 'production');

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, {
    success: false,
    message: 'Authentication required'
  });
});

test('development responses include an error stack', () => {
  const result = invokeErrorMiddleware(new Error('development failure'), 'development');

  assert.equal(result.statusCode, 500);
  assert.equal(result.body.message, 'development failure');
  assert.match(result.body.stack, /development failure/);
});
