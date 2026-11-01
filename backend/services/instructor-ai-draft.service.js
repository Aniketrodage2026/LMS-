const mongoose = require('mongoose');
const Course = require('../models/course.schema');
const User = require('../models/user.schema');
const Material = require('../models/course-material.schema');
const Chunk = require('../models/course-material-chunk.schema');
const Budget = require('../models/instructor-ai-draft-budget.schema');
const AppError = require('../utils/appError');
const { createGeminiRagProvider, redactProviderText, ProviderError } = require('./ai/providers/gemini.provider');

const kinds = new Set(['OUTLINE', 'PRACTICE_PROMPTS', 'ASSIGNMENT_RUBRIC']);
const settings = (config) => ({
  dailyLimit: boundedInteger(config.AI_INSTRUCTOR_DRAFT_DAILY_LIMIT, 5, 1, 100),
  maxOutputTokens: boundedInteger(config.AI_INSTRUCTOR_DRAFT_MAX_OUTPUT_TOKENS, 1000, 1, 1000),
  timeoutMs: boundedInteger(config.AI_INSTRUCTOR_DRAFT_TIMEOUT_MS, 20000, 1000, 30000)
});
const boundedInteger = (value, fallback, min, max) => {
  const candidate = value === undefined ? fallback : value;
  if (!(typeof candidate === 'number' || (typeof candidate === 'string' && /^\d+$/.test(candidate)))
    || !Number.isSafeInteger(Number(candidate)) || Number(candidate) < min || Number(candidate) > max) {
    throw new AppError('Instructor draft generation is not configured correctly.', 503, 'AI_DRAFT_UNAVAILABLE');
  }
  return Number(candidate);
};
const invalid = () => new AppError('Choose a valid draft type and provide a focus of 1 to 300 characters.', 400, 'AI_DRAFT_INVALID');
const denied = () => new AppError('Only the instructor who manages this course can generate drafts.', 403, 'AUTH_ROLE_FORBIDDEN');
const unavailable = () => new AppError('Draft generation is temporarily unavailable. Please try again later.', 503, 'AI_DRAFT_UNAVAILABLE');

function clean(value, maxLength, key) {
  let result = redactProviderText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  if (key) result = result.split(key).join('[redacted]');
  return result;
}

function parseDraft(raw, sources, kind, key) {
  let result;
  try {
    if (typeof raw !== 'string' || raw.length > 12000) throw new Error();
    result = JSON.parse(raw);
  } catch {
    throw new ProviderError('INVALID_OUTPUT');
  }
  if (!result || Array.isArray(result) || typeof result !== 'object'
    || Object.keys(result).sort().join(',') !== 'items,title'
    || typeof result.title !== 'string' || !result.title.trim() || result.title.length > 120
    || clean(result.title, 120, key) !== result.title || /<\/?[a-z!]|\\u0000/i.test(result.title)
    || !Array.isArray(result.items) || result.items.length < 3 || result.items.length > 8) {
    throw new ProviderError('INVALID_OUTPUT');
  }
  const items = result.items.map((item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object'
      || Object.keys(item).sort().join(',') !== 'citations,content,heading'
      || typeof item.heading !== 'string' || !item.heading.trim() || item.heading.length > 120
      || clean(item.heading, 120, key) !== item.heading || /<\/?[a-z!]|\\u0000/i.test(item.heading)
      || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 600
      || clean(item.content, 600, key) !== item.content || /<\/?[a-z!]|\\u0000/i.test(item.content)
      || !Array.isArray(item.citations) || item.citations.length > 3
      || (sources.length > 0 && item.citations.length === 0)) throw new ProviderError('INVALID_OUTPUT');
    const seen = new Set();
    const citations = item.citations.map((citation) => {
      if (!citation || Array.isArray(citation) || Object.keys(citation).sort().join(',')
        !== 'pageEnd,pageStart,sourceId' || typeof citation.sourceId !== 'string' || seen.has(citation.sourceId)) {
        throw new ProviderError('INVALID_OUTPUT');
      }
      const source = sources.find((entry) => entry.sourceId === citation.sourceId);
      if (!source || citation.pageStart !== source.pageStart || citation.pageEnd !== source.pageEnd) {
        throw new ProviderError('INVALID_OUTPUT');
      }
      seen.add(citation.sourceId);
      return { materialId: String(source.material._id), title: source.title,
        pageStart: source.pageStart, pageEnd: source.pageEnd };
    });
    return { heading: item.heading.trim(), content: item.content.trim(), citations };
  });
  return { kind, title: result.title.trim(), items };
}

