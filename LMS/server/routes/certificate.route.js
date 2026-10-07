const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const {
  claim,
  getEligibility,
  listMine,
  verifyPublic
} = require('../controller/certificate.controller');

const courseRouter = express.Router({ mergeParams: true });
courseRouter.use(isLoggedIn, requireRole('STUDENT'));
courseRouter.get('/:courseId/certificate/eligibility', getEligibility);
courseRouter.post('/:courseId/certificate/claim', claim);

const meRouter = express.Router();
meRouter.use(isLoggedIn, requireRole('STUDENT'));
meRouter.get('/certificates', listMine);

const publicRouter = express.Router();
publicRouter.get('/verify/:token', verifyPublic);

module.exports = { courseRouter, meRouter, publicRouter };
