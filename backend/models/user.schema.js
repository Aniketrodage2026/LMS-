const mongoose=require('mongoose')
const jwt=require('jsonwebtoken');
const bcrypt=require('bcryptjs')
const crypto=require('crypto');  //  it is used to generate secure reset token
const userSchema=new mongoose.Schema({
    fullName:{
        type:String,
        required:[true,"Name is Reauired"],
        minLength:[5,"Name must be atleast 5 char"],
        maxLenght:[30,"Name should be less than 30 char"],
        lowercase:true
    },
    email:{
        type:String,
        required:[true,"Email is required"],
        unique:[true,"User Already exist"],
        lowercase:true,
        trim:true,
        match:[/^\S+@\S+\.\S+$/,'Enter a valid email']
    },
    password:{
        type:String,
        required:[true,'Password is required'],
        minLength:[8,"Password must be atleast 8 char"],
        select:false
    },
    role:{
       type:String,
       enum:['STUDENT','INSTRUCTOR','ADMIN'],
       default:'STUDENT' 
    },
    avatar:{
        public_id:{
            type:String,   
        },
        secure_url:{
            type:String
        }
    },
    forgotPasswordToken:String,
    forgotPasswordExpiry:Date,
    
    subscription:{
        id:String,
        status:String
    }
},{
    timestamps:true
})

//Hash Password before saving

userSchema.pre('save',async function(next){
    if(!this.isModified('password')) return next();

    this.password=await bcrypt.hash(this.password,10)

})

//methods for comparing password and to generate password 

userSchema.methods={
    comparePassword:async function(palneTextPassword){
        return await bcrypt.compare(palneTextPassword,this.password)
    },
    generateJWTtoken:function() {
        return jwt.sign(
            {id:this._id,role:this.role},
            process.env.JWT_SECRET,
            {expiresIn:process.env.JWT_EXPIRY}
        )
    },
    generatePasswordToken:async function() {
        const resetToken=crypto.randomBytes(20).toString('hex')

        this.forgotPasswordToken=crypto
            .createHash('sha256')
            .update(resetToken)
            .digest('hex')

        this.forgotPasswordExpiry=Date.now() + 10 * 60 *1000  //time start from now till 10 min

        return resetToken;
    }

}

module.exports=mongoose.model('User',userSchema)
