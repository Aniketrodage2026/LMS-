const fs = require('node:fs/promises');
const path = require('node:path');
const AppError = require('../utils/appError');

const UNSUPPORTED_MESSAGE = 'This file type is not supported. Choose one of the accepted file types.';
const SIGNATURE_HEADER_BYTES = 64 * 1024;
const TRANSIENT_OPEN_CODES = new Set(['EPERM', 'EACCES', 'ENOENT']);
const MAX_OPEN_ATTEMPTS = 6;
const OPEN_RETRY_DELAY_MS = 50;

const categories = {
  material: {
    maxBytes: 10 * 1024 * 1024,
    formats: { '.pdf': 'application/pdf' }
  },
  image: {
    maxBytes: 200 * 1024 * 1024,
    formats: {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp'
    }
  },
  video: {
    maxBytes: 200 * 1024 * 1024,
    formats: {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime'
    }
  },
  submission: {
    maxBytes: 25 * 1024 * 1024,
    formats: {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.zip': ['application/zip', 'application/x-zip-compressed'],
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg'
    }
  }
};

function unsupported() {
  return new AppError(UNSUPPORTED_MESSAGE, 400, 'UPLOAD_FILE_TYPE_UNSUPPORTED');
}

function ruleFor(category) {
  const rule = categories[category];
  if (!rule) throw new TypeError('Unsupported upload category');
  return rule;
}

function allowedMimes(category, extension) {
  const expected = ruleFor(category).formats[extension];
  return expected === undefined ? new Set() : new Set(Array.isArray(expected) ? expected : [expected]);
}

function allowedByNameAndMime({ originalname, mimetype }, category) {
  const extension = path.extname(originalname || '').toLowerCase();
  return allowedMimes(category, extension).has(mimetype);
}

function hasPrefix(buffer, values) {
  return buffer.length >= values.length && values.every((value, index) => buffer[index] === value);
}

function detectContentType(bytes) {
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return bytes.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    const archiveText = bytes.toString('latin1');
    return archiveText.includes('[Content_Types].xml') && archiveText.includes('word/')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/zip';
  }
  return null;
}

function createMediaValidator({ fsPromises = fs, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  async function openForHeader(filePath) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt += 1) {
      try {
        return await fsPromises.open(filePath, 'r');
      } catch (error) {
        lastError = error;
        if (!TRANSIENT_OPEN_CODES.has(error?.code) || attempt === MAX_OPEN_ATTEMPTS) throw error;
        await sleep(OPEN_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  async function validateStoredUpload(file, category) {
    const rule = ruleFor(category);
    const extension = path.extname(file?.originalname || '').toLowerCase();
    if (!file?.path || !allowedByNameAndMime(file, category)) throw unsupported();

    const stat = await fsPromises.stat(file.path);
    if (!Number.isInteger(stat.size) || stat.size < 0 || stat.size > rule.maxBytes || file.size !== stat.size) throw unsupported();

    const handle = await openForHeader(file.path);
    const bytes = Buffer.alloc(Math.min(SIGNATURE_HEADER_BYTES, stat.size));
    try {
      await handle.read(bytes, 0, bytes.length, 0);
    } finally {
      await handle.close();
    }
    const detectedType = detectContentType(bytes);
    if (!detectedType || !allowedMimes(category, extension).has(detectedType) || detectedType !== file.mimetype) throw unsupported();

    return { extension: extension.slice(1), contentType: detectedType, size: stat.size };
  }

  return { validateStoredUpload };
}

const { validateStoredUpload } = createMediaValidator();

module.exports = {
  MAX_OPEN_ATTEMPTS,
  OPEN_RETRY_DELAY_MS,
  SIGNATURE_HEADER_BYTES,
  allowedByNameAndMime,
  allowedMimes,
  categories,
  createMediaValidator,
  detectContentType,
  validateStoredUpload
};
