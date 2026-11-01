const Course = require('../../models/course.schema');
const Enrollment = require('../../models/enrollment.schema');
const LearningProfile = require('../../models/learning-profile.schema');
const LectureProgress = require('../../models/lecture-progress.schema');
const Quiz = require('../../models/quiz.schema');
const QuizAttempt = require('../../models/quiz-attempt.schema');
const Assignment = require('../../models/assignment.schema');
const Submission = require('../../models/submission.schema');
const Certificate = require('../../models/certificate.schema');
const { calculateEligibility } = require('../certificate.service');
const AppError = require('../../utils/appError');
const { objectId, profileDto, safeText } = require('./learning-profile.service');

const MAX_COURSES = 10;
const MAX_ASSESSMENTS = 20;
const EARLY_SUPPORT_INACTIVITY_DAYS = 14;
const EARLY_SUPPORT_INACTIVITY_MS = EARLY_SUPPORT_INACTIVITY_DAYS * 24 * 60 * 60 * 1000;

function activityStatus(lastActivityAt, completed, total, now) {
  if (total === 0) return 'NO_LESSONS';
  if (completed >= total) return 'COMPLETE';
  if (!lastActivityAt) return 'NOT_STARTED';
  return now.getTime() - lastActivityAt.getTime() >= EARLY_SUPPORT_INACTIVITY_MS ? 'PAUSED' : 'ACTIVE';
}

function buildProgressRecap(activeCourses, now) {
  const upcomingWork = activeCourses.flatMap(({ course, assessments }) => [
    ...assessments.quizzes.filter((quiz) => !quiz.passed).map((quiz) => ({
      id: quiz.id, courseId: course.id, courseTitle: course.title, kind: 'QUIZ',
      title: quiz.title, dueAt: null
    })),
    ...assessments.assignments.filter((assignment) => assignment.status === 'NOT_SUBMITTED'
      && assignment.dueDate && new Date(assignment.dueDate).getTime() > now.getTime()).map((assignment) => ({
      id: assignment.id, courseId: course.id, courseTitle: course.title, kind: 'ASSIGNMENT',
      title: assignment.title, dueAt: assignment.dueDate
    }))
  ]).sort((left, right) => (
    (left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY)
      - (right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY)
    || left.courseTitle.localeCompare(right.courseTitle)
    || left.title.localeCompare(right.title)
  ));
  return {
    courseCount: activeCourses.length,
    completedLessons: activeCourses.reduce((sum, entry) => sum + entry.progress.completedLectures, 0),
    totalLessons: activeCourses.reduce((sum, entry) => sum + entry.progress.totalLectures, 0),
    upcomingWork: upcomingWork.slice(0, 10)
  };
}

