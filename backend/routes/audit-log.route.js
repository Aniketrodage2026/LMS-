const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const { listAuditLogs } = require('../controller/audit-log.controller');

const router = express.Router();

router.get('/', isLoggedIn, requireRole('ADMIN'), listAuditLogs);

module.exports = router;
