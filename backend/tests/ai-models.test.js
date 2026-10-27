const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const LearningProfile = require('../models/learning-profile.schema');
const AIConversation = require('../models/ai-conversation.schema');
const AIUsageLog = require('../models/ai-usage-log.schema');
const Course = require('../models/course.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function profile(overrides = {}) {
  return {
    student: new mongoose.Types.ObjectId(),
    careerGoal: '  Become a web developer  ',
    interests: [' JavaScript ', 'JAVASCRIPT', ' Web Development '],
    selfReportedSkills: [' HTML ', 'html', ' CSS '],
    experienceLevel: 'BEGINNER',
    weeklyAvailabilityHours: 5,
    ...overrides
  };
}

function conversation(overrides = {}) {
  return {
    student: new mongoose.Types.ObjectId(),
    messages: [{ role: 'USER', text: '  Help me choose a course  ' }],
    ...overrides
  };
}

function usage(overrides = {}) {
  return {
    student: new mongoose.Types.ObjectId(),
    feature: 'DISCOVERY',
    provider: 'GEMINI',
    modelAlias: 'learning-assistant',
    outcome: 'SUCCESS',
    inputTokens: 25,
    outputTokens: 10,
    ...overrides
  };
}

function course(overrides = {}) {
  return {
    title: 'Web development basics',
    description: 'An introductory course',
    category: 'Programming',
    instructor: new mongoose.Types.ObjectId(),
    thumbnail: { public_id: 'existing-thumbnail', secure_url: 'https://example.com/image.png' },
    ...overrides
  };
}

test.before(async () => {
  await connectTestDb();
  await Promise.all([LearningProfile.init(), AIConversation.init(), AIUsageLog.init()]);
});

test.after(disconnectTestDb);

test('learning profile persists one normalized profile per immutable student', async () => {
  const input = profile();
  const saved = await LearningProfile.create(input);
  assert.equal(saved.careerGoal, 'Become a web developer');
  assert.deepEqual([...saved.interests], ['javascript', 'web development']);
  assert.deepEqual([...saved.selfReportedSkills], ['html', 'css']);
  assert.ok(saved.createdAt instanceof Date);
  await assert.rejects(LearningProfile.create(input), (error) => error.code === 11000);

  saved.student = new mongoose.Types.ObjectId();
  await assert.rejects(saved.save(), /immutable/i);
  assert.equal(String((await LearningProfile.findById(saved._id)).student), String(input.student));
});

test('profile rejects absent identity, empty or oversized values, and unbounded tags', async () => {
  for (const overrides of [
    { student: undefined }, { careerGoal: '  ' }, { careerGoal: 'a'.repeat(501) },
    { interests: ['  '] }, { interests: [null] }, { interests: null },
    { selfReportedSkills: [42] }, { selfReportedSkills: 'html' },
    { selfReportedSkills: ['a'.repeat(81)] },
    { interests: Array.from({ length: 21 }, (_, index) => `topic-${index}`) },
    { selfReportedSkills: Array.from({ length: 21 }, (_, index) => `skill-${index}`) }
  ]) {
    await assert.rejects(new LearningProfile(profile(overrides)).validate(), mongoose.Error.ValidationError);
  }
});

test('profile allows only known levels and strict integer weekly availability from 1 to 80', async () => {
  for (const experienceLevel of ['BEGINNER', 'INTERMEDIATE', 'ADVANCED']) {
    for (const weeklyAvailabilityHours of [1, 80]) {
      await new LearningProfile(profile({ experienceLevel, weeklyAvailabilityHours })).validate();
    }
  }
  for (const overrides of [
    { experienceLevel: 'EXPERT' }, { experienceLevel: undefined },
    { weeklyAvailabilityHours: 0 }, { weeklyAvailabilityHours: 81 },
    { weeklyAvailabilityHours: 1.5 }, { weeklyAvailabilityHours: '5' },
    { weeklyAvailabilityHours: undefined }
  ]) {
    await assert.rejects(new LearningProfile(profile(overrides)).validate(), mongoose.Error.ValidationError);
  }
});

