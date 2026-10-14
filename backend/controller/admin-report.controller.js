const mongoose = require('mongoose');
const AppError = require('../utils/appError');
const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const Purchase = require('../models/purchase.schema');
const AuditLog = require('../models/audit-log.schema');
const { parseLimit, parseCursor, invalidAdminRequest } = require('../utils/admin-pagination');

const studentSelect = '_id fullName email';
const courseSelect = '_id title';
const roles = new Set(['STUDENT', 'INSTRUCTOR', 'ADMIN']);
const targetTypes = new Set(['USER', 'COURSE', 'LECTURE', 'QUIZ', 'ASSIGNMENT', 'SUBMISSION', 'PURCHASE', 'CERTIFICATE']);
const auditActions = new Set(AuditLog.actions);
const maxAmount = Number.MAX_SAFE_INTEGER;

const reportablePurchaseFilter = {
  status: 'VERIFIED',
  currency: 'INR',
  amount: { $type: ['double', 'int'] },
  updatedAt: { $type: 'date' },
  $expr: {
    $let: {
      vars: { amount: { $cond: [{ $isNumber: '$amount' }, '$amount', null] } },
      in: {
        $and: [
          { $ne: ['$$amount', null] },
          { $gt: [{ $ifNull: ['$$amount', 0] }, 0] },
          { $lte: [{ $ifNull: ['$$amount', 0] }, maxAmount] },
          { $eq: [{ $ifNull: ['$$amount', 0] }, { $trunc: { $ifNull: ['$$amount', 0] } }] }
        ]
      }
    }
  }
};

function safeSummary(action, summary) {
  const entries = summary instanceof Map ? Object.fromEntries(summary) : summary;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
  if (action === 'ROLE_CHANGED') {
    const result = {};
    if (typeof entries.fromRole === 'string' && entries.fromRole.length <= 30 && roles.has(entries.fromRole)) result.fromRole = entries.fromRole;
    if (typeof entries.toRole === 'string' && entries.toRole.length <= 30 && roles.has(entries.toRole)) result.toRole = entries.toRole;
    return result;
  }
  if (action === 'COURSE_UPDATED' && entries.status !== undefined && typeof entries.status === 'string' && entries.status.length <= 30 && entries.status === 'UNPUBLISHED') {
    return { status: 'UNPUBLISHED' };
  }
  return {};
}

function publicAudit(entry) {
  if (
    !entry || !mongoose.isObjectIdOrHexString(entry._id) || !mongoose.isObjectIdOrHexString(entry.actor)
    || typeof entry.action !== 'string' || !auditActions.has(entry.action)
    || !entry.target || typeof entry.target.type !== 'string' || !targetTypes.has(entry.target.type)
    || !mongoose.isObjectIdOrHexString(entry.target.id) || !(entry.createdAt instanceof Date)
    || Number.isNaN(entry.createdAt.getTime())
  ) return null;
  const summary = safeSummary(entry.action, entry.summary);
  return {
    id: String(entry._id), actor: String(entry.actor), action: entry.action,
    target: { type: entry.target.type, id: String(entry.target.id) }, summary,
    createdAt: entry.createdAt.toISOString()
  };
}

function purchaseCursor(entry) {
  return Buffer.from(JSON.stringify({ at: entry.updatedAt.toISOString(), id: String(entry._id) })).toString('base64url');
}

function publicPurchase(purchase) {
  if (
    !purchase || !mongoose.isObjectIdOrHexString(purchase._id) || !Number.isFinite(purchase.amount)
    || !Number.isInteger(purchase.amount) || purchase.amount <= 0 || purchase.currency !== 'INR'
    || !(purchase.updatedAt instanceof Date) || Number.isNaN(purchase.updatedAt.getTime())
    || !purchase.student || !mongoose.isObjectIdOrHexString(purchase.student._id)
    || typeof purchase.student.fullName !== 'string' || typeof purchase.student.email !== 'string'
  ) return null;
  const course = purchase.course && mongoose.isObjectIdOrHexString(purchase.course._id) && typeof purchase.course.title === 'string'
    ? { id: String(purchase.course._id), title: purchase.course.title }
    : null;
  return {
    id: String(purchase._id),
    student: purchase.student && purchase.student._id ? {
      id: String(purchase.student._id), name: purchase.student.fullName, email: purchase.student.email
    } : null,
    course,
    amount: purchase.amount, currency: purchase.currency, verifiedAt: purchase.updatedAt.toISOString()
  };
}

