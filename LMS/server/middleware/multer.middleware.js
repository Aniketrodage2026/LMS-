const path = require('path');
const crypto = require('node:crypto');
const multer = require('multer');
const AppError = require('../utils/appError');

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const videoExtensions = new Set(['.mp4', '.webm', '.mov']);
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const videoMimes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const submissionExtensions = new Set(['.pdf', '.docx', '.zip', '.png', '.jpg', '.jpeg']);
const submissionMimes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'application/x-zip-compressed',
  'image/png',
  'image/jpeg'
]);
const submissionMimesByExtension = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
  ['.zip', new Set(['application/zip', 'application/x-zip-compressed'])],
  ['.png', new Set(['image/png'])],
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])]
]);

function createFilename(originalname) {
  return `${crypto.randomUUID()}${path.extname(originalname).toLowerCase()}`;
}

function createUpload(allowedExtensions, allowedMimes, fileSize = 200 * 1024 * 1024, mimesByExtension = null) {
  return multer({
    limits: { fileSize },
    storage: multer.diskStorage({
      destination: 'uploads/',
      filename: (_req, file, callback) => callback(null, createFilename(file.originalname))
    }),
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const expectedMimes = mimesByExtension && mimesByExtension.get(extension);
      if (
        !allowedExtensions.has(extension)
        || !allowedMimes.has(file.mimetype)
        || (mimesByExtension && (!expectedMimes || !expectedMimes.has(file.mimetype)))
      ) {
        return callback(new AppError(`Unsupported file type: ${extension || 'unknown'}`, 400));
      }
      return callback(null, true);
    }
  });
}

const upload = createUpload(imageExtensions, imageMimes);
upload.thumbnail = upload;
upload.video = createUpload(videoExtensions, videoMimes);
upload.submission = createUpload(
  submissionExtensions,
  submissionMimes,
  25 * 1024 * 1024,
  submissionMimesByExtension
);
upload.createFilename = createFilename;

module.exports = upload;
