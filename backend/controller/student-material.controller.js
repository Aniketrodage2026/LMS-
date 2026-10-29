const mongoose = require('mongoose');
const Material = require('../models/course-material.schema');
const AppError = require('../utils/appError');
const { requireStudentMaterialAccess, scopedMaterials, cleanText } = require('../services/course-tutor.service');
const { createRuntimeMediaStorageFactory } = require('../services/runtime-media-storage.service');

const invalid = () => new AppError('Choose a valid course material.', 400, 'MATERIAL_INVALID_REQUEST');
const missing = () => new AppError('This course material is not available.', 404, 'MATERIAL_NOT_FOUND');
function safeError(error) {
  const safe = error instanceof AppError ? error
    : new AppError('We could not open the course materials. Try again shortly.', 503, 'MATERIAL_UNAVAILABLE');
  safe.stack = undefined;
  return safe;
}

function createStudentMaterialController({ storage } = {}) {
  // Material download grants last at most two minutes, independently of video TTL.
  const runtime = createRuntimeMediaStorageFactory({ env: { ...process.env, R2_SIGNED_URL_TTL_SECONDS: '120' } });
  return {
    async list(req, res, next) {
      try {
        if (Object.keys(req.query).length) throw invalid();
        const access = await requireStudentMaterialAccess(req.user._id, req.params.courseId);
        const materials = await Material.find(scopedMaterials(access)).select('_id title lecture pageCount').sort({ createdAt: 1, _id: 1 }).lean();
        return res.set('Cache-Control', 'no-store').json({ success: true, materials: materials.map(material => ({
          id: String(material._id), title: cleanText(material.title), lectureId: material.lecture ? String(material.lecture) : null,
          pageCount: material.pageCount, downloadEndpoint: `/api/v1/courses/${access.course._id}/materials/${material._id}/download`
        })) });
      } catch (error) { return next(safeError(error)); }
    },
    async download(req, res, next) {
      try {
        if (Object.keys(req.query).length || !mongoose.isObjectIdOrHexString(req.params.materialId)) throw invalid();
        const access = await requireStudentMaterialAccess(req.user._id, req.params.courseId);
        const material = await Material.findOne({ ...scopedMaterials(access), _id: req.params.materialId });
        if (!material) throw missing();
        if (material.storage?.provider !== 'R2' || material.storage.contentType !== 'application/pdf'
          || !/^materials\/[a-zA-Z0-9/_-]+\.pdf$/.test(material.storage.key)) throw missing();
        const url = await (storage || runtime.get()).signedReadUrl(material);
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw missing();
        // Recheck after a slow signing adapter before issuing a new capability.
        await requireStudentMaterialAccess(req.user._id, req.params.courseId);
        if (!await Material.exists({ ...scopedMaterials(access), _id: material._id })) throw missing();
        return res.status(302).set({ Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
      } catch (error) { return next(safeError(error)); }
    }
  };
}
function studentMaterialErrorHandler(error, req, res, next) { return next(safeError(error)); }
module.exports = { createStudentMaterialController, studentMaterialErrorHandler };
