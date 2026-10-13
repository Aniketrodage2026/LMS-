const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const AppError = require('../utils/appError');

const RATE_LIMIT_MESSAGE = 'Too many requests. Please wait a few minutes and try again.';

function assignRequestId(req, res, next) {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}

function createLimiter({ max, windowMs }) {
    return rateLimit({
        windowMs,
        limit: max,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res, next) => next(new AppError(RATE_LIMIT_MESSAGE, 429, 'SECURITY_RATE_LIMITED'))
    });
}

function safeRequestLogger(req, res, next) {
    const started = process.hrtime.bigint();

    res.on('finish', () => {
        const durationMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
        console.info(JSON.stringify({
            event: 'http_request',
            requestId: req.requestId,
            method: req.method,
            route: req.route?.path || 'unmatched',
            status: res.statusCode,
            durationMs
        }));
    });

    next();
}

module.exports = { RATE_LIMIT_MESSAGE, assignRequestId, createLimiter, safeRequestLogger };
