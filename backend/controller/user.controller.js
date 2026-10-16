const AppError = require('../utils/appError');
const User = require('../models/user.schema');
const cloudinary = require('cloudinary');
const sendEmail = require('../utils/sendEmail');
const crypto = require('crypto');
const fs = require('fs/promises');
const { recordAuditSafely } = require('../services/audit-log.service');
const { CLOUDINARY, R2, objectKeyFor } = require('../services/media-storage.service');
const { createMediaPresenter } = require('../services/media-presentation.service');
const { createRuntimeMediaStorageFactory } = require('../services/runtime-media-storage.service');

const mediaStorageFactory = createRuntimeMediaStorageFactory({ cloudinary });
const { validateStoredUpload } = require('../services/media-validation.service');

async function audit(req, action, type, id, summary) {
  return recordAuditSafely({
    actor: req.user._id,
    action,
    target: { type, id },
    summary,
    requestId: req.requestId
  });
}

function cookieOptions() {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

async function publicUser(user) {
  const value = user.toObject ? user.toObject() : { ...user };
  delete value.password;
  delete value.forgotPasswordToken;
  delete value.forgotPasswordExpiry;
  delete value.subscription;
  value.avatar = await createMediaPresenter({ storage: configuredMediaStorage().storage }).image(value.avatar);
  return value;
}

async function sendAuthenticatedUser(res, statusCode, user, message) {
  const safeUser = await publicUser(user);
  res.cookie('token', user.generateJWTtoken(), cookieOptions());
  return res.status(statusCode).json({ success: true, message, user: safeUser });
}

function configuredMediaStorage() {
  return { provider: process.env.R2_ENABLED === 'true' ? R2 : CLOUDINARY, storage: mediaStorageFactory.get() };
}

async function storeAvatar(file) {
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
        key: provider === R2 ? objectKeyFor({ category: 'avatars', extension: media.extension }) : undefined,
        contentType: media.contentType,
        size: media.size,
        options: { folder: 'lms', width: 250, height: 250, gravity: 'faces', crop: 'fill' }
      })
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('We could not upload this file. Please try again shortly.', 500, 'UPLOAD_UNAVAILABLE');
  } finally {
    await fs.unlink(file.path).catch(() => undefined);
  }
}

async function removeMediaSafely(storage, media) {
  if (!media) return;
  await storage.remove(media);
}

exports.register = async (req, res, next) => {
  let uploaded;
  let saved = false;
  try {
    const { fullName, email: requestedEmail, password } = req.body || {};
    const email = typeof requestedEmail === 'string' ? requestedEmail.trim().toLowerCase() : '';
    if (typeof fullName !== 'string' || !fullName.trim() || !email || !password) {
      return next(new AppError('Full name, email, and password are required.', 400, 'VALIDATION_REQUIRED'));
    }

    if (await User.findOne({ email })) {
      return next(new AppError('An account already exists for this email. Sign in instead, or reset your password if you do not remember it.', 409, 'AUTH_EMAIL_EXISTS'));
    }

    const user = new User({
      fullName,
      email,
      password,
      role: 'STUDENT',
      avatar: {
        public_id: email,
        secure_url: 'https://ui-avatars.com/api/?name=John+Doe&background=0D8ABC&color=fff&size=200'
      }
    });

    await user.validate();

    if (req.file) {
      uploaded = await storeAvatar(req.file);
      user.avatar = uploaded.media;
    }

    await user.save();
    saved = true;

    return sendAuthenticatedUser(res, 201, user, 'User registered successfully!');
  } catch (error) {
    if (uploaded && !saved) await uploaded.storage.remove(uploaded.media).catch(() => undefined);
    if (req.file) await fs.unlink(req.file.path).catch(() => undefined);
    const databaseError = error.cause || error;
    if (databaseError.code === 11000 && databaseError.keyPattern?.email) {
      return next(new AppError('An account already exists for this email. Sign in instead, or reset your password if you do not remember it.', 409, 'AUTH_EMAIL_EXISTS'));
    }
    return next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email: requestedEmail, password } = req.body || {};
    const email = typeof requestedEmail === 'string' ? requestedEmail.trim().toLowerCase() : '';
    if (!email || !password) {
      return next(new AppError('Email and password are required.', 400, 'VALIDATION_REQUIRED'));
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return next(new AppError('We couldn’t sign you in with that email and password. Check your details or reset your password.', 401, 'AUTH_INVALID_CREDENTIALS'));
    }

    return sendAuthenticatedUser(res, 200, user, 'Login successful!');
  } catch (error) {
    return next(error);
  }
};

exports.logout = async (req, res, next) => {
  try {
    res.clearCookie('token', cookieOptions());
    return res.status(200).json({ success: true, message: 'User logged out successfully!' });
  } catch (error) {
    return next(error);
  }
};

exports.getProfile = async (req, res, next) => {
  try {
    return res.status(200).json({ success: true, message: 'User Details', user: await publicUser(req.user) });
  } catch (error) {
    return next(error);
  }
};

