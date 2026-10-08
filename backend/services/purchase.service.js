const crypto = require('crypto');

function createPurchaseService({ razorpay, secret }) {
  function signaturesEqual(left, right) {
    const leftBuffer = Buffer.from(left || '', 'utf8');
    const rightBuffer = Buffer.from(right || '', 'utf8');
    return leftBuffer.length === rightBuffer.length
      && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  return {
    async createOrder({ amount, receipt }) {
      return razorpay.orders.create({ amount, currency: 'INR', receipt });
    },

    async findOrderByReceipt(receipt) {
      const response = await razorpay.orders.all({ receipt, count: 1 });
      return response && Array.isArray(response.items) ? response.items[0] || null : null;
    },

    verifySignature({ orderId, paymentId, signature }) {
      const expected = crypto.createHmac('sha256', secret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');
      return signaturesEqual(expected, signature);
    },

    signaturesEqual
  };
}

module.exports = { createPurchaseService };