async function courseContext(student, course, now) {
  const publishedAssessments = { course: course._id, status: 'PUBLISHED' };
  const [progress, quizzes, assignments, totalQuizzes, totalAssignments, certificate, certificateEligibility] = await Promise.all([
    LectureProgress.find({ student, course: course._id, lectureId: { $in: course.lectures.map((lecture) => lecture._id) } })
      .select('lectureId completed lastWatchedAt').lean(),
    Quiz.find(publishedAssessments).select('title passMark').sort({ title: 1, _id: 1 }).limit(MAX_ASSESSMENTS).lean(),
    Assignment.find(publishedAssessments).select('title dueDate maxMarks').sort({ title: 1, _id: 1 }).limit(MAX_ASSESSMENTS).lean(),
    Quiz.countDocuments(publishedAssessments),
    Assignment.countDocuments(publishedAssessments),
    Certificate.findOne({ student, course: course._id }).select('certificateNumber issuedAt').lean(),
    calculateEligibility(student, course._id)
  ]);
  const [attempts, submissions] = await Promise.all([
    quizzes.length === 0 ? [] : QuizAttempt.aggregate([
      { $match: { student, course: course._id, quiz: { $in: quizzes.map((quiz) => quiz._id) } } },
      { $group: { _id: '$quiz', bestPercentage: { $max: '$percentage' }, passed: { $max: { $cond: [{ $eq: ['$passed', true] }, 1, 0] } } } },
      { $project: { _id: 0, quiz: '$_id', bestPercentage: 1, passed: { $eq: ['$passed', 1] } } },
      { $limit: MAX_ASSESSMENTS }
    ]),
    assignments.length === 0 ? [] : Submission.aggregate([
      { $match: { student, course: course._id, assignment: { $in: assignments.map((assignment) => assignment._id) } } },
      { $sort: { assignment: 1, version: -1, createdAt: -1, _id: -1 } },
      { $group: { _id: '$assignment', status: { $first: '$status' }, marks: { $first: '$marks' } } },
      { $project: { _id: 0, assignment: '$_id', status: 1, marks: 1 } },
      { $limit: MAX_ASSESSMENTS }
    ])
  ]);
  const completed = new Set(progress.filter((row) => row.completed === true).map((row) => String(row.lectureId)));
  const lastActivityAt = progress.reduce((latest, row) => {
    if (!row.lastWatchedAt) return latest;
    const time = row.lastWatchedAt instanceof Date ? row.lastWatchedAt : new Date(row.lastWatchedAt);
    return Number.isFinite(time.getTime()) && (!latest || time > latest) ? time : latest;
  }, null);
  const orderedLectures = course.lectures.map((lecture, index) => ({ ...lecture, index }))
    .sort((left, right) => (left.position ?? left.index) - (right.position ?? right.index) || left.index - right.index);
  const next = orderedLectures.find((lecture) => !completed.has(String(lecture._id)));
  const bestAttempts = new Map(attempts.map((attempt) => [String(attempt.quiz), {
    bestPercentage: attempt.bestPercentage, passed: attempt.passed
  }]));
  const latestSubmissions = new Map(submissions.map((submission) => [String(submission.assignment), submission]));
  return {
    course: { id: String(course._id), title: safeText(course.title, 100), category: safeText(course.category, 80) },
    progress: { totalLectures: course.lectures.length, completedLectures: completed.size,
      completionPercent: course.lectures.length === 0 ? 0 : Math.round(100 * completed.size / course.lectures.length) },
    lastActivityAt,
    activityStatus: activityStatus(lastActivityAt, completed.size, course.lectures.length, now),
    nextLecture: next ? { id: String(next._id), title: safeText(next.title, 100) } : null,
    assessments: {
      totalQuizzes, totalAssignments,
      quizzes: quizzes.map((quiz) => ({ id: String(quiz._id), title: safeText(quiz.title, 100), passMark: quiz.passMark,
        ...(bestAttempts.get(String(quiz._id)) || { bestPercentage: null, passed: false }) })),
      assignments: assignments.map((assignment) => {
        const submission = latestSubmissions.get(String(assignment._id));
        return { id: String(assignment._id), title: safeText(assignment.title, 100), dueDate: assignment.dueDate || null,
          maxMarks: assignment.maxMarks, status: submission?.status || 'NOT_SUBMITTED', marks: submission?.status === 'GRADED' ? submission.marks : null };
      })
    },
    certificate: certificate ? { certificateNumber: certificate.certificateNumber, issuedAt: certificate.issuedAt } : null,
    certificateEligibility
  };
}

async function buildStudentContext(studentId, courseId, now = new Date()) {
  const student = objectId(studentId, 'studentId');
  const requestedCourse = courseId === undefined ? undefined : objectId(courseId, 'courseId');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  const [profile, enrollments] = await Promise.all([
    LearningProfile.findOne({ student }).select('careerGoal interests selfReportedSkills experienceLevel weeklyAvailabilityHours').lean(),
    Enrollment.find({ student, status: 'ACTIVE', ...(requestedCourse ? { course: requestedCourse } : {}) }).select('course').lean()
  ]);
  const courses = await Course.find({ status: 'PUBLISHED', _id: { $in: enrollments.map((enrollment) => enrollment.course) } })
    .select('title category lectures._id lectures.title lectures.position').sort({ title: 1, _id: 1 }).limit(MAX_COURSES).lean();
  if (requestedCourse && courses.length === 0) throw new AppError('An active published course enrollment is required', 403);
  const activeCourses = await Promise.all(courses.map((course) => courseContext(student, course, now)));
  return { profile: profileDto(profile), activeCourses, recap: buildProgressRecap(activeCourses, now) };
}

module.exports = { buildStudentContext, activityStatus, buildProgressRecap, EARLY_SUPPORT_INACTIVITY_DAYS };
