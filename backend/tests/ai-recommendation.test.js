const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const LearningProfile = require('../models/learning-profile.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const LectureProgress = require('../models/lecture-progress.schema');
const Quiz = require('../models/quiz.schema');
const QuizAttempt = require('../models/quiz-attempt.schema');
const Assignment = require('../models/assignment.schema');
const Submission = require('../models/submission.schema');
const Certificate = require('../models/certificate.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { saveProfile } = require('../services/ai/learning-profile.service');
const { getRecommendations } = require('../services/ai/recommendation.service');
const { buildStudentContext } = require('../services/ai/student-context.service');

const id = () => new mongoose.Types.ObjectId();
function profile(overrides = {}) {
  return { careerGoal: 'JavaScript developer', interests: ['javascript'], selfReportedSkills: ['html'],
    experienceLevel: 'BEGINNER', weeklyAvailabilityHours: 5, ...overrides };
}
function course(overrides = {}) {
  return Course.create({ title: 'JavaScript foundations', description: 'JavaScript developer lessons',
    category: 'Programming', instructor: id(),
    thumbnail: { public_id: 'PRIVATE_MEDIA_ID', secure_url: 'https://example.com/image.png' }, ...overrides });
}
function lecture(title) {
  return { title, lecture: { public_id: 'PRIVATE_LECTURE', secure_url: 'https://example.com/video.mp4' } };
}
async function enroll(student, value, overrides = {}) {
  return Enrollment.create({ student, course: value._id, source: 'FREE_ENROLLMENT', ...overrides });
}
async function progress(student, value, lectureId, completed = true) {
  return LectureProgress.create({ student, course: value._id, lectureId, completed, watchedPercent: completed ? 100 : 25 });
}

test.before(async () => {
  await connectTestDb();
  await Promise.all([LearningProfile.init(), Enrollment.init(), LectureProgress.init(), Certificate.init(), Submission.init()]);
});
test.beforeEach(async () => {
  await Promise.all([LearningProfile, Course, Enrollment, LectureProgress, Quiz, QuizAttempt, Assignment, Submission, Certificate]
    .map((model) => model.deleteMany({})));
});
test.after(disconnectTestDb);

test('saveProfile normalizes and persists only the caller profile through document saves', async () => {
  const student = id();
  const other = id();
  await LearningProfile.create({ student: other, ...profile({ careerGoal: 'OTHER_STUDENT' }) });
  const saved = await saveProfile(student, profile({ careerGoal: '  JavaScript developer  ',
    interests: [' JavaScript ', 'JAVASCRIPT'], selfReportedSkills: [' HTML ', 'html'], experienceLevel: ' beginner ' }));
  assert.deepEqual(saved, profile());
  const updated = await saveProfile(student, profile({ weeklyAvailabilityHours: 12 }));
  assert.equal(updated.weeklyAvailabilityHours, 12);
  assert.equal(await LearningProfile.countDocuments({ student }), 1);
  assert.equal((await LearningProfile.findOne({ student })).weeklyAvailabilityHours, 12);
  assert.equal((await LearningProfile.findOne({ student: other })).careerGoal, 'OTHER_STUDENT');
  assert.equal(saved.student, undefined);
  assert.equal(saved._id, undefined);
});

test('saveProfile rejects invalid or injected fields without modifying persisted data', async () => {
  const student = id();
  await saveProfile(student, profile());
  for (const invalid of [profile({ student: id() }), profile({ password: 'PRIVATE_PASSWORD' }),
    profile({ weeklyAvailabilityHours: '5' }), profile({ interests: [null] }), profile({ careerGoal: 'x'.repeat(501) })]) {
    await assert.rejects(saveProfile(student, invalid));
  }
  await assert.rejects(saveProfile({ $ne: null }, profile()), /studentId/);
  assert.equal((await LearningProfile.findOne({ student })).weeklyAvailabilityHours, 5);
});

test('profile text redacts recognizable email and credentials before persistence and DTO output', async () => {
  const student = id();
  const saved = await saveProfile(student, profile({ careerGoal: 'Developer me@example.com password=PRIVATE_PASSWORD',
    interests: ['me@example.com'], selfReportedSkills: ['Bearer PRIVATE_TOKEN'] }));
  const stored = await LearningProfile.findOne({ student }).lean();
  for (const value of [saved, stored]) {
    assert.doesNotMatch(JSON.stringify(value), /me@example\.com|PRIVATE_PASSWORD|PRIVATE_TOKEN/);
  }
});

test('quoted credential keys and Basic authorization are redacted in persistence and legacy context', async () => {
  const student = id();
  const credentials = '{"password":"REVIEW_PASSWORD","token":"REVIEW_TOKEN","api_key":"REVIEW_API_KEY"}';
  const basic = 'Authorization: Basic UkVWSUVXX0JBU0lD';
  const saved = await saveProfile(student, profile({ careerGoal: `${credentials} ${basic}`,
    interests: ['{"password":"REVIEW_INTEREST"}'], selfReportedSkills: ["'token': 'REVIEW_SKILL'"] }));
  const stored = await LearningProfile.findOne({ student });
  for (const value of [saved, stored.toObject(), await buildStudentContext(student)]) {
    assert.doesNotMatch(JSON.stringify(value), /REVIEW_|review_|UkVWSUVXX0JBU0lD/);
  }
  // Profiles saved before service redaction must also be safe when read into context.
  stored.careerGoal = `${credentials} ${basic}`;
  await stored.save();
  assert.doesNotMatch(JSON.stringify(await buildStudentContext(student)), /REVIEW_|UkVWSUVXX0JBU0lD/);
});

test('Basic learning prose remains visible when it is not an authorization header', async () => {
  const student = id();
  const saved = await saveProfile(student, profile({ careerGoal: 'Learn Basic Python' }));
  assert.equal(saved.careerGoal, 'Learn Basic Python');
  await course({ title: 'Basic Python foundations' });
  assert.equal((await getRecommendations(student))[0].course.title, 'Basic Python foundations');
});

test('recommendations select only published courses without the caller active enrollment', async () => {
  const student = id();
  const own = await course({ title: 'Owned course basics' });
  const revoked = await course({ title: 'Revoked course basics' });
  const available = await course({ title: 'Available course basics' });
  await course({ title: 'Unpublished course basics', status: 'UNPUBLISHED' });
  await enroll(student, own);
  await enroll(student, revoked, { status: 'REVOKED' });
  await enroll(id(), available);
  const rows = await getRecommendations(student);
  assert.deepEqual(rows.map((row) => row.course.id), [String(available._id), String(revoked._id)]);
  assert.ok(rows.every((row) => row.score >= 0 && row.score <= 100));
  assert.deepEqual(await getRecommendations(student), rows);
});

test('named score signals use the exact proportional scoring contract', async () => {
  const student = id();
  await saveProfile(student, profile({ careerGoal: 'JavaScript analytics engineer', interests: [' WEB DEVELOPMENT '],
    selfReportedSkills: ['html'], experienceLevel: 'BEGINNER' }));
  await course({ title: 'JavaScript course basics', description: 'Learn JavaScript', category: 'Web Development',
    learningMetadata: { skills: ['html', 'css'], level: 'INTERMEDIATE' } });
  const [row] = await getRecommendations(student);
  assert.deepEqual(row.signals, { interestCategoryMatch: 30, goalKeywordMatch: 7, skillMatch: 8, levelFit: 8, prerequisiteFit: 20 });
  assert.equal(row.score, 73);
});

test('scores reach 100 with all matches and fall to zero with no evidence or fit', async () => {
  const student = id();
  await saveProfile(student, profile());
  const perfect = await course({ learningMetadata: { level: 'BEGINNER', skills: ['html', 'javascript'] } });
  await saveProfile(student, profile({ selfReportedSkills: ['html', 'javascript'] }));
  const mismatch = await course({ title: 'Advanced finance course', description: 'Finance', category: 'Finance',
    learningMetadata: { level: 'ADVANCED', skills: ['finance'], prerequisites: { skills: ['accounting'] } } });
  const rows = await getRecommendations(student);
  assert.equal(rows.find((row) => row.course.id === String(perfect._id)).score, 100);
  assert.equal(rows.find((row) => row.course.id === String(mismatch._id)).score, 0);
});

test('absent learning metadata adds zero points and free ties never change the score', async () => {
  const student = id();
  const paid = await course({ title: 'Alpha paid course', accessType: 'PAID', price: 100 });
  const freeZ = await course({ title: 'Zulu free course' });
  const freeA = await course({ title: 'Alpha free course' });
  const rows = await getRecommendations(student);
  assert.deepEqual(rows.map((row) => row.course.id), [String(freeA._id), String(freeZ._id), String(paid._id)]);
  assert.deepEqual(rows.map((row) => row.score), [0, 0, 0]);
  assert.deepEqual(rows[0].signals, { interestCategoryMatch: 0, goalKeywordMatch: 0, skillMatch: 0, levelFit: 0, prerequisiteFit: 0 });
  assert.equal((await getRecommendations(student, 1)).length, 1);
  await assert.rejects(getRecommendations(student, 0), /limit/);
  await assert.rejects(getRecommendations({ $ne: null }), /studentId/);
});

test('missing skills and levels never imply evidence while explicit prerequisite rules still apply', async () => {
  const student = id();
  await saveProfile(student, profile({ careerGoal: 'Unrelated', interests: ['unrelated'] }));
  const empty = await course({ learningMetadata: {} });
  const skillsOnly = await course({ learningMetadata: { skills: ['html'] } });
  const levelOnly = await course({ learningMetadata: { level: 'BEGINNER' } });
  const rows = await getRecommendations(student);
  assert.deepEqual(rows.find(row => row.course.id === String(empty._id)).signals,
    { interestCategoryMatch: 0, goalKeywordMatch: 0, skillMatch: 0, levelFit: 0, prerequisiteFit: 0 });
  assert.deepEqual(rows.find(row => row.course.id === String(skillsOnly._id)).signals,
    { interestCategoryMatch: 0, goalKeywordMatch: 0, skillMatch: 15, levelFit: 0, prerequisiteFit: 20 });
  assert.deepEqual(rows.find(row => row.course.id === String(levelOnly._id)).signals,
    { interestCategoryMatch: 0, goalKeywordMatch: 0, skillMatch: 0, levelFit: 15, prerequisiteFit: 20 });
});

test('higher scoring paid courses outrank lower scoring free courses', async () => {
  const student = id();
  await saveProfile(student, profile());
  const paid = await course({ accessType: 'PAID', price: 100, learningMetadata: { skills: ['html', 'javascript'] } });
  await course({ title: 'Finance foundations', category: 'Finance', description: 'Finance', learningMetadata: { skills: ['finance'] } });
  assert.equal((await getRecommendations(student))[0].course.id, String(paid._id));
});

test('no candidates returns an empty list and an unenrolled context stays empty', async () => {
  const student = id();
  assert.deepEqual(await getRecommendations(student), []);
  assert.deepEqual(await buildStudentContext(student), { profile: null, activeCourses: [] });
});

test('prerequisites require every current lecture completed by the caller plus self-reported skills', async () => {
  const student = id();
  const prerequisite = await course({ title: 'HTML foundations course', lectures: [lecture('First lesson'), lecture('Second lesson')] });
  await enroll(student, prerequisite);
  await saveProfile(student, profile());
  const target = await course({ learningMetadata: { prerequisites: { courses: [prerequisite._id], skills: ['html'] } } });
  await progress(student, prerequisite, prerequisite.lectures[0]._id);
  await progress(id(), prerequisite, prerequisite.lectures[1]._id);
  await progress(student, prerequisite, id()); // Deleted lecture evidence must not count.
  let row = (await getRecommendations(student)).find((item) => item.course.id === String(target._id));
  assert.equal(row.signals.prerequisiteFit, 0);
  assert.ok(row.unmetPrerequisites.length > 0);
  await progress(student, prerequisite, prerequisite.lectures[1]._id);
  row = (await getRecommendations(student)).find((item) => item.course.id === String(target._id));
  assert.equal(row.signals.prerequisiteFit, 20);
  assert.deepEqual(row.unmetPrerequisites, []);
});

test('interests, other student progress, zero-lecture courses and missing courses never satisfy prerequisites', async () => {
  const student = id();
  const empty = await course({ title: 'Empty prerequisite course' });
  await saveProfile(student, profile({ interests: ['html'], selfReportedSkills: [] }));
  const target = await course({ learningMetadata: { prerequisites: { courses: [empty._id, id()], skills: ['html'] } } });
  const row = (await getRecommendations(student)).find((item) => item.course.id === String(target._id));
  assert.equal(row.signals.prerequisiteFit, 0);
  assert.equal(row.unmetPrerequisites.length, 3);
  assert.doesNotMatch(JSON.stringify(row.unmetPrerequisites), new RegExp(String(empty._id)));
});

test('recommendation cards expose bounded display fields and presentation-ready thumbnail URLs only', async () => {
  const student = id();
  await course({ description: `Description ${'x'.repeat(2000)} me@example.com`,
    thumbnail: { storage: { provider: 'R2', key: 'PRIVATE_STORAGE_KEY', contentType: 'image/png', size: 20 } } });
  const [row] = await getRecommendations(student);
  assert.deepEqual(Object.keys(row.course).sort(), ['accessType', 'category', 'currency', 'description', 'id', 'level', 'price', 'skills', 'thumbnailUrl', 'title']);
  assert.equal(row.course.thumbnailUrl, null);
  assert.ok(row.course.description.length <= 500);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE_STORAGE_KEY|me@example\.com|instructor|__v|public_id|secure_url/);
  await Course.deleteMany({});
  await course();
  assert.equal((await getRecommendations(student))[0].course.thumbnailUrl, 'https://example.com/image.png');
  await Course.deleteMany({});
  await course({ thumbnail: { public_id: 'secret', secure_url: 'https://example.com/image.png?token=SECRET' } });
  assert.equal((await getRecommendations(student))[0].course.thumbnailUrl, null);
});

test('thumbnail URLs reject recognizable secrets and email in plain or encoded paths', async () => {
  const student = id();
  const paths = ['me@example.com/image.png', 'token=REVIEW_TOKEN/image.png',
    'me%40example.com/token%3DREVIEW_TOKEN/image.png',
    'me%2540example.com/token%253DREVIEW_TOKEN/image.png',
    '%7B%22password%22%3A%22REVIEW_PASSWORD%22%7D/image.png',
    'Authorization%3A%20Basic%20UkVWSUVXX0JBU0lD/image.png'];
  await Promise.all(paths.map((path, index) => course({ title: `Sensitive thumbnail ${index}`,
    thumbnail: { public_id: 'private', secure_url: `https://example.com/${path}` } })));
  const recommendations = await getRecommendations(student, 20);
  assert.equal(recommendations.length, paths.length);
  for (const row of recommendations) assert.equal(row.course.thumbnailUrl, null, row.course.title);
  assert.doesNotMatch(JSON.stringify(recommendations), /REVIEW_|UkVWSUVXX0JBU0lD|me@|me%40|me%2540/);
});

test('thumbnail URL normalization cannot reconstruct sensitive values through control characters', async () => {
  const student = id();
  const cases = [
    'me@\nexample.com/image.png', 'to\tken=REVIEW_TOKEN/image.png', 'me@\rexample.com/image.png',
    'me@%0Aexample.com/image.png', 'to%09ken=REVIEW_TOKEN/image.png', 'image.png', 'course%20image.png'
  ];
  const courses = await Promise.all(cases.map((path, index) => course({ title: `Normalized thumbnail ${index}`,
    thumbnail: { public_id: 'private', secure_url: `https://example.com/${path}` } })));
  const recommendations = await getRecommendations(student, 20);
  const urls = new Map(recommendations.map((row) => [row.course.id, row.course.thumbnailUrl]));
  assert.deepEqual(courses.map((entry) => urls.get(String(entry._id))), [null, null, null, null, null,
    'https://example.com/image.png', 'https://example.com/course%20image.png']);
  assert.doesNotMatch(JSON.stringify(recommendations), /me@example\.com|REVIEW_TOKEN|me@%0A|to%09ken/);
});

test('student context includes only caller active published courses and current-lecture progress', async () => {
  const student = id();
  const other = id();
  await saveProfile(student, profile());
  await saveProfile(other, profile({ careerGoal: 'OTHER_STUDENT_PROFILE' }));
  const own = await course({ lectures: [lecture('First lesson'), lecture('Next lesson')] });
  const foreign = await course({ title: 'OTHER_STUDENT_COURSE' });
  const unpublished = await course({ title: 'UNPUBLISHED_COURSE', status: 'UNPUBLISHED' });
  const revoked = await course({ title: 'REVOKED_COURSE' });
  await enroll(student, own);
  await enroll(other, foreign);
  await enroll(student, unpublished);
  await enroll(student, revoked, { status: 'REVOKED' });
  await progress(student, own, own.lectures[0]._id);
  await progress(student, own, id());
  await progress(other, own, own.lectures[1]._id);
  const context = await buildStudentContext(student);
  assert.deepEqual(context.profile, profile());
  assert.equal(context.activeCourses.length, 1);
  assert.equal(context.activeCourses[0].course.id, String(own._id));
  assert.deepEqual(context.activeCourses[0].progress, { totalLectures: 2, completedLectures: 1, completionPercent: 50 });
  assert.deepEqual(context.activeCourses[0].nextLecture, { id: String(own.lectures[1]._id), title: 'Next lesson' });
  assert.doesNotMatch(JSON.stringify(context), /OTHER_STUDENT|UNPUBLISHED_COURSE|REVOKED_COURSE|PRIVATE_MEDIA|PRIVATE_LECTURE|student|instructor|__v|storage|secure_url/);
  assert.deepEqual(await buildStudentContext(student, own._id), context);
  await assert.rejects(buildStudentContext(student, foreign._id), (error) => error.statusCode === 403);
  await assert.rejects(buildStudentContext(student, unpublished._id), (error) => error.statusCode === 403);
  await assert.rejects(buildStudentContext(student, { $ne: null }), /courseId/);
});

test('context assessments use published definitions, caller attempts and latest submission summaries only', async () => {
  const student = id();
  const own = await course();
  await enroll(student, own);
  const quizInput = { course: own._id, title: 'Published quiz', status: 'PUBLISHED', passMark: 80,
    instructions: 'PRIVATE_QUIZ_INSTRUCTIONS', questions: [{ prompt: 'PRIVATE_PROMPT', options: ['a', 'b'], correctOptionIndex: 0 }] };
  const quiz = await Quiz.create(quizInput);
  const draftQuiz = await Quiz.create({ ...quizInput, title: 'DRAFT_QUIZ', status: 'DRAFT' });
  for (const [owner, quizId, correctAnswers] of [[student, quiz._id, 0], [id(), quiz._id, 1], [student, draftQuiz._id, 1]]) {
    await QuizAttempt.create({ student: owner, course: own._id, quiz: quizId, answers: [0], totalQuestions: 1,
      correctAnswers, score: correctAnswers, percentage: correctAnswers * 100, passed: correctAnswers === 1 });
  }
  const assignment = await Assignment.create({ course: own._id, title: 'Published assignment', status: 'PUBLISHED',
    instructions: 'PRIVATE_ASSIGNMENT_INSTRUCTIONS', maxMarks: 100 });
  await Assignment.create({ course: own._id, title: 'DRAFT_ASSIGNMENT', instructions: 'PRIVATE', maxMarks: 100 });
  for (const [owner, version, status, marks] of [[student, 1, 'GRADED', 100], [student, 2, 'SUBMITTED', null], [id(), 1, 'GRADED', 100]]) {
    await Submission.create({ assignment: assignment._id, course: own._id, student: owner, version,
      writtenAnswer: 'PRIVATE_RAW_ANSWER', late: false, status, marks, feedback: 'PRIVATE_FEEDBACK' });
  }
  await Certificate.create({ student: id(), course: own._id, certificateNumber: 'LMS-2026-AAAAAAAAAAAAAAAAAAAA',
    verificationToken: 'a'.repeat(64), eligibilitySnapshot: { private: true } });
  let context = await buildStudentContext(student);
  assert.deepEqual(context.activeCourses[0].assessments, {
    totalQuizzes: 1, totalAssignments: 1,
    quizzes: [{ id: String(quiz._id), title: 'Published quiz', passMark: 80, bestPercentage: 0, passed: false }],
    assignments: [{ id: String(assignment._id), title: 'Published assignment', dueDate: null, maxMarks: 100, status: 'SUBMITTED', marks: null }]
  });
  assert.equal(context.activeCourses[0].certificate, null);
  await Certificate.create({ student, course: own._id, certificateNumber: 'LMS-2026-BBBBBBBBBBBBBBBBBBBB',
    verificationToken: 'b'.repeat(64), eligibilitySnapshot: { private: true } });
  context = await buildStudentContext(student);
  assert.equal(context.activeCourses[0].certificate.certificateNumber, 'LMS-2026-BBBBBBBBBBBBBBBBBBBB');
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|DRAFT|answers|correctOption|verificationToken|eligibilitySnapshot|feedback|writtenAnswer|gradedBy/);
});

