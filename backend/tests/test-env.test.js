const test = require('node:test');
const assert = require('node:assert/strict');

test('test bootstrap disables runtime R2 access by default', () => {
  assert.equal(process.env.R2_ENABLED, 'false');
});
