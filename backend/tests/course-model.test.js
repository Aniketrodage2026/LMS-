const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Course = require('../models/course.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

function validCourse(overrides = {}) {
  return {
    title: 'A valid course title',
    description: 'A course description',
    category: 'Programming',
    instructor: new mongoose.Types.ObjectId(),
    thumbnail: {
      public_id: 'thumbnail-id',
      secure_url: 'https://example.com/thumbnail.jpg'
    },
    ...overrides
  };
}

function validLecture(overrides = {}) {
  return {
    title: 'Lecture title',
    description: 'Lecture description',
    lecture: {
      public_id: 'lecture-id',
      secure_url: 'https://example.com/lecture.mp4'
    },
    ...overrides
  };
}

function Enrollment() {
  try {
    return require('../models/enrollment.schema');
  } catch (error) {
    assert.fail(`Enrollment model is unavailable: ${error.message}`);
  }
}

test.before(async () => {
  await connectTestDb();
});

test.after(async () => {
  await disconnectTestDb();
});

test('paid courses reject zero and fractional paise prices', async () => {
  const zeroPrice = new Course(validCourse({ accessType: 'PAID', price: 0 }));
  await assert.rejects(
    () => zeroPrice.validate(),
    (error) => error.errors.price.message === 'Paid courses require a positive price'
  );

  const fractionalPrice = new Course(validCourse({ accessType: 'PAID', price: 1.5 }));
  await assert.rejects(
    () => fractionalPrice.validate(),
    (error) => /integer/i.test(error.errors.price.message)
  );
});

test('free courses require a zero price in paise', async () => {
  const course = new Course(validCourse({ price: 1 }));

  await assert.rejects(
    () => course.validate(),
    (error) => error.errors.price.message === 'Free courses must have a price of 0'
  );
});

test('valid free and paid course pricing validates', async () => {
  await new Course(validCourse()).validate();
  await new Course(validCourse({ accessType: 'PAID', price: 49900 })).validate();
});

test('a persisted course applies access, pricing, publication, timestamp, and lecture defaults', async () => {
  const course = await Course.create(validCourse({
    lectures: [validLecture()]
  }));

  assert.equal(course.accessType, 'FREE');
  assert.equal(course.price, 0);
  assert.equal(course.currency, 'INR');
  assert.equal(course.status, 'PUBLISHED');
  assert.ok(course.createdAt instanceof Date);
  assert.ok(course.updatedAt instanceof Date);
  assert.equal(course.lectures[0].isPreview, false);
});

test('optimistic concurrency rejects a stale price save after the course becomes free', async () => {
  const course = await Course.create(validCourse({ accessType: 'PAID', price: 100 }));
  const firstCopy = await Course.findById(course._id);
  const staleCopy = await Course.findById(course._id);

  firstCopy.accessType = 'FREE';
  firstCopy.price = 0;
  await firstCopy.save();

  staleCopy.price = 200;
  await assert.rejects(
    () => staleCopy.save(),
    (error) => error && error.name === 'VersionError'
  );

  const persisted = await Course.findById(course._id).lean();
  assert.equal(persisted.accessType, 'FREE');
  assert.equal(persisted.price, 0);
});

test('a course rejects more than one preview lecture', async () => {
  const course = new Course(validCourse({
    lectures: [
      validLecture({ title: 'First preview', isPreview: true }),
      validLecture({ title: 'Second preview', isPreview: true })
    ]
  }));

  await assert.rejects(
    () => course.validate(),
    (error) => error.errors.lectures.message === 'A course can have only one preview lecture'
  );
});

test('a course accepts zero or one preview lecture', async () => {
  await new Course(validCourse({ lectures: [] })).validate();
  await new Course(validCourse({ lectures: [validLecture({ title: 'Preview', isPreview: true })] })).validate();
});

test('a lecture position rejects a negative number', async () => {
  const course = new Course(validCourse({
    lectures: [validLecture({ position: -1 })]
  }));

  await assert.rejects(
    () => course.validate(),
    (error) => /minimum allowed value/.test(error.errors['lectures.0.position'].message)
  );
});

test('a lecture position rejects a fractional number', async () => {
  const course = new Course(validCourse({
    lectures: [validLecture({ position: 1.5 })]
  }));

  await assert.rejects(
    () => course.validate(),
    (error) => error.errors['lectures.0.position'].message === 'Lecture position must be a nonnegative integer'
  );
});

test('a lecture duration rejects a negative number', async () => {
  const course = new Course(validCourse({
    lectures: [validLecture({ durationSeconds: -1 })]
  }));

  await assert.rejects(
    () => course.validate(),
    (error) => /minimum allowed value/.test(error.errors['lectures.0.durationSeconds'].message)
  );
});

test('course requires description and an instructor User reference', async () => {
  const noDescription = new Course(validCourse({ description: undefined }));
  await assert.rejects(() => noDescription.validate(), (error) => Boolean(error.errors.description));

  const noInstructor = new Course(validCourse({ instructor: undefined }));
  await assert.rejects(() => noInstructor.validate(), (error) => Boolean(error.errors.instructor));

  const instructor = Course.schema.path('instructor');
  assert.equal(instructor.options.ref, 'User');
  assert.equal(instructor.options.index, true);
  assert.equal(Course.schema.path('createdBy'), undefined);
});

test('enrollment rejects a duplicate student and course pair while allowing different pairs', async () => {
  const EnrollmentModel = Enrollment();
  await EnrollmentModel.init();

  const student = new mongoose.Types.ObjectId();
  const course = new mongoose.Types.ObjectId();
  await EnrollmentModel.create({ student, course, source: 'FREE_ENROLLMENT' });

  await assert.rejects(
    () => EnrollmentModel.create({ student, course, source: 'FREE_ENROLLMENT' }),
    (error) => error && error.code === 11000
  );

  await EnrollmentModel.create({
    student: new mongoose.Types.ObjectId(),
    course,
    source: 'FREE_ENROLLMENT'
  });
  await EnrollmentModel.create({
    student,
    course: new mongoose.Types.ObjectId(),
    source: 'PURCHASE'
  });
});

test('enrollment persists source and defaults, and exposes only the required indexes', async () => {
  const EnrollmentModel = Enrollment();
  const enrollment = await EnrollmentModel.create({
    student: new mongoose.Types.ObjectId(),
    course: new mongoose.Types.ObjectId(),
    source: 'PURCHASE'
  });

  assert.equal(enrollment.source, 'PURCHASE');
  assert.equal(enrollment.status, 'ACTIVE');
  assert.ok(enrollment.enrolledAt instanceof Date);
  assert.equal(EnrollmentModel.schema.path('student').options.ref, 'User');
  assert.equal(EnrollmentModel.schema.path('course').options.ref, 'Course');

  const indexes = EnrollmentModel.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.student === 1 && keys.course === 1 && options.unique));
  assert.ok(indexes.some(([keys]) => keys.student === 1 && keys.status === 1));
  assert.ok(indexes.some(([keys]) => keys.course === 1 && keys.status === 1));
  assert.equal(indexes.length, 3);
});
