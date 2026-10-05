const AppError=require('../utils/appError')
const Course=require('../models/course.schema')
const cloudinary=require('cloudinary')
const fs = require("fs/promises");

exports.getAllCourses=async(req,res,next)=>{
    try {
        const courses=await Course.find({}).select('-lectures')
        res.status(200).json({
            success:true,
            message:"All courses",
            courses
        })
    } catch (error) {
        return next(new AppError(error.message,500))
    }
}

exports.getLecturesByCourseId = async (req, res, next) => {
  try {
    const { courseId } = req.params;

    // validate id format first (to avoid CastError from mongoose)
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return next(new AppError("Invalid courseId format", 400));
    }

    const course = await Course.findById(courseId);

    if (!course) {
      return next(new AppError("Course not found", 404));
    }

    res.status(200).json({
      success: true,
      message: "Course lectures fetched successfully",
      lectures: course.lectures,
    });
  } catch (error) {
    return next(new AppError(error.message, 500));
  }
};


exports.createCourse=async(req,res,next)=>{

  try {
    const {title,description,category,createdBy}=req.body

  if(!title || !description || !category || !createdBy){
    return next(new AppError('All fields are required',500))
  }

  const course=await Course.create({
    title,
    description,
    category,
    createdBy,
    thumbnail:{
      public_id:"Dummy_id",
      secure_url:"Dummy_url"
    }
  })
  if(req.file){
    const result=await cloudinary.v2.uploader.upload(req.file.path,{
      folder:'lms',
      height:250,
      width:250,
      gravity:'faces',
      crop:'fill'
    })

    if(result){
      course.thumbnail.public_id=result.public_id;
      course.thumbnail.secure_url=result.secure_url;
    }

    await fs.unlink(req.file.path);
  }
  await course.save()

  res.status(200).json({
    success:true,
    message:'Course created successfully',
    course
  })
  } 
  catch (error) {
    return next(new AppError(error.message,500))
  }
  
}

exports.updateCourse=async(req,res,next)=>{
  
  try {
    const {courseId}=req.params

    let updateData={...req.body}

    //if new thembnail is uploaded 

    if(req.file){

      const course=await Course.findById(courseId)

      if(!course){
        return next(new AppError("Course does not exist",404));
      }

      //remone old thumbnail if exists

      if(course.thumbnail && course.thumbnail.public_id){
        await cloudinary.v2.uploader.destroy(course.thumbnail.public_id);
      }

      //Upload new thumbnail

      const result=await cloudinary.v2.uploader.upload(req.file.path,{
        folder:"lms",
        width:250,
        height:250,
        gravity:"faces",
        crop:"fill"
      });

      updateData.thumbnail={
        public_id:result.public_id,
        secure_url:result.secure_url
      };

      //Remove local file

      await fs.unlink(req.file.path)
    }

    const updateCourse=await Course.findByIdAndUpdate(courseId,updateData,{
      new:true,
      runValidators:true
    })

    if(!updateCourse){
      return next(new AppError("Course does not exist",404))
    }
  
    res.status(200).json({
      success:true,
      message:"Course updated successfully",
      course:updateCourse
    })
  } catch (error) {
    return next(new AppError(error.message,500))
  }
}

exports.deleteCourse=async(req,res,next)=>{

  try {
    const{courseId}=req.params

    const course=await Course.findById(courseId);
    
    if(!course){
      return next(new AppError('Course does not exist',404))
    }

    //removing thembnail from cloudnary if exist 

    if(course.thumbnail && course.thumbnail.public_id){
      await cloudinary.v2.uploader.destroy(course.thumbnail.public_id)
    }

    await Course.findByIdAndDelete(courseId)

    res.status(200).json({
      success:true,
      message:'Course deleted successfully'
    })
  } catch (error) {
    return next(new AppError(error.message,500))
  }
}


exports.addLectureToCourseById = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const { title, description } = req.body;

    // Validate fields
    if (!title || !description || !req.file) {
      return next(new AppError("Title, description, and video file are required", 400));
    }

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return next(new AppError("Course with given ID does not exist", 400));
    }

    // Upload video to Cloudinary
    const result = await cloudinary.v2.uploader.upload(req.file.path, {
      folder: "lms",
      resource_type: "video",
      chunk_size: 6000000, // for large videos
    });

    if (!result || !result.public_id || !result.secure_url) {
      return next(new AppError("Video upload failed at Cloudinary", 500));
    }

    // Build lecture object
    const lectureData = {
      title,
      description,
      lecture: {
        public_id: result.public_id,
        secure_url: result.secure_url,
      },
    };

    // Remove local file after upload
    await fs.unlink(req.file.path);

    // Save lecture to DB
    course.lectures.push(lectureData);
    course.numberOflectures = course.lectures.length;
    await course.save();

    res.status(200).json({
      success: true,
      message: "Lecture added successfully",
      lecture: lectureData,
    });
  } catch (error) {
    console.error("Upload Error:", error); // 👀 helps debugging
    return next(new AppError(error.message || "Something went wrong", 500));
  }
};

exports.deleteLectureFromCourse=async(req,res,next)=>{
  try {
    const{courseId,lectureId}=req.params

    const course=await Course.findById(courseId);
    if(!course){
      return next(new AppError('Course not found',404))
    }

    const lecture = course.lectures.id(lectureId);


    if(!lecture){
      return next(new AppError('Lecture not found',400))
    }

    //Delete video from cloudinary if  exist 
    if(lecture.lecture && lecture.lecture.public_id){
      await cloudinary.v2.uploader.destroy(lecture.lecture.public_id,{
        resource_type:'video'
      })
    }

    //Remove lecture from course

    course.lectures=course.lectures.filter((lec)=>lec._id.toString()!==lectureId)
    
    course.numberOflectures=course.lectures.length;

    await course.save();

    res.status(200).json({
      success:true,
      message:'Lecture deleted Successfully'
    })
  } catch (error) {
    return next(new AppError(error.message,500))
  }
}