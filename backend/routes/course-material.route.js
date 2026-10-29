const express = require('express');
const { isLoggedIn, requireRole } = require('../middleware/auth.middleware');
const { requireCourseManager } = require('./instructor-course.route');
const upload = require('../middleware/multer.middleware');
const { createCourseMaterialController } = require('../controller/course-material.controller');

function createCourseMaterialRouter(options = {}) {
  const router = express.Router({ mergeParams: true });
  const controller = createCourseMaterialController(options);
  router.use(isLoggedIn, requireRole('INSTRUCTOR', 'ADMIN'), requireCourseManager);
  router.get('/', controller.listMaterials);
  router.post('/', upload.material.single('file'), controller.uploadMaterial);
  router.patch('/:materialId/status', controller.updateMaterialStatus);
  router.post('/:materialId/retry', controller.retryMaterial);
  router.delete('/:materialId', controller.deleteMaterial);
  return router;
}

module.exports = { createCourseMaterialRouter };
