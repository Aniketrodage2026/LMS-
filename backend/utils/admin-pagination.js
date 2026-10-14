const mongoose = require('mongoose');
const AppError = require('./appError');

function invalidAdminRequest() {
  return new AppError(
    'Check the admin filters or paging details and try again.',
    400,
    'ADMIN_INVALID_REQUEST'
  );
}

function parseLimit(value) {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalidAdminRequest();

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalidAdminRequest();
  return limit;
}

function parseCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidAdminRequest();

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed
      || Object.getPrototypeOf(parsed) !== Object.prototype
      || Object.keys(parsed).length !== 2
      || !Object.hasOwn(parsed, 'at')
      || !Object.hasOwn(parsed, 'id')
      || typeof parsed.at !== 'string'
      || typeof parsed.id !== 'string'
      || !mongoose.isObjectIdOrHexString(parsed.id)
    ) {
      throw invalidAdminRequest();
    }

    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime()) || at.toISOString() !== parsed.at) throw invalidAdminRequest();

    return { at, id: new mongoose.Types.ObjectId(parsed.id) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidAdminRequest();
  }
}

function encodeCursor(entry) {
  return Buffer.from(JSON.stringify({
    at: entry.createdAt.toISOString(),
    id: String(entry._id)
  })).toString('base64url');
}

module.exports = { parseLimit, parseCursor, encodeCursor, invalidAdminRequest };
