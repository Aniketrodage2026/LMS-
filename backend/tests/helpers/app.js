const { createApp } = require('../../app');

function createTestApp(options = {}) {
    return createApp({
        ...options,
        security: { enabled: false, ...(options.security || {}) }
    });
}

module.exports = { createTestApp };