test('conversation persists only bounded role-tagged messages and course references per student', async () => {
  const recommendedCourseId = new mongoose.Types.ObjectId();
  const input = conversation({ recommendedCourseIds: [recommendedCourseId] });
  const saved = await AIConversation.create(input);
  assert.equal(saved.messages[0].text, 'Help me choose a course');
  assert.ok(saved.messages[0].createdAt instanceof Date);
  assert.equal(String(saved.recommendedCourseIds[0]), String(recommendedCourseId));
  await assert.rejects(AIConversation.create(input), (error) => error.code === 11000);

  await new AIConversation(conversation({
    messages: Array.from({ length: 20 }, () => ({ role: 'ASSISTANT', text: 'Choose a course.' })),
    recommendedCourseIds: Array.from({ length: 5 }, () => new mongoose.Types.ObjectId())
  })).validate();
  for (const overrides of [
    { student: undefined }, { messages: [{ role: 'SYSTEM', text: 'Hidden instruction' }] },
    { messages: [null] }, { messages: null },
    { messages: [{ role: 'USER', text: '  ' }] },
    { messages: [{ role: 'USER', text: 'a'.repeat(2001) }] },
    { messages: Array.from({ length: 21 }, () => ({ role: 'USER', text: 'Hello' })) },
    { recommendedCourseIds: Array.from({ length: 6 }, () => new mongoose.Types.ObjectId()) },
    { recommendedCourseIds: ['invented-course'] }, { recommendedCourseIds: [null] }
  ]) {
    await assert.rejects(new AIConversation(conversation(overrides)).validate(), mongoose.Error.ValidationError);
  }
});

test('AI records reject non-allowlisted credential, payload, and private context fields', () => {
  for (const field of ['prompt', 'response', 'apiKey', 'password', 'email', 'jwt', 'cookie', 'payment', 'objectKey', 'assignment']) {
    assert.throws(() => new LearningProfile(profile({ [field]: 'private' })), mongoose.Error.StrictModeError);
    assert.throws(() => new AIConversation(conversation({ [field]: 'private' })), mongoose.Error.StrictModeError);
    assert.throws(() => new AIUsageLog(usage({ [field]: 'private' })), mongoose.Error.StrictModeError);
  }
  const unsafeNested = new AIConversation(conversation({ messages: [{ role: 'USER', text: 'Hello', prompt: 'private' }] }));
  assert.ok(unsafeNested.validateSync());
});

test('usage log validates only operational categories and optional strict nonnegative token counts', async () => {
  await new AIUsageLog(usage({ inputTokens: undefined, outputTokens: undefined })).validate();
  for (const overrides of [
    { student: undefined }, { feature: 'PAYMENT' }, { provider: 'https://provider.example' },
    { modelAlias: '  ' }, { modelAlias: 'a'.repeat(81) }, { outcome: 'raw-provider-error' },
    { inputTokens: -1 }, { outputTokens: 0.5 }, { inputTokens: '25' }
  ]) {
    await assert.rejects(new AIUsageLog(usage(overrides)).validate(), mongoose.Error.ValidationError);
  }
});

test('usage logs are append-only through document, query, replacement, delete, and bulk APIs', async () => {
  const saved = await AIUsageLog.create(usage());
  await assert.rejects(saved.save(), /append-only/i);
  saved.outputTokens = 99;
  await assert.rejects(saved.save(), /immutable/i);
  const filter = { _id: saved._id };
  for (const operation of [
    () => AIUsageLog.updateOne(filter, { $set: { outputTokens: 99 } }),
    () => AIUsageLog.updateMany(filter, { $set: { outcome: 'ERROR' } }),
    () => AIUsageLog.findOneAndUpdate(filter, { $set: { outputTokens: 99 } }),
    () => AIUsageLog.replaceOne(filter, usage()),
    () => AIUsageLog.findOneAndReplace(filter, usage()),
    () => AIUsageLog.deleteOne(filter),
    () => AIUsageLog.deleteMany(filter),
    () => AIUsageLog.findOneAndDelete(filter),
    () => saved.deleteOne(),
    () => AIUsageLog.bulkWrite([{ updateOne: { filter, update: { $set: { outputTokens: 99 } } } }])
  ]) {
    await assert.rejects(operation(), /append-only/i);
  }
  const persisted = await AIUsageLog.findById(saved._id).lean();
  assert.equal(persisted.outputTokens, 10);
  assert.deepEqual(Object.keys(persisted).sort(), [
    '_id', 'createdAt', 'feature', 'inputTokens', 'modelAlias', 'outcome', 'outputTokens', 'provider', 'student'
  ]);
});

