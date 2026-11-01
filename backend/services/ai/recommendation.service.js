const Course = require('../../models/course.schema');
const Enrollment = require('../../models/enrollment.schema');
const LectureProgress = require('../../models/lecture-progress.schema');
const LearningProfile = require('../../models/learning-profile.schema');
const { objectId, profileDto, safeText, safeTags, redactSensitiveText } = require('./learning-profile.service');

const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'be', 'become', 'for', 'i', 'in', 'my', 'of', 'on', 'the', 'to', 'want', 'with']);
const normalized = (value) => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : '';
const tags = (values) => [...new Set((values || []).map(normalized).filter(Boolean))];
const keywords = (value) => new Set((normalized(value).match(/[\p{L}\p{N}]+/gu) || []).filter((word) => !STOP_WORDS.has(word)));

function thumbnailUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    let decoded = url.href;
    for (let depth = 0; depth < 5; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    // Reject excessive nesting rather than passing an undecoded secret through.
    if (/[\u0000-\u001f\u007f]/.test(decoded) || /%[a-f0-9]{2}/i.test(decoded) || redactSensitiveText(decoded) !== decoded) return null;
    return url.href;
  } catch {
    return null;
  }
}

function courseCard(course) {
  return {
    id: String(course._id), title: safeText(course.title, 100), description: safeText(course.description),
    category: safeText(course.category, 80), accessType: course.accessType,
    price: course.price, currency: course.currency, thumbnailUrl: thumbnailUrl(course.thumbnail?.secure_url),
    level: LEVELS.includes(course.learningMetadata?.level) ? course.learningMetadata.level : null,
    skills: safeTags(course.learningMetadata?.skills)
  };
}

async function prerequisiteFacts(student, candidates, activeCourseIds) {
  const requiredIds = [...new Set(candidates.flatMap((course) => course.learningMetadata?.prerequisites?.courses || []).map(String))];
  if (requiredIds.length === 0) return { completed: new Set(), published: new Map() };
  const prerequisites = await Course.find({ _id: { $in: requiredIds }, status: 'PUBLISHED' })
    .select('_id title lectures._id').lean();
  const rows = prerequisites.length ? await LectureProgress.find({
    student, course: { $in: prerequisites.map((course) => course._id) }, completed: true
  })
    .select('course lectureId').lean() : [];
  const completed = new Map();
  for (const row of rows) {
    const key = String(row.course);
    if (!completed.has(key)) completed.set(key, new Set());
    completed.get(key).add(String(row.lectureId));
  }
  const completedCourses = new Set(prerequisites.filter((course) => course.lectures.length > 0
    && course.lectures.every((lecture) => completed.get(String(course._id))?.has(String(lecture._id))))
    .map((course) => String(course._id)));
  return {
    completed: completedCourses,
    published: new Map(prerequisites.map((course) => [String(course._id), {
      id: String(course._id), title: safeText(course.title, 100),
      status: completedCourses.has(String(course._id)) ? 'COMPLETED'
        : activeCourseIds.has(String(course._id)) ? 'IN_PROGRESS' : 'AVAILABLE'
    }]))
  };
}

