const test = require('node:test');
const assert = require('node:assert/strict');

const AppError = require('../utils/appError');
const {
  PUBLIC,
  AUTHENTICATED,
  createVideoDeliveryService
} = require('../services/video-delivery.service');

function createCloudinary() {
  const cloudinary = {
    urlCalls: [],
    renameCalls: [],
    url(...args) {
      this.urlCalls.push(args);
      return 'https://cdn.example.com/signed-video.mp4';
    },
    uploader: {
      rename: async (...args) => {
        cloudinary.renameCalls.push(args);
        return { public_id: args[1] };
      }
    }
  };

  return cloudinary;
}

test('classifies paid non-preview lectures as authenticated delivery', () => {
  const service = createVideoDeliveryService({ cloudinary: createCloudinary() });

  assert.equal(service.deliveryTypeFor({ accessType: 'PAID', isPreview: false }), AUTHENTICATED);
  assert.equal(service.deliveryTypeFor({ accessType: 'PAID', isPreview: true }), PUBLIC);
  assert.equal(service.deliveryTypeFor({ accessType: 'FREE', isPreview: false }), PUBLIC);
});

test('sets Cloudinary upload options for public and protected video delivery', () => {
  const service = createVideoDeliveryService({ cloudinary: createCloudinary() });

  assert.deepEqual(service.uploadOptions({ accessType: 'FREE', isPreview: false }), {
    folder: 'lms', resource_type: 'video', chunk_size: 6000000, type: 'upload'
  });
  assert.deepEqual(service.uploadOptions({ accessType: 'PAID', isPreview: false }), {
    folder: 'lms', resource_type: 'video', chunk_size: 6000000, type: 'authenticated'
  });
});

test('returns secure public URLs and signs authenticated playback URLs with the configured token', () => {
  const cloudinary = createCloudinary();
  const service = createVideoDeliveryService({
    cloudinary,
    authTokenKey: 'playback-key',
    tokenDurationSeconds: 900
  });

  assert.equal(service.playbackUrl({ deliveryType: PUBLIC, secure_url: 'https://cdn.example.com/public.mp4' }), 'https://cdn.example.com/public.mp4');
  assert.equal(service.playbackUrl({ deliveryType: AUTHENTICATED, public_id: 'premium-video' }), 'https://cdn.example.com/signed-video.mp4');
  assert.deepEqual(cloudinary.urlCalls, [[
    'premium-video',
    {
      secure: true,
      resource_type: 'video',
      type: 'authenticated',
      sign_url: true,
      auth_token: { key: 'playback-key', duration: 900 }
    }
  ]]);
});

test('fails with a safe AppError when authenticated playback has no signing key', () => {
  const service = createVideoDeliveryService({ cloudinary: createCloudinary() });

  assert.throws(
    () => service.playbackUrl({ deliveryType: AUTHENTICATED, public_id: 'premium-video' }),
    (error) => error instanceof AppError
      && error.message === 'Premium video playback is temporarily unavailable. Please try again shortly.'
      && error.code === 'VIDEO_DELIVERY_UNAVAILABLE'
  );
});

test('uses the default duration unless the value is a positive integer from one to sixty minutes', () => {
  const service = createVideoDeliveryService({ cloudinary: createCloudinary() });

  assert.equal(service.normalizeDuration(), 600);
  assert.equal(service.normalizeDuration(59), 600);
  assert.equal(service.normalizeDuration(60), 60);
  assert.equal(service.normalizeDuration(3600), 3600);
  assert.equal(service.normalizeDuration(3601), 600);
  assert.equal(service.normalizeDuration(120.5), 600);
});

test('renames video delivery type with Cloudinary parameters and skips no-op moves', async () => {
  const cloudinary = createCloudinary();
  const service = createVideoDeliveryService({ cloudinary });

  await service.renameDelivery({ publicId: 'video-id', from: PUBLIC, to: AUTHENTICATED });
  await service.renameDelivery({ publicId: 'video-id', from: AUTHENTICATED, to: AUTHENTICATED });

  assert.deepEqual(cloudinary.renameCalls, [[
    'video-id',
    'video-id',
    {
      resource_type: 'video',
      type: 'upload',
      to_type: 'authenticated',
      overwrite: true,
      invalidate: true
    }
  ]]);
});

test('uses the provider-neutral storage signer for R2 playback without exposing its object key', async () => {
  const signedReads = [];
  const service = createVideoDeliveryService({
    cloudinary: createCloudinary(),
    mediaStorage: {
      signedReadUrl: async (media) => {
        signedReads.push(media);
        return 'https://r2.example/signed-paid-video';
      }
    }
  });
  const media = {
    storage: {
      provider: 'R2',
      key: 'lectures/private-object.mp4',
      contentType: 'video/mp4',
      size: 42
    }
  };

  assert.equal(await service.playbackUrl(media), 'https://r2.example/signed-paid-video');
  assert.deepEqual(signedReads, [media]);
});

test('maps R2 signing failures to the safe video delivery error', async () => {
  const service = createVideoDeliveryService({
    cloudinary: createCloudinary(),
    mediaStorage: { signedReadUrl: async () => { throw new Error('R2 internal details'); } }
  });

  await assert.rejects(
    () => service.playbackUrl({ storage: { provider: 'R2', key: 'lectures/private.mp4' } }),
    (error) => error instanceof AppError
      && error.code === 'VIDEO_DELIVERY_UNAVAILABLE'
      && !error.message.includes('R2 internal details')
  );
});
