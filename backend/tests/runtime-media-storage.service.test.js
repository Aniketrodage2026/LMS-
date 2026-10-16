const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeMediaStorageFactory } = require('../services/runtime-media-storage.service');

test('reuses the configured R2 media storage while configuration is unchanged', () => {
  let clients = 0;
  let storageFactories = 0;
  const env = {
    R2_ENABLED: 'true',
    DB_URL: 'mongodb://example', JWT_SECRET: 'secret', JWT_EXPIRY: '1h', FRONTEND_URL: 'http://frontend'
  };
  const factory = createRuntimeMediaStorageFactory({
    env,
    cloudinary: { v2: {} },
    loadEnv: () => ({ r2: { endpoint: 'https://r2.example', accessKeyId: 'key', secretAccessKey: 'secret', bucketName: 'bucket', signedUrlTtlSeconds: 600 } }),
    S3Client: class FakeClient { constructor() { clients += 1; } },
    getSignedUrl: async () => 'signed',
    createR2Storage: () => ({ put() {}, remove() {}, getSignedUrl() {} }),
    createMediaStorage: () => ({ id: ++storageFactories })
  });

  assert.strictEqual(factory.get(), factory.get());
  assert.equal(clients, 1);
  assert.equal(storageFactories, 1);
});
