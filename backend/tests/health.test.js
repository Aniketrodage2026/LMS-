const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const request = require('supertest');

const { createTestApp } = require('./helpers/app');

test('GET /health returns the service health contract', async () => {
  const response = await request(createTestApp()).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, status: 'ok' });
});

test('GET /health works without Razorpay credentials', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const request = require('supertest');
const { createTestApp } = require('./tests/helpers/app');
request(createTestApp()).get('/health').then((response) => {
  if (response.status !== 200 || JSON.stringify(response.body) !== JSON.stringify({ success: true, status: 'ok' })) {
    process.exitCode = 1;
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        RAZORPAY_KEY_ID: '',
        RAZORPAY_KEY_SECRET: '',
        RAZORPAY_SECREAT: ''
      }
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
