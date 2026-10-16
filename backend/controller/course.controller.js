const mongoose = require('mongoose');
const cloudinary = require('cloudinary');
const fs = require('fs/promises');
const AppError = require('../utils/appError');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const { canLearnCourse, getPreviewLecture } = require('../services/course-access.service');
const { recordAuditSafely } = require('../services/audit-log.service');
const { createVideoDeliveryService } = require('../services/video-delivery.service');
const { CLOUDINARY, R2, objectKeyFor } = require('../services/media-storage.service');
const { createMediaPresenter } = require('../services/media-presentation.service');
const { createRuntimeMediaStorageFactory } = require('../services/runtime-media-storage.service');
const { validateStoredUpload } = require('../services/media-validation.service');

const validObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
async function removeLocalFile(file) { if (file && file.path) await fs.unlink(file.path).catch(() => undefined); }
const courseUpdateFields = new Set(['title', 'description', 'category', 'accessType', 'price', 'currency', 'status']);
let mediaStorageFactory = createRuntimeMediaStorageFactory({ cloudinary });

function setMediaStorageFactoryForTests(factory) {
  const previous = mediaStorageFactory;
  mediaStorageFactory = factory;
  return () => { mediaStorageFactory = previous; };
}

function safeLectureDto(lecture, secureUrl) {
  return {
    id: String(lecture._id),
    title: lecture.title,
    description: lecture.description,
    durationSeconds: Number(lecture.durationSeconds ?? 0),
    isPreview: Boolean(lecture.isPreview),
    secureUrl
  };
}

function videoDeliveryService(mediaStorage) {
  return createVideoDeliveryService({
    cloudinary: cloudinary.v2,
    mediaStorage,
    authTokenKey: process.env.CLOUDINARY_AUTH_TOKEN_KEY,
    tokenDurationSeconds: Number(process.env.CLOUDINARY_AUTH_TOKEN_DURATION_SECONDS)
  });
}

async function audit(req, action, type, id, summary) {
  return recordAuditSafely({
    actor: req.user._id,
    action,
    target: { type, id },
    summary,
    requestId: req.requestId
  });
}

