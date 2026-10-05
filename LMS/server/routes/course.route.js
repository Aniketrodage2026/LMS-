const express=require('express')
const{getAllCourses,getLecturesByCourseId,createCourse,updateCourse,deleteCourse,addLectureToCourseById, deleteLectureFromCourse}=require('../controller/course.controller')
const {isLoggedIn,authorizedRole,authorizedSubscriber}=require('../middleware/auth.middleware')
const upload=require('../middleware/multer.middleware')

const router=express.Router()

router.route('/')
      .get(getAllCourses)
      .post(isLoggedIn,
            authorizedRole('ADMIN'),
            upload.single('thumbnail'),
            createCourse);

router.route('/:courseId')
      .get(isLoggedIn,
           authorizedSubscriber,
           getLecturesByCourseId)
      .put(isLoggedIn, 
           authorizedRole('ADMIN'),
           upload.single('thumbnail'),
           updateCourse)

      .delete(isLoggedIn, 
            authorizedRole('ADMIN'),
            deleteCourse)
      .post(isLoggedIn, 
            authorizedRole('ADMIN'),
            upload.single('lecture'),
            addLectureToCourseById)      

router.route('/:courseId/lectures/:lectureId')
      .delete(
            isLoggedIn,
            authorizedRole('ADMIN'),
            deleteLectureFromCourse
      );
module.exports=router

