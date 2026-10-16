const AppError = require('../utils/appError');

function createMediaPresenter({ storage }) {
  if (!storage || typeof storage.signedReadUrl !== 'function') {
    throw new TypeError('media storage is required');
  }

  return {
    async image(media) {
      if (!media) return null;
      try {
        return { secure_url: await storage.signedReadUrl(media) };
      } catch {
        throw new AppError('We could not load this image. Please try again shortly.', 503, 'MEDIA_READ_UNAVAILABLE');
      }
    }
  };
}

module.exports = { createMediaPresenter };
