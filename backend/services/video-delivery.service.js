const AppError = require('../utils/appError');

const PUBLIC = 'PUBLIC';
const AUTHENTICATED = 'AUTHENTICATED';
const DEFAULT_TOKEN_DURATION_SECONDS = 600;

function normalizeDuration(duration) {
  return Number.isInteger(duration) && duration >= 60 && duration <= 3600
    ? duration
    : DEFAULT_TOKEN_DURATION_SECONDS;
}

function createVideoDeliveryService({ cloudinary, mediaStorage, authTokenKey, tokenDurationSeconds } = {}) {
  const tokenDuration = normalizeDuration(tokenDurationSeconds);

  function deliveryTypeFor({ accessType, isPreview }) {
    return accessType === 'PAID' && !isPreview ? AUTHENTICATED : PUBLIC;
  }

  function uploadOptions({ accessType, isPreview }) {
    return {
      folder: 'lms',
      resource_type: 'video',
      chunk_size: 6000000,
      type: deliveryTypeFor({ accessType, isPreview }) === AUTHENTICATED ? 'authenticated' : 'upload'
    };
  }

  function playbackUrl(media) {
    if (media?.storage?.provider === 'R2') {
      try {
        return Promise.resolve(mediaStorage?.signedReadUrl(media)).then((url) => {
          if (!url) throw new Error('Missing signed R2 URL');
          return url;
        }).catch(() => {
          throw new AppError(
            'Premium video playback is temporarily unavailable. Please try again shortly.',
            500,
            'VIDEO_DELIVERY_UNAVAILABLE'
          );
        });
      } catch {
        throw new AppError(
          'Premium video playback is temporarily unavailable. Please try again shortly.',
          500,
          'VIDEO_DELIVERY_UNAVAILABLE'
        );
      }
    }
    if (media.deliveryType !== AUTHENTICATED) return media.secure_url;

    if (!authTokenKey) {
      throw new AppError(
        'Premium video playback is temporarily unavailable. Please try again shortly.',
        500,
        'VIDEO_DELIVERY_UNAVAILABLE'
      );
    }

    return cloudinary.url(media.public_id, {
      secure: true,
      resource_type: 'video',
      type: 'authenticated',
      sign_url: true,
      auth_token: { key: authTokenKey, duration: tokenDuration }
    });
  }

  function renameDelivery({ publicId, from, to }) {
    if (from === to) return undefined;

    return cloudinary.uploader.rename(publicId, publicId, {
      resource_type: 'video',
      type: from === AUTHENTICATED ? 'authenticated' : 'upload',
      to_type: to === AUTHENTICATED ? 'authenticated' : 'upload',
      overwrite: true,
      invalidate: true
    });
  }

  return { deliveryTypeFor, uploadOptions, playbackUrl, renameDelivery, normalizeDuration };
}

module.exports = { PUBLIC, AUTHENTICATED, createVideoDeliveryService };
