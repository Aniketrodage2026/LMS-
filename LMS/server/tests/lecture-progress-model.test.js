const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const LectureProgress = require('../models/lecture-progress.schema');
const { percentFor, recordProgress } = require('../services/learning-progress.service');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function progressValues(overrides = {}) {
  return {
    student: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    lectureId: new mongoose.Types.ObjectId(),
    durationSeconds: 300,
    ...overrides
  };
}

test.before(async () => {
  await connectTestDb();
  await LectureProgress.init();
});

test.after(async () => {
  await disconnectTestDb();
});

test('lecture progress applies defaults and declares immutable ownership and dashboard indexes', async () => {
  const progress = await LectureProgress.create(progressValues());

  assert.equal(progress.watchedSeconds, 0);
  assert.equal(progress.watchedPercent, 0);
  assert.equal(progress.completed, false);
  assert.equal(progress.completedAt, null);
  assert.ok(progress.lastWatchedAt instanceof Date);
  assert.ok(progress.createdAt instanceof Date);
  assert.equal(LectureProgress.schema.path('student').options.ref, 'User');
  assert.equal(LectureProgress.schema.path('course').options.ref, 'Course');
  assert.equal(LectureProgress.schema.path('student').options.immutable, true);
  assert.equal(LectureProgress.schema.path('course').options.immutable, true);
  assert.equal(LectureProgress.schema.path('lectureId').options.immutable, true);

  const indexes = LectureProgress.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.student === 1 && keys.lectureId === 1 && options.unique));
  assert.ok(indexes.some(([keys]) => keys.student === 1 && keys.course === 1));
  assert.ok(indexes.some(([keys]) => keys.student === 1 && keys.lastWatchedAt === -1));
});

test('lecture progress permits one record per student and lecture', async () => {
  const values = progressValues();
  await LectureProgress.create(values);

  await assert.rejects(
    () => LectureProgress.create(values),
    (error) => error && error.code === 11000
  );
});

test('lecture progress rejects negative watched time and percent outside 0 through 100', async () => {
  await assert.rejects(
    () => LectureProgress.create(progressValues({ watchedSeconds: -1 })),
    (error) => Boolean(error.errors.watchedSeconds)
  );
  await assert.rejects(
    () => LectureProgress.create(progressValues({ watchedPercent: 101 })),
    (error) => Boolean(error.errors.watchedPercent)
  );
});

test('lecture progress percentage rounds to two decimals and never exceeds 100', () => {
  assert.equal(percentFor(1, 3), 33.33);
  assert.equal(percentFor(301, 300), 100);
  assert.equal(percentFor(0, 0), 0);
});

test('lecture progress service keeps saved progress monotonic and retains first completion time', async () => {
  const studentId = new mongoose.Types.ObjectId();
  const courseId = new mongoose.Types.ObjectId();
  const lectureId = new mongoose.Types.ObjectId();

  const first = await recordProgress({
    studentId,
    courseId,
    lectureId,
    watchedSeconds: 275,
    durationSeconds: 300
  });
  const completedAt = first.completedAt;

  const second = await recordProgress({
    studentId,
    courseId,
    lectureId,
    watchedSeconds: 120,
    durationSeconds: 300
  });

  assert.equal(first.watchedSeconds, 275);
  assert.equal(first.watchedPercent, 91.67);
  assert.equal(first.completed, true);
  assert.ok(completedAt instanceof Date);
  assert.equal(second.watchedSeconds, 275);
  assert.equal(second.watchedPercent, 91.67);
  assert.equal(second.completed, true);
  assert.equal(second.completedAt.getTime(), completedAt.getTime());
});

test('lecture progress service retains the first duration and derives percent from it after a delayed write', async () => {
  const studentId = new mongoose.Types.ObjectId();
  const courseId = new mongoose.Types.ObjectId();
  const lectureId = new mongoose.Types.ObjectId();

  await recordProgress({
    studentId,
    courseId,
    lectureId,
    watchedSeconds: 90,
    durationSeconds: 100
  });
  const delayed = await recordProgress({
    studentId,
    courseId,
    lectureId,
    watchedSeconds: 20,
    durationSeconds: 1000
  });

  assert.equal(delayed.watchedSeconds, 90);
  assert.equal(delayed.durationSeconds, 100);
  assert.equal(delayed.watchedPercent, 90);
  assert.equal(delayed.completed, true);
});

test('lecture progress service rejects non-numeric, non-finite, and invalid time ranges', async () => {
  const baseValues = {
    studentId: new mongoose.Types.ObjectId(),
    courseId: new mongoose.Types.ObjectId(),
    lectureId: new mongoose.Types.ObjectId(),
    watchedSeconds: 20,
    durationSeconds: 100
  };

  for (const overrides of [
    { watchedSeconds: '20' },
    { watchedSeconds: Infinity },
    { durationSeconds: '100' },
    { durationSeconds: NaN },
    { durationSeconds: 0 },
    { watchedSeconds: -1 },
    { watchedSeconds: 101, durationSeconds: 100 }
  ]) {
    await assert.rejects(
      () => recordProgress({ ...baseValues, ...overrides }),
      RangeError
    );
  }
});
