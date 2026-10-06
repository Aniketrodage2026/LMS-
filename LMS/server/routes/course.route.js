const express = require('express');
const {
  getAllCourses,
  getCourseById,
  getPreviewLectureByCourseId,
  getLectureByCourseId,
  enrollInFreeCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  addLectureToCourseById,
  deleteLectureFromCourse
} = require('../controller/course.controller');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const upload = require('../middleware/multer.middleware');
const { requireCourseManager } = require('./instructor-course.route');
const {
  recordLectureProgress,
  completeLecture,
  getCourseProgress
} = require('../controller/learning-progress.controller');

const router = express.Router();

router.route('/')
  .get(getAllCourses)
  .post(isLoggedIn, requireRole('ADMIN', 'INSTRUCTOR'), upload.thumbnail.single('thumbnail'), createCourse);

router.get('/:courseId/preview', getPreviewLectureByCourseId);
router.get('/:courseId/lectures/:lectureId', isLoggedIn, getLectureByCourseId);
router.post('/:courseId/enroll', isLoggedIn, requireRole('STUDENT'), enrollInFreeCourse);
router.patch('/:courseId/lectures/:lectureId/progress', isLoggedIn, requireRole('STUDENT'), recordLectureProgress);
router.post('/:courseId/lectures/:lectureId/complete', isLoggedIn, requireRole('STUDENT'), completeLecture);
router.get('/:courseId/progress', isLoggedIn, requireRole('STUDENT'), getCourseProgress);

router.route('/:courseId')
  .get(getCourseById)
  .put(isLoggedIn, requireRole('ADMIN', 'INSTRUCTOR'), requireCourseManager, upload.thumbnail.single('thumbnail'), updateCourse)
  .delete(isLoggedIn, requireRole('ADMIN', 'INSTRUCTOR'), requireCourseManager, deleteCourse)
  .post(isLoggedIn, requireRole('ADMIN', 'INSTRUCTOR'), requireCourseManager, upload.video.single('lecture'), addLectureToCourseById);

router.delete('/:courseId/lectures/:lectureId', isLoggedIn, requireRole('ADMIN', 'INSTRUCTOR'), requireCourseManager, deleteLectureFromCourse);

module.exports = router;
