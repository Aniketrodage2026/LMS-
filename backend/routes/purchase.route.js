const express = require('express');

const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const { createPurchaseController } = require('../controller/purchase.controller');

function dispatchVerification(req, res, next) {
  const body = req.body || {};
  const isSubscriptionCallback = Object.hasOwn(body, 'razorpay_subscription_id');
  const isHybridCallback = isSubscriptionCallback && Object.hasOwn(body, 'razorpay_order_id');
  if (isSubscriptionCallback && !isHybridCallback) return next('router');
  return next();
}

function createPurchaseRouter(options = {}) {
  const router = express.Router();
  const controller = createPurchaseController(options);

  router.post('/orders', isLoggedIn, requireRole('STUDENT'), controller.createOrder);
  router.post('/verify', isLoggedIn, dispatchVerification, requireRole('STUDENT'), controller.verifyPayment);
  return router;
}

function createPurchaseHistoryRouter(options = {}) {
  const router = express.Router();
  const controller = createPurchaseController(options);

  router.get('/', isLoggedIn, requireRole('STUDENT'), controller.getPurchaseHistory);
  return router;
}

module.exports = { createPurchaseRouter, createPurchaseHistoryRouter, dispatchVerification };
