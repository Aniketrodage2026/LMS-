const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const { listUsers } = require('../controller/admin-user.controller');
const { listCourses, updateCourseStatus } = require('../controller/admin-course.controller');
const { overview, listPurchases } = require('../controller/admin-report.controller');

const router = express.Router();

router.use(isLoggedIn, requireRole('ADMIN'));
router.get('/overview', overview);
router.get('/purchases', listPurchases);
router.get('/users', listUsers);
router.get('/courses', listCourses);
router.patch('/courses/:courseId/status', updateCourseStatus);

module.exports = router;
