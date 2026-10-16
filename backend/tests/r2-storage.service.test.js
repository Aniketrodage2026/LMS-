const test = require('node:test');
const assert = require('node:assert/strict');

const { createR2Storage } = require('../services/r2-storage.service');

function validR2Config() {
  return {
    bucketName: 'lms-media-private',
    signedUrlTtlSeconds: 600
  };
}

test('R2 storage uploads an object with its configured bucket and metadata', async () => {
  const calls = [];
  const storage = createR2Storage({
    client: { send: async (command) => calls.push(command) },
    getSignedUrl: async () => 'https://r2.example/signed',
    config: validR2Config()
  });

  await storage.put({
    key: 'courses/a/lectures/x.mp4',
    body: Buffer.from('x'),
    contentType: 'video/mp4',
    contentLength: 1
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, {
    Bucket: 'lms-media-private',
    Key: 'courses/a/lectures/x.mp4',
    Body: Buffer.from('x'),
    ContentType: 'video/mp4',
    ContentLength: 1
  });
});

test('R2 storage deletes and heads objects in its configured bucket', async () => {
  const calls = [];
  const storage = createR2Storage({
    client: { send: async (command) => calls.push(command) },
    getSignedUrl: async () => 'https://r2.example/signed',
    config: validR2Config()
  });

  await storage.remove('courses/a/lectures/x.mp4');
  await storage.head('courses/a/lectures/x.mp4');

  assert.deepEqual(calls.map((command) => command.input), [
    { Bucket: 'lms-media-private', Key: 'courses/a/lectures/x.mp4' },
    { Bucket: 'lms-media-private', Key: 'courses/a/lectures/x.mp4' }
  ]);
});

test('R2 storage signs a GET URL using the configured short-lived TTL', async () => {
  const calls = [];
  const storage = createR2Storage({
    client: {},
    getSignedUrl: async (client, command, options) => {
      calls.push({ client, command, options });
      return 'https://r2.example/signed';
    },
    config: validR2Config()
  });

  assert.equal(await storage.getSignedUrl('courses/a/lectures/x.mp4'), 'https://r2.example/signed');
  assert.deepEqual(calls[0].command.input, {
    Bucket: 'lms-media-private',
    Key: 'courses/a/lectures/x.mp4'
  });
  assert.deepEqual(calls[0].options, { expiresIn: 600 });
});
