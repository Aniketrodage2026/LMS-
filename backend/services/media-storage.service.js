const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const CLOUDINARY = 'CLOUDINARY';
const R2 = 'R2';
const categories = new Set(['avatars', 'thumbnails', 'lectures', 'assignments', 'materials']);

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function providerFor(media = {}) {
  if (media.storage === undefined || media.storage === null) return CLOUDINARY;
  const provider = media.storage.provider;
  if (provider !== CLOUDINARY && provider !== R2) throw new TypeError('Unsupported media storage provider');
  return provider;
}

function objectKeyFor({ category, extension = '', randomUUID = crypto.randomUUID } = {}) {
  if (!categories.has(category)) throw new TypeError('Unsupported media category');
  const normalizedExtension = extension === '' ? '' : `.${String(extension).replace(/^\.+/, '').toLowerCase()}`;
  if (normalizedExtension && !/^\.[a-z0-9]+$/.test(normalizedExtension)) {
    throw new TypeError('Invalid media extension');
  }
  return `${category}/${randomUUID()}${normalizedExtension}`;
}

function createCloudinaryLegacyStorage(cloudinary) {
  if (!cloudinary?.v2?.uploader) return null;
  return {
    async uploadLocalFile({ localPath, options = {} }) {
      const result = await cloudinary.v2.uploader.upload(localPath, options);
      return { public_id: result.public_id, secure_url: result.secure_url };
    },
    remove(media, options = {}) {
      return cloudinary.v2.uploader.destroy(media.public_id || media.storage?.key, options);
    },
    signedReadUrl(media) {
      if (media.secure_url) return media.secure_url;
      const resource_type = media.storage?.contentType?.startsWith('image/') ? 'image'
        : media.storage?.contentType?.startsWith('video/') ? 'video' : 'raw';
      return cloudinary.v2.url(media.storage.key, { secure: true, resource_type });
    }
  };
}

function createMediaStorage({ r2, legacy, cloudinary, readLocalFile = (localPath) => fs.createReadStream(localPath) } = {}) {
  const legacyStorage = legacy || createCloudinaryLegacyStorage(cloudinary);

  function requireAdapter(adapter, provider) {
    if (!adapter) throw new Error(`${provider} media storage is not configured`);
    return adapter;
  }

  return {
    providerFor,
    objectKeyFor,
    async uploadLocalFile({ provider, localPath, key, contentType, size, options } = {}) {
      if (provider === R2) {
        if (!hasText(key) || !hasText(contentType) || !Number.isInteger(size) || size < 0) {
          throw new TypeError('R2 media requires key, contentType, and a nonnegative integer size');
        }
        await requireAdapter(r2, R2).put({
          key,
          body: await readLocalFile(localPath),
          contentType,
          contentLength: size
        });
        return { storage: { provider: R2, key, contentType, size } };
      }
      if (provider === CLOUDINARY) return requireAdapter(legacyStorage, CLOUDINARY).uploadLocalFile({ localPath, options });
      throw new TypeError('A supported media storage provider is required');
    },
    remove(media, options) {
      return providerFor(media) === R2
        ? requireAdapter(r2, R2).remove(media.storage.key)
        : requireAdapter(legacyStorage, CLOUDINARY).remove(media, options);
    },
    signedReadUrl(media) {
      return providerFor(media) === R2
        ? requireAdapter(r2, R2).getSignedUrl(media.storage.key)
        : requireAdapter(legacyStorage, CLOUDINARY).signedReadUrl(media);
    },
    async readToFile(media, { localPath, maxBytes = 10485760 } = {}) {
      const source = media?.storage;
      if (source?.provider !== R2 || source.contentType !== 'application/pdf'
        || !/^materials\/[a-zA-Z0-9/_-]+\.pdf$/.test(source.key || '') || source.key.includes('//')
        || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > 10485760
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10485760 || source.size > maxBytes || !hasText(localPath)) {
        throw new TypeError('A bounded private PDF source is required');
      }
      let body; let output; let created = false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await requireAdapter(r2, R2).read(source.key, { abortSignal: controller.signal });
        body = response?.Body;
        if (!body || typeof body.pipe !== 'function' || response.ContentLength !== source.size) throw new Error('Invalid private PDF response');
        let total = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) {
          total += chunk.length;
          callback(total > maxBytes || total > source.size ? new Error('Private PDF limit exceeded') : null, chunk);
        } });
        output = fs.createWriteStream(localPath, { flags: 'wx', mode: 0o600 });
        output.once('open', () => { created = true; });
        await pipeline(body, limit, output, { signal: controller.signal });
        if (total !== source.size) throw new Error('Incomplete private PDF response');
      } catch {
        body?.destroy?.();
        if (output && !output.closed) { output.destroy(); await new Promise(resolve => output.once('close', resolve)); }
        if (created) await fs.promises.unlink(localPath).catch(() => {});
        throw new Error('The private PDF source could not be read');
      } finally { clearTimeout(timeout); }
    }
  };
}

module.exports = { CLOUDINARY, R2, createMediaStorage, objectKeyFor, providerFor };
