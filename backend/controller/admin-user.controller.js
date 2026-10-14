const AppError = require('../utils/appError');
const User = require('../models/user.schema');
const {
  parseLimit,
  parseCursor,
  encodeCursor,
  invalidAdminRequest
} = require('../utils/admin-pagination');

const allowedRoles = new Set(['STUDENT', 'INSTRUCTOR', 'ADMIN']);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseFilters(query) {
  const filter = {};

  if (query.role !== undefined) {
    if (typeof query.role !== 'string' || !allowedRoles.has(query.role)) throw invalidAdminRequest();
    filter.role = query.role;
  }

  if (query.query !== undefined) {
    if (typeof query.query !== 'string') throw invalidAdminRequest();
    const value = query.query.trim();
    if (value.length > 100) throw invalidAdminRequest();
    if (value) {
      const pattern = new RegExp(escapeRegex(value), 'i');
      filter.$or = [{ fullName: pattern }, { email: pattern }];
    }
  }

  return filter;
}

function publicUser(user) {
  return {
    id: String(user._id),
    name: user.fullName,
    email: user.email,
    avatar: user.avatar?.secure_url || null,
    role: user.role,
    createdAt: user.createdAt.toISOString()
  };
}

async function listUsers(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const filter = parseFilters(req.query);

    if (cursor) {
      const olderThanCursor = {
        $or: [
          { createdAt: { $lt: cursor.at } },
          { createdAt: cursor.at, _id: { $lt: cursor.id } }
        ]
      };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, olderThanCursor];
        delete filter.$or;
      } else {
        Object.assign(filter, olderThanCursor);
      }
    }

    const records = await User.find(filter)
      .select('_id fullName email avatar.secure_url role createdAt')
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasNextPage = records.length > limit;
    const users = records.slice(0, limit);

    return res.status(200).json({
      success: true,
      users: users.map(publicUser),
      nextCursor: hasNextPage ? encodeCursor(users[users.length - 1]) : null
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(
      'We could not retrieve the user directory. Try again shortly.',
      500,
      'SYSTEM_UNEXPECTED'
    ));
  }
}

module.exports = { listUsers };
