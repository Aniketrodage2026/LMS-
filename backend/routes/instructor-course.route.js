const express = require('express');
const mongoose = require('mongoose');
const Course = require('../models/course.schema');
const AppError = require('../utils/appError');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const upload = require('../middleware/multer.middleware');
const { canManageCourse } = require('../services/course-access.service');
const {
  createCourse,
  updateCourse,
  deleteCourse,
  addLectureToCourseById,
  deleteLectureFromCourse
} = require('../controller/course.controller');
const instructorQuizRouter = require('./instructor-quiz.route');
const instructorAssignmentRouter = require('./instructor-assignment.route');

const router = express.Router();

async function requireCourseManager(req, res, next) {
  try {
    const { courseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return next(new AppError('Invalid courseId format', 400));
    }

    const course = await Course.findById(courseId);
    if (!course) return next(new AppError('Course not found', 404));
    if (!await canManageCourse(req.user, course)) {
      return next(new AppError('You do not have access to manage this course', 403));
    }

    req.course = course;
    return next();
  } catch (error) {
    return next(new AppError(error.message, 500));
  }
}

router.post('/', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), upload.thumbnail.single('thumbnail'), createCourse);
router.use('/:courseId/quizzes', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, instructorQuizRouter);
router.use('/:courseId/assignments', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, instructorAssignmentRouter);
router.patch('/:courseId', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, upload.thumbnail.single('thumbnail'), updateCourse);
router.post('/:courseId/lectures', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, upload.video.single('video'), addLectureToCourseById);
router.delete('/:courseId/lectures/:lectureId', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, deleteLectureFromCourse);
router.delete('/:courseId', isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager, deleteCourse);

module.exports = router;
module.exports.requireCourseManager = requireCourseManager;