test('course metadata stays optional for existing documents and separates course and skill prerequisites', async () => {
  const legacy = await Course.create(course());
  assert.equal(legacy.learningMetadata, undefined);
  await Course.hydrate({ ...legacy.toObject(), instructor: undefined }).validate();
  const prerequisite = new mongoose.Types.ObjectId();
  const saved = await Course.create(course({ learningMetadata: {
    level: 'BEGINNER', skills: [' HTML ', 'html', ' CSS '],
    prerequisites: { courses: [prerequisite], skills: [' JavaScript ', 'javascript'] }
  } }));
  assert.deepEqual([...saved.learningMetadata.skills], ['html', 'css']);
  assert.deepEqual([...saved.learningMetadata.prerequisites.skills], ['javascript']);
  assert.equal(String(saved.learningMetadata.prerequisites.courses[0]), String(prerequisite));
  await new Course(course({ learningMetadata: {} })).validate();
  for (const learningMetadata of [
    { level: 'EXPERT' }, { skills: ['  '] }, { skills: [null] }, { skills: ['a'.repeat(81)] },
    { skills: Array.from({ length: 21 }, (_, index) => `skill-${index}`) },
    { prerequisites: { courses: ['not-a-course'] } },
    { prerequisites: { courses: [null] } },
    { prerequisites: { courses: Array.from({ length: 21 }, () => new mongoose.Types.ObjectId()) } },
    { prerequisites: { skills: ['a'.repeat(81)] } }
  ]) {
    await assert.rejects(new Course(course({ learningMetadata })).validate(), mongoose.Error.ValidationError);
  }
});

test('query mutations cannot exceed conversation collection bounds', async () => {
  const saved = await AIConversation.create(conversation({
    messages: Array.from({ length: 20 }, () => ({ role: 'USER', text: 'Hello' })),
    recommendedCourseIds: Array.from({ length: 5 }, () => new mongoose.Types.ObjectId())
  }));
  const filter = { _id: saved._id };
  const extraMessage = { role: 'USER', text: 'One too many' };
  for (const operation of [
    () => AIConversation.updateOne(filter, { $push: { messages: extraMessage } }, { runValidators: true }),
    () => AIConversation.updateMany(filter, { $addToSet: { recommendedCourseIds: new mongoose.Types.ObjectId() } }, { runValidators: true }),
    () => AIConversation.findOneAndUpdate(filter, { $set: { 'messages.20': extraMessage } }),
    () => AIConversation.updateOne(filter, [{ $set: { messages: Array(21).fill(extraMessage) } }]),
    () => AIConversation.replaceOne(filter, conversation({ student: saved.student, messages: Array(21).fill(extraMessage) }), { runValidators: false }),
    () => AIConversation.findOneAndReplace(filter, conversation({ student: saved.student, messages: Array(21).fill(extraMessage) }), { runValidators: false }),
    () => AIConversation.bulkWrite([{ updateOne: { filter, update: { $push: { messages: extraMessage } } } }])
  ]) {
    await assert.rejects(operation(), /document.*save/i);
  }
  const persisted = await AIConversation.findById(saved._id).lean();
  assert.equal(persisted.messages.length, 20);
  assert.equal(persisted.recommendedCourseIds.length, 5);
});

test('query mutations cannot exceed either profile tag collection bound', async () => {
  const saved = await LearningProfile.create(profile({
    interests: Array.from({ length: 20 }, (_, index) => `interest-${index}`),
    selfReportedSkills: Array.from({ length: 20 }, (_, index) => `skill-${index}`)
  }));
  const filter = { _id: saved._id };
  for (const operation of [
    () => LearningProfile.updateOne(filter, { $push: { interests: 'extra' } }, { runValidators: true }),
    () => LearningProfile.updateMany(filter, { $push: { selfReportedSkills: 'extra' } }, { runValidators: true }),
    () => LearningProfile.findOneAndUpdate(filter, { $set: { 'interests.20': 'extra' } }),
    () => LearningProfile.updateOne(filter, [{ $set: { selfReportedSkills: Array(21).fill('extra') } }]),
    () => LearningProfile.replaceOne(filter, profile({ student: saved.student, interests: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }), { runValidators: false }),
    () => LearningProfile.findOneAndReplace(filter, profile({ student: saved.student, interests: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }), { runValidators: false }),
    () => LearningProfile.bulkWrite([{ updateOne: { filter, update: { $push: { interests: 'extra' } } } }])
  ]) {
    await assert.rejects(operation(), /document.*save/i);
  }
  const persisted = await LearningProfile.findById(saved._id).lean();
  assert.equal(persisted.interests.length, 20);
  assert.equal(persisted.selfReportedSkills.length, 20);
});

