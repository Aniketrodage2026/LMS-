const test = require('node:test');
const assert = require('node:assert/strict');

test('Razorpay client uses RAZORPAY_KEY_SECRET', () => {
  const previousEnvironment = {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    legacySecret: process.env.RAZORPAY_SECREAT
  };

  try {
    process.env.RAZORPAY_KEY_ID = 'test-key-id';
    process.env.RAZORPAY_KEY_SECRET = 'canonical-test-secret';
    process.env.RAZORPAY_SECREAT = 'legacy-test-secret';

    delete require.cache[require.resolve('../utils/razorpay')];
    const createRazorpayClient = require('../utils/razorpay');
    const client = createRazorpayClient();

    assert.equal(client.key_secret, 'canonical-test-secret');
  } finally {
    if (previousEnvironment.keyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = previousEnvironment.keyId;

    if (previousEnvironment.keySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = previousEnvironment.keySecret;

    if (previousEnvironment.legacySecret === undefined) delete process.env.RAZORPAY_SECREAT;
    else process.env.RAZORPAY_SECREAT = previousEnvironment.legacySecret;

    delete require.cache[require.resolve('../utils/razorpay')];
  }
});
