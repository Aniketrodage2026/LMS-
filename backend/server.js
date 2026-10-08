require('dotenv').config();

const app = require('./app.js');
const cloudinary = require('cloudinary');
const connectDB = require('./config/dbConnect');
const { loadEnv } = require('./config/env');

async function startServer() {
    try {
        const config = loadEnv();
        const port = process.env.PORT || 5000;

        cloudinary.v2.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_secret: process.env.CLOUDINARY_CLOUD_API_SECRET,
            api_key: process.env.CLOUDINARY_CLOUD_API_KEY
        });

        await connectDB(config.dbUrl);

        return app.listen(port, () => {
            console.log(`App is running on http://localhost:${port}`);
        });
    } catch (error) {
        console.error(`Failed to start server: ${error.message}`);
        process.exitCode = 1;
        return null;
    }
}

if (require.main === module) {
    startServer();
}

module.exports = { startServer };