async function overview(req, res, next) {
  try {
    const [totalUsers, students, instructors, admins, totalCourses, publishedCourses, activeEnrollments, verified, denominator, numerator, activities] = await Promise.all([
      User.countDocuments(), User.countDocuments({ role: 'STUDENT' }), User.countDocuments({ role: 'INSTRUCTOR' }), User.countDocuments({ role: 'ADMIN' }),
      Course.countDocuments(), Course.countDocuments({ status: 'PUBLISHED' }), Enrollment.countDocuments({ status: 'ACTIVE' }),
      Purchase.aggregate([{ $match: reportablePurchaseFilter }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$amount' } } }]),
      Enrollment.aggregate([
        { $match: { status: 'ACTIVE', student: { $type: 'objectId' }, course: { $type: 'objectId' } } },
        { $group: { _id: { student: '$student', course: '$course' } } },
        { $lookup: { from: Course.collection.name, localField: '_id.course', foreignField: '_id', as: 'course' } },
        { $unwind: '$course' },
        { $project: { slots: { $cond: [{ $isArray: '$course.lectures' }, { $size: '$course.lectures' }, 0] } } },
        { $group: { _id: null, total: { $sum: '$slots' } } }
      ]),
      LectureProgress.aggregate([
        { $match: { completed: true, student: { $type: 'objectId' }, course: { $type: 'objectId' }, lectureId: { $type: 'objectId' } } },
        { $lookup: {
          from: Enrollment.collection.name,
          let: { student: '$student', course: '$course' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$student', '$$student'] }, { $eq: ['$course', '$$course'] }] }, status: 'ACTIVE', student: { $type: 'objectId' }, course: { $type: 'objectId' } } }, { $limit: 1 }],
          as: 'enrollment'
        } },
        { $match: { 'enrollment.0': { $exists: true } } },
        { $lookup: { from: Course.collection.name, localField: 'course', foreignField: '_id', as: 'courseDoc' } },
        { $unwind: '$courseDoc' },
        { $match: { $expr: { $in: ['$lectureId', { $cond: [{ $isArray: '$courseDoc.lectures' }, '$courseDoc.lectures._id', []] }] } } },
        { $group: { _id: { student: '$student', course: '$course', lectureId: '$lectureId' } } },
        { $count: 'total' }
      ]),
      AuditLog.find({}).select('_id actor action target summary createdAt').sort({ createdAt: -1, _id: -1 }).limit(10).lean()
    ]);
    const totalLectureSlots = denominator[0]?.total || 0;
    const completedLectures = numerator[0]?.total || 0;
    const verifiedSummary = verified[0] || { count: 0, revenue: 0 };
    const verifiedRevenuePaise = Number.isSafeInteger(verifiedSummary.revenue)
      ? verifiedSummary.revenue
      : Number.MAX_SAFE_INTEGER;
    return res.status(200).json({
      success: true,
      metrics: {
        users: { total: totalUsers, students, instructors, admins },
        courses: { total: totalCourses, published: publishedCourses }, activeEnrollments,
        purchases: { verifiedCount: verifiedSummary.count, verifiedRevenuePaise, currency: 'INR' },
        learning: {
          completedLectures, totalLectureSlots,
          completionPercent: totalLectureSlots ? Number(((completedLectures / totalLectureSlots) * 100).toFixed(2)) : 0
        }
      },
      recentActivity: activities.map(publicAudit).filter(Boolean)
    });
  } catch (error) {
    return next(new AppError('We could not retrieve the administrative overview. Try again shortly.', 500, 'SYSTEM_UNEXPECTED'));
  }
}

async function listPurchases(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const filter = { ...reportablePurchaseFilter };
    if (req.query.courseId !== undefined) {
      if (typeof req.query.courseId !== 'string' || !mongoose.isObjectIdOrHexString(req.query.courseId)) throw invalidAdminRequest();
      filter.course = new mongoose.Types.ObjectId(req.query.courseId);
    }
    const pipeline = [
      { $match: filter },
      { $lookup: { from: User.collection.name, localField: 'student', foreignField: '_id', as: 'student' } },
      { $unwind: '$student' },
      { $match: { 'student.fullName': { $type: 'string' }, 'student.email': { $type: 'string' } } },
      { $match: { $expr: { $and: [{ $gt: [{ $strLenCP: '$student.fullName' }, 0] }, { $gt: [{ $strLenCP: '$student.email' }, 0] }] } } }
    ];
    if (cursor) pipeline.push({ $match: { $or: [{ updatedAt: { $lt: cursor.at } }, { updatedAt: cursor.at, _id: { $lt: cursor.id } }] } });
    pipeline.push(
      { $sort: { updatedAt: -1, _id: -1 } },
      { $limit: limit + 1 },
      { $lookup: { from: Course.collection.name, localField: 'course', foreignField: '_id', as: 'course' } },
      { $unwind: { path: '$course', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 1, amount: 1, currency: 1, updatedAt: 1, 'student._id': 1, 'student.fullName': 1, 'student.email': 1, 'course._id': 1, 'course.title': 1 } }
    );
    const records = await Purchase.aggregate(pipeline);
    const hasNextPage = records.length > limit;
    const page = records.slice(0, limit);
    return res.status(200).json({ success: true, purchases: page.map(publicPurchase).filter(Boolean), nextCursor: hasNextPage ? purchaseCursor(page[page.length - 1]) : null });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError('We could not retrieve verified purchases. Try again shortly.', 500, 'SYSTEM_UNEXPECTED'));
  }
}

module.exports = { overview, listPurchases };