async function reserveBudget(instructor, now, limit) {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await Budget.init();
  try {
    await Budget.findOneAndUpdate({ instructor, dayStart },
      { $setOnInsert: { instructor, dayStart, expiresAt: new Date(dayStart.getTime() + 32 * 86400000), used: 0 } },
      { upsert: true, setDefaultsOnInsert: false });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const reservation = await Budget.findOneAndUpdate({ instructor, dayStart, used: { $lt: limit } },
    { $inc: { used: 1 } }, { new: true });
  if (!reservation) throw new AppError('You have reached the daily instructor draft limit. Try again tomorrow.', 429, 'AI_DRAFT_LIMIT_REACHED');
}

function courseContext(course, key) {
  return {
    title: clean(course.title, 50, key),
    description: clean(course.description, 600, key),
    category: clean(course.category, 80, key),
    level: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'].includes(course.learningMetadata?.level)
      ? course.learningMetadata.level : null,
    skills: (course.learningMetadata?.skills ?? []).slice(0, 10).map((tag) => clean(tag, 80, key)).filter(Boolean),
    prerequisiteSkills: (course.learningMetadata?.prerequisites?.skills ?? []).slice(0, 10)
      .map((tag) => clean(tag, 80, key)).filter(Boolean),
    lectureTitles: (course.lectures ?? []).slice(0, 20).map((lecture) => clean(lecture.title, 100, key)).filter(Boolean)
  };
}

async function publishedSources(courseId, key) {
  const materials = await Material.find({ course: courseId, status: 'PUBLISHED' })
    .select('_id title pageCount updatedAt').sort({ createdAt: -1 }).limit(50).lean();
  if (!materials.length) return [];
  const byMaterial = new Map(materials.map((material) => [String(material._id), material]));
  const chunks = await Chunk.find({ course: courseId, material: { $in: materials.map((material) => material._id) } })
    .select('_id material course pageStart pageEnd ordinal text').sort({ material: 1, ordinal: 1 }).limit(5).lean();
  return chunks.flatMap((chunk) => {
    const material = byMaterial.get(String(chunk.material));
    if (!material || !chunk.course.equals(courseId) || !Number.isSafeInteger(chunk.pageStart)
      || !Number.isSafeInteger(chunk.pageEnd) || chunk.pageStart < 1 || chunk.pageEnd < chunk.pageStart
      || chunk.pageEnd > material.pageCount || typeof chunk.text !== 'string') return [];
    const text = clean(chunk.text, 2000, key);
    if (!text) return [];
    return [{ material, title: clean(material.title, 120, key),
      pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, chunkId: chunk._id, text }];
  }).map((source, index) => ({ ...source, sourceId: `S${index + 1}` }));
}

async function recheckAccess(instructorId, courseId, courseUpdatedAt, sources) {
  const [user, course] = await Promise.all([
    User.findById(instructorId).select('role').lean(),
    Course.findOne({ _id: courseId, instructor: instructorId }).select('updatedAt').lean()
  ]);
  if (user?.role !== 'INSTRUCTOR' || !course) throw denied();
  if (String(course.updatedAt?.getTime()) !== String(courseUpdatedAt?.getTime())) {
    throw new AppError('Course details changed during generation. Please try again.', 409, 'AI_DRAFT_STALE');
  }
  if (!sources.length) return;
  const [materials, chunks] = await Promise.all([
    Material.find({ _id: { $in: sources.map((source) => source.material._id) }, course: courseId, status: 'PUBLISHED' })
      .select('_id updatedAt').lean(),
    Chunk.find({ _id: { $in: sources.map((source) => source.chunkId) }, course: courseId })
      .select('_id material').lean()
  ]);
  const currentMaterials = new Map(materials.map((material) => [String(material._id), material]));
  const currentChunks = new Map(chunks.map((chunk) => [String(chunk._id), chunk]));
  if (sources.some((source) => {
    const currentMaterial = currentMaterials.get(String(source.material._id));
    const currentChunk = currentChunks.get(String(source.chunkId));
    return !currentMaterial || !currentChunk || !currentChunk.material.equals(source.material._id)
      || String(currentMaterial.updatedAt?.getTime()) !== String(source.material.updatedAt?.getTime());
  })) throw new AppError('Published course materials changed during generation. Please try again.', 409, 'AI_DRAFT_STALE');
}

function createInstructorAiDraftService({ config = process.env, generateDraft, now = () => new Date() } = {}) {
  const limits = settings(config);
  const generator = generateDraft || ((input) => createGeminiRagProvider(config).generateInstructorDraft(input));
  return {
    async generate({ instructorId, courseId, course, kind, focus }) {
      if (!mongoose.isObjectIdOrHexString(instructorId) || !mongoose.isObjectIdOrHexString(courseId)
        || !kinds.has(kind) || typeof focus !== 'string' || !focus.trim() || focus.trim().length > 300) throw invalid();
      const [user, currentCourse] = await Promise.all([
        User.findById(instructorId).select('role').lean(),
        Course.findOne({ _id: courseId, instructor: instructorId })
      ]);
      if (user?.role !== 'INSTRUCTOR' || !currentCourse
        || !course?._id?.equals(currentCourse._id)) throw denied();
      const safeFocus = clean(focus, 300, config.GEMINI_API_KEY);
      if (!safeFocus) throw invalid();
      const sources = await publishedSources(currentCourse._id, config.GEMINI_API_KEY);
      await reserveBudget(currentCourse.instructor, now(), limits.dailyLimit);
      let generated;
      try {
        generated = await generator({
          kind,
          focus: safeFocus,
          course: courseContext(currentCourse, config.GEMINI_API_KEY),
          sources: sources.map(({ sourceId, title, pageStart, pageEnd, text }) =>
            ({ sourceId, title, pageStart, pageEnd, text })),
          maxOutputTokens: limits.maxOutputTokens,
          timeoutMs: limits.timeoutMs
        });
      } catch (error) {
        if (error instanceof ProviderError) throw unavailable();
        throw error;
      }
      let draft;
      try {
        draft = parseDraft(generated?.text, sources, kind, config.GEMINI_API_KEY);
      } catch (error) {
        if (error instanceof ProviderError) throw unavailable();
        throw error;
      }
      await recheckAccess(instructorId, currentCourse._id, currentCourse.updatedAt, sources);
      return { draft, sourceMode: sources.length ? 'PUBLISHED_MATERIALS' : 'COURSE_METADATA_ONLY' };
    }
  };
}

module.exports = { createInstructorAiDraftService, parseDraft, publishedSources };
