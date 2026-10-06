const mongoose = require('mongoose');
const cloudinary = require('cloudinary');
const fs = require('fs/promises');
const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const { canLearnCourse, getPreviewLecture } = require('../services/course-access.service');

const validObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
async function removeLocalFile(file) { if (file && file.path) await fs.unlink(file.path).catch(() => undefined); }
const courseUpdateFields = new Set(['title', 'description', 'category', 'accessType', 'price', 'currency', 'status']);

function allowedCourseUpdates(body) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => courseUpdateFields.has(key)));
}

function publicCourseQuery(req) {
  const query = { status: 'PUBLISHED' };
  if (req.query.accessType !== undefined) {
    if (!['FREE', 'PAID'].includes(req.query.accessType)) return null;
    query.accessType = req.query.accessType;
  }
  if (req.query.category !== undefined) query.category = req.query.category;
  return query;
}

exports.getAllCourses = async (req, res, next) => {
  try {
    const query = publicCourseQuery(req);
    if (!query) return next(new AppError('Invalid accessType query', 400));
    const courses = await Course.find(query).select('-lectures');
    return res.status(200).json({ success: true, message: 'All courses', courses });
  } catch (error) { return next(new AppError(error.message, 500)); }
};

exports.getCourseById = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400));
    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' }).select('-lectures');
    if (!course) return next(new AppError('Course not found', 404));
    return res.status(200).json({ success: true, course });
  } catch (error) { return next(new AppError(error.message, 500)); }
};

exports.getPreviewLectureByCourseId = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400));
    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' });
    if (!course) return next(new AppError('Course not found', 404));
    const lecture = getPreviewLecture(course);
    if (!lecture) return next(new AppError('Lecture not found', 404));
    return res.status(200).json({ success: true, lecture });
  } catch (error) { return next(new AppError(error.message, 500)); }
};

exports.getLectureByCourseId = async (req, res, next) => {
  try {
    const { courseId, lectureId } = req.params;
    if (!validObjectId(courseId) || !validObjectId(lectureId)) return next(new AppError('Invalid courseId or lectureId format', 400));
    const course = await Course.findById(courseId);
    if (!course) return next(new AppError('Course not found', 404));
    const lecture = course.lectures.id(lectureId);
    if (!lecture) return next(new AppError('Lecture not found', 404));
    if (!await canLearnCourse(req.user, course)) return next(new AppError('Purchase or enrol in this course to access this lesson', 403));
    if (lecture.isPreview) return next(new AppError('Lecture not found', 404));
    return res.status(200).json({ success: true, lecture });
  } catch (error) { return next(new AppError(error.message, 500)); }
};

exports.enrollInFreeCourse = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400));

    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' });
    if (!course) return next(new AppError('Course not found', 404));
    if (course.accessType === 'PAID') {
      return res.status(400).json({ success: false, message: 'This course requires payment' });
    }

    const membershipQuery = { student: req.user._id, course: course._id };
    const existingEnrollment = await Enrollment.findOne(membershipQuery);
    if (existingEnrollment && existingEnrollment.status === 'REVOKED') {
      return res.status(403).json({ success: false, message: 'Your access to this course has been revoked' });
    }
    if (existingEnrollment) {
      return res.status(200).json({ success: true, enrollment: existingEnrollment });
    }

    const result = await Enrollment.updateOne(
      membershipQuery,
      {
        $setOnInsert: {
          source: 'FREE_ENROLLMENT',
          status: 'ACTIVE',
          enrolledAt: new Date()
        }
      },
      { upsert: true }
    );
    const enrollment = await Enrollment.findOne(membershipQuery);
    if (!enrollment) throw new Error('Enrollment was not created');
    if (enrollment.status === 'REVOKED') {
      return res.status(403).json({ success: false, message: 'Your access to this course has been revoked' });
    }

    return res.status(result.upsertedCount === 1 ? 201 : 200).json({ success: true, enrollment });
  } catch (error) {
    return next(new AppError('Unable to enroll in course', 500));
  }
};

exports.createCourse = async (req, res, next) => {
  let uploadedThumbnail;
  try {
    const { title, description, category, accessType, price } = req.body;
    if (!title || !description || !category) {
      await removeLocalFile(req.file);
      return next(new AppError('All fields are required', 400));
    }
    const course = new Course({
      title,
      description,
      category,
      accessType,
      price,
      instructor: req.user._id,
      thumbnail: { public_id: 'Dummy_id', secure_url: 'Dummy_url' }
    });
    if (req.file) {
      const result = await cloudinary.v2.uploader.upload(req.file.path, { folder: 'lms', height: 250, width: 250, gravity: 'faces', crop: 'fill' });
      uploadedThumbnail = { public_id: result.public_id, secure_url: result.secure_url };
      course.thumbnail = uploadedThumbnail;
      await removeLocalFile(req.file);
    }
    await course.save();
    return res.status(200).json({ success: true, message: 'Course created successfully', course });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedThumbnail) await cloudinary.v2.uploader.destroy(uploadedThumbnail.public_id).catch(() => undefined);
    return next(new AppError(error.message, error.name === 'ValidationError' ? 422 : 500));
  }
};

exports.updateCourse = async (req, res, next) => {
  let uploadedThumbnail;
  let savedCourse = false;
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course does not exist', 404));
    const updateData = allowedCourseUpdates(req.body);
    const oldThumbnail = course.thumbnail && {
      public_id: course.thumbnail.public_id,
      secure_url: course.thumbnail.secure_url
    };
    if (req.file) {
      const result = await cloudinary.v2.uploader.upload(req.file.path, { folder: 'lms', width: 250, height: 250, gravity: 'faces', crop: 'fill' });
      uploadedThumbnail = { public_id: result.public_id, secure_url: result.secure_url };
      updateData.thumbnail = uploadedThumbnail;
      await removeLocalFile(req.file);
    }
    course.set(updateData);
    await course.save();
    savedCourse = true;
    if (uploadedThumbnail && oldThumbnail && oldThumbnail.public_id) await cloudinary.v2.uploader.destroy(oldThumbnail.public_id);
    return res.status(200).json({ success: true, message: 'Course updated successfully', course });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedThumbnail && !savedCourse) await cloudinary.v2.uploader.destroy(uploadedThumbnail.public_id).catch(() => undefined);
    return next(new AppError(error.message, error.name === 'ValidationError' ? 422 : 500));
  }
};

exports.deleteCourse = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course does not exist', 404));
    const assets = [
      course.thumbnail && course.thumbnail.public_id && { publicId: course.thumbnail.public_id },
      ...course.lectures.map((lecture) => lecture.lecture && lecture.lecture.public_id && {
        publicId: lecture.lecture.public_id,
        options: { resource_type: 'video' }
      })
    ].filter(Boolean);
    const deletion = await Course.deleteOne({ _id: course._id, __v: course.__v });
    if (deletion.deletedCount !== 1) return next(new AppError('Course was modified before it could be deleted', 409));
    const cleanup = await Promise.allSettled(assets.map(({ publicId, options }) => cloudinary.v2.uploader.destroy(publicId, options)));
    if (cleanup.some((result) => result.status === 'rejected')) {
      return next(new AppError('Course deleted but one or more media assets could not be removed', 500));
    }
    return res.status(200).json({ success: true, message: 'Course deleted successfully' });
  } catch (error) { return next(new AppError(error.message, 500)); }
};

exports.addLectureToCourseById = async (req, res, next) => {
  let uploadedLecture;
  try {
    const { courseId } = req.params;
    const { title, description } = req.body;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400));
    if (!title || !description || !req.file) {
      await removeLocalFile(req.file);
      return next(new AppError('Title, description, and video file are required', 400));
    }
    const course = req.course || await Course.findById(courseId);
    if (!course) { await removeLocalFile(req.file); return next(new AppError('Course with given ID does not exist', 404)); }
    const result = await cloudinary.v2.uploader.upload(req.file.path, { folder: 'lms', resource_type: 'video', chunk_size: 6000000 });
    if (!result || !result.public_id || !result.secure_url) throw new Error('Video upload failed at Cloudinary');
    uploadedLecture = { public_id: result.public_id, secure_url: result.secure_url };
    await removeLocalFile(req.file);
    const isPreview = req.body.isPreview === true || req.body.isPreview === 'true';
    if (isPreview) course.lectures.forEach((item) => { item.isPreview = false; });
    course.lectures.push({
      title, description, lecture: uploadedLecture, isPreview,
      position: req.body.position === undefined || req.body.position === '' ? undefined : Number(req.body.position),
      durationSeconds: req.body.durationSeconds === undefined || req.body.durationSeconds === '' ? undefined : Number(req.body.durationSeconds)
    });
    course.numberOflectures = course.lectures.length;
    await course.save();
    return res.status(200).json({ success: true, message: 'Lecture added successfully', lecture: course.lectures[course.lectures.length - 1] });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedLecture) await cloudinary.v2.uploader.destroy(uploadedLecture.public_id, { resource_type: 'video' }).catch(() => undefined);
    return next(new AppError(error.message, error.name === 'ValidationError' ? 422 : 500));
  }
};

exports.deleteLectureFromCourse = async (req, res, next) => {
  try {
    const { courseId, lectureId } = req.params;
    if (!validObjectId(courseId) || !validObjectId(lectureId)) return next(new AppError('Invalid courseId or lectureId format', 400));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course not found', 404));
    const lecture = course.lectures.id(lectureId);
    if (!lecture) return next(new AppError('Lecture not found', 404));
    course.lectures = course.lectures.filter((item) => item._id.toString() !== lectureId);
    course.numberOflectures = course.lectures.length;
    await course.save();
    if (lecture.lecture && lecture.lecture.public_id) await cloudinary.v2.uploader.destroy(lecture.lecture.public_id, { resource_type: 'video' });
    return res.status(200).json({ success: true, message: 'Lecture deleted Successfully' });
  } catch (error) { return next(new AppError(error.message, 500)); }
};
