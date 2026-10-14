const mongoose = require('mongoose');
const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const { recordAuditSafely } = require('../services/audit-log.service');
const {
  parseLimit,
  parseCursor,
  encodeCursor,
  invalidAdminRequest
} = require('../utils/admin-pagination');

const allowedStatuses = new Set(['PUBLISHED', 'UNPUBLISHED']);
const courseSelect = [
  '_id title description thumbnail.secure_url instructor accessType price currency status',
  'numberOflectures createdAt updatedAt'
].join(' ');
const instructorSelect = '_id fullName email avatar.secure_url';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseFilters(query) {
  const filter = {};

  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !allowedStatuses.has(query.status)) throw invalidAdminRequest();
    filter.status = query.status;
  }

  if (query.query !== undefined) {
    if (typeof query.query !== 'string') throw invalidAdminRequest();
    const value = query.query.trim();
    if (value.length > 100) throw invalidAdminRequest();
    if (value) filter.title = new RegExp(escapeRegex(value), 'i');
  }

  return filter;
}

function publicCourse(course) {
  const instructor = course.instructor && course.instructor._id ? {
    id: String(course.instructor._id),
    name: course.instructor.fullName,
    email: course.instructor.email,
    avatar: course.instructor.avatar?.secure_url || null
  } : null;

  return {
    id: String(course._id),
    title: course.title,
    description: course.description,
    thumbnail: course.thumbnail?.secure_url || null,
    instructor,
    accessType: course.accessType,
    price: course.price,
    currency: course.currency,
    status: course.status,
    lectureCount: course.numberOflectures,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString()
  };
}

function addOlderThanCursor(filter, cursor) {
  if (!cursor) return filter;
  const olderThanCursor = {
    $or: [
      { createdAt: { $lt: cursor.at } },
      { createdAt: cursor.at, _id: { $lt: cursor.id } }
    ]
  };
  return Object.keys(filter).length ? { $and: [filter, olderThanCursor] } : olderThanCursor;
}

async function findSafeCourseById(courseId) {
  return Course.findById(courseId)
    .select(courseSelect)
    .populate({ path: 'instructor', select: instructorSelect })
    .lean();
}

async function listCourses(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const filter = addOlderThanCursor(parseFilters(req.query), cursor);
    const records = await Course.find(filter)
      .select(courseSelect)
      .populate({ path: 'instructor', select: instructorSelect })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasNextPage = records.length > limit;
    const courses = records.slice(0, limit);
    return res.status(200).json({
      success: true,
      courses: courses.map(publicCourse),
      nextCursor: hasNextPage ? encodeCursor(courses[courses.length - 1]) : null
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(
      'We could not retrieve the course directory. Try again shortly.',
      500,
      'SYSTEM_UNEXPECTED'
    ));
  }
}

async function updateCourseStatus(req, res, next) {
  const { courseId } = req.params;
  const requestedStatus = req.body?.status;
  if (!mongoose.isObjectIdOrHexString(courseId) || typeof requestedStatus !== 'string' || !allowedStatuses.has(requestedStatus)) {
    return next(invalidAdminRequest());
  }

  try {
    const changedCourse = await Course.findOneAndUpdate(
      { _id: courseId, status: { $ne: requestedStatus } },
      { $set: { status: requestedStatus }, $inc: { __v: 1 } },
      { new: true, runValidators: true }
    )
      .select(courseSelect)
      .populate({ path: 'instructor', select: instructorSelect })
      .lean();

    if (!changedCourse) {
      const current = await findSafeCourseById(courseId);
      if (!current) return next(new AppError('Course not found.', 404, 'COURSE_NOT_FOUND'));
      return res.status(200).json({ success: true, course: publicCourse(current) });
    }

    await recordAuditSafely({
      actor: req.user._id,
      action: requestedStatus === 'PUBLISHED' ? 'COURSE_PUBLISHED' : 'COURSE_UPDATED',
      target: { type: 'COURSE', id: changedCourse._id },
      summary: requestedStatus === 'UNPUBLISHED' ? { status: 'UNPUBLISHED' } : undefined,
      requestId: req.requestId
    });

    return res.status(200).json({ success: true, course: publicCourse(changedCourse) });
  } catch (error) {
    return next(new AppError(
      'We could not update the course status. Try again shortly.',
      500,
      'SYSTEM_UNEXPECTED'
    ));
  }
}

module.exports = { listCourses, updateCourseStatus };
