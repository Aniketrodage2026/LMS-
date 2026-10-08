
const multer = require('multer');

const multerClientErrorCodes = new Set([
    'LIMIT_FILE_SIZE',
    'LIMIT_UNEXPECTED_FILE',
    'LIMIT_FILE_COUNT',
    'LIMIT_PART_COUNT',
    'LIMIT_FIELD_COUNT',
    'LIMIT_FIELD_KEY',
    'LIMIT_FIELD_VALUE'
]);

const errorMiddleware = (error, req, res, next) => {
    const isMulterClientError = error instanceof multer.MulterError
        && multerClientErrorCodes.has(error.code);
    const statusCode = isMulterClientError ? 400 : (error.statusCode || 500);
    const production = process.env.NODE_ENV === 'production';
    const message = isMulterClientError
        ? 'Invalid upload request'
        : production && statusCode >= 500
        ? 'Internal server error'
        : error.message || 'Something went wrong';

    const body = {
        success: false,
        message
    };

    if (!production && !isMulterClientError) {
        body.stack = error.stack;
    }

    return res.status(statusCode).json(body);
};

module.exports = errorMiddleware;
