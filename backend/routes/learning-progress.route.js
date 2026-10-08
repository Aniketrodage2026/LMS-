const express = require('express');
const { getMyLearning } = require('../controller/learning-progress.controller');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/learning', isLoggedIn, requireRole('STUDENT'), getMyLearning);

module.exports = router;
