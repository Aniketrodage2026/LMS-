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

async function completedPrerequisites(student, candidates) {
  const requiredIds = [...new Set(candidates.flatMap((course) => course.learningMetadata?.prerequisites?.courses || []).map(String))];
  if (requiredIds.length === 0) return new Set();
  const prerequisites = await Course.find({ _id: { $in: requiredIds }, status: 'PUBLISHED' }).select('lectures._id').lean();
  const rows = await LectureProgress.find({ student, course: { $in: prerequisites.map((course) => course._id) }, completed: true })
    .select('course lectureId').lean();
  const completed = new Map();
  for (const row of rows) {
    const key = String(row.course);
    if (!completed.has(key)) completed.set(key, new Set());
    completed.get(key).add(String(row.lectureId));
  }
  return new Set(prerequisites.filter((course) => course.lectures.length > 0
    && course.lectures.every((lecture) => completed.get(String(course._id))?.has(String(lecture._id))))
    .map((course) => String(course._id)));
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

async function getRecommendations(studentId, limit = 5) {
  const student = objectId(studentId, 'studentId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError('limit must be an integer from 1 to 20');
  const [profile, enrollments] = await Promise.all([
    LearningProfile.findOne({ student }).select('careerGoal interests selfReportedSkills experienceLevel weeklyAvailabilityHours').lean(),
    Enrollment.find({ student, status: 'ACTIVE' }).select('course').lean()
  ]);
  const courses = await Course.find({ status: 'PUBLISHED', _id: { $nin: enrollments.map((enrollment) => enrollment.course) } })
    .select('title description category accessType price currency thumbnail.secure_url learningMetadata').lean();
  const completedCourses = await completedPrerequisites(student, courses);
  return courses.map((course) => scoreCourse(course, profileDto(profile), completedCourses)).sort((left, right) => (
    right.score - left.score
    || Number(right.course.accessType === 'FREE') - Number(left.course.accessType === 'FREE')
    || compareText(normalized(left.course.title), normalized(right.course.title))
    || compareText(left.course.title, right.course.title)
    || compareText(left.course.id, right.course.id)
  )).slice(0, limit);
}

module.exports = { getRecommendations };
