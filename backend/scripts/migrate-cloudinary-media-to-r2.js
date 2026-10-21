const path = require('node:path');

const { objectKeyFor } = require('../services/media-storage.service');
const { allowedMimes, categories, detectContentType } = require('../services/media-validation.service');

const R2 = 'R2';
const logLine = (logger, type, id, outcome) => logger[outcome === 'failed' ? 'error' : 'info'](
  `cloudinary-r2-migration type=${type} id=${String(id)} outcome=${outcome}`
);

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function plain(value) {
  return value?.toObject ? value.toObject() : value;
}

function isR2(media) {
  return media?.storage?.provider === R2;
}

function isAuthenticatedPaidNonPreviewLecture(course, lecture) {
  return course?.accessType === 'PAID'
    && lecture?.isPreview === false
    && lecture?.lecture?.deliveryType === 'AUTHENTICATED';
}

function verifiedCloudinaryUrl(sourceUrl, cloudName) {
  if (!hasText(sourceUrl) || !hasText(cloudName)) return false;
  try {
    const url = new URL(sourceUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'res.cloudinary.com'
      && !url.username
      && !url.password
      && !url.port
      && pathParts[0] === cloudName;
  } catch {
    return false;
  }
}

function usableLegacyMedia(media, cloudName) {
  return Boolean(
    media
    && !isR2(media)
    && hasText(media.public_id)
    && verifiedCloudinaryUrl(media.secure_url, cloudName)
  );
}

function extensionFor(media) {
  try {
    return path.extname(new URL(media.secure_url).pathname).slice(1).toLowerCase();
  } catch {
    return '';
  }
}

function contentTypeFor(media, response) {
  const declared = hasText(media?.mimetype) ? media.mimetype.trim() : response.headers?.get?.('content-type');
  return hasText(declared) ? declared.split(';', 1)[0].trim().toLowerCase() : 'application/octet-stream';
}

function validationCategory(candidate) {
  if (candidate.category === 'assignments') return 'submission';
  if (candidate.category === 'lectures') return 'video';
  return 'image';
}

function validDeclaredSize(response, maxBytes) {
  const contentLength = response?.headers?.get?.('content-length');
  if (contentLength === null || contentLength === undefined || contentLength === '') return;
  if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
    throw new Error('Legacy source exceeds the allowed size');
  }
}

async function readBoundedBody(response, { maxBytes }) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new Error('Legacy source response stream is unavailable');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    if (bytes.length > maxBytes - size) throw new Error('Legacy source exceeds the allowed size');
    chunks.push(bytes);
    size += bytes.length;
  }
  return Buffer.concat(chunks, size);
}

function validateLegacyBytes(candidate, response, bytes) {
  const category = validationCategory(candidate);
  const extension = `.${extensionFor(candidate.media)}`;
  const declaredContentType = contentTypeFor(candidate.media, response);
  const detectedContentType = detectContentType(bytes);
  if (!extensionFor(candidate.media)
    || !allowedMimes(category, extension).has(declaredContentType)
    || !detectedContentType
    || !allowedMimes(category, extension).has(detectedContentType)
    || detectedContentType !== declaredContentType) {
    throw new Error('Legacy source type is invalid');
  }
  return { contentType: detectedContentType, extension: extension.slice(1) };
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal });
    return { response, stopTimeout: () => clearTimeout(timeout) };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function conditionForLegacy(prefix, media) {
  return {
    [`${prefix}.public_id`]: media.public_id,
    [`${prefix}.secure_url`]: media.secure_url,
    [`${prefix}.storage.provider`]: { $ne: R2 }
  };
}

function mediaStorage({ key, contentType, size }) {
  return { provider: R2, key, contentType, size };
}

async function* readRecords(model, projection) {
  const query = model.find({}, projection);
  const leanQuery = query?.lean ? query.lean() : null;
  if (leanQuery?.cursor) {
    for await (const record of leanQuery.cursor()) yield record;
    return;
  }
  for (const record of await query) yield record;
}

