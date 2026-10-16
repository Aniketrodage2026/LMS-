const { PUBLIC, AUTHENTICATED, createVideoDeliveryService } = require('../services/video-delivery.service');

function safeId(value) {
  return value ? String(value) : 'unknown';
}

function hasPublicId(lecture) {
  return typeof lecture?.lecture?.public_id === 'string' && lecture.lecture.public_id.trim().length > 0;
}

function conditionalLectureFilter(courseId, lectureId) {
  return {
    _id: courseId,
    lectures: {
      $elemMatch: {
        _id: lectureId,
        $or: [
          { 'lecture.deliveryType': PUBLIC },
          { 'lecture.deliveryType': { $exists: false } }
        ]
      }
    }
  };
}

function isNotFound(error) {
  return error && (error.http_code === 404 || error.statusCode === 404 || error.code === 404);
}

function createCloudinaryVideoDelivery({ cloudinary, authTokenKey, tokenDurationSeconds }) {
  const delivery = createVideoDeliveryService({ cloudinary, authTokenKey, tokenDurationSeconds });
  return {
    ...delivery,
    async isAuthenticated(publicId) {
      try {
        await cloudinary.api.resource(publicId, { resource_type: 'video', type: 'authenticated' });
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    }
  };
}

/**
 * Counts every paid, non-preview lecture as scanned. Previews are skipped but not
 * scanned; already authenticated and unusable paid lectures are both scanned and
 * skipped. `migrated` counts only completed provider rename plus Mongo update.
 */
async function migratePremiumVideoDelivery({ Course, videoDelivery, dryRun = false, logger = console }) {
  const report = { scanned: 0, migrated: 0, skipped: 0, failed: 0 };
  const courses = await Course.find({ accessType: 'PAID' });

  for (const course of courses) {
    for (const lecture of course.lectures || []) {
      if (lecture.isPreview) {
        report.skipped += 1;
        continue;
      }

      report.scanned += 1;
      const deliveryType = lecture.lecture?.deliveryType;
      if (!hasPublicId(lecture)
        || deliveryType === AUTHENTICATED
        || (deliveryType !== PUBLIC && deliveryType !== undefined)) {
        report.skipped += 1;
        continue;
      }

      const courseId = safeId(course._id);
      const lectureId = safeId(lecture._id);
      if (dryRun) {
        logger.info(`DRY-RUN: would migrate course=${courseId} lecture=${lectureId}`);
        continue;
      }

      try {
        const alreadyAuthenticated = await videoDelivery.isAuthenticated(lecture.lecture.public_id);
        if (!alreadyAuthenticated) {
          await videoDelivery.renameDelivery({
            publicId: lecture.lecture.public_id,
            from: PUBLIC,
            to: AUTHENTICATED
          });
        }
        const update = await Course.updateOne(
          conditionalLectureFilter(course._id, lecture._id),
          { $set: { 'lectures.$.lecture.deliveryType': AUTHENTICATED } }
        );
        if (!update || update.matchedCount !== 1 || update.modifiedCount !== 1) {
          throw new Error('Migration record update was unsuccessful');
        }
        report.migrated += 1;
      } catch {
        report.failed += 1;
        logger.error(`Premium video migration failed for course=${courseId} lecture=${lectureId}`);
      }
    }
  }

  return report;
}

async function runCli(dependencies = {}) {
  const args = dependencies.args || process.argv.slice(2);
  const logger = dependencies.logger || console;
  const env = dependencies.env || process.env;
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
    logger.error('Usage: node scripts/migrate-premium-video-delivery.js [--dry-run]');
    return 2;
  }

  let mongoose = dependencies.mongoose;
  let connected = false;
  let exitCode = 0;
  try {
    (dependencies.dotenv || require('dotenv')).config();
    const loadEnv = dependencies.loadEnv || require('../config/env').loadEnv;
    const config = loadEnv(env);
    const cloudinary = dependencies.cloudinary || require('cloudinary').v2;
    const requiredCloudinaryValues = [
      env.CLOUDINARY_CLOUD_NAME,
      env.CLOUDINARY_CLOUD_API_KEY,
      env.CLOUDINARY_CLOUD_API_SECRET
    ];
    if (requiredCloudinaryValues.some((value) => !value)) throw new Error('Cloudinary configuration is required');

    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_CLOUD_API_KEY,
      api_secret: env.CLOUDINARY_CLOUD_API_SECRET,
      ...(env.CLOUDINARY_AUTH_TOKEN_KEY
        ? { auth_token: { key: env.CLOUDINARY_AUTH_TOKEN_KEY } }
        : {})
    });
    const connectDB = dependencies.connectDB || require('../config/dbConnect');
    mongoose = mongoose || require('mongoose');
    await connectDB(config.dbUrl);
    connected = true;
    const report = await migratePremiumVideoDelivery({
      Course: dependencies.Course || require('../models/course.schema'),
      videoDelivery: (dependencies.createVideoDeliveryService || createCloudinaryVideoDelivery)({
        cloudinary,
        authTokenKey: env.CLOUDINARY_AUTH_TOKEN_KEY,
        tokenDurationSeconds: config.cloudinaryAuthTokenDurationSeconds
      }),
      dryRun: args[0] === '--dry-run',
      logger
    });
    if (report.failed > 0) exitCode = 1;
  } catch {
    logger.error('Premium video migration configuration or startup failed.');
    exitCode = 2;
  } finally {
    if (connected) {
      try {
        await mongoose.disconnect();
      } catch {
        logger.error('Premium video migration disconnect failed.');
        if (exitCode === 0) exitCode = 1;
      }
    }
  }
  return exitCode;
}

if (require.main === module) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = { migratePremiumVideoDelivery, runCli, createCloudinaryVideoDelivery };
