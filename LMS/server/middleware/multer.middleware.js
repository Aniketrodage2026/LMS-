const path=require('path')
const multer=require('multer')

const upload=multer({
    dest:"uploads/",
    limits:{fileSize: 200 * 1024 * 1024},//50 MB in size max limit
    storage:multer.diskStorage({
        destination:"uploads/",
        filename:(_req,file,cb)=>{
            cb(null,file.originalname);
        },
    }),
    fileFilter:(_req,file,cb)=>{
        let ext=path.extname(file.originalname);
        if(
            ext !==".jpg" &&
            ext !==".jpeg"&&
            ext !==".webp"&&
            ext !==".png"&&
            ext !==".mp4" &&
            ext !==".mkv" &&
            ext !==".avi" && 
            ext !==".mov" && 
            ext !== ".vlc"
        ){
            cb(new Error(`Unsuppored file type! ${ext}`),false);
            return;
        }
        cb(null,true);
    }
});

module.exports=upload