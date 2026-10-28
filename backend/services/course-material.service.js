const mongoose = require('mongoose');
const CourseMaterial = require('../models/course-material.schema');
const CourseMaterialChunk = require('../models/course-material-chunk.schema');
const { canManageCourse } = require('./course-access.service');
const AppError = require('../utils/appError');

const failureMessages = Object.freeze({
  INVALID_PDF: 'Choose a valid PDF file and try again.',
  PDF_TOO_LARGE: 'Choose a PDF smaller than 10 MB.',
  TOO_MANY_PAGES: 'Choose a PDF with 100 pages or fewer.',
  ENCRYPTED_PDF: 'Choose a PDF without password protection.',
  NO_READABLE_TEXT: 'This PDF has no readable text. Upload a PDF with selectable text.',
  EXTRACTION_FAILED: 'We could not read this PDF. Check the file and try again.',
  EMBEDDING_FAILED: 'We could not prepare this material for questions. The saved PDF is available for recovery.',
  STORAGE_FAILED: 'We could not save this PDF. Try again shortly.',
  PROCESSING_FAILED: 'We could not finish preparing this material. Check its status before trying again.'
});

function instructorMaterialDto(material, chunkCount = 0) {
  const failureCode = Object.hasOwn(failureMessages, material.failureCode) ? material.failureCode : null;
  return {
    id: String(material._id), courseId: String(material.course), lectureId: material.lecture ? String(material.lecture) : null,
    title: material.title, originalFilename: material.originalFilename, size: material.size, status: material.status,
    pageCount: material.pageCount, chunkCount, failureCode, failureMessage: failureCode ? failureMessages[failureCode] : null,
    createdAt: material.createdAt, updatedAt: material.updatedAt
  };
}

async function requireManagedMaterial({ user, course, materialId }) {
  if (!['INSTRUCTOR', 'ADMIN'].includes(user?.role) || !await canManageCourse(user, course)) {
    throw new AppError('Your account does not have permission to manage this course.', 403, 'AUTH_ROLE_FORBIDDEN');
  }
  if (typeof materialId !== 'string' || !mongoose.Types.ObjectId.isValid(materialId)) {
    throw new AppError('Choose a valid course material.', 400, 'MATERIAL_INVALID_REQUEST');
  }
  const material = await CourseMaterial.findOne({ _id: materialId, course: course._id });
  if (!material) throw new AppError('Course material not found.', 404, 'MATERIAL_NOT_FOUND');
  return material;
}

async function materialDtoWithCount(material) {
  const chunkCount = await CourseMaterialChunk.countDocuments({ material: material._id, course: material.course });
  return instructorMaterialDto(material, chunkCount);
}

async function listManagedMaterials(course) {
  // Explicit projection prevents source storage or provider data from being used in list responses.
  const materials = await CourseMaterial.find({ course: course._id })
    .select('course lecture title originalFilename size status pageCount failureCode createdAt updatedAt').sort({ createdAt: -1, _id: -1 }).lean();
  const counts = await CourseMaterialChunk.aggregate([
    { $match: { course: course._id } }, { $group: { _id: '$material', count: { $sum: 1 } } }
  ]);
  const byMaterial = new Map(counts.map(entry => [String(entry._id), entry.count]));
  return materials.map(material => instructorMaterialDto(material, byMaterial.get(String(material._id)) || 0));
}

module.exports = { instructorMaterialDto, requireManagedMaterial, materialDtoWithCount, listManagedMaterials, failureMessages };
