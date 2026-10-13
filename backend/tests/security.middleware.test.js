const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');

const { createApp } = require('../app');

const securityOptions = {
    enabled: true,
    authMax: 10,
    resetMax: 10,
    publicMax: 10,
    windowMs: 60_000
};

test('enabled security adds safe headers and a UUID request ID', async () => {
    const response = await request(createApp({ security: securityOptions })).get('/health');

    assert.equal(response.status, 200);
    assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
});

test('oversized login JSON returns the stable 413 error envelope', async () => {
    const response = await request(createApp({ security: securityOptions }))
        .post('/api/v1/auth/login')
        .send({ email: 'learner@example.com', password: 'x'.repeat(1_100_000) });

    assert.equal(response.status, 413);
    assert.equal(response.body.success, false);
    assert.equal(response.body.message, 'This request is too large. Reduce it and try again.');
    assert.deepEqual(response.body.error, {
        code: 'REQUEST_TOO_LARGE',
        message: 'This request is too large. Reduce it and try again.'
    });
});

test('login and reset rate limits return the stable security error', async () => {
    const app = createApp({ security: { ...securityOptions, authMax: 1, resetMax: 1 } });

    await request(app).post('/api/v1/auth/login').send({});
    const login = await request(app).post('/api/v1/auth/login').send({});
    await request(app).post('/api/v1/auth/reset').send({});
    const reset = await request(app).post('/api/v1/auth/reset').send({});

    for (const response of [login, reset]) {
        assert.equal(response.status, 429);
        assert.deepEqual(response.body.error, {
            code: 'SECURITY_RATE_LIMITED',
            message: 'Too many requests. Please wait a few minutes and try again.'
        });
    }
});

test('public API limiter applies outside auth routes without throttling health', async () => {
    const app = createApp({ security: { ...securityOptions, publicMax: 1 } });

    await request(app).get('/api/v1/not-found');
    const limited = await request(app).get('/api/v1/not-found');
    const health = await request(app).get('/health');

    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'SECURITY_RATE_LIMITED');
    assert.equal(health.status, 200);
});

test('ready reports database availability without exposing database details', async () => {
    const response = await request(createApp({ security: securityOptions })).get('/ready');

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { success: false, status: 'not_ready' });
});

test('malformed JSON has a stable safe error envelope', async () => {
    const response = await request(createApp({ security: securityOptions }))
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email":');

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.message, 'This request contains invalid JSON. Check it and try again.');
    assert.deepEqual(response.body.error, {
        code: 'REQUEST_INVALID_JSON',
        message: 'This request contains invalid JSON. Check it and try again.'
    });
});

test('5xx operational logs keep only safe error fields', async () => {
    const messages = [];
    const originalError = console.error;
    console.error = (message) => messages.push(message);

    try {
        await request(createApp({
            security: securityOptions,
            configureApp(app) {
                app.get('/_test/private-failure', () => {
                    throw new Error('database password secret should not be logged');
                });
            }
        })).get('/_test/private-failure');
    } finally {
        console.error = originalError;
    }

    assert.equal(messages.length, 1);
    const log = JSON.parse(messages[0]);
    assert.deepEqual(Object.keys(log).sort(), ['code', 'event', 'requestId', 'statusCode']);
    assert.equal(log.event, 'http_error');
    assert.equal(log.statusCode, 500);
    assert.equal(log.code, 'SYSTEM_UNEXPECTED');
    assert.doesNotMatch(messages[0], /database password secret/);
});

test('safe request logs do not leak reset tokens or request bodies', async () => {
    const messages = [];
    const originalInfo = console.info;
    console.info = (message) => messages.push(message);

    try {
        const token = 'reset-token-should-not-appear';
        const secret = 'body-secret-should-not-appear';
        const app = createApp({ security: { ...securityOptions, resetMax: 1 } });
        await request(app).post('/api/v1/auth/reset').send({});
        await request(app)
            .post(`/api/v1/auth/reset/${token}`)
            .send({ password: secret });
    } finally {
        console.info = originalInfo;
    }

    assert.equal(messages.length, 2);
    for (const message of messages) {
        assert.doesNotMatch(message, /reset-token-should-not-appear|body-secret-should-not-appear/);
        assert.deepEqual(Object.keys(JSON.parse(message)).sort(), [
            'durationMs', 'event', 'method', 'requestId', 'route', 'status'
        ]);
    }
});
