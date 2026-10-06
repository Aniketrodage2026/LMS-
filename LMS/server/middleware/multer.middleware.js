const path = require('path');
const crypto = require('node:crypto');
const multer = require('multer');
const AppError = require('../utils/appError');

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const videoExtensions = new Set(['.mp4', '.webm', '.mov']);
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const videoMimes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

function createFilename(originalname) {
  return `${crypto.randomUUID()}${path.extname(originalname).toLowerCase()}`;
}

function createUpload(allowedExtensions, allowedMimes) {
  return multer({
    limits: { fileSize: 200 * 1024 * 1024 },
    storage: multer.diskStorage({
      destination: 'uploads/',
      filename: (_req, file, callback) => callback(null, createFilename(file.originalname))
    }),
    fileFilter: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!allowedExtensions.has(extension) || !allowedMimes.has(file.mimetype)) {
        return callback(new AppError(`Unsupported file type: ${extension || 'unknown'}`, 400));
      }
      return callback(null, true);
    }
  });
}

const upload = createUpload(imageExtensions, imageMimes);
upload.thumbnail = upload;
upload.video = createUpload(videoExtensions, videoMimes);
upload.createFilename = createFilename;

module.exports = upload;
