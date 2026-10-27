const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const Assignment = require('../models/assignment.schema');
const Submission = require('../models/submission.schema');
const Certificate = require('../models/certificate.schema');
const AppError = require('../utils/appError');

const ELIGIBILITY_RULE_VERSION = 1;
const ASSESSMENT_BATCH_SIZE = 20;

function roundedPercent(numerator, denominator) {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function createCertificateValues(now = new Date()) {
  return {
    certificateNumber: `LMS-${now.getUTCFullYear()}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
    verificationToken: crypto.randomBytes(32).toString('hex')
  };
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

// Read every published requirement, but transfer only a bounded page of
// definitions and best/latest summaries. Raw answers and history never leave
// MongoDB, including when this read-only service is used by AI guidance.
async function assessmentSummary(studentId, courseId, session) {
  const student = new mongoose.Types.ObjectId(studentId);
  const course = new mongoose.Types.ObjectId(courseId);
  let requiredQuizzes = 0;
  let passedQuizzes = 0;
  let requiredAssignments = 0;
  let gradedAssignments = 0;
  let totalPercentage = 0;
  for (const model of [Quiz, Assignment]) {
    let after;
    while (true) {
      const definitions = await withSession(model.find({ course, status: 'PUBLISHED', ...(after ? { _id: { $gt: after } } : {}) })
        .select(model === Quiz ? '_id' : '_id maxMarks').sort({ _id: 1 }).limit(ASSESSMENT_BATCH_SIZE), session).lean();
      if (!definitions.length) break;
      const ids = definitions.map((entry) => entry._id);
      if (model === Quiz) {
        const attempts = await withSession(QuizAttempt.aggregate([
          { $match: { student, course, quiz: { $in: ids } } },
          { $group: { _id: '$quiz', percentage: { $max: '$percentage' }, passed: { $max: { $cond: [{ $eq: ['$passed', true] }, 1, 0] } } } },
          { $limit: ASSESSMENT_BATCH_SIZE }
        ]), session);
        const best = new Map(attempts.map((entry) => [String(entry._id), entry]));
        requiredQuizzes += definitions.length;
        for (const quiz of definitions) {
          const attempt = best.get(String(quiz._id));
          totalPercentage += attempt?.percentage || 0;
          if (attempt?.passed === 1) passedQuizzes += 1;
        }
      } else {
        const submissions = await withSession(Submission.aggregate([
          { $match: { student, course, assignment: { $in: ids } } },
          { $sort: { assignment: 1, version: -1, createdAt: -1, _id: -1 } },
          { $group: { _id: '$assignment', status: { $first: '$status' }, marks: { $first: '$marks' } } },
          { $limit: ASSESSMENT_BATCH_SIZE }
        ]), session);
        const latest = new Map(submissions.map((entry) => [String(entry._id), entry]));
        requiredAssignments += definitions.length;
        for (const assignment of definitions) {
          const submission = latest.get(String(assignment._id));
          if (submission?.status === 'GRADED') {
            gradedAssignments += 1;
            const marks = Number(submission.marks);
            if (Number.isFinite(marks)) totalPercentage += roundedPercent(marks, assignment.maxMarks);
          }
        }
      }
      if (definitions.length < ASSESSMENT_BATCH_SIZE) break;
      after = definitions[definitions.length - 1]._id;
    }
  }
  const count = requiredQuizzes + requiredAssignments;
  return { requiredQuizzes, passedQuizzes, requiredAssignments, gradedAssignments,
    average: count === 0 ? 100 : Number((totalPercentage / count).toFixed(2)) };
}

async function calculateEligibility(studentId, courseId, { session } = {}) {
  const course = await withSession(Course.findById(courseId).select('lectures'), session).lean();
  if (!course) {
    const error = new Error('Course not found');
    error.code = 'COURSE_NOT_FOUND';
    throw error;
  }

  const lectureIds = course.lectures.map((lecture) => lecture._id);
  const [completedLectures, summary] = await Promise.all([
    lectureIds.length === 0
      ? 0
      : withSession(LectureProgress.countDocuments({
        student: studentId,
        course: course._id,
        lectureId: { $in: lectureIds },
        completed: true
      }), session),
    assessmentSummary(studentId, course._id, session)
  ]);

  const totalLectures = lectureIds.length;
  const lecturePercent = roundedPercent(completedLectures, totalLectures);
  const { requiredQuizzes, passedQuizzes, requiredAssignments, gradedAssignments, average } = summary;
  const lectureRequirementMet = lecturePercent >= 80;
  const quizzesRequirementMet = passedQuizzes === requiredQuizzes;
  const assignmentsRequirementMet = gradedAssignments === requiredAssignments;
  const assessmentRequirementMet = average >= 80;

  return {
    eligible: lectureRequirementMet
      && quizzesRequirementMet
      && assignmentsRequirementMet
      && assessmentRequirementMet,
    totalLectures,
    completedLectures,
    lecturePercent,
    requiredQuizzes,
    passedQuizzes,
    requiredAssignments,
    gradedAssignments,
    assessmentAverage: average,
    lectureRequirementMet,
    quizzesRequirementMet,
    assignmentsRequirementMet,
    assessmentRequirementMet
  };
}

function eligibilitySnapshot(eligibility) {
  return {
    ruleVersion: ELIGIBILITY_RULE_VERSION,
    totalLectures: eligibility.totalLectures,
    completedLectures: eligibility.completedLectures,
    lecturePercent: eligibility.lecturePercent,
    requiredQuizzes: eligibility.requiredQuizzes,
    passedQuizzes: eligibility.passedQuizzes,
    requiredAssignments: eligibility.requiredAssignments,
    gradedAssignments: eligibility.gradedAssignments,
    assessmentAverage: eligibility.assessmentAverage
  };
}

function certificateSummary(certificate, courseTitle) {
  return {
    certificateNumber: certificate.certificateNumber,
    courseTitle,
    issuedAt: certificate.issuedAt
  };
}

function publicCertificate(certificate, learnerName, courseTitle) {
  return {
    certificateNumber: certificate.certificateNumber,
    learnerName,
    courseTitle,
    issuedAt: certificate.issuedAt,
    valid: true
  };
}

function transactionUnavailable(error) {
  return Boolean(error && /Transaction numbers are only allowed|does not support transactions|transactions unsupported|replica set/i.test(error.message));
}

async function claimCertificate(studentId, courseId) {
  const existing = await Certificate.findOne({ student: studentId, course: courseId });
  if (existing) return { certificate: existing, created: false };

  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const alreadyClaimed = await Certificate.findOne({ student: studentId, course: courseId }).session(session);
      if (alreadyClaimed) {
        result = { certificate: alreadyClaimed, created: false };
        return;
      }

      const activeEnrollment = await Enrollment.findOneAndUpdate(
        { student: studentId, course: courseId, status: 'ACTIVE' },
        { $set: { status: 'ACTIVE' } },
        { new: false, session }
      );
      if (!activeEnrollment) {
        throw new AppError('An active enrollment is required to claim a certificate', 403);
      }

      const eligibility = await calculateEligibility(studentId, courseId, { session });
      if (!eligibility.eligible) {
        result = { certificate: null, created: false, eligibility };
        return;
      }

      const [certificate] = await Certificate.create([{
        student: studentId,
        course: courseId,
        ...createCertificateValues(),
        eligibilitySnapshot: eligibilitySnapshot(eligibility)
      }], { session });
      result = { certificate, created: true };
    });
    return result;
  } catch (error) {
    if (error && error.code === 11000) {
      const certificate = await Certificate.findOne({ student: studentId, course: courseId });
      if (certificate) return { certificate, created: false };
    }
    if (transactionUnavailable(error)) {
      throw new AppError('Certificate processing is temporarily unavailable', 503);
    }
    throw error;
  } finally {
    if (session) await session.endSession();
  }
}

module.exports = {
  ELIGIBILITY_RULE_VERSION,
  calculateEligibility,
  certificateSummary,
  claimCertificate,
  createCertificateValues,
  eligibilitySnapshot,
  publicCertificate
};
