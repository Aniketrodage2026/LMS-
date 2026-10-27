const mongoose = require('mongoose');
const LearningProfile = require('../../models/learning-profile.schema');

const PROFILE_FIELDS = ['careerGoal', 'interests', 'selfReportedSkills', 'experienceLevel', 'weeklyAvailabilityHours'];

function objectId(value, fieldName) {
  if (!(typeof value === 'string' || value instanceof mongoose.Types.ObjectId) || !mongoose.Types.ObjectId.isValid(value)) {
    throw new TypeError(`${fieldName} must be a valid ObjectId`);
  }
  return new mongoose.Types.ObjectId(value);
}

// Apply the same minimization to stored profile text and every free-text DTO field.
// This covers recognizable credentials; callers must still avoid supplying secrets.
function redactSensitiveText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b(?:authorization["']?\s*[:=]\s*["']?\s*Basic|Bearer)\s+[^\s"',;}]+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    // A truncated quoted credential consumes the remaining field, including a
    // dangling escape; never reinterpret its opening quote as an unquoted value.
    .replace(/\b(?:password|passwd|(?:client[_ -]?)?secret|(?:(?:access|refresh|id)[_ -]?)?token|api[_ -]?key|authorization)["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^"'\s,;][^\s,;]*)/gi, '[redacted]');
}

function safeText(value, maxLength = 500) {
  return redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeTags(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === 'string').map((value) => safeText(value, 80).toLowerCase()))].slice(0, 20)
    : [];
}

function profileDto(profile) {
  if (!profile) return null;
  return {
    careerGoal: safeText(profile.careerGoal),
    interests: safeTags(profile.interests),
    selfReportedSkills: safeTags(profile.selfReportedSkills),
    experienceLevel: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'].includes(profile.experienceLevel) ? profile.experienceLevel : undefined,
    weeklyAvailabilityHours: Number.isInteger(profile.weeklyAvailabilityHours) ? profile.weeklyAvailabilityHours : undefined
  };
}

async function saveProfile(studentId, input) {
  const student = objectId(studentId, 'studentId');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((field) => !PROFILE_FIELDS.includes(field))) {
    throw new TypeError('Provide only learning profile fields');
  }
  const values = {};
  for (const field of PROFILE_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (field === 'careerGoal' && typeof value === 'string') values[field] = safeText(value, Number.MAX_SAFE_INTEGER);
    else if (['interests', 'selfReportedSkills'].includes(field) && Array.isArray(value)) {
      values[field] = value.map((tag) => typeof tag === 'string' ? safeText(tag, Number.MAX_SAFE_INTEGER) : tag);
    } else if (field === 'experienceLevel' && typeof value === 'string') values[field] = value.trim().toUpperCase();
    else values[field] = value;
  }
  let document = await LearningProfile.findOne({ student });
  document = document || new LearningProfile({ student });
  document.set(values);
  try {
    await document.save();
  } catch (error) {
    if (error.code !== 11000) throw error;
    // A simultaneous first save may have created this caller's unique profile.
    document = await LearningProfile.findOne({ student });
    if (!document) throw error;
    document.set(values);
    await document.save();
  }
  return profileDto(document);
}

module.exports = { saveProfile, profileDto, safeText, safeTags, objectId, redactSensitiveText };
