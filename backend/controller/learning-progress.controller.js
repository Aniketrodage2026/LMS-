const mongoose = require('mongoose');
const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const { recordProgress, completeLecture, getMyLearning: getMyLearningForStudent } = require('../services/learning-progress.service');

function validObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveLectureDuration(lecture) {
  return finiteNumber(lecture.durationSeconds) && lecture.durationSeconds > 0
    ? lecture.durationSeconds
    : 0;
}

function safeProgress(progress) {
  return {
    id: String(progress._id),
    courseId: String(progress.course),
    lectureId: String(progress.lectureId),
    watchedSeconds: progress.watchedSeconds,
    watchedPercent: progress.watchedPercent,
    durationSeconds: progress.durationSeconds,
    completed: progress.completed,
    completedAt: progress.completedAt,
    lastWatchedAt: progress.lastWatchedAt
  };
}

async function loadCourse(courseId) {
  if (!validObjectId(courseId)) {
    throw new AppError('Invalid courseId format', 400);
  }

  const course = await Course.findById(courseId);
  if (!course) {
    throw new AppError('Course not found', 404);
  }
  return course;
}

async function requireActiveEnrollment(req, course) {
  const enrollment = await Enrollment.exists({
    student: req.user._id,
    course: course._id,
    status: 'ACTIVE'
  });
  if (!enrollment) {
    throw new AppError('Purchase or enrol in this course to access this lesson', 403);
  }
}

async function getAccessibleCourse(req) {
  const course = await loadCourse(req.params.courseId);
  await requireActiveEnrollment(req, course);
  return course;
}

async function getAccessibleLecture(req) {
  const { lectureId } = req.params;
  if (!validObjectId(req.params.courseId) || !validObjectId(lectureId)) {
    throw new AppError('Invalid courseId or lectureId format', 400);
  }

  const course = await loadCourse(req.params.courseId);
  const lecture = course.lectures.id(lectureId);
  if (!lecture) {
    throw new AppError('Lecture not found', 404);
  }
  await requireActiveEnrollment(req, course);
  return { course, lecture };
}

function requestError(error, next) {
  return next(error instanceof AppError ? error : new AppError(error.message, 500));
}

exports.recordLectureProgress = async (req, res, next) => {
  try {
    const { watchedSeconds, durationSeconds } = req.body || {};
    if (!finiteNumber(watchedSeconds) || !finiteNumber(durationSeconds) || durationSeconds <= 0 || watchedSeconds < 0 || watchedSeconds > durationSeconds) {
      throw new AppError('watchedSeconds and durationSeconds must be finite numeric values within the video duration', 400);
    }

    const { course, lecture } = await getAccessibleLecture(req);
    const authoritativeDuration = positiveLectureDuration(lecture);
    if (authoritativeDuration && durationSeconds !== authoritativeDuration) {
      throw new AppError('durationSeconds does not match the lecture duration', 400);
    }

    const progress = await recordProgress({
      studentId: req.user._id,
      courseId: course._id,
      lectureId: lecture._id,
      watchedSeconds,
      durationSeconds
    });
    return res.status(200).json({ success: true, progress: safeProgress(progress) });
  } catch (error) {
    return requestError(error, next);
  }
};

exports.completeLecture = async (req, res, next) => {
  try {
    const { course, lecture } = await getAccessibleLecture(req);
    const progress = await completeLecture({
      studentId: req.user._id,
      courseId: course._id,
      lectureId: lecture._id,
      durationSeconds: positiveLectureDuration(lecture)
    });
    return res.status(200).json({ success: true, progress: safeProgress(progress) });
  } catch (error) {
    return requestError(error, next);
  }
};

exports.getCourseProgress = async (req, res, next) => {
  try {
    const course = await getAccessibleCourse(req);
    const rows = await LectureProgress.find({ student: req.user._id, course: course._id }).lean();
    const progressByLecture = new Map(rows.map((row) => [String(row.lectureId), row]));
    const lectures = course.lectures.map((lecture) => {
      const row = progressByLecture.get(String(lecture._id));
      return {
        id: String(lecture._id),
        title: lecture.title,
        watchedSeconds: row ? row.watchedSeconds : 0,
        watchedPercent: row ? row.watchedPercent : 0,
        durationSeconds: row ? row.durationSeconds : 0,
        completed: row ? row.completed : false,
        completedAt: row ? row.completedAt : null,
        lastWatchedAt: row ? row.lastWatchedAt : null
      };
    });
    const completedLectures = lectures.filter((lecture) => lecture.completed).length;
    const totalLectures = lectures.length;

    return res.status(200).json({
      success: true,
      progress: {
        courseId: String(course._id),
        totalLectures,
        completedLectures,
        completionPercent: totalLectures === 0 ? 0 : Math.round((completedLectures / totalLectures) * 100),
        lectures
      }
    });
  } catch (error) {
    return requestError(error, next);
  }
};

exports.getMyLearning = async (req, res, next) => {
  try {
    const learning = await getMyLearningForStudent(req.user._id);
    return res.status(200).json({ success: true, learning });
  } catch (error) {
    return requestError(error, next);
  }
};
