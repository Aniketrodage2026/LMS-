
const errorMiddleware = (error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    const production = process.env.NODE_ENV === 'production';
    const message = production && statusCode >= 500
        ? 'Internal server error'
        : error.message || 'Something went wrong';

    const body = {
        success: false,
        message
    };

    if (!production) {
        body.stack = error.stack;
    }

    return res.status(statusCode).json(body);
};

module.exports = errorMiddleware;
