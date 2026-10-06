const Enrollment = require('../models/enrollment.schema');

async function canManageCourse(user, course) {
  if (!user || !course) return false;
  if (user.role === 'ADMIN') return true;
  return Boolean(course.instructor && typeof course.instructor.equals === 'function'
    && course.instructor.equals(user._id));
}

async function canLearnCourse(user, course) {
  if (!user) return false;
  if (await canManageCourse(user, course)) return true;
  return Enrollment.exists({ student: user._id, course: course._id, status: 'ACTIVE' });
}

function getPreviewLecture(course) {
  return course.lectures.find((lecture) => lecture.isPreview) || course.lectures[0] || null;
}

module.exports = { canManageCourse, canLearnCourse, getPreviewLecture };
