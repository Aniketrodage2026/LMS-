const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const userRouter = require('./routes/user.route');
const coursesRouter = require('./routes/course.route');
const instructorCoursesRouter = require('./routes/instructor-course.route');
const learningProgressRouter = require('./routes/learning-progress.route');
const paymentRouter = require('./routes/payment.route');
const auditLogRouter = require('./routes/audit-log.route');
const adminOperationsRouter = require('./routes/admin-operations.route');
const { createPurchaseRouter, createPurchaseHistoryRouter } = require('./routes/purchase.route');
const { courseRouter: certificateCourseRouter, meRouter: certificateMeRouter, publicRouter: certificatePublicRouter } = require('./routes/certificate.route');
const errorMiddleware = require('./middleware/error.middleware');
const { assignRequestId, createLimiter, safeRequestLogger } = require('./middleware/security.middleware');

function createApp(options = {}) {
    const app = express();
    const frontendUrl = process.env.FRONTEND_URL;
    const security = {
        enabled: process.env.NODE_ENV !== 'test',
        authMax: 10,
        resetMax: 5,
        publicMax: 300,
        windowMs: 15 * 60 * 1000,
        ...(options.security || {})
    };

    app.set('trust proxy', process.env.TRUST_PROXY === 'true');
    app.use(assignRequestId);
    if (security.enabled) {
        app.use(helmet());
        app.use(safeRequestLogger);
    }

    app.use(cookieParser());
    app.use(express.json({ limit: '1mb' }));
    app.use(cors({
        origin(origin, callback) {
            callback(null, Boolean(origin && origin === frontendUrl));
        },
        credentials: true
    }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    if (security.enabled) {
        const authLimiter = createLimiter({ max: security.authMax, windowMs: security.windowMs });
        const resetLimiter = createLimiter({ max: security.resetMax, windowMs: security.windowMs });
        const publicLimiter = createLimiter({ max: security.publicMax, windowMs: security.windowMs });

        app.use('/api/v1/auth/login', authLimiter);
        app.use('/api/v1/auth/register', authLimiter);
        app.use('/api/v1/auth/reset', resetLimiter);
        app.use('/api/v1', (req, res, next) => (
            req.path.startsWith('/auth/') ? next() : publicLimiter(req, res, next)
        ));
    }

    app.get('/health', (req, res) => {
        res.status(200).json({ success: true, status: 'ok' });
    });

    app.get('/ready', (req, res) => {
        const ready = mongoose.connection.readyState === 1;
        res.status(ready ? 200 : 503).json({
            success: ready,
            status: ready ? 'ready' : 'not_ready'
        });
    });

    app.use('/api/v1/auth', userRouter);
    app.use('/api/v1/admin/audit-logs', auditLogRouter);
    app.use('/api/v1/admin', adminOperationsRouter);
    app.use('/api/v1/admin', userRouter.adminRouter);
    app.use('/api/v1/me', learningProgressRouter);
    app.use('/api/v1/me', certificateMeRouter);
    app.use('/api/v1/courses', coursesRouter);
    app.use('/api/v1/courses', certificateCourseRouter);
    app.use('/api/v1/certificates', certificatePublicRouter);
    app.use('/api/v1/instructor/courses', instructorCoursesRouter);
    app.use('/api/v1/payments', createPurchaseRouter(options));
    app.use('/api/v1/purchases', createPurchaseHistoryRouter(options));
    app.use('/api/v1/payments', paymentRouter);

    if (typeof options.configureApp === 'function') {
        options.configureApp(app);
    }

    app.use((req, res) => {
        res.status(404).json({ success: false, message: 'Route not found' });
    });
    app.use(errorMiddleware);

    return app;
}

const app = createApp();

module.exports = app;
module.exports.createApp = createApp;