async function* candidateStream(models) {
    for await (const userValue of readRecords(models.User, { _id: 1, avatar: 1 })) {
      const user = plain(userValue);
      if (user.avatar) yield {
        type: 'USER_AVATAR', id: user._id, category: 'avatars', media: plain(user.avatar),
        update: (storage) => models.User.updateOne(
          { _id: user._id, ...conditionForLegacy('avatar', user.avatar) },
          { $set: { 'avatar.storage': storage } }
        )
      };
    }
    for await (const courseValue of readRecords(models.Course, { _id: 1, accessType: 1, thumbnail: 1, lectures: 1 })) {
      const course = plain(courseValue);
      if (course.thumbnail) yield {
        type: 'COURSE_THUMBNAIL', id: course._id, category: 'thumbnails', media: plain(course.thumbnail),
        update: (storage) => models.Course.updateOne(
          { _id: course._id, ...conditionForLegacy('thumbnail', course.thumbnail) },
          { $set: { 'thumbnail.storage': storage } }
        )
      };
      for (const lectureValue of course.lectures || []) {
        const lecture = plain(lectureValue);
        if (!lecture?.lecture) continue;
        yield {
          type: 'COURSE_LECTURE', id: `${course._id}:${lecture._id}`, category: 'lectures', media: plain(lecture.lecture),
          skip: isAuthenticatedPaidNonPreviewLecture(course, lecture),
          update: (storage) => models.Course.updateOne({
            _id: course._id,
            lectures: { $elemMatch: {
              _id: lecture._id,
              ...conditionForLegacy('lecture', lecture.lecture)
            } }
          }, { $set: { 'lectures.$.lecture.storage': storage } })
        };
      }
    }
    for await (const submissionValue of readRecords(models.Submission, { _id: 1, file: 1 })) {
      const submission = plain(submissionValue);
      if (submission.file) yield {
        type: 'SUBMISSION_FILE', id: submission._id, category: 'assignments', media: plain(submission.file),
        update: (storage) => models.Submission.updateOne(
          { _id: submission._id, ...conditionForLegacy('file', submission.file) },
          { $set: { 'file.storage': storage } }
        )
      };
    }
}

async function buildCandidates(models) {
  const candidates = [];
  for await (const candidate of candidateStream(models)) candidates.push(candidate);
  return candidates;
}

async function removeCopiedObject(r2, key) {
  await r2.remove(key);
}

async function migrateCloudinaryMediaToR2({
  models,
  r2,
  fetch: fetchImpl,
  cloudName,
  dryRun = false,
  logger = console,
  randomUUID,
  timeoutMs = 30_000
} = {}) {
  if (!models?.User || !models?.Course || !models?.Submission) throw new TypeError('Migration models are required');
  if (!hasText(cloudName)) throw new TypeError('Cloudinary cloud name is required');
  if (!dryRun && (!r2 || typeof r2.put !== 'function' || typeof r2.head !== 'function' || typeof r2.remove !== 'function')) {
    throw new TypeError('R2 storage is required for migration');
  }
  if (!dryRun && typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for migration');

  const report = { candidates: 0, migrated: 0, skipped: 0, failed: 0 };
  for await (const candidate of candidateStream(models)) {
    if (candidate.skip || isR2(candidate.media) || !usableLegacyMedia(candidate.media, cloudName)) {
      report.skipped += 1;
      logLine(logger, candidate.type, candidate.id, 'skipped');
      continue;
    }

    report.candidates += 1;
    if (dryRun) {
      logLine(logger, candidate.type, candidate.id, 'dry-run');
      continue;
    }

    let key;
    let copyStarted = false;
    try {
      const request = await fetchWithTimeout(fetchImpl, candidate.media.secure_url, { timeoutMs });
      const { response } = request;
      let bytes;
      let validated;
      try {
        if (!response?.ok) throw new Error('Cloudinary source could not be read');
        const rule = categories[validationCategory(candidate)];
        validDeclaredSize(response, rule.maxBytes);
        bytes = await readBoundedBody(response, { maxBytes: rule.maxBytes });
        validated = validateLegacyBytes(candidate, response, bytes);
      } finally {
        request.stopTimeout();
      }
      key = objectKeyFor({ category: candidate.category, extension: validated.extension, randomUUID });
      copyStarted = true;
      await r2.put({ key, body: bytes, contentType: validated.contentType, contentLength: bytes.length });
      const verification = await r2.head(key);
      if (!verification || Number(verification.ContentLength) !== bytes.length) throw new Error('R2 copy verification failed');

      const update = await candidate.update(mediaStorage({ key, contentType: validated.contentType, size: bytes.length }));
      if (!update || update.matchedCount !== 1 || update.modifiedCount !== 1) {
        try {
          await removeCopiedObject(r2, key);
          report.skipped += 1;
          logLine(logger, candidate.type, candidate.id, 'skipped');
        } catch {
          report.failed += 1;
          logLine(logger, candidate.type, candidate.id, 'cleanup-failed');
        }
        continue;
      }
      report.migrated += 1;
      logLine(logger, candidate.type, candidate.id, 'migrated');
    } catch {
      if (copyStarted && key) {
        try {
          await removeCopiedObject(r2, key);
        } catch {
          report.failed += 1;
          logLine(logger, candidate.type, candidate.id, 'cleanup-failed');
          continue;
        }
      }
      report.failed += 1;
      logLine(logger, candidate.type, candidate.id, 'failed');
    }
  }
  return report;
}

function loadMigrationConfig(env = process.env, { dryRun = false } = {}) {
  const required = ['DB_URL', 'CLOUDINARY_CLOUD_NAME'];
  const missing = required.filter((name) => !hasText(env[name]));
  if (missing.length > 0) throw new Error(`Missing migration environment variables: ${missing.join(', ')}`);

  if (dryRun) return { dbUrl: env.DB_URL, cloudName: env.CLOUDINARY_CLOUD_NAME, r2: null };
  if (env.R2_ENABLED !== 'true') throw new Error('R2_ENABLED=true is required for migration');
  const r2Required = ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const missingR2 = r2Required.filter((name) => !hasText(env[name]));
  if (missingR2.length > 0) throw new Error(`Missing R2 migration environment variables: ${missingR2.join(', ')}`);
  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) throw new Error('R2_ACCOUNT_ID must be a 32-character hexadecimal Cloudflare account ID');
  const ttl = env.R2_SIGNED_URL_TTL_SECONDS === undefined || env.R2_SIGNED_URL_TTL_SECONDS === ''
    ? 600 : Number(env.R2_SIGNED_URL_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new Error('R2_SIGNED_URL_TTL_SECONDS must be an integer between 60 and 3600');
  }
  return {
    dbUrl: env.DB_URL,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    r2: {
      enabled: true,
      accountId: env.R2_ACCOUNT_ID,
      bucketName: env.R2_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      signedUrlTtlSeconds: ttl
    }
  };
}

