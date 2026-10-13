const mongoose = require('mongoose');
const AuditLog = require('../models/audit-log.schema');
const AppError = require('../utils/appError');

const invalidRequest = () => new AppError(
  'Check the audit-log paging details and try again.',
  400,
  'AUDIT_INVALID_REQUEST'
);

function parseLimit(value) {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalidRequest();

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalidRequest();
  return limit;
}

function parseCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidRequest();

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed
      || Object.getPrototypeOf(parsed) !== Object.prototype
      || typeof parsed.createdAt !== 'string'
      || typeof parsed.id !== 'string'
      || !mongoose.isObjectIdOrHexString(parsed.id)
    ) {
      throw invalidRequest();
    }

    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
      throw invalidRequest();
    }

    return { createdAt, id: new mongoose.Types.ObjectId(parsed.id) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidRequest();
  }
}

function encodeCursor(entry) {
  return Buffer.from(JSON.stringify({
    createdAt: entry.createdAt.toISOString(),
    id: String(entry._id)
  })).toString('base64url');
}

function publicEntry(entry) {
  const summary = entry.summary instanceof Map
    ? Object.fromEntries(entry.summary)
    : { ...(entry.summary || {}) };

  return {
    id: String(entry._id),
    actor: String(entry.actor),
    action: entry.action,
    target: {
      type: entry.target.type,
      id: String(entry.target.id)
    },
    summary,
    createdAt: entry.createdAt.toISOString()
  };
}

async function listAuditLogs(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const filter = {};

    if (cursor) {
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
      ];
    }

    const records = await AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasNextPage = records.length > limit;
    const entries = records.slice(0, limit);

    return res.status(200).json({
      success: true,
      entries: entries.map(publicEntry),
      nextCursor: hasNextPage ? encodeCursor(entries[entries.length - 1]) : null
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError('We could not retrieve audit logs. Try again shortly.', 500, 'SYSTEM_UNEXPECTED'));
  }
}

module.exports = { listAuditLogs };
