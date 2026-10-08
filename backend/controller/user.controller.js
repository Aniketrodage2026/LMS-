const AppError = require('../utils/appError');
const User = require('../models/user.schema');
const cloudinary = require('cloudinary');
const sendEmail = require('../utils/sendEmail');
const crypto = require('crypto');
const fs = require('fs/promises');

function cookieOptions() {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

function publicUser(user) {
  const value = user.toObject ? user.toObject() : { ...user };
  delete value.password;
  delete value.forgotPasswordToken;
  delete value.forgotPasswordExpiry;
  delete value.subscription;
  return value;
}

function sendAuthenticatedUser(res, statusCode, user, message) {
  res.cookie('token', user.generateJWTtoken(), cookieOptions());
  return res.status(statusCode).json({ success: true, message, user: publicUser(user) });
}

exports.register = async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password) {
      return next(new AppError('All fields are required', 400));
    }

    if (await User.findOne({ email })) {
      return next(new AppError('User already exists, please login!', 400));
    }

    const user = await User.create({
      fullName,
      email,
      password,
      role: 'STUDENT',
      avatar: {
        public_id: email,
        secure_url: 'https://ui-avatars.com/api/?name=John+Doe&background=0D8ABC&color=fff&size=200'
      }
    });

    if (req.file) {
      try {
        const result = await cloudinary.v2.uploader.upload(req.file.path, {
          folder: 'lms',
          width: 250,
          height: 250,
          gravity: 'faces',
          crop: 'fill'
        });
        user.avatar.public_id = result.public_id;
        user.avatar.secure_url = result.secure_url;
        await user.save();
        await fs.unlink(req.file.path);
      } catch (error) {
        return next(new AppError(error.message || 'File not uploaded, please try again', 500));
      }
    }

    return sendAuthenticatedUser(res, 201, user, 'User registered successfully!');
  } catch (error) {
    return next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return next(new AppError('All fields are required!', 400));
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return next(new AppError('Email or password do not match!', 400));
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
    return res.status(200).json({ success: true, message: 'User Details', user: publicUser(req.user) });
  } catch (error) {
    return next(error);
  }
};

exports.updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!['STUDENT', 'INSTRUCTOR'].includes(role)) {
      return next(new AppError('Role must be STUDENT or INSTRUCTOR', 400));
    }

    const user = await User.findByIdAndUpdate(req.params.userId, { role }, { new: true, runValidators: true });
    if (!user) {
      return next(new AppError('User does not exist', 404));
    }

    return res.status(200).json({ success: true, message: 'User role updated successfully!', user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return next(new AppError('Email is required', 400));
    const user = await User.findOne({ email });
    if (!user) return next(new AppError('Invalid user', 400));

    const resetToken = await user.generatePasswordToken();
    await user.save();
    const resetPasswordUrl = `${process.env.FRONTEND_URL}/rest-password/${resetToken}`;
    const message = `You can reset your password at ${resetPasswordUrl}. If you did not request this, please ignore it.`;

    try {
      await sendEmail({ email, subject: 'Reset Password', message });
      return res.status(200).json({ success: true, message: `Reset password token has send to ${email} successfully !` });
    } catch (error) {
      user.forgotPasswordToken = undefined;
      user.forgotPasswordExpiry = undefined;
      await user.save();
      return next(new AppError(error.message, 500));
    }
  } catch (error) {
    return next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const forgotPasswordToken = crypto.createHash('sha256').update(req.params.resetToken).digest('hex');
    const user = await User.findOne({ forgotPasswordToken, forgotPasswordExpiry: { $gt: Date.now() } });
    if (!user) return next(new AppError('Token is invalid or expired, please try again', 400));

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
  try {
    const user = await User.findById(req.user.id);
    if (!user) return next(new AppError('User does not exist', 400));
    if (req.body.fullName) user.fullName = req.body.fullName;

    if (req.file) {
      if (user.avatar && user.avatar.public_id) await cloudinary.v2.uploader.destroy(user.avatar.public_id);
      const result = await cloudinary.v2.uploader.upload(req.file.path, {
        folder: 'lms', width: 250, height: 250, gravity: 'faces', crop: 'fill'
      });
      user.avatar.public_id = result.public_id;
      user.avatar.secure_url = result.secure_url;
      await fs.unlink(req.file.path);
    }

    await user.save();
    return res.status(200).json({ success: true, message: 'User details updated successfully!' });
  } catch (error) {
    return next(error);
  }
};
