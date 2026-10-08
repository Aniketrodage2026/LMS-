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

function roundedPercent(numerator, denominator) {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function assessmentAverage(values) {
  if (values.length === 0) return 100;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function createCertificateValues(now = new Date()) {
  return {
    certificateNumber: `LMS-${now.getUTCFullYear()}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
    verificationToken: crypto.randomBytes(32).toString('hex')
  };
}

function bestAttemptsByQuiz(attempts) {
  const best = new Map();
  const passed = new Set();

  for (const attempt of attempts) {
    const quizId = String(attempt.quiz);
    const percentage = Number(attempt.percentage);
    if (Number.isFinite(percentage) && (!best.has(quizId) || percentage > best.get(quizId))) {
      best.set(quizId, percentage);
    }
    if (attempt.passed === true) passed.add(quizId);
  }

  return { best, passed };
}

function latestSubmissionsByAssignment(submissions) {
  const latest = new Map();
  for (const submission of submissions) {
    const assignmentId = String(submission.assignment);
    if (!latest.has(assignmentId)) latest.set(assignmentId, submission);
  }
  return latest;
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function calculateEligibility(studentId, courseId, { session } = {}) {
  const course = await withSession(Course.findById(courseId).select('lectures'), session).lean();
  if (!course) {
    const error = new Error('Course not found');
    error.code = 'COURSE_NOT_FOUND';
    throw error;
  }

  const [quizzes, assignments] = await Promise.all([
    withSession(Quiz.find({ course: course._id, status: 'PUBLISHED' }).select('_id'), session).lean(),
    withSession(Assignment.find({ course: course._id, status: 'PUBLISHED' }).select('_id maxMarks'), session).lean()
  ]);
  const lectureIds = course.lectures.map((lecture) => lecture._id);
  const quizIds = quizzes.map((quiz) => quiz._id);
  const assignmentIds = assignments.map((assignment) => assignment._id);
  const [completedLectures, attempts, submissions] = await Promise.all([
    lectureIds.length === 0
      ? 0
      : withSession(LectureProgress.countDocuments({
        student: studentId,
        course: course._id,
        lectureId: { $in: lectureIds },
        completed: true
      }), session),
    quizIds.length === 0
      ? []
      : withSession(
        QuizAttempt.find({ student: studentId, course: course._id, quiz: { $in: quizIds } })
          .select('quiz percentage passed'),
        session
      ).lean(),
    assignmentIds.length === 0
      ? []
      : withSession(
        Submission.find({ student: studentId, course: course._id, assignment: { $in: assignmentIds } })
          .select('assignment version createdAt status marks')
          .sort({ assignment: 1, version: -1, createdAt: -1, _id: -1 }),
        session
      ).lean()
  ]);

  const { best: bestQuizPercentages, passed: passedQuizIds } = bestAttemptsByQuiz(attempts);
  const latestSubmissions = latestSubmissionsByAssignment(submissions);
  const values = [];

  for (const quiz of quizzes) values.push(bestQuizPercentages.get(String(quiz._id)) || 0);
  for (const assignment of assignments) {
    const submission = latestSubmissions.get(String(assignment._id));
    const marks = Number(submission?.marks);
    values.push(submission?.status === 'GRADED' && Number.isFinite(marks)
      ? roundedPercent(marks, assignment.maxMarks)
      : 0);
  }

  const totalLectures = lectureIds.length;
  const lecturePercent = roundedPercent(completedLectures, totalLectures);
  const requiredQuizzes = quizzes.length;
  const passedQuizzes = quizzes.filter((quiz) => passedQuizIds.has(String(quiz._id))).length;
  const requiredAssignments = assignments.length;
  const gradedAssignments = assignments.filter((assignment) => (
    latestSubmissions.get(String(assignment._id))?.status === 'GRADED'
  )).length;
  const average = assessmentAverage(values);
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
