const mongoose = require('mongoose');
const AppError = require('../utils/appError');
const Certificate = require('../models/certificate.schema');
const Course = require('../models/course.schema');
const Enrollment = require('../models/enrollment.schema');
const { recordAuditSafely } = require('../services/audit-log.service');
const {
  calculateEligibility,
  certificateSummary,
  claimCertificate,
  publicCertificate
} = require('../services/certificate.service');

async function requireActiveCourseEnrollment(studentId, courseId) {
  if (!mongoose.Types.ObjectId.isValid(courseId)) {
    throw new AppError('Choose a valid course to check your certificate.', 400, 'CERTIFICATE_INVALID_REQUEST');
  }

  const course = await Course.findById(courseId).select('title');
  if (!course) throw new AppError('Course not found', 404, 'COURSE_NOT_FOUND');

  const enrollment = await Enrollment.exists({
    student: studentId,
    course: course._id,
    status: 'ACTIVE'
  });
  if (!enrollment) {
    throw new AppError('An active enrollment is required to access certificates', 403, 'COURSE_ENROLLMENT_REQUIRED');
  }
  return course;
}

function requestError(error, next) {
  if (error instanceof AppError && error.code !== 'SYSTEM_UNEXPECTED') return next(error);
  if (error instanceof AppError && error.statusCode === 503) {
    return next(new AppError('Certificate processing is temporarily unavailable. Try again shortly.', 503, 'CERTIFICATE_UNAVAILABLE'));
  }
  if (error instanceof AppError && error.statusCode === 403) {
    return next(new AppError('An active enrollment is required to access certificates.', 403, 'COURSE_ENROLLMENT_REQUIRED'));
  }
  return next(new AppError('We could not complete this certificate request. Try again shortly.', 500, 'SYSTEM_UNEXPECTED'));
}

function audit(req, certificate) {
  return recordAuditSafely({
    actor: req.user._id,
    action: 'CERTIFICATE_GENERATED',
    target: { type: 'CERTIFICATE', id: certificate._id },
    requestId: req.requestId
  });
}

exports.getEligibility = async (req, res, next) => {
  try {
    const course = await requireActiveCourseEnrollment(req.user._id, req.params.courseId);
    const eligibility = await calculateEligibility(req.user._id, course._id);
    return res.status(200).json({ success: true, eligibility });
  } catch (error) {
    return requestError(error, next);
  }
};

exports.claim = async (req, res, next) => {
  try {
    const course = await requireActiveCourseEnrollment(req.user._id, req.params.courseId);
    const result = await claimCertificate(req.user._id, course._id);
    if (!result.certificate) {
      return res.status(409).json({
        success: false,
        message: 'Certificate requirements are not yet met',
        error: { code: 'CERTIFICATE_NOT_ELIGIBLE', message: 'Certificate requirements are not yet met' },
        eligibility: result.eligibility
      });
    }

    if (result.created) await audit(req, result.certificate);

    return res.status(result.created ? 201 : 200).json({
      success: true,
      certificate: certificateSummary(result.certificate, course.title)
    });
  } catch (error) {
    return requestError(error, next);
  }
};

exports.listMine = async (req, res, next) => {
  try {
    const certificates = await Certificate.find({ student: req.user._id })
      .populate({ path: 'course', select: 'title' })
      .sort({ issuedAt: -1, _id: -1 });
    return res.status(200).json({
      success: true,
      certificates: certificates
        .filter((certificate) => certificate.course)
        .map((certificate) => certificateSummary(certificate, certificate.course.title))
    });
  } catch (error) {
    return requestError(error, next);
  }
};

exports.verifyPublic = async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) {
      throw new AppError('Certificate not found', 404, 'CERTIFICATE_NOT_FOUND');
    }
    const certificate = await Certificate.findOne({ verificationToken: req.params.token })
      .select('+verificationToken')
      .populate({ path: 'student', select: 'fullName' })
      .populate({ path: 'course', select: 'title' });
    if (!certificate || !certificate.student || !certificate.course) {
      throw new AppError('Certificate not found', 404, 'CERTIFICATE_NOT_FOUND');
    }
    return res.status(200).json({
      success: true,
      certificate: publicCertificate(certificate, certificate.student.fullName, certificate.course.title)
    });
  } catch (error) {
    return requestError(error, next);
  }
};
