const mongoose = require('mongoose');
const User = require('../models/user.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const Material = require('../models/course-material.schema');
const Chunk = require('../models/course-material-chunk.schema');
const Budget = require('../models/rag-usage-budget.schema');
const UsageLog = require('../models/rag-usage-log.schema');
const AppError = require('../utils/appError');
const { createRagEmbeddingService, isValidEmbedding, EMBEDDING_MODEL, EMBEDDING_DIMENSION } = require('./rag-embedding.service');
const { createGeminiRagProvider, redactProviderText, ProviderError } = require('./ai/providers/gemini.provider');

const COPY = Object.freeze({
  NO_RELEVANT_SOURCE: 'I could not find enough information in the available course materials to answer this question.',
  RAG_UNAVAILABLE: 'The course tutor is temporarily unavailable. Please try again later or ask your instructor.',
  RAG_LIMIT_REACHED: 'You have reached your daily course tutor limit. Please try again tomorrow.'
});
const MAX_SOURCES = 5;
const MIN_SCORE = 0.7;
const MAX_EXCERPT_CHARS = 2400;
class NoRelevantSource extends Error {}
const materialFields = '_id course lecture title pageCount updatedAt';
const invalid = () => new AppError('Provide a valid course, optional lecture, and a question of 1 to 2000 characters.', 400, 'AI_TUTOR_INVALID');
const denied = () => new AppError('An active published course enrollment is required', 403, 'AI_ENROLLMENT_REQUIRED');
const fallback = outcome => ({ answer: COPY[outcome], citations: [], outcome });
function objectId(value) {
  if (!mongoose.isObjectIdOrHexString(value)) throw invalid();
  return new mongoose.Types.ObjectId(String(value));
}

// Kept independent of route middleware so internal callers cannot grant themselves
// instructor/admin access through the general canLearnCourse manager exception.
async function requireStudentMaterialAccess(studentId, courseId, lectureId) {
  const student = objectId(studentId); const id = objectId(courseId);
  const lecture = lectureId === undefined ? null : objectId(lectureId);
  const user = await User.findById(student).select('role').lean();
  if (user?.role !== 'STUDENT') throw denied();
  const course = await Course.findOne({ _id: id, status: 'PUBLISHED' }).select('_id lectures._id').lean();
  if (!course || !await Enrollment.exists({ student, course: id, status: 'ACTIVE' })) throw denied();
  if (lecture && !course.lectures.some(entry => entry._id.equals(lecture))) throw invalid();
  return { student, course, lecture };
}

function scopedMaterials(access) {
  return { course: access.course._id, status: 'PUBLISHED',
    ...(access.lecture ? { $or: [{ lecture: null }, { lecture: access.lecture }] } : {}) };
}

function cleanText(value, key) {
  let clean = redactProviderText(value).replace(/\bmaterials\/[a-zA-Z0-9/_ .-]+\.pdf\b/gi, '[redacted]');
  if (key) clean = clean.split(key).join('[redacted]');
  return clean;
}

function readRagConfig(config) {
  const integer = (value, defaultValue, min, max) => {
    const chosen = value === undefined ? defaultValue : value;
    if (!/^[0-9]+$/.test(String(chosen)) || !Number.isSafeInteger(Number(chosen)) || Number(chosen) < min || Number(chosen) > max) {
      throw new ProviderError('PROVIDER_UNAVAILABLE');
    }
    return Number(chosen);
  };
  const index = config.ATLAS_VECTOR_INDEX === undefined ? 'course_material_chunks_vector' : config.ATLAS_VECTOR_INDEX;
  if (typeof index !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(index)
    || (config.GEMINI_EMBEDDING_MODEL !== undefined && config.GEMINI_EMBEDDING_MODEL !== EMBEDDING_MODEL)
    || (config.RAG_EMBEDDING_DIMENSION !== undefined && String(config.RAG_EMBEDDING_DIMENSION) !== '768')) {
    throw new ProviderError('PROVIDER_UNAVAILABLE');
  }
  return { index, dailyLimit: integer(config.RAG_DAILY_REQUEST_LIMIT, 10, 1, 100),
    timeoutMs: integer(config.RAG_REQUEST_TIMEOUT_MS, 20000, 1000, 30000) };
}

async function reserveBudget(student, dayKey, limit) {
  await Budget.init();
  try {
    await Budget.findOneAndUpdate({ student, dayKey }, { $max: { used: 0 }, $setOnInsert: { student, dayKey } },
      { upsert: true, setDefaultsOnInsert: false });
  } catch (error) { if (error.code !== 11000) throw error; }
  return Boolean(await Budget.findOneAndUpdate({ student, dayKey, used: { $lt: limit } }, { $inc: { used: 1 } }, { new: true }));
}

function parseAnswer(raw, sources, key) {
  let output;
  try {
    if (typeof raw !== 'string' || raw.length > 8000) throw new Error();
    output = JSON.parse(raw);
  } catch { throw new ProviderError('INVALID_OUTPUT'); }
  if (output && !Array.isArray(output) && Object.keys(output).sort().join(',') === 'answer,citations'
    && output.answer === '' && Array.isArray(output.citations) && output.citations.length === 0) return fallback('NO_RELEVANT_SOURCE');
  if (!output || Array.isArray(output) || Object.keys(output).sort().join(',') !== 'answer,citations'
    || typeof output.answer !== 'string' || !output.answer.trim() || output.answer.length > 4000
    || cleanText(output.answer, key) !== output.answer || /<\/?[a-z!]|\[redacted\]|\u0000/i.test(output.answer)
    || !Array.isArray(output.citations) || !output.citations.length || output.citations.length > 3) throw new ProviderError('INVALID_OUTPUT');
  const seen = new Set();
  const citations = output.citations.map(citation => {
    if (!citation || Array.isArray(citation) || Object.keys(citation).sort().join(',') !== 'pageEnd,pageStart,sourceId'
      || typeof citation.sourceId !== 'string' || seen.has(citation.sourceId)) throw new ProviderError('INVALID_OUTPUT');
    const source = sources.find(entry => entry.sourceId === citation.sourceId);
    if (!source || citation.pageStart !== source.pageStart || citation.pageEnd !== source.pageEnd) throw new ProviderError('INVALID_OUTPUT');
    seen.add(citation.sourceId);
    return { materialId: String(source.material._id), title: cleanText(source.material.title, key),
      pageStart: source.pageStart, pageEnd: source.pageEnd };
  });
  return { answer: output.answer.trim(), citations, outcome: 'ANSWERED' };
}

async function sourcesRemainPublished(access, sources) {
  const published = await Material.find({ ...scopedMaterials(access), _id: { $in: sources.map(source => source.material._id) } }).select(materialFields).lean();
  const current = new Map(published.map(entry => [String(entry._id), entry]));
  return !sources.some(source => !current.has(String(source.material._id))
    || +new Date(current.get(String(source.material._id)).updatedAt) !== +new Date(source.material.updatedAt))
    && await Chunk.countDocuments({ _id: { $in: sources.map(source => source.chunkId) } }) === sources.length;
}

async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError('TIMEOUT')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function createCourseTutorService({ config = process.env, fetchImpl = globalThis.fetch, now = () => new Date(),
  embedQuery, vectorSearch, generate } = {}) {
  return {
    async answerCourseQuestion({ studentId, courseId, lectureId, question } = {}) {
      if (typeof question !== 'string' || question.length > 2000) throw invalid();
      const normalized = question.normalize('NFKC').replace(/[\p{Cf}\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 2000) throw invalid();
      const access = await requireStudentMaterialAccess(studentId, courseId, lectureId);
      const date = now(); const dayKey = date.toISOString().slice(0, 10);
      const log = { student: access.student, course: access.course._id, provider: 'NONE', modelAlias: 'none',
        outcome: 'ERROR', sourceCount: 0, createdAt: date };
      let result = fallback('RAG_UNAVAILABLE'); let accessError; let answerSources = [];
      try {
        const settings = readRagConfig(config);
        let materials = await Material.find(scopedMaterials(access)).select(materialFields).lean();
        if (!materials.length) { result = fallback('NO_RELEVANT_SOURCE'); log.outcome = 'NO_RELEVANT_SOURCE'; }
        else if ((await Budget.findOne({ student: access.student, dayKey }).select('used').lean())?.used >= settings.dailyLimit) {
          result = fallback('RAG_LIMIT_REACHED'); log.outcome = 'QUOTA_EXCEEDED';
        } else {
          log.provider = 'GEMINI'; log.modelAlias = 'gemini';
          const safeQuestion = cleanText(normalized, config.GEMINI_API_KEY);
          const embed = embedQuery || createRagEmbeddingService({ env: config, fetch: fetchImpl }).embedQuery;
          const queryVector = await bounded(() => embed(safeQuestion), settings.timeoutMs);
          if (!isValidEmbedding(queryVector)) throw new ProviderError('INVALID_OUTPUT');
          await requireStudentMaterialAccess(studentId, courseId, lectureId);
          materials = await Material.find(scopedMaterials(access)).select(materialFields).lean();
          if (!materials.length) throw new NoRelevantSource();
          const filter = { course: access.course._id, material: { $in: materials.map(entry => entry._id) },
            embeddingModel: EMBEDDING_MODEL, embeddingDimension: EMBEDDING_DIMENSION };
          // Atlas vector filters do not accept null operands. Material ids retain
          // the course-wide branch while the lecture branch uses an ObjectId.
          if (access.lecture) filter.$or = [{ lecture: access.lecture },
            { material: { $in: materials.filter(entry => !entry.lecture).map(entry => entry._id) } }];
          const pipeline = [
            { $vectorSearch: { index: settings.index, path: 'embedding', queryVector, numCandidates: 100, limit: 5, filter } },
            { $project: { _id: 1, score: { $meta: 'vectorSearchScore' } } }
          ];
          const hits = await bounded(() => vectorSearch ? vectorSearch(pipeline)
            : Chunk.aggregate(pipeline).option({ maxTimeMS: settings.timeoutMs }), settings.timeoutMs);
          await requireStudentMaterialAccess(studentId, courseId, lectureId);
          const freshMaterials = await Material.find(scopedMaterials(access)).select(materialFields).lean();
          const allowed = new Map(freshMaterials.map(entry => [String(entry._id), entry]));
          // Only database records (not index-returned text) are trusted sources.
          const ranked = (Array.isArray(hits) ? hits : []).slice(0, MAX_SOURCES)
            .filter(hit => mongoose.isObjectIdOrHexString(hit?._id) && Number.isFinite(hit.score) && hit.score >= MIN_SCORE && hit.score <= 1);
          const chunks = await Chunk.find({ _id: { $in: ranked.map(hit => hit._id) }, course: access.course._id,
            material: { $in: freshMaterials.map(entry => entry._id) }, embeddingModel: EMBEDDING_MODEL, embeddingDimension: EMBEDDING_DIMENSION,
            ...(access.lecture ? { $or: [{ lecture: null }, { lecture: access.lecture }] } : {}) })
            .select('_id material course lecture pageStart pageEnd text').lean();
          const byId = new Map(chunks.map(chunk => [String(chunk._id), chunk])); const seen = new Set(); const sources = [];
          for (const hit of ranked) {
            const chunk = byId.get(String(hit._id)); const material = chunk && allowed.get(String(chunk.material));
            if (!chunk || !material || seen.has(String(chunk._id)) || String(chunk.lecture ?? '') !== String(material.lecture ?? '')
              || !Number.isSafeInteger(chunk.pageStart) || !Number.isSafeInteger(chunk.pageEnd) || chunk.pageStart < 1
              || chunk.pageEnd < chunk.pageStart || chunk.pageEnd > material.pageCount || typeof chunk.text !== 'string') continue;
            const text = cleanText(chunk.text, config.GEMINI_API_KEY).slice(0, MAX_EXCERPT_CHARS);
            if (!text.trim()) continue;
            seen.add(String(chunk._id));
            sources.push({ sourceId: `S${sources.length + 1}`, text, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
              chunkId: chunk._id, material });
          }
          log.sourceCount = sources.length;
          if (!sources.length) { result = fallback('NO_RELEVANT_SOURCE'); log.outcome = 'NO_RELEVANT_SOURCE'; }
          else if (!await reserveBudget(access.student, dayKey, settings.dailyLimit)) {
            result = fallback('RAG_LIMIT_REACHED'); log.outcome = 'QUOTA_EXCEEDED';
          } else {
            await requireStudentMaterialAccess(studentId, courseId, lectureId);
            if (!await sourcesRemainPublished(access, sources)) throw new NoRelevantSource();
            const generator = generate || createGeminiRagProvider(config, fetchImpl).generate;
            const response = await bounded(() => generator({ question: safeQuestion,
              sources: sources.map(({ sourceId, text, pageStart, pageEnd }) => ({ sourceId, text, pageStart, pageEnd })) }), settings.timeoutMs);
            result = parseAnswer(response?.text, sources, config.GEMINI_API_KEY);
            answerSources = sources;
            await requireStudentMaterialAccess(studentId, courseId, lectureId);
            if (!await sourcesRemainPublished(access, sources)) {
              result = fallback('NO_RELEVANT_SOURCE'); log.outcome = 'NO_RELEVANT_SOURCE';
            } else log.outcome = result.outcome === 'ANSWERED' ? 'SUCCESS' : 'NO_RELEVANT_SOURCE';
            for (const key of ['inputTokens', 'outputTokens']) {
              if (Number.isSafeInteger(response?.usage?.[key]) && response.usage[key] >= 0) log[key] = response.usage[key];
            }
          }
        }
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 403) accessError = error;
        log.outcome = error instanceof NoRelevantSource ? 'NO_RELEVANT_SOURCE'
          : ['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT', 'INVALID_OUTPUT', 'QUOTA_EXCEEDED'].includes(error?.code) ? error.code : 'ERROR';
        result = fallback(error instanceof NoRelevantSource ? 'NO_RELEVANT_SOURCE' : 'RAG_UNAVAILABLE');
      }
      try { await UsageLog.create(log); } catch { result = fallback('RAG_UNAVAILABLE'); }
      if (accessError) throw accessError;
      if (result.outcome === 'ANSWERED') {
        // The durable audit write can outlive enrollment or publication. Keep
        // these checks last so that write cannot release a stale capability.
        try {
          await requireStudentMaterialAccess(studentId, courseId, lectureId);
          if (!await sourcesRemainPublished(access, answerSources)) return fallback('NO_RELEVANT_SOURCE');
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 403) throw error;
          return fallback('RAG_UNAVAILABLE');
        }
      }
      return result;
    }
  };
}

async function answerCourseQuestion(request) { return createCourseTutorService().answerCourseQuestion(request); }
module.exports = { createCourseTutorService, answerCourseQuestion, requireStudentMaterialAccess, scopedMaterials, cleanText };
