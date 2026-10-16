const { S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { loadEnv } = require('../config/env');
const { createR2Storage } = require('./r2-storage.service');
const { createMediaStorage } = require('./media-storage.service');

function createRuntimeMediaStorageFactory({
  cloudinary,
  env = process.env,
  loadEnv: loadConfiguration = loadEnv,
  S3Client: S3ClientConstructor = S3Client,
  getSignedUrl: signGetUrl = getSignedUrl,
  createR2Storage: createR2 = createR2Storage,
  createMediaStorage: createMedia = createMediaStorage
} = {}) {
  let cached;
  let cacheKey;

  function get() {
    if (env.R2_ENABLED !== 'true') {
      if (!cached || cacheKey !== 'CLOUDINARY') {
        cached = createMedia({ cloudinary });
        cacheKey = 'CLOUDINARY';
      }
      return cached;
    }

    const config = loadConfiguration(env).r2;
    const key = [config.endpoint, config.bucketName, config.accessKeyId, config.secretAccessKey, config.signedUrlTtlSeconds].join('|');
    if (!cached || cacheKey !== key) {
      const client = new S3ClientConstructor({
        region: 'auto',
        endpoint: config.endpoint,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
      });
      cached = createMedia({ cloudinary, r2: createR2({ client, getSignedUrl: signGetUrl, config }) });
      cacheKey = key;
    }
    return cached;
  }

  return { get };
}

module.exports = { createRuntimeMediaStorageFactory };
