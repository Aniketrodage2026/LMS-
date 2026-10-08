const mongoose=require('mongoose')

const PaymentSchema=new mongoose.Schema({
    razorpay_payment_id:{
        type:String,
        required:true
    },
    razorpay_subscription_id:{
        type:String,
        required:true
    },
    razorpay_signature:{
        type:String,
        required:true
    }
})

module.exports=mongoose.model('Payment',PaymentSchema)