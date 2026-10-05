const express=require('express')
const{register,login,logout,getProfile,forgotPassword,resetPassword,changePassword,updateUser,updateUserRole}=require('../controller/user.controller')
const {isLoggedIn,requireRole}=require('../middleware/auth.middleware')
const upload=require('../middleware/multer.middleware');
const router=express.Router();
const adminRouter=express.Router();


router.post('/register',upload.single('avatar'),register);
router.post('/login',login)
router.get('/logout',logout)
router.get('/getprofile',isLoggedIn,getProfile)
router.post('/reset',forgotPassword)
router.post('/reset/:resetToken',resetPassword)
router.post('/changepassword',isLoggedIn,changePassword)
router.put('/update',isLoggedIn,upload.single('avatar'),updateUser)

adminRouter.patch('/users/:userId/role', isLoggedIn, requireRole('ADMIN'), updateUserRole);

module.exports=router
module.exports.adminRouter=adminRouter;
