class AppError extends Error {
    constructor(message,statusCode = 500,code = 'SYSTEM_UNEXPECTED',meta) {
        super(message)
        this.statusCode=statusCode
        this.code=code
        if (meta !== undefined) this.meta=meta

        Error.captureStackTrace(this,this.constructor)
    }
}

module.exports=AppError
