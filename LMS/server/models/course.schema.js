const mongoose=require('mongoose')

const courseSchema=new mongoose.Schema({
    title:{
        type:String,
        required:[true,'Title of course is required'],
        minLength:[8,'Title must be atleast 8 char'],
        maxLength:[50,'Title must be less than 50 char'],
        trim:true
    },
    description:{
        type:String,
        require:['Description is required'],
        trim:true
    },
    category:{
        type:String,
        required:[true,'Category is required']
    },
    thumbnail:{
        public_id:{
            type:String,
            required:true
        },
        secure_url:{
            type:String,
            required:true
        }
    },
    lectures:[{
        title:String,
        description:String,
        lecture:{
            public_id:{
                type:String,
                required:true
            },
            secure_url:{
                type:String,
                required:true
            }
        }
    }],
    numberOflectures:{
        type:Number,
        default:0
    },
    createdBy:{
        type:String,
        required:true
    }

},{
    timestamps:true
})

module.exports=mongoose.model('Course',courseSchema)