test('context bounds courses and published assessment summaries and chooses lecture position order', async () => {
  const student = id();
  const own = await course({ title: 'Alpha primary course', lectures: [
    { ...lecture('Second lesson'), position: 2 }, { ...lecture('First lesson'), position: 1 }
  ] });
  await enroll(student, own);
  for (let index = 0; index < 11; index += 1) await enroll(student, await course({ title: `Other course ${String(index).padStart(2, '0')}` }));
  await Assignment.insertMany(Array.from({ length: 22 }, (_, index) => ({ course: own._id,
    title: `Assignment ${String(index).padStart(2, '0')}`, instructions: 'PRIVATE', status: 'PUBLISHED', maxMarks: 100 })));
  const context = await buildStudentContext(student);
  assert.equal(context.activeCourses.length, 10);
  assert.equal(context.activeCourses[0].nextLecture.title, 'First lesson');
  assert.equal(context.activeCourses[0].assessments.totalAssignments, 22);
  assert.equal(context.activeCourses[0].assessments.assignments.length, 20);
  assert.equal((await buildStudentContext(student, own._id)).activeCourses.length, 1);
});

test('context bounds database result sets while retaining complete best-attempt and latest-version facts', async (t) => {
  const student = id();
  const own = await course();
  await enroll(student, own);
  const quizzes = await Quiz.insertMany(Array.from({ length: 25 }, (_, index) => ({ course: own._id,
    title: `Quiz ${String(index).padStart(2, '0')}`, status: 'PUBLISHED', passMark: 80,
    questions: [{ prompt: 'Private question', options: ['a', 'b'], correctOptionIndex: 0 }] })));
  const assignments = await Assignment.insertMany(Array.from({ length: 25 }, (_, index) => ({ course: own._id,
    title: `Assignment ${String(index).padStart(2, '0')}`, status: 'PUBLISHED', instructions: 'PRIVATE', maxMarks: 100 })));
  await QuizAttempt.insertMany(quizzes.slice(0, 20).flatMap((quiz) => [1, 2, 3].map((version) => ({
    student, course: own._id, quiz: quiz._id, answers: [0], totalQuestions: 1,
    correctAnswers: version === 1 ? 1 : 0, score: version === 1 ? 1 : 0,
    percentage: version === 1 ? 100 : 0, passed: version === 1
  }))));
  await Submission.insertMany(assignments.slice(0, 20).flatMap((assignment) => [1, 2, 3].map((version) => ({
    student, course: own._id, assignment: assignment._id, version, writtenAnswer: 'PRIVATE', late: false,
    status: 'GRADED', marks: version === 3 ? 73 : 100
  }))));
  const transfers = [];
  const observedModels = new Set(['Quiz', 'Assignment', 'QuizAttempt', 'Submission']);
  // Observe real database results, without replacing queries or their returned data.
  const queryExec = mongoose.Query.prototype.exec;
  t.mock.method(mongoose.Query.prototype, 'exec', async function (...args) {
    const result = await queryExec.apply(this, args);
    if (observedModels.has(this.model.modelName) && Array.isArray(result)) transfers.push({ model: this.model.modelName, size: result.length });
    return result;
  });
  const aggregateExec = mongoose.Aggregate.prototype.exec;
  t.mock.method(mongoose.Aggregate.prototype, 'exec', async function (...args) {
    const result = await aggregateExec.apply(this, args);
    if (observedModels.has(this.model().modelName) && Array.isArray(result)) transfers.push({ model: this.model().modelName, size: result.length });
    return result;
  });
  const { assessments } = (await buildStudentContext(student)).activeCourses[0];
  assert.equal(assessments.totalQuizzes, 25);
  assert.equal(assessments.totalAssignments, 25);
  assert.equal(assessments.quizzes.length, 20);
  assert.equal(assessments.assignments.length, 20);
  assert.ok(assessments.quizzes.every((quiz) => quiz.bestPercentage === 100 && quiz.passed === true));
  assert.ok(assessments.assignments.every((assignment) => assignment.status === 'GRADED' && assignment.marks === 73));
  const { certificateEligibility } = (await buildStudentContext(student)).activeCourses[0];
  assert.ok(certificateEligibility, 'Guidance must include the authoritative certificate checklist');
  assert.equal(certificateEligibility.requiredQuizzes, 25);
  assert.equal(certificateEligibility.passedQuizzes, 20);
  assert.equal(certificateEligibility.requiredAssignments, 25);
  assert.equal(certificateEligibility.gradedAssignments, 20);
  assert.equal(certificateEligibility.eligible, false);
  assert.deepEqual([...new Set(transfers.map((entry) => entry.model))].sort(), ['Assignment', 'Quiz', 'QuizAttempt', 'Submission']);
  assert.ok(transfers.every((entry) => entry.size <= 20), `Unbounded database transfers: ${JSON.stringify(transfers)}`);
});

