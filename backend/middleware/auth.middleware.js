const AppError = require("../utils/appError");
const jwt = require("jsonwebtoken");
const User = require("../models/user.schema"); // optional if you want full user info

const isLoggedIn = async (req, res, next) => {
  try {
    const token = req.cookies && req.cookies.token;
    if (!token) {
      return next(new AppError('Authentication required', 401));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password -forgotPasswordToken -forgotPasswordExpiry');
    if (!user) {
      return next(new AppError('Authentication required', 401));
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(new AppError('Authentication required', 401));
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new AppError('You do not have access to this route', 403));
  }
  return next();
};

// Existing payment routes use the legacy USER label for learners.
const authorizedRole = (...roles) => requireRole(...roles.map((role) => role === 'USER' ? 'STUDENT' : role));

const authorizedSubscriber=async(req,res,next)=>{
  if (!req.user) {
    return next(new AppError('Authentication required', 401));
  }

  const subscriptionStatus = req.user.subscription && req.user.subscription.status;
  const currentRole=req.user.role

  if(currentRole !=='ADMIN' && subscriptionStatus !=='active'){
    return next(new AppError('Please subscribe to the course',403))
  }

  next();
}

module.exports = {isLoggedIn, requireRole, authorizedRole, authorizedSubscriber};