exports.updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body || {};
    if (!['STUDENT', 'INSTRUCTOR'].includes(role)) {
      return next(new AppError('Choose the student or instructor role.', 400, 'VALIDATION_INVALID_REQUEST'));
    }

    const changedUser = await User.findOneAndUpdate(
      { _id: req.params.userId, role: { $nin: [role, 'ADMIN'] } },
      { role },
      { new: false, runValidators: true }
    );
    if (changedUser) {
      const fromRole = changedUser.role;
      changedUser.role = role;
      await audit(req, 'ROLE_CHANGED', 'USER', changedUser._id, { fromRole, toRole: role });
      return res.status(200).json({ success: true, message: 'User role updated successfully!', user: await publicUser(changedUser) });
    }

    const existingUser = await User.findById(req.params.userId);
    if (!existingUser) {
      return next(new AppError('This user is not available.', 404, 'AUTH_USER_NOT_FOUND'));
    }
    if (existingUser.role === 'ADMIN') {
      return next(new AppError('Your account does not have permission to do that.', 403, 'AUTH_ROLE_FORBIDDEN'));
    }
    return res.status(200).json({ success: true, message: 'User role updated successfully!', user: await publicUser(existingUser) });
  } catch (error) {
    if (error?.name === 'CastError' || error?.name === 'ValidationError') {
      return next(new AppError('Check the user ID and role, then try again.', 400, 'VALIDATION_INVALID_REQUEST'));
    }
    return next(new AppError('We could not update this role. Try again shortly.', 500, 'SYSTEM_UNEXPECTED'));
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email: requestedEmail } = req.body;
    const email = typeof requestedEmail === 'string' ? requestedEmail.trim().toLowerCase() : '';
    if (!email) return next(new AppError('Email is required', 400));
    const publicResponse = {
      success: true,
      message: 'If an account exists for this email, a reset link is on its way.'
    };
    const user = await User.findOne({ email });
    if (!user) return res.status(200).json(publicResponse);

    const resetToken = await user.generatePasswordToken();
    await user.save();
    const resetPasswordUrl = `${process.env.FRONTEND_URL}/rest-password/${resetToken}`;
    const message = `You can reset your password at ${resetPasswordUrl}. If you did not request this, please ignore it.`;

    try {
      await sendEmail({ email: user.email, subject: 'Reset Password', message });
      return res.status(200).json(publicResponse);
    } catch (error) {
      user.forgotPasswordToken = undefined;
      user.forgotPasswordExpiry = undefined;
      await user.save();
      return next(new AppError('We couldn’t send a reset link right now. Please try again.', 500, 'AUTH_RESET_EMAIL_UNAVAILABLE'));
    }
  } catch (error) {
    return next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const forgotPasswordToken = crypto.createHash('sha256').update(req.params.resetToken).digest('hex');
    const user = await User.findOne({ forgotPasswordToken, forgotPasswordExpiry: { $gt: Date.now() } });
    if (!user) return next(new AppError('This reset link has expired. Request a new one to continue.', 400, 'AUTH_RESET_TOKEN_INVALID'));

    user.password = req.body.password;
    user.forgotPasswordExpiry = undefined;
    user.forgotPasswordToken = undefined;
    await user.save();
    return res.status(200).json({ success: true, message: 'Password changed successfully!' });
  } catch (error) {
    return next(error);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return next(new AppError('Every field is required!', 400));
    const user = await User.findById(req.user.id).select('+password');
    if (!user) return next(new AppError('User does not exist', 400));
    if (!(await user.comparePassword(oldPassword))) return next(new AppError('Old password is invalid', 400));

    user.password = newPassword;
    await user.save();
    return res.status(200).json({ success: true, message: 'Password updated successfully!' });
  } catch (error) {
    return next(error);
  }
};

exports.updateUser = async (req, res, next) => {
  let uploaded;
  let saved = false;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return next(new AppError('User does not exist', 400));
    if (req.body.fullName) user.fullName = req.body.fullName;

    const oldAvatar = user.avatar?.toObject ? user.avatar.toObject() : user.avatar;
    if (req.file) {
      uploaded = await storeAvatar(req.file);
      user.avatar = uploaded.media;
    }

    await user.save();
    saved = true;
    if (uploaded && oldAvatar) {
      try {
        await removeMediaSafely(uploaded.storage, oldAvatar);
      } catch {
        return next(new AppError('Your profile was updated, but the previous profile image could not be removed.', 500, 'USER_MEDIA_UNAVAILABLE'));
      }
    }
    return res.status(200).json({ success: true, message: 'User details updated successfully!' });
  } catch (error) {
    if (uploaded && !saved) await uploaded.storage.remove(uploaded.media).catch(() => undefined);
    if (req.file) await fs.unlink(req.file.path).catch(() => undefined);
    return next(error);
  }
};
