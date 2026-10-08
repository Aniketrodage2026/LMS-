const express=require('express')
const {isLoggedIn,authorizedRole}=require('../middleware/auth.middleware')
const{getRazorpayApiKey,buySubscription,verifySubscription,cancelSubscription,getAllPayment}=require('../controller/payment.controller')
const router=express.Router()

router
    .route('/razorpay-key')
    .get(
        isLoggedIn,
        getRazorpayApiKey)

router
    .route('/subscribe')
    .post(
         isLoggedIn,
         buySubscription)

router
    .route('/verify')
    .post(
         isLoggedIn,
         verifySubscription)

router
    .route('/unsubscribe')
    .post(
        isLoggedIn,
        authorizedRole('USER'),
        cancelSubscription) 

router
     .route('/')
     .get(isLoggedIn,
        authorizedRole('ADMIN'),
        getAllPayment)

module.exports=router