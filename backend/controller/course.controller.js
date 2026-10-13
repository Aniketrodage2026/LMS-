const mongoose = require('mongoose');
const cloudinary = require('cloudinary');
const fs = require('fs/promises');
const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const { canLearnCourse, getPreviewLecture } = require('../services/course-access.service');
const { recordAuditSafely } = require('../services/audit-log.service');

const validObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
async function removeLocalFile(file) { if (file && file.path) await fs.unlink(file.path).catch(() => undefined); }
const courseUpdateFields = new Set(['title', 'description', 'category', 'accessType', 'price', 'currency', 'status']);

async function audit(req, action, type, id, summary) {
  return recordAuditSafely({
    actor: req.user._id,
    action,
    target: { type, id },
    summary,
    requestId: req.requestId
  });
}

async function uploadMedia(file, options) {
  try {
    const result = await cloudinary.v2.uploader.upload(file.path, options);
    if (!result || !result.public_id || !result.secure_url) throw new Error('Missing upload result');
    return result;
  } catch {
    throw new AppError('We could not upload this file. Please try again shortly.', 500, 'UPLOAD_UNAVAILABLE');
  }
}

function courseRequestError(error) {
  if (error instanceof AppError) return error;
  if (error.name === 'ValidationError') {
    const approvedMessages = new Set([
      'Title of course is required', 'Title must be atleast 8 char', 'Title must be less than 50 char',
      'Description is required', 'Category is required', 'Price must be an integer number of paise',
      'Free courses must have a price of 0', 'Paid courses require a positive price',
      'A course can have only one preview lecture', 'Lecture position must be a nonnegative integer'
    ]);
    const message = Object.values(error.errors || {}).map(field => field.message).find(value => approvedMessages.has(value));
    return new AppError(message || 'Check the course details and try again.', 422, 'COURSE_INVALID_REQUEST');
  }
  return new AppError('We could not complete this course request. Please try again shortly.', 500, 'COURSE_UNAVAILABLE');
}

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
    if (!query) return next(new AppError('Invalid accessType query', 400, 'COURSE_INVALID_REQUEST'));
    const courses = await Course.find(query).select('-lectures');
    return res.status(200).json({ success: true, message: 'All courses', courses });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.getCourseById = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' }).select('-lectures');
    if (!course) return next(new AppError('Course not found', 404, 'COURSE_NOT_FOUND'));
    return res.status(200).json({ success: true, course });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.getPreviewLectureByCourseId = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' });
    if (!course) return next(new AppError('Course not found', 404, 'COURSE_NOT_FOUND'));
    const lecture = getPreviewLecture(course);
    if (!lecture) return next(new AppError('Lecture not found', 404, 'COURSE_LECTURE_NOT_FOUND'));
    return res.status(200).json({
      success: true,
      lecture: {
        id: String(lecture._id),
        title: lecture.title,
        description: lecture.description,
        secureUrl: lecture.lecture?.secure_url,
        durationSeconds: Number(lecture.durationSeconds ?? 0),
        isPreview: Boolean(lecture.isPreview)
      }
    });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.getLectureByCourseId = async (req, res, next) => {
  try {
    const { courseId, lectureId } = req.params;
    if (!validObjectId(courseId) || !validObjectId(lectureId)) return next(new AppError('Invalid courseId or lectureId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = await Course.findById(courseId);
    if (!course) return next(new AppError('Course not found', 404, 'COURSE_NOT_FOUND'));
    const lecture = course.lectures.id(lectureId);
    if (!lecture) return next(new AppError('Lecture not found', 404, 'COURSE_LECTURE_NOT_FOUND'));
    if (!await canLearnCourse(req.user, course)) {
      const revoked = await Enrollment.exists({ student: req.user._id, course: course._id, status: 'REVOKED' });
      if (revoked) return next(new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED'));
      const code = req.user.role !== 'STUDENT' ? 'COURSE_ACCESS_DENIED' : course.accessType === 'PAID' ? 'COURSE_PURCHASE_REQUIRED' : 'COURSE_ENROLLMENT_REQUIRED';
      return next(new AppError('Purchase or enrol in this course to access this lesson', 403, code));
    }
    if (lecture.isPreview) return next(new AppError('Lecture not found', 404, 'COURSE_LECTURE_NOT_FOUND'));
    return res.status(200).json({ success: true, lecture });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.enrollInFreeCourse = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));

    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' });
    if (!course) return next(new AppError('Course not found', 404, 'COURSE_NOT_FOUND'));
    if (course.accessType === 'PAID') {
      return next(new AppError('This course requires payment', 400, 'COURSE_PURCHASE_REQUIRED'));
    }

    const membershipQuery = { student: req.user._id, course: course._id };
    const existingEnrollment = await Enrollment.findOne(membershipQuery);
    if (existingEnrollment && existingEnrollment.status === 'REVOKED') {
      return next(new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED'));
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
      return next(new AppError('Your access to this course has been revoked', 403, 'COURSE_ACCESS_REVOKED'));
    }

    return res.status(result.upsertedCount === 1 ? 201 : 200).json({ success: true, enrollment });
  } catch (error) {
    return next(new AppError('Unable to enroll in course', 500, 'COURSE_ENROLLMENT_UNAVAILABLE'));
  }
};

exports.createCourse = async (req, res, next) => {
  let uploadedThumbnail;
  try {
    const { title, description, category, accessType, price } = req.body;
    if (!title || !description || !category) {
      await removeLocalFile(req.file);
      return next(new AppError('All fields are required', 400, 'COURSE_INVALID_REQUEST'));
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
      const result = await uploadMedia(req.file, { folder: 'lms', height: 250, width: 250, gravity: 'faces', crop: 'fill' });
      uploadedThumbnail = { public_id: result.public_id, secure_url: result.secure_url };
      course.thumbnail = uploadedThumbnail;
      await removeLocalFile(req.file);
    }
    await course.save();
    await audit(req, 'COURSE_CREATED', 'COURSE', course._id);
    return res.status(200).json({ success: true, message: 'Course created successfully', course });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedThumbnail) await cloudinary.v2.uploader.destroy(uploadedThumbnail.public_id).catch(() => undefined);
    return next(courseRequestError(error));
  }
};

exports.updateCourse = async (req, res, next) => {
  let uploadedThumbnail;
  let savedCourse = false;
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course does not exist', 404, 'COURSE_NOT_FOUND'));
    const previousStatus = course.status;
    const updateData = allowedCourseUpdates(req.body);
    const oldThumbnail = course.thumbnail && {
      public_id: course.thumbnail.public_id,
      secure_url: course.thumbnail.secure_url
    };
    if (req.file) {
      const result = await uploadMedia(req.file, { folder: 'lms', width: 250, height: 250, gravity: 'faces', crop: 'fill' });
      uploadedThumbnail = { public_id: result.public_id, secure_url: result.secure_url };
      updateData.thumbnail = uploadedThumbnail;
      await removeLocalFile(req.file);
    }
    course.set(updateData);
    await course.save();
    savedCourse = true;
    await audit(req, previousStatus !== 'PUBLISHED' && course.status === 'PUBLISHED' ? 'COURSE_PUBLISHED' : 'COURSE_UPDATED', 'COURSE', course._id);
    if (uploadedThumbnail && oldThumbnail && oldThumbnail.public_id) await cloudinary.v2.uploader.destroy(oldThumbnail.public_id);
    return res.status(200).json({ success: true, message: 'Course updated successfully', course });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedThumbnail && !savedCourse) await cloudinary.v2.uploader.destroy(uploadedThumbnail.public_id).catch(() => undefined);
    return next(courseRequestError(error));
  }
};

exports.deleteCourse = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course does not exist', 404, 'COURSE_NOT_FOUND'));
    const assets = [
      course.thumbnail && course.thumbnail.public_id && { publicId: course.thumbnail.public_id },
      ...course.lectures.map((lecture) => lecture.lecture && lecture.lecture.public_id && {
        publicId: lecture.lecture.public_id,
        options: { resource_type: 'video' }
      })
    ].filter(Boolean);
    const deletion = await Course.deleteOne({ _id: course._id, __v: course.__v });
    if (deletion.deletedCount !== 1) return next(new AppError('Course was modified before it could be deleted', 409, 'COURSE_UPDATE_CONFLICT'));
    await audit(req, 'COURSE_DELETED', 'COURSE', course._id);
    const cleanup = await Promise.allSettled(assets.map(({ publicId, options }) => cloudinary.v2.uploader.destroy(publicId, options)));
    if (cleanup.some((result) => result.status === 'rejected')) {
      return next(new AppError('Course deleted but one or more media assets could not be removed', 500, 'COURSE_MEDIA_UNAVAILABLE'));
    }
    return res.status(200).json({ success: true, message: 'Course deleted successfully' });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.addLectureToCourseById = async (req, res, next) => {
  let uploadedLecture;
  try {
    const { courseId } = req.params;
    const { title, description } = req.body;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    if (!title || !description) {
      await removeLocalFile(req.file);
      return next(new AppError('Title, description, and video file are required', 400, 'COURSE_INVALID_REQUEST'));
    }
    if (!req.file) return next(new AppError('Choose a video file to upload.', 400, 'UPLOAD_FILE_REQUIRED'));
    const course = req.course || await Course.findById(courseId);
    if (!course) { await removeLocalFile(req.file); return next(new AppError('Course with given ID does not exist', 404, 'COURSE_NOT_FOUND')); }
    const result = await uploadMedia(req.file, { folder: 'lms', resource_type: 'video', chunk_size: 6000000 });
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
    const lecture = course.lectures[course.lectures.length - 1];
    await audit(req, 'LECTURE_CREATED', 'LECTURE', lecture._id);
    return res.status(200).json({ success: true, message: 'Lecture added successfully', lecture });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedLecture) await cloudinary.v2.uploader.destroy(uploadedLecture.public_id, { resource_type: 'video' }).catch(() => undefined);
    return next(courseRequestError(error));
  }
};

exports.deleteLectureFromCourse = async (req, res, next) => {
  try {
    const { courseId, lectureId } = req.params;
    if (!validObjectId(courseId) || !validObjectId(lectureId)) return next(new AppError('Invalid courseId or lectureId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course not found', 404, 'COURSE_NOT_FOUND'));
    const lecture = course.lectures.id(lectureId);
    if (!lecture) return next(new AppError('Lecture not found', 404, 'COURSE_LECTURE_NOT_FOUND'));
    course.lectures = course.lectures.filter((item) => item._id.toString() !== lectureId);
    course.numberOflectures = course.lectures.length;
    await course.save();
    await audit(req, 'LECTURE_DELETED', 'LECTURE', lecture._id);
    if (lecture.lecture && lecture.lecture.public_id) await cloudinary.v2.uploader.destroy(lecture.lecture.public_id, { resource_type: 'video' });
    return res.status(200).json({ success: true, message: 'Lecture deleted Successfully' });
  } catch (error) { return next(courseRequestError(error)); }
};
