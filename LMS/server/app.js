const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const userRouter = require('./routes/user.route');
const coursesRouter = require('./routes/course.route');
const instructorCoursesRouter = require('./routes/instructor-course.route');
const learningProgressRouter = require('./routes/learning-progress.route');
const paymentRouter = require('./routes/payment.route');
const { createPurchaseRouter, createPurchaseHistoryRouter } = require('./routes/purchase.route');
const errorMiddleware = require('./middleware/error.middleware');
const morgan = require('morgan');

function createApp(options = {}) {
    const app = express();
    const frontendUrl = process.env.FRONTEND_URL;

    app.use(cookieParser());
    app.use(express.json());
    app.use(cors({
        origin(origin, callback) {
            callback(null, Boolean(origin && origin === frontendUrl));
        },
        credentials: true
    }));
    app.use(morgan('dev'));
    app.use(express.urlencoded({ extended: true }));

    app.get('/health', (req, res) => {
        res.status(200).json({ success: true, status: 'ok' });
    });

    app.use('/api/v1/auth', userRouter);
    app.use('/api/v1/admin', userRouter.adminRouter);
    app.use('/api/v1/me', learningProgressRouter);
    app.use('/api/v1/courses', coursesRouter);
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
