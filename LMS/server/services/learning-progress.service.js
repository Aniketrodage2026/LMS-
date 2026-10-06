const mongoose = require('mongoose');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');

function percentFor(watchedSeconds, durationSeconds) {
  const watched = Number(watchedSeconds);
  const duration = Number(durationSeconds);

  if (!Number.isFinite(watched) || !Number.isFinite(duration) || watched <= 0 || duration <= 0) {
    return 0;
  }

  return Math.min(100, Number(((watched / duration) * 100).toFixed(2)));
}

function nonNegativeNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a nonnegative number`);
  }
  return value;
}

function objectId(value, fieldName) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new TypeError(`${fieldName} must be a valid ObjectId`);
  }
  return new mongoose.Types.ObjectId(value);
}

function isDuplicateKey(error) {
  return error && error.code === 11000;
}

function atomicProgressUpdate({ studentId, courseId, lectureId, watchedSeconds, durationSeconds }) {
  const student = objectId(studentId, 'studentId');
  const course = objectId(courseId, 'courseId');
  const lecture = objectId(lectureId, 'lectureId');
  const watched = nonNegativeNumber(watchedSeconds, 'watchedSeconds');
  const duration = nonNegativeNumber(durationSeconds, 'durationSeconds');
  if (duration <= 0) {
    throw new RangeError('durationSeconds must be greater than zero');
  }
  if (watched > duration) {
    throw new RangeError('watchedSeconds cannot exceed durationSeconds');
  }
  const now = new Date();

  const storedSeconds = { $ifNull: ['$watchedSeconds', 0] };
  const nextSeconds = { $max: [storedSeconds, watched] };
  const canonicalDuration = {
    $cond: [
      { $gt: [{ $ifNull: ['$durationSeconds', 0] }, 0] },
      '$durationSeconds',
      duration
    ]
  };
  const nextPercent = {
    $max: [
      { $ifNull: ['$watchedPercent', 0] },
      {
        $min: [
          100,
          {
            $round: [
              { $multiply: [{ $divide: [nextSeconds, canonicalDuration] }, 100] },
              2
            ]
          }
        ]
      }
    ]
  };
  const isCompleted = {
    $or: [
      { $ifNull: ['$completed', false] },
      { $gte: [nextPercent, 90] }
    ]
  };

  return LectureProgress.findOneAndUpdate(
    { student, lectureId: lecture },
    [
      {
        $set: {
          student: { $ifNull: ['$student', student] },
          course: { $ifNull: ['$course', course] },
          lectureId: { $ifNull: ['$lectureId', lecture] },
          watchedSeconds: nextSeconds,
          watchedPercent: nextPercent,
          durationSeconds: canonicalDuration,
          completed: isCompleted,
          completedAt: {
            $cond: [
              isCompleted,
              { $ifNull: ['$completedAt', now] },
              null
            ]
          },
          lastWatchedAt: now
        }
      }
    ],
    { new: true, upsert: true }
  );
}

async function recordProgress(values) {
  try {
    return await atomicProgressUpdate(values);
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    const student = objectId(values.studentId, 'studentId');
    const lecture = objectId(values.lectureId, 'lectureId');
    await LectureProgress.findOne({ student, lectureId: lecture }).lean();
    return atomicProgressUpdate(values);
  }
}

function atomicCompletionUpdate({ studentId, courseId, lectureId, durationSeconds = 0 }) {
  const student = objectId(studentId, 'studentId');
  const course = objectId(courseId, 'courseId');
  const lecture = objectId(lectureId, 'lectureId');
  const duration = nonNegativeNumber(durationSeconds, 'durationSeconds');
  const now = new Date();
  const storedSeconds = { $ifNull: ['$watchedSeconds', 0] };
  const canonicalDuration = {
    $cond: [
      { $gt: [{ $ifNull: ['$durationSeconds', 0] }, 0] },
      '$durationSeconds',
      duration
    ]
  };

  return LectureProgress.findOneAndUpdate(
    { student, lectureId: lecture },
    [
      {
        $set: {
          student: { $ifNull: ['$student', student] },
          course: { $ifNull: ['$course', course] },
          lectureId: { $ifNull: ['$lectureId', lecture] },
          watchedSeconds: { $max: [storedSeconds, canonicalDuration] },
          watchedPercent: 100,
          durationSeconds: canonicalDuration,
          completed: true,
          completedAt: { $ifNull: ['$completedAt', now] },
          lastWatchedAt: now
        }
      }
    ],
    { new: true, upsert: true }
  );
}

async function completeLecture(values) {
  try {
    return await atomicCompletionUpdate(values);
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    const student = objectId(values.studentId, 'studentId');
    const lecture = objectId(values.lectureId, 'lectureId');
    await LectureProgress.findOne({ student, lectureId: lecture }).lean();
    return atomicCompletionUpdate(values);
  }
}

function timeValue(value) {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

async function getMyLearning(studentId) {
  const enrollments = await Enrollment.find({ student: studentId, status: 'ACTIVE' })
    .populate({
      path: 'course',
      select: 'title category thumbnail accessType price lectures',
      match: { status: 'PUBLISHED' }
    })
    .lean();
  const liveEnrollments = enrollments.filter((enrollment) => enrollment.course);
  const courseIds = liveEnrollments.map((enrollment) => enrollment.course._id);
  const progressRows = courseIds.length === 0
    ? []
    : await LectureProgress.find({ student: studentId, course: { $in: courseIds } }).lean();
  const progressByCourse = new Map();

  for (const row of progressRows) {
    const courseId = String(row.course);
    const rows = progressByCourse.get(courseId) || [];
    rows.push(row);
    progressByCourse.set(courseId, rows);
  }

  const learning = liveEnrollments.map((enrollment) => {
    const { course } = enrollment;
    const lectureIds = new Set(course.lectures.map((lecture) => String(lecture._id)));
    const lecturesById = new Map(course.lectures.map((lecture) => [String(lecture._id), lecture]));
    const currentRows = (progressByCourse.get(String(course._id)) || [])
      .filter((row) => lectureIds.has(String(row.lectureId)));
    const progressByLecture = new Map(currentRows.map((row) => [String(row.lectureId), row]));
    const totalLectures = course.lectures.length;
    const completedLectures = course.lectures.filter((lecture) => progressByLecture.get(String(lecture._id))?.completed).length;
    const lastWatchedRow = currentRows.reduce((latest, row) => {
      const rowTime = timeValue(row.lastWatchedAt);
      return rowTime !== null && (latest === null || rowTime > timeValue(latest.lastWatchedAt)) ? row : latest;
    }, null);
    const lastWatchedAt = lastWatchedRow ? lastWatchedRow.lastWatchedAt : null;
    const lastWatchedLecture = lastWatchedRow
      ? {
        id: String(lastWatchedRow.lectureId),
        title: lecturesById.get(String(lastWatchedRow.lectureId)).title,
        watchedSeconds: lastWatchedRow.watchedSeconds,
        watchedPercent: lastWatchedRow.watchedPercent,
        durationSeconds: lastWatchedRow.durationSeconds,
        completed: lastWatchedRow.completed,
        completedAt: lastWatchedRow.completedAt,
        lastWatchedAt
      }
      : null;

    return {
      course: {
        id: String(course._id),
        title: course.title,
        category: course.category,
        thumbnail: { secure_url: course.thumbnail?.secure_url || null },
        accessType: course.accessType,
        price: course.price
      },
      totalLectures,
      completedLectures,
      completionPercent: totalLectures === 0 ? 0 : Math.round((completedLectures / totalLectures) * 100),
      lastWatchedAt,
      lastWatchedLecture,
      enrolledAt: enrollment.enrolledAt
    };
  });

  learning.sort((left, right) => {
    const leftActivity = timeValue(left.lastWatchedAt);
    const rightActivity = timeValue(right.lastWatchedAt);
    if (leftActivity !== null || rightActivity !== null) {
      if (leftActivity === null) return 1;
      if (rightActivity === null) return -1;
      if (leftActivity !== rightActivity) return rightActivity - leftActivity;
    }

    const leftEnrollment = timeValue(left.enrolledAt) || 0;
    const rightEnrollment = timeValue(right.enrolledAt) || 0;
    if (leftEnrollment !== rightEnrollment) return rightEnrollment - leftEnrollment;
    return left.course.id.localeCompare(right.course.id);
  });

  return learning.map(({ enrolledAt, ...item }) => item);
}

module.exports = { percentFor, recordProgress, completeLecture, getMyLearning };
