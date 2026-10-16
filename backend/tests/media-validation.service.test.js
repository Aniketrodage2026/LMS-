const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createMediaValidator, validateStoredUpload } = require('../services/media-validation.service');

async function withFile({ name, mimetype, bytes }, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lms-media-validation-'));
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, bytes);
  try {
    return await callback({ originalname: name, mimetype, path: filePath, size: bytes.length });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('rejects an image filename and MIME whose file signature is not an image', async () => {
  await withFile({
    name: 'avatar.jpg',
    mimetype: 'image/jpeg',
    bytes: Buffer.from('not an image')
  }, async (file) => {
    await assert.rejects(
      () => validateStoredUpload(file, 'image'),
      /not supported/i
    );
  });
});

test('accepts matching PNG extension, MIME, signature, and byte size', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32)
  ]);
  await withFile({ name: 'avatar.png', mimetype: 'image/png', bytes: png }, async (file) => {
    const media = await validateStoredUpload(file, 'image');
    assert.deepEqual(media, { extension: 'png', contentType: 'image/png', size: png.length });
  });
});

test('rejects a valid PNG when Multer metadata claims a different MIME type', async () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32)
  ]);
  await withFile({ name: 'avatar.png', mimetype: 'image/jpeg', bytes: png }, async (file) => {
    await assert.rejects(() => validateStoredUpload(file, 'image'), /not supported/i);
  });
});

test('reads only a bounded header instead of buffering the full upload', async (t) => {
  const fsPromises = require('node:fs/promises');
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(128 * 1024)
  ]);
  t.mock.method(fsPromises, 'readFile', async () => {
    throw new Error('validateStoredUpload must not buffer the entire file');
  });
  await withFile({ name: 'large-avatar.png', mimetype: 'image/png', bytes: png }, async (file) => {
    const media = await validateStoredUpload(file, 'image');
    assert.equal(media.size, png.length);
  });
});

test('retries one transient Windows file-open failure before validating the header', async () => {
  let opens = 0;
  const validator = createMediaValidator({
    fsPromises: {
      stat: async () => ({ size: 8 }),
      open: async () => {
        opens += 1;
        if (opens === 1) {
          const error = new Error('file still locked');
          error.code = 'EPERM';
          throw error;
        }
        return {
          read: async (buffer) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer),
          close: async () => {}
        };
      }
    },
    sleep: async () => {}
  });

  const media = await validator.validateStoredUpload({
    originalname: 'avatar.png', mimetype: 'image/png', path: 'temporary.png', size: 8
  }, 'image');
  assert.equal(opens, 2);
  assert.equal(media.contentType, 'image/png');
});

test('does not retry a persistent transient file-open failure indefinitely', async () => {
  let opens = 0;
  const validator = createMediaValidator({
    fsPromises: {
      stat: async () => ({ size: 8 }),
      open: async () => {
        opens += 1;
        const error = new Error('file still locked');
        error.code = 'EACCES';
        throw error;
      }
    },
    sleep: async () => {}
  });

  await assert.rejects(() => validator.validateStoredUpload({
    originalname: 'avatar.png', mimetype: 'image/png', path: 'temporary.png', size: 8
  }, 'image'), /file still locked/);
  assert.ok(opens > 1);
  assert.ok(opens <= 6);
});
