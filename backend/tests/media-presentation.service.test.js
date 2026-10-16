const test = require('node:test');
const assert = require('node:assert/strict');

const { createMediaPresenter } = require('../services/media-presentation.service');

test('presents private R2 image media as a UI-compatible signed URL without storage metadata', async () => {
  const presenter = createMediaPresenter({
    storage: { signedReadUrl: async () => 'https://r2.example/signed-image' }
  });
  const image = await presenter.image({
    storage: { provider: 'R2', key: 'thumbnails/private.png', contentType: 'image/png', size: 12 }
  });

  assert.deepEqual(image, { secure_url: 'https://r2.example/signed-image' });
  assert.equal(JSON.stringify(image).includes('thumbnails/private.png'), false);
  assert.equal(JSON.stringify(image).includes('R2'), false);
});
