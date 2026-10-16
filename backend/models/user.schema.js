const mongoose=require('mongoose')
const jwt=require('jsonwebtoken');
const bcrypt=require('bcryptjs')
const crypto=require('crypto');  //  it is used to generate secure reset token
const mediaStorageSchema = new mongoose.Schema({
    provider: { type: String, enum: ['CLOUDINARY', 'R2'], required: true },
    key: { type: String, required: true, trim: true },
    contentType: { type: String, required: true, trim: true },
    size: {
        type: Number,
        required: true,
        min: 0,
        cast: false,
        validate: {
            validator: Number.isInteger,
            message: 'media storage size must be a nonnegative integer'
        }
    }
}, { _id: false });

function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
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
        },
        storage: { type: mediaStorageSchema, default: undefined }
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

userSchema.pre('validate', function validateAvatar(next) {
    const avatar = this.avatar;
    const hasLegacyRecord = hasText(avatar?.public_id) && hasText(avatar?.secure_url);
    const hasAnyAvatarValue = avatar && Object.keys(avatar.toObject ? avatar.toObject() : avatar).length > 0;
    if (hasAnyAvatarValue && !hasLegacyRecord && !avatar.storage) {
        this.invalidate('avatar', 'avatar requires legacy Cloudinary media or storage metadata');
    }
    next();
});

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