test('guidance includes authoritative certificate eligibility using only the caller latest assessment facts', async () => {
  const student = id();
  const own = await course({ lectures: [lecture('Only lesson')] });
  await enroll(student, own);
  await progress(student, own, own.lectures[0]._id);
  const quiz = await Quiz.create({ course: own._id, title: 'Knowledge check', status: 'PUBLISHED', passMark: 80,
    questions: [{ prompt: 'PRIVATE_QUESTION', options: ['a', 'b'], correctOptionIndex: 0 }] });
  await QuizAttempt.create({ student, course: own._id, quiz: quiz._id, answers: [0], totalQuestions: 1,
    correctAnswers: 1, score: 1, percentage: 100, passed: true });
  const assignment = await Assignment.create({ course: own._id, title: 'Project', status: 'PUBLISHED',
    instructions: 'PRIVATE_INSTRUCTIONS', maxMarks: 100 });
  await Submission.create({ student, course: own._id, assignment: assignment._id, version: 1,
    writtenAnswer: 'PRIVATE_RAW', late: false, status: 'GRADED', marks: 90 });
  const eligible = (await buildStudentContext(student, own._id)).activeCourses[0];
  assert.deepEqual(eligible.certificateEligibility, { eligible: true, totalLectures: 1, completedLectures: 1,
    lecturePercent: 100, requiredQuizzes: 1, passedQuizzes: 1, requiredAssignments: 1, gradedAssignments: 1,
    assessmentAverage: 95, lectureRequirementMet: true, quizzesRequirementMet: true,
    assignmentsRequirementMet: true, assessmentRequirementMet: true });
  await Submission.create({ student, course: own._id, assignment: assignment._id, version: 2,
    writtenAnswer: 'PRIVATE_NEW_RAW', late: false, status: 'SUBMITTED' });
  await Submission.create({ student: id(), course: own._id, assignment: assignment._id, version: 1,
    writtenAnswer: 'OTHER_STUDENT_RAW', late: false, status: 'GRADED', marks: 100 });
  const pending = (await buildStudentContext(student, own._id)).activeCourses[0];
  assert.equal(pending.certificateEligibility.eligible, false);
  assert.equal(pending.certificateEligibility.gradedAssignments, 0);
  assert.equal(pending.certificateEligibility.assessmentAverage, 50);
  assert.equal(pending.assessments.assignments[0].status, 'SUBMITTED');
  assert.doesNotMatch(JSON.stringify(pending), /PRIVATE|OTHER_STUDENT|writtenAnswer|answers|correctOption/);
});
