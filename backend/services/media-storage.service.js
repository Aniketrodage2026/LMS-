const fs = require('node:fs');
const crypto = require('node:crypto');

const CLOUDINARY = 'CLOUDINARY';
const R2 = 'R2';
const categories = new Set(['avatars', 'thumbnails', 'lectures', 'assignments']);

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
    }
  };
}

module.exports = { CLOUDINARY, R2, createMediaStorage, objectKeyFor, providerFor };