test('query mutations cannot bypass learning metadata bounds while ordinary course updates still persist', async () => {
  const saved = await Course.create(course({ learningMetadata: {
    skills: Array.from({ length: 20 }, (_, index) => `skill-${index}`),
    prerequisites: {
      courses: Array.from({ length: 20 }, () => new mongoose.Types.ObjectId()),
      skills: Array.from({ length: 20 }, (_, index) => `required-${index}`)
    }
  } }));
  const filter = { _id: saved._id };
  const tooMany = Array.from({ length: 21 }, (_, index) => `skill-${index}`);
  for (const operation of [
    () => Course.updateOne(filter, { $push: { 'learningMetadata.skills': 'extra' } }, { runValidators: true }),
    () => Course.updateMany(filter, { $addToSet: { 'learningMetadata.prerequisites.courses': new mongoose.Types.ObjectId() } }, { runValidators: true }),
    () => Course.findOneAndUpdate(filter, { $push: { 'learningMetadata.prerequisites.skills': 'extra' } }, { runValidators: true }),
    () => Course.updateOne(filter, { $set: { 'learningMetadata.skills.20': 'extra' } }),
    () => Course.updateOne(filter, { $rename: { category: 'learningMetadata.skills' } }),
    () => Course.updateOne(filter, [{ $set: { learningMetadata: { skills: tooMany } } }]),
    () => Course.replaceOne(filter, course({ learningMetadata: { skills: tooMany } }), { runValidators: false }),
    () => Course.findOneAndReplace(filter, course({ learningMetadata: { skills: tooMany } }), { runValidators: false }),
    () => Course.bulkWrite([{ updateOne: { filter, update: { $push: { 'learningMetadata.skills': 'extra' } } } }])
  ]) {
    await assert.rejects(operation(), /document.*save/i);
  }
  await Course.updateOne(filter, { $set: { category: 'Updated category' } });
  const persisted = await Course.findById(saved._id).lean();
  assert.equal(persisted.category, 'Updated category');
  assert.equal(persisted.learningMetadata.skills.length, 20);
  assert.equal(persisted.learningMetadata.prerequisites.courses.length, 20);
  assert.equal(persisted.learningMetadata.prerequisites.skills.length, 20);
});

test('document mutation deduplicates normalized profile tags before persistence', async () => {
  const saved = await LearningProfile.create(profile({ interests: ['html'], selfReportedSkills: ['css'] }));
  saved.interests.push(' HTML ');
  saved.selfReportedSkills.push(' CSS ');
  await saved.validate();
  assert.deepEqual([...saved.interests], ['html']);
  assert.deepEqual([...saved.selfReportedSkills], ['css']);
  await saved.save();
  const persisted = await LearningProfile.findById(saved._id).lean();
  assert.deepEqual(persisted.interests, ['html']);
  assert.deepEqual(persisted.selfReportedSkills, ['css']);
});

test('course query upserts cannot insert unvalidated learning metadata from equality filters', async () => {
  const skills = Array.from({ length: 21 }, (_, index) => `skill-${index}`);
  for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
    const id = new mongoose.Types.ObjectId();
    const filter = { _id: id, 'learningMetadata.skills': skills };
    const update = operation.includes('Replace') || operation === 'replaceOne'
      ? course()
      : { $set: course() };
    await assert.rejects(Course[operation](filter, update, { upsert: true, runValidators: true }), /document.*save/i);
    assert.equal(await Course.exists({ _id: id }), null);
  }
});

test('course bulk upserts cannot insert unvalidated learning metadata from equality filters', async () => {
  const skills = Array.from({ length: 21 }, (_, index) => `skill-${index}`);
  for (const operation of ['updateOne', 'updateMany', 'replaceOne']) {
    const id = new mongoose.Types.ObjectId();
    const mutation = {
      filter: { _id: id, $and: [{ 'learningMetadata.skills': { $eq: skills } }] },
      upsert: true,
      ...(operation === 'replaceOne' ? { replacement: course() } : { update: { $set: course() } })
    };
    await assert.rejects(Course.bulkWrite([{ [operation]: mutation }]), /document.*save/i);
    assert.equal(await Course.exists({ _id: id }), null);
  }

  const saved = await Course.create(course({ learningMetadata: { skills: ['html'] } }));
  await Course.bulkWrite([{ updateOne: {
    filter: { _id: saved._id, 'learningMetadata.skills': 'html' },
    update: { $set: { category: 'Updated via bulk' } },
    upsert: false
  } }]);
  const persisted = await Course.findById(saved._id).lean();
  assert.equal(persisted.category, 'Updated via bulk');
  assert.deepEqual(persisted.learningMetadata.skills, ['html']);
});

test('document mutation deduplicates normalized course and prerequisite skills before persistence', async () => {
  const saved = await Course.create(course({ learningMetadata: {
    skills: ['html'], prerequisites: { skills: ['css'] }
  } }));
  saved.learningMetadata.skills.push(' HTML ');
  saved.learningMetadata.prerequisites.skills.push(' CSS ');
  await saved.validate();
  assert.deepEqual([...saved.learningMetadata.skills], ['html']);
  assert.deepEqual([...saved.learningMetadata.prerequisites.skills], ['css']);
  await saved.save();
  const persisted = await Course.findById(saved._id).lean();
  assert.deepEqual(persisted.learningMetadata.skills, ['html']);
  assert.deepEqual(persisted.learningMetadata.prerequisites.skills, ['css']);
});
