const path = require('path');
const crypto = require('node:crypto');
const multer = require('multer');
const AppError = require('../utils/appError');
const { allowedByNameAndMime, categories } = require('../services/media-validation.service');

function createFilename(originalname) {
  return `${crypto.randomUUID()}${path.extname(originalname).toLowerCase()}`;
}

function createUpload(category) {
  return multer({
    limits: { fileSize: categories[category].maxBytes },
    storage: multer.diskStorage({
      destination: 'uploads/',
      filename: (_req, file, callback) => callback(null, `${category === 'material' ? 'material-' : ''}${createFilename(file.originalname)}`)
    }),
    fileFilter: (_req, file, callback) => {
      if (!allowedByNameAndMime(file, category)) {
        return callback(new AppError('This file type is not supported. Choose one of the accepted file types.', 400, 'UPLOAD_FILE_TYPE_UNSUPPORTED'));
      }
      return callback(null, true);
    }
  });
}

const upload = createUpload('image');
upload.thumbnail = upload;
upload.video = createUpload('video');
upload.submission = createUpload('submission');
upload.material = createUpload('material');
upload.createFilename = createFilename;

module.exports = upload;
