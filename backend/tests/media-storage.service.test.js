const test = require('node:test');
const assert = require('node:assert/strict');

const { createMediaStorage, objectKeyFor, providerFor } = require('../services/media-storage.service');
const User = require('../models/user.schema');

test('legacy Cloudinary media remains readable when storage is absent', () => {
  assert.equal(providerFor({ public_id: 'legacy', secure_url: 'https://res.cloudinary.com/demo' }), 'CLOUDINARY');
  assert.equal(createMediaStorage().providerFor({ public_id: 'legacy' }), 'CLOUDINARY');
});

test('R2 media storage dispatches local uploads, removals, and signed reads', async () => {
  const calls = [];
  const storage = createMediaStorage({
    readLocalFile: async () => Buffer.from('file bytes'),
    r2: {
      put: async (values) => calls.push(['put', values]),
      remove: async (key) => calls.push(['remove', key]),
      getSignedUrl: async (key) => `https://r2.example/${key}`
    }
  });
  const media = await storage.uploadLocalFile({
    provider: 'R2',
    localPath: 'C:/tmp/avatar.png',
    key: 'avatars/random.png',
    contentType: 'image/png',
    size: 12
  });

  assert.deepEqual(media, {
    storage: { provider: 'R2', key: 'avatars/random.png', contentType: 'image/png', size: 12 }
  });
  assert.deepEqual(calls[0], ['put', {
    key: 'avatars/random.png', body: Buffer.from('file bytes'), contentType: 'image/png', contentLength: 12
  }]);
  await storage.remove(media);
  assert.equal(await storage.signedReadUrl(media), 'https://r2.example/avatars/random.png');
  assert.deepEqual(calls.slice(1), [['remove', 'avatars/random.png']]);
});

test('legacy Cloudinary media dispatches through the injected legacy adapter', async () => {
  const storage = createMediaStorage({
    legacy: {
      uploadLocalFile: async () => ({ public_id: 'legacy-id', secure_url: 'https://cloudinary.example/legacy-id' }),
      remove: async (media) => assert.equal(media.public_id, 'legacy-id'),
      signedReadUrl: async (media) => media.secure_url
    }
  });
  const media = await storage.uploadLocalFile({ provider: 'CLOUDINARY', localPath: 'C:/tmp/file' });
  assert.equal(await storage.signedReadUrl(media), 'https://cloudinary.example/legacy-id');
  await storage.remove(media);
});

test('Cloudinary storage metadata dispatches with its storage key', async () => {
  const seen = [];
  const storage = createMediaStorage({
    legacy: {
      remove: async (media) => seen.push(['remove', media.storage.key]),
      signedReadUrl: async (media) => `https://cloudinary.example/${media.storage.key}`
    }
  });
  const media = { storage: { provider: 'CLOUDINARY', key: 'legacy/key', contentType: 'image/png', size: 1 } };
  assert.equal(await storage.signedReadUrl(media), 'https://cloudinary.example/legacy/key');
  await storage.remove(media);
  assert.deepEqual(seen, [['remove', 'legacy/key']]);
});

test('media with malformed storage metadata does not fall back to Cloudinary', () => {
  assert.throws(() => providerFor({ storage: {} }), /Unsupported media storage provider/);
});

test('random object keys contain no caller identifiers', () => {
  const key = objectKeyFor({ category: 'assignments', extension: '.pdf', randomUUID: () => 'fixed-random-id' });
  assert.equal(key, 'assignments/fixed-random-id.pdf');
  assert.equal(key.includes('student@example.com'), false);
});

test('user avatars accept R2 storage metadata and reject incomplete records', async () => {
  const user = new User({
    fullName: 'Avatar Student',
    email: 'avatar@example.com',
    password: 'password123',
    avatar: { storage: { provider: 'R2', key: 'avatars/random.png', contentType: 'image/png', size: 3 } }
  });
  await assert.doesNotReject(() => user.validate());
  user.avatar.storage.key = '';
  await assert.rejects(() => user.validate(), /key/);
});

test('user avatars reject invalid R2 storage sizes without coercion', async () => {
  for (const size of [0.5, -1, '1']) {
    const user = new User({
      fullName: 'Avatar Student',
      email: `invalid-avatar-${String(size).replace('.', '-') }@example.com`,
      password: 'password123',
      avatar: { storage: { provider: 'R2', key: 'avatars/random.png', contentType: 'image/png', size } }
    });
    await assert.rejects(() => user.validate());
  }
});

