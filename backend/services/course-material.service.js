const mongoose = require('mongoose');
const CourseMaterial = require('../models/course-material.schema');
const CourseMaterialChunk = require('../models/course-material-chunk.schema');
const { canManageCourse } = require('./course-access.service');
const AppError = require('../utils/appError');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeMediaStorageFactory } = require('./runtime-media-storage.service');
const { createPdfMaterialService } = require('./pdf-material.service');

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

async function cleanup(operation) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await operation(); return true; } catch { /* Expose only a fixed cleanup failure. */ }
  }
  return false;
}

function createMaterialLifecycleService({ storage, parsePdf, embedDocument } = {}) {
  const runtime = createRuntimeMediaStorageFactory();
  function privateStorage() {
    if (!storage && process.env.R2_ENABLED !== 'true') throw new Error('Private storage unavailable');
    return storage || runtime.get();
  }
  async function retryMaterial(material) {
    if (material.status !== 'FAILED') throw new AppError('Only a failed material can be retried.', 409, 'MATERIAL_INVALID_TRANSITION');
    // This validated save also claims the version so concurrent manager requests cannot both start.
    material.status = 'PROCESSING'; material.failureCode = null;
    await material.save();
    let directory;
    try {
      await CourseMaterialChunk.deleteMany({ material: material._id });
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lms-material-retry-'));
      const localPath = path.join(directory, 'source.pdf');
      await privateStorage().readToFile(material, { localPath, maxBytes: 10485760 });
      return await createPdfMaterialService({ parsePdf, embedDocument }).reprocessMaterial({ material,
        file: { path: localPath, originalname: material.originalFilename, mimetype: 'application/pdf', size: material.size } });
    } catch {
      await cleanup(() => CourseMaterialChunk.deleteMany({ material: material._id }));
      if (material.status === 'PROCESSING') {
        material.status = 'FAILED'; material.failureCode = 'STORAGE_FAILED';
        await cleanup(() => material.save());
      }
      return { status: 'FAILED', materialId: String(material._id), failureCode: material.failureCode || 'PROCESSING_FAILED' };
    } finally {
      if (directory && !await cleanup(() => fs.rm(directory, { recursive: true, force: true }))) {
        throw new AppError('We could not finish processing this material. Check its status before trying again.', 500, 'SYSTEM_UNEXPECTED');
      }
    }
  }
  async function deleteMaterial(material) {
    if (material.status === 'PROCESSING') throw new AppError('This material is still processing. Refresh its status before deleting it.', 409, 'MATERIAL_INVALID_TRANSITION');
    if (material.status === 'PUBLISHED') { material.status = 'READY'; await material.save(); }
    material.status = 'PROCESSING'; material.failureCode = null;
    await material.save();
    try {
      if (!await cleanup(() => CourseMaterialChunk.deleteMany({ material: material._id }))) throw new Error('Chunk cleanup failed');
      if (!await cleanup(() => privateStorage().remove(material))) throw new Error('Source cleanup failed');
      if (!await cleanup(() => CourseMaterial.deleteOne({ _id: material._id, __v: material.__v }))) throw new Error('Record cleanup failed');
    } catch {
      material.status = 'FAILED'; material.failureCode = 'STORAGE_FAILED';
      await cleanup(() => material.save());
      throw new AppError('We could not remove this material completely. It is unpublished; try deleting it again shortly.', 502, 'MATERIAL_STORAGE_FAILED');
    }
  }
  return { retryMaterial, deleteMaterial };
}

async function cleanupDeletedCourseMaterials(courseId, storage) {
  const materials = await CourseMaterial.find({ course: courseId }).lean();
  let failed = false;
  for (const material of materials) {
    if (!await cleanup(() => storage.remove(material))) failed = true;
  }
  // The deleted course is the authorization boundary: retain no searchable orphan rows.
  const results = await Promise.all([
    cleanup(() => CourseMaterialChunk.deleteMany({ course: courseId })),
    cleanup(() => CourseMaterial.deleteMany({ course: courseId }))
  ]);
  if (failed || results.some(result => !result)) throw new Error('Course material cleanup failed');
}

module.exports = { instructorMaterialDto, requireManagedMaterial, materialDtoWithCount, listManagedMaterials, failureMessages,
  createMaterialLifecycleService, cleanupDeletedCourseMaterials };
