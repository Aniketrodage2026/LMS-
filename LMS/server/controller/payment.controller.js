const AppError=require('../utils/appError')
const Payment=require('../models/payment.schema')
const User=require('../models/user.schema')
const createRazorpayClient=require('../utils/razorpay')
const crypto=require('crypto')
require('dotenv').config()
exports.getRazorpayApiKey=async(req,res,next)=>{
    try {
        res.status(200).json({  
            success:true,
            message:"RazorPay API Key",
            key:process.env.RAZORPAY_KEY_ID
        })
    } catch (error) {
        return next(new AppError(error.message,500))
    }
}

exports.buySubscription = async (req, res, next) => {
  try {
    const { id } = req.user;

    // Find user
    const user = await User.findById(id);
    if (!user) {
      return next(new AppError('Unauthorized, please login', 401));
    }

    // Admin cannot purchase subscription
    if (user.role === 'ADMIN') {
      return next(new AppError('Admin cannot purchase a subscription', 403));
    }

    // Create subscription in Razorpay
    const razorpay = createRazorpayClient();
    const subscription = await razorpay.subscriptions.create({
      plan_id: process.env.RAZORPAY_PLAN_ID,
      customer_notify: 1,
      total_count:1
    });

    // Update user subscription info
    user.subscription.id = subscription.id;
    user.subscription.status = subscription.status;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Subscription created successfully',
      subscription_id: subscription.id
    });

  } catch (error) {
    // console.error(error)
    return next(new AppError(error.message || 'Something went wrong', 500));
  }
};

exports.verifySubscription=async(req,res,next)=>{
    try {
        const {id}=req.user
        const user=await User.findById(id)
        if(!user){
            return next(new AppError('Unauthorized User,Please login',500))
        }

        const{
        razorpay_payment_id,razorpay_subscription_id,razorpay_signature}=req.body

        const generateSignature=crypto
        .createHmac('sha256',process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_payment_id + "|" + razorpay_subscription_id)
        .digest("hex")

        if(generateSignature != razorpay_signature){
            return next(new AppError('Payment not Varified,Please try again',500))
        }

        //record payment details in Payment Collection

        await Payment.create({
            razorpay_payment_id,
            razorpay_signature,
            razorpay_subscription_id
        })

        //Update user record with subscription status

        user.subscription.status='active'
        await user.save()

        res.status(200).json({
            success:true,
            message:"Payment verified successfully"
        })
    } catch (error) {
        return next(new AppError(error.message,500))
    }
}

exports.cancelSubscription=async(req,res,next)=>{
    try {
        const {id}=req.user
        const user=await User.findById(id)

        if(!user){
            return next(new AppError('unauthorized User,Please login',500))
        }

        if(user.role==='ADMIN'){
            return next(new AppError('Admin can not cancle the subscription of course',403))
        }

        const subscriptionId=user.subscription.id
        const razorpay = createRazorpayClient()
        const subscription=await razorpay.subscriptions.cancel(subscriptionId)

        user.subscription.status=subscription.status;

        await user.save()
        res.status(200).json({
            success:true,
            message:"Subscription Cancal Succcessfully"
        })

    } catch (error) {
        return next(new AppError(error.message,500))
    }
}

exports.getAllPayment=async(req,res,next)=>{
    try {
        const {count}=req.query;
        const razorpay = createRazorpayClient()

        const subscription=await razorpay.subscriptions.all({
            count:count ||10
        })
        res.status(200).json({
            success:true,
            message:'All payment',
            payments:subscription
        })
    } catch (error) {
        return next(new AppError(error.message,500))
    }
}
