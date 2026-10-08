const mongoose = require('mongoose');
const { migrateLegacyUserRoles } = require('../services/user-role-migration.service');

mongoose.set('strictQuery', false);

const connectDB = async (dbUrl = process.env.DB_URL) => {
    const conn = await mongoose.connect(dbUrl);
    await migrateLegacyUserRoles();
    console.log(`DB Connected to:${conn.connection.host}`);
    return conn;
};

module.exports = connectDB;
