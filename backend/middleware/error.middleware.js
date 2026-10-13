
const multer = require('multer');
const AppError = require('../utils/appError');

const multerClientErrorCodes = new Set([
    'MISSING_FIELD_NAME',
    'LIMIT_FILE_SIZE',
    'LIMIT_UNEXPECTED_FILE',
    'LIMIT_FILE_COUNT',
    'LIMIT_PART_COUNT',
    'LIMIT_FIELD_COUNT',
    'LIMIT_FIELD_KEY',
    'LIMIT_FIELD_VALUE'
]);

const publicError = (error, production) => {
    const isMulterClientError = error instanceof multer.MulterError
        && multerClientErrorCodes.has(error.code);

    if (error?.type === 'entity.too.large' || error?.status === 413) {
        return { statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'This request is too large. Reduce it and try again.' };
    }

    if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, 'body')) {
        return { statusCode: 400, code: 'REQUEST_INVALID_JSON', message: 'This request contains invalid JSON. Check it and try again.' };
    }

    if (isMulterClientError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return { statusCode: 400, code: 'UPLOAD_FILE_TOO_LARGE', message: 'This file is too large. Choose a smaller file and try again.' };
        }
        return { statusCode: 400, code: 'UPLOAD_FILE_INVALID', message: 'Invalid upload request' };
    }

    if (error instanceof AppError) {
        const redactMessage = production && error.statusCode >= 500 && error.code === 'SYSTEM_UNEXPECTED';
        return {
            statusCode: error.statusCode,
            code: error.code,
            message: redactMessage ? 'Internal server error' : error.message
        };
    }

    return {
        statusCode: 500,
        code: 'SYSTEM_UNEXPECTED',
        message: production ? 'Internal server error' : error.message || 'Something went wrong'
    };
};

const errorMiddleware = (error, req, res, next) => {
    const production = process.env.NODE_ENV === 'production';
    const { statusCode, code, message } = publicError(error, production);

    if (statusCode >= 500) {
        console.error(JSON.stringify({
            event: 'http_error',
            requestId: req.requestId || null,
            statusCode,
            code
        }));
    }

    const body = {
        success: false,
        message,
        error: { code, message }
    };

    if (!production && !(error instanceof multer.MulterError)) {
        body.stack = error.stack;
    }

    return res.status(statusCode).json(body);
};

module.exports = errorMiddleware;
