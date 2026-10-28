const mongoose = require('mongoose');
const fs = require('node:fs/promises');
const AppError = require('../utils/appError');
const { ingestMaterial } = require('../services/pdf-material.service');
const { recordAuditSafely } = require('../services/audit-log.service');
const { requireManagedMaterial, materialDtoWithCount, listManagedMaterials, failureMessages } = require('../services/course-material.service');

function requestError(message) { return new AppError(message, 400, 'MATERIAL_INVALID_REQUEST'); }
function safeError(error) {
  if (error instanceof AppError) return error;
  if (error?.name === 'VersionError') return new AppError('This material changed while you were updating it. Refresh and try again.', 409, 'MATERIAL_CONFLICT');
  return new AppError('We could not complete this material request. Try again shortly.', 500, 'SYSTEM_UNEXPECTED');
}
async function removeLocal(path) {
  if (!path) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await fs.unlink(path); return; }
    catch (error) { if (error.code === 'ENOENT') return; }
  }
  throw new AppError('We could not finish processing this upload. Check the material list before trying again.', 500, 'SYSTEM_UNEXPECTED');
}
function validateUpload(req) {
  const body = req.body || {};
  if (Object.keys(body).some(key => !['title', 'lectureId'].includes(key))) throw requestError('Provide only a title and optional lecture for this PDF.');
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120 || /[\x00-\x1f\x7f]/.test(body.title)) {
    throw requestError('Enter a material title between 1 and 120 characters.');
  }
  let lectureId = null;
  if (body.lectureId !== undefined && body.lectureId !== '') {
    if (typeof body.lectureId !== 'string' || !mongoose.Types.ObjectId.isValid(body.lectureId)
      || !req.course.lectures.some(lecture => lecture._id.equals(body.lectureId))) {
      throw requestError('Choose a lecture from this course.');
    }
    lectureId = body.lectureId;
  }
  if (!req.file) throw requestError('Choose a PDF to upload.');
  return { title: body.title.trim(), lectureId };
}
function audit(req, action, id) {
  return recordAuditSafely({ actor: req.user._id, action, target: { type: 'MATERIAL', id }, requestId: req.requestId });
}

function createCourseMaterialController({ ingest = ingestMaterial } = {}) {
  async function uploadMaterial(req, res, next) {
    try {
      let result;
      try {
        const { title, lectureId } = validateUpload(req);
        result = await ingest({ courseId: req.course._id, localPath: req.file.path, originalName: req.file.originalname,
          title, lectureId, uploadedBy: req.user._id });
      } finally { await removeLocal(req.file?.path); }
      const material = result?.materialId ? await requireManagedMaterial({ user: req.user, course: req.course, materialId: result.materialId }) : null;
      if (result?.status !== 'READY' || !material || material.status !== 'READY') {
        const failureCode = Object.hasOwn(failureMessages, result?.failureCode) ? result.failureCode : 'PROCESSING_FAILED';
        const status = ['INVALID_PDF', 'PDF_TOO_LARGE', 'TOO_MANY_PAGES', 'ENCRYPTED_PDF', 'NO_READABLE_TEXT', 'EXTRACTION_FAILED'].includes(failureCode) ? 422 : 502;
        const message = failureMessages[failureCode];
        return res.status(status).json({ success: false, message, error: { code: `MATERIAL_${failureCode}`, message },
          ...(material ? { material: await materialDtoWithCount(material) } : {}) });
      }
      await audit(req, 'MATERIAL_UPLOADED', material._id);
      return res.status(201).json({ success: true, material: await materialDtoWithCount(material) });
    } catch (error) { return next(safeError(error)); }
  }
  async function listMaterials(req, res, next) {
    try { return res.json({ success: true, materials: await listManagedMaterials(req.course) }); }
    catch (error) { return next(safeError(error)); }
  }
  async function updateMaterialStatus(req, res, next) {
    try {
      if (Object.keys(req.body || {}).length !== 1 || !['READY', 'PUBLISHED'].includes(req.body?.status)) {
        throw requestError('Choose publish or unpublish for this material.');
      }
      const material = await requireManagedMaterial({ user: req.user, course: req.course, materialId: req.params.materialId });
      const desired = req.body.status;
      if (!((material.status === 'READY' && desired === 'PUBLISHED') || (material.status === 'PUBLISHED' && desired === 'READY'))) {
        throw new AppError(desired === 'PUBLISHED' ? 'Only a ready material can be published.' : 'Only a published material can be unpublished.', 409, 'MATERIAL_INVALID_TRANSITION');
      }
      material.status = desired;
      await material.save();
      await audit(req, desired === 'PUBLISHED' ? 'MATERIAL_PUBLISHED' : 'MATERIAL_UNPUBLISHED', material._id);
      return res.json({ success: true, material: await materialDtoWithCount(material) });
    } catch (error) { return next(safeError(error)); }
  }
  return { uploadMaterial, listMaterials, updateMaterialStatus };
}

module.exports = { createCourseMaterialController };