async function uploadLecture(file, course, isPreview) {
  let provider;
  let storage;
  try {
    ({ provider, storage } = configuredMediaStorage());
    const media = await validateStoredUpload(file, 'video');
    const delivery = videoDeliveryService(storage);
    const uploaded = await storage.uploadLocalFile({
      provider,
      localPath: file.path,
      key: provider === R2 ? `courses/${course._id}/lectures/${objectKeyFor({ category: 'lectures', extension: media.extension }).split('/').at(-1)}` : undefined,
      contentType: media.contentType,
      size: media.size,
      options: delivery.uploadOptions({ accessType: course.accessType, isPreview })
    });
    return {
      storage,
      media: {
        ...uploaded,
        deliveryType: delivery.deliveryTypeFor({ accessType: course.accessType, isPreview })
      }
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('We could not upload this file. Please try again shortly.', 500, 'UPLOAD_UNAVAILABLE');
  } finally {
    await removeLocalFile(file);
  }
}

function configuredMediaStorage() {
  return { provider: process.env.R2_ENABLED === 'true' ? R2 : CLOUDINARY, storage: mediaStorageFactory.get() };
}

async function presentCourse(course) {
  const value = course.toObject ? course.toObject() : { ...course };
  value.thumbnail = await createMediaPresenter({ storage: configuredMediaStorage().storage }).image(value.thumbnail);
  return value;
}

async function uploadThumbnail(file) {
  let provider;
  let storage;
  try {
    ({ provider, storage } = configuredMediaStorage());
    const media = await validateStoredUpload(file, 'image');
    return {
      storage,
      media: await storage.uploadLocalFile({
        provider,
        localPath: file.path,
        key: provider === R2 ? objectKeyFor({ category: 'thumbnails', extension: media.extension }) : undefined,
        contentType: media.contentType,
        size: media.size,
        options: { folder: 'lms', height: 250, width: 250, gravity: 'faces', crop: 'fill' }
      })
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('We could not upload this file. Please try again shortly.', 500, 'UPLOAD_UNAVAILABLE');
  } finally {
    await removeLocalFile(file);
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

function videoDeliveryUnavailable() {
  return new AppError(
    'Premium video playback is temporarily unavailable. Please try again shortly.',
    500,
    'VIDEO_DELIVERY_UNAVAILABLE'
  );
}

async function validateCourseUpdate(course, updateData) {
  const candidate = new Course(course.toObject());
  candidate.set(updateData);
  await candidate.validate();
}

async function reconcileLectureDelivery(course, accessType) {
  const delivery = videoDeliveryService();
  const target = delivery.deliveryTypeFor({ accessType, isPreview: false });
  for (const item of course.lectures) {
    if (item.isPreview || !item.lecture || item.lecture.deliveryType === target) continue;
    if (item.lecture.storage?.provider === R2) {
      item.lecture.deliveryType = target;
      await course.save();
      continue;
    }
    if (!item.lecture.public_id) continue;
    const from = item.lecture.deliveryType;
    try { await delivery.renameDelivery({ publicId: item.lecture.public_id, from, to: target }); } catch { throw videoDeliveryUnavailable(); }
    item.lecture.deliveryType = target;
    await course.save();
  }
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
    const presentedCourses = await Promise.all(courses.map(presentCourse));
    return res.status(200).json({ success: true, message: 'All courses', courses: presentedCourses });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.getCourseById = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = await Course.findOne({ _id: courseId, status: 'PUBLISHED' }).select('-lectures');
    if (!course) return next(new AppError('Course not found', 404, 'COURSE_NOT_FOUND'));
    return res.status(200).json({ success: true, course: await presentCourse(course) });
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
    const secureUrl = await videoDeliveryService(configuredMediaStorage().storage).playbackUrl(lecture.lecture);
    return res.status(200).json({ success: true, lecture: safeLectureDto(lecture, secureUrl) });
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
    if (course.accessType === 'PAID' && lecture.lecture?.deliveryType !== 'AUTHENTICATED') {
      return next(new AppError('Premium video playback is temporarily unavailable. Please try again shortly.', 500, 'VIDEO_DELIVERY_UNAVAILABLE'));
    }
    const secureUrl = await videoDeliveryService(configuredMediaStorage().storage).playbackUrl(lecture.lecture);
    return res.status(200).json({ success: true, lecture: safeLectureDto(lecture, secureUrl) });
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
  let thumbnailStorage;
  let savedCourse = false;
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
      const uploaded = await uploadThumbnail(req.file);
      uploadedThumbnail = uploaded.media;
      thumbnailStorage = uploaded.storage;
      course.thumbnail = uploadedThumbnail;
    }
    await course.save();
    savedCourse = true;
    await audit(req, 'COURSE_CREATED', 'COURSE', course._id);
    return res.status(200).json({ success: true, message: 'Course created successfully', course: await presentCourse(course) });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedThumbnail && !savedCourse) await thumbnailStorage.remove(uploadedThumbnail).catch(() => undefined);
    return next(courseRequestError(error));
  }
};

exports.updateCourse = async (req, res, next) => {
  let uploadedThumbnail;
  let thumbnailStorage;
  let savedCourse = false;
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course does not exist', 404, 'COURSE_NOT_FOUND'));
    const previousStatus = course.status;
    const updateData = allowedCourseUpdates(req.body);
    await validateCourseUpdate(course, updateData);
    const oldThumbnail = course.thumbnail?.toObject ? course.thumbnail.toObject() : course.thumbnail;
    if (req.file) {
      const uploaded = await uploadThumbnail(req.file);
      uploadedThumbnail = uploaded.media;
      thumbnailStorage = uploaded.storage;
      updateData.thumbnail = uploadedThumbnail;
    }
    await validateCourseUpdate(course, updateData);
    const previousAccessType = course.accessType;
    const requestedAccessType = updateData.accessType || previousAccessType;
    if (previousAccessType === 'FREE' && requestedAccessType === 'PAID') {
      await reconcileLectureDelivery(course, 'PAID');
      course.set(updateData);
      await course.save();
    } else if (previousAccessType === 'PAID' && requestedAccessType === 'FREE') {
      course.set(updateData);
      await course.save();
      await reconcileLectureDelivery(course, 'FREE');
    } else if (previousAccessType === 'PAID') {
      await reconcileLectureDelivery(course, 'PAID');
      course.set(updateData);
      await course.save();
    } else {
      course.set(updateData);
      await course.save();
      await reconcileLectureDelivery(course, 'FREE');
    }
    savedCourse = true;
    await audit(req, previousStatus !== 'PUBLISHED' && course.status === 'PUBLISHED' ? 'COURSE_PUBLISHED' : 'COURSE_UPDATED', 'COURSE', course._id);
    if (uploadedThumbnail && oldThumbnail) {
      try {
        await thumbnailStorage.remove(oldThumbnail);
      } catch {
        return next(new AppError('Course updated, but the previous thumbnail could not be removed.', 500, 'COURSE_MEDIA_UNAVAILABLE'));
      }
    }
    return res.status(200).json({ success: true, message: 'Course updated successfully', course: await presentCourse(course) });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedThumbnail && !savedCourse) await thumbnailStorage.remove(uploadedThumbnail).catch(() => undefined);
    return next(courseRequestError(error));
  }
};

exports.deleteCourse = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    if (!validObjectId(courseId)) return next(new AppError('Invalid courseId format', 400, 'COURSE_INVALID_REQUEST'));
    const course = req.course || await Course.findById(courseId);
    if (!course) return next(new AppError('Course does not exist', 404, 'COURSE_NOT_FOUND'));
    const assets = course.lectures.map((lecture) => lecture.lecture).filter(Boolean);
    const deletion = await Course.deleteOne({ _id: course._id, __v: course.__v });
    if (deletion.deletedCount !== 1) return next(new AppError('Course was modified before it could be deleted', 409, 'COURSE_UPDATE_CONFLICT'));
    await audit(req, 'COURSE_DELETED', 'COURSE', course._id);
    const cleanup = await Promise.allSettled([
      ...(course.thumbnail ? [configuredMediaStorage().storage.remove(course.thumbnail)] : []),
      ...assets.map((media) => configuredMediaStorage().storage.remove(media, { resource_type: 'video' }))
    ]);
    if (cleanup.some((result) => result.status === 'rejected')) {
      return next(new AppError('Course deleted but one or more media assets could not be removed', 500, 'COURSE_MEDIA_UNAVAILABLE'));
    }
    return res.status(200).json({ success: true, message: 'Course deleted successfully' });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.addLectureToCourseById = async (req, res, next) => {
  let uploadedLecture;
  let lectureStorage;
  let paidPreviewDeliveryTransitioned = false;
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
    const isPreview = req.body.isPreview === true || req.body.isPreview === 'true';
    const delivery = videoDeliveryService();
    const uploaded = await uploadLecture(req.file, course, isPreview);
    uploadedLecture = uploaded.media;
    lectureStorage = uploaded.storage;
    if (isPreview && course.accessType === 'PAID') {
      for (const item of course.lectures.filter((item) => item.isPreview)) {
        const from = item.lecture && item.lecture.deliveryType;
        if (!item.lecture || from === 'AUTHENTICATED') continue;
        if (item.lecture.storage?.provider === R2) {
          item.lecture.deliveryType = 'AUTHENTICATED';
          paidPreviewDeliveryTransitioned = true;
          await course.save();
          continue;
        }
        if (!item.lecture.public_id) continue;
        try {
          await delivery.renameDelivery({ publicId: item.lecture.public_id, from, to: 'AUTHENTICATED' });
        } catch {
          throw videoDeliveryUnavailable();
        }
        item.lecture.deliveryType = 'AUTHENTICATED';
        paidPreviewDeliveryTransitioned = true;
        await course.save();
      }
    }
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
    return res.status(200).json({
      success: true,
      message: 'Lecture added successfully',
      lecture: safeLectureDto(lecture)
    });
  } catch (error) {
    await removeLocalFile(req.file);
    if (uploadedLecture) await lectureStorage.remove(uploadedLecture, { resource_type: 'video' }).catch(() => undefined);
    if (paidPreviewDeliveryTransitioned) return next(videoDeliveryUnavailable());
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
    if (lecture.lecture) await configuredMediaStorage().storage.remove(lecture.lecture, { resource_type: 'video' });
    return res.status(200).json({ success: true, message: 'Lecture deleted Successfully' });
  } catch (error) { return next(courseRequestError(error)); }
};

exports.__setMediaStorageFactoryForTests = setMediaStorageFactoryForTests;