function scoreCourse(course, profile, completedCourses) {
  const metadata = course.learningMetadata || {};
  const courseSkills = tags(metadata.skills);
  const hasMetadata = Boolean(metadata.level || courseSkills.length
    || metadata.prerequisites?.courses?.length || metadata.prerequisites?.skills?.length);
  const profileSkills = new Set(tags(profile?.selfReportedSkills));
  const interests = tags(profile?.interests);
  const goal = keywords(profile?.careerGoal);
  const courseKeywords = keywords([course.title, course.description, course.category, ...courseSkills].join(' '));
  const goalOverlap = [...goal].filter((word) => courseKeywords.has(word)).length;
  const levelDistance = !metadata.level || !profile?.experienceLevel
    ? null : Math.abs(LEVELS.indexOf(metadata.level) - LEVELS.indexOf(profile.experienceLevel));
  const unmetPrerequisites = [];
  for (const required of metadata.prerequisites?.courses || []) {
    if (!completedCourses.has(String(required))) unmetPrerequisites.push('Complete the required prerequisite course');
  }
  for (const skill of tags(metadata.prerequisites?.skills)) {
    if (!profileSkills.has(skill)) unmetPrerequisites.push(`Self-report prerequisite skill: ${safeText(skill, 80)}`);
  }
  const signals = {
    interestCategoryMatch: interests.some((interest) => interest === normalized(course.category) || courseSkills.includes(interest)) ? 30 : 0,
    goalKeywordMatch: goal.size === 0 ? 0 : Math.round(20 * goalOverlap / goal.size),
    skillMatch: courseSkills.length === 0 ? 0 : Math.round(15 * courseSkills.filter((skill) => profileSkills.has(skill)).length / courseSkills.length),
    levelFit: levelDistance === 0 ? 15 : levelDistance === 1 ? 8 : 0,
    prerequisiteFit: hasMetadata && unmetPrerequisites.length === 0 ? 20 : 0
  };
  return { course: courseCard(course), score: Math.max(0, Math.min(100, Object.values(signals).reduce((sum, value) => sum + value, 0))),
    signals, unmetPrerequisites };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRecommendations(left, right) {
  return right.score - left.score
    || Number(right.course.accessType === 'FREE') - Number(left.course.accessType === 'FREE')
    || compareText(normalized(left.course.title), normalized(right.course.title))
    || compareText(left.course.title, right.course.title)
    || compareText(left.course.id, right.course.id);
}

function prerequisiteSummary(course, facts, candidateIds, profile) {
  const coursePrerequisites = (course.learningMetadata?.prerequisites?.courses || []).map((reference) => {
    const id = String(reference);
    const known = facts.published.get(id);
    if (known) return known;
    if (candidateIds.has(id)) {
      const candidate = facts.candidates.get(id);
      return { id, title: safeText(candidate?.title, 100) || 'Published prerequisite course', status: 'AVAILABLE' };
    }
    return { id: null, title: 'Course details unavailable', status: 'UNKNOWN' };
  });
  const profileSkills = new Set(tags(profile?.selfReportedSkills));
  const skillPrerequisites = tags(course.learningMetadata?.prerequisites?.skills).map((skill) => ({
    skill: safeText(skill, 80),
    status: profileSkills.has(skill) ? 'MET' : 'NEEDS_SKILL'
  }));
  const unmetPrerequisites = [
    ...coursePrerequisites.filter((item) => item.status !== 'COMPLETED').map((item) => {
      if (item.status === 'AVAILABLE') return `Complete prerequisite course: ${item.title}`;
      if (item.status === 'IN_PROGRESS') return `Finish enrolled prerequisite course: ${item.title}`;
      return 'Confirm prerequisite course availability before starting';
    }),
    ...skillPrerequisites.filter((item) => item.status !== 'MET')
      .map((item) => `Self-report prerequisite skill: ${item.skill}`)
  ];
  return {
    prerequisites: { courses: coursePrerequisites, skills: skillPrerequisites },
    unmetPrerequisites
  };
}

function matchReasons(recommendation) {
  const { signals } = recommendation;
  const reasons = [];
  if (signals.goalKeywordMatch > 0) reasons.push('Matches your career goal');
  if (signals.interestCategoryMatch > 0) reasons.push('Aligns with your interests');
  if (signals.skillMatch > 0) reasons.push('Matches skills you reported');
  if (signals.levelFit > 0) reasons.push('Fits your experience level');
  if (recommendation.prerequisites.courses.some((item) => item.status === 'AVAILABLE')) {
    reasons.push('Builds on an earlier course in this pathway');
  }
  if (recommendation.unmetPrerequisites.length > 0) reasons.push('Has prerequisites to confirm or complete');
  if (reasons.length === 0) reasons.push('Available to explore in the published catalog');
  return reasons;
}

function orderPathway(scored, candidates, completedCourses) {
  const byId = new Map(scored.map((item) => [item.course.id, item]));
  const candidateIds = new Set(byId.keys());
  const dependents = new Map([...candidateIds].map((id) => [id, []]));
  const incoming = new Map();
  for (const [id, course] of candidates) {
    const required = [...new Set((course.learningMetadata?.prerequisites?.courses || []).map(String))]
      .filter((requiredId) => candidateIds.has(requiredId) && !completedCourses.has(requiredId));
    incoming.set(id, required.length);
    for (const requiredId of required) dependents.get(requiredId).push(id);
  }
  const rank = new Map(scored.map((item, index) => [item.course.id, index]));
  const ready = [...candidateIds].filter((id) => incoming.get(id) === 0)
    .sort((left, right) => rank.get(left) - rank.get(right));
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id)) {
      incoming.set(dependent, incoming.get(dependent) - 1);
      if (incoming.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort((left, right) => rank.get(left) - rank.get(right));
      }
    }
  }
  return ordered;
}

async function getRecommendations(studentId, limit = 5) {
  const student = objectId(studentId, 'studentId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError('limit must be an integer from 1 to 20');
  const [profile, enrollments] = await Promise.all([
    LearningProfile.findOne({ student }).select('careerGoal interests selfReportedSkills experienceLevel weeklyAvailabilityHours').lean(),
    Enrollment.find({ student, status: 'ACTIVE' }).select('course').lean()
  ]);
  const activeCourseIds = new Set(enrollments.map((enrollment) => String(enrollment.course)));
  const courses = await Course.find({ status: 'PUBLISHED', _id: { $nin: enrollments.map((enrollment) => enrollment.course) } })
    .select('title description category accessType price currency thumbnail.secure_url learningMetadata').lean();
  const profileValue = profileDto(profile);
  const facts = await prerequisiteFacts(student, courses, activeCourseIds);
  facts.candidates = new Map(courses.map((course) => [String(course._id), course]));
  const scored = courses.map((course) => {
    const recommendation = scoreCourse(course, profileValue, facts.completed);
    const summary = prerequisiteSummary(course, facts, new Set(facts.candidates.keys()), profileValue);
    return { ...recommendation, ...summary };
  }).sort(compareRecommendations);
  const candidateMap = new Map(courses.map((course) => [String(course._id), course]));
  return orderPathway(scored, candidateMap, facts.completed).slice(0, limit).map((recommendation, index) => ({
    ...recommendation,
    pathwayOrder: index + 1,
    matchReasons: matchReasons(recommendation)
  }));
}

module.exports = { getRecommendations };