async function runCli(dependencies = {}) {
  const args = dependencies.args || process.argv.slice(2);
  const logger = dependencies.logger || console;
  const env = dependencies.env || process.env;
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
    logger.error('Usage: node scripts/migrate-cloudinary-media-to-r2.js [--dry-run]');
    return 2;
  }

  const dryRun = args[0] === '--dry-run';
  let mongoose = dependencies.mongoose;
  let connected = false;
  let exitCode = 0;
  try {
    (dependencies.dotenv || require('dotenv')).config();
    const config = (dependencies.loadMigrationConfig || loadMigrationConfig)(env, { dryRun });
    mongoose = mongoose || require('mongoose');
    const connectReadOnly = dependencies.connectReadOnly
      || (async ({ dbUrl, mongoose: connection }) => connection.connect(dbUrl));
    await connectReadOnly({ dbUrl: config.dbUrl, mongoose });
    connected = true;

    let r2 = dependencies.r2;
    if (!dryRun && !r2) {
      const { S3Client } = dependencies.awsSdk || require('@aws-sdk/client-s3');
      const { createR2Storage } = dependencies.r2Storage || require('../services/r2-storage.service');
      r2 = createR2Storage({
        client: new S3Client({
          region: 'auto', endpoint: config.r2.endpoint,
          credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey }
        }),
        config: config.r2
      });
    }
    const report = await migrateCloudinaryMediaToR2({
      models: dependencies.models || {
        User: require('../models/user.schema'),
        Course: require('../models/course.schema'),
        Submission: require('../models/submission.schema')
      },
      r2,
      fetch: dependencies.fetch || globalThis.fetch,
      cloudName: config.cloudName,
      dryRun,
      logger
    });
    if (report.failed > 0) exitCode = 1;
  } catch {
    logger.error('Cloudinary to R2 migration configuration or startup failed.');
    exitCode = 2;
  } finally {
    if (connected) {
      try {
        await mongoose.disconnect();
      } catch {
        logger.error('Cloudinary to R2 migration disconnect failed.');
        if (exitCode === 0) exitCode = 1;
      }
    }
  }
  return exitCode;
}

if (require.main === module) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  buildCandidates,
  candidateStream,
  loadMigrationConfig,
  migrateCloudinaryMediaToR2,
  runCli,
  usableLegacyMedia,
  verifiedCloudinaryUrl
};
