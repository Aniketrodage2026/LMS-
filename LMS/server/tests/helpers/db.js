const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

async function connectTestDb() {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    return mongoServer.getUri();
}

async function disconnectTestDb() {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }

    if (mongoServer) {
        await mongoServer.stop();
        mongoServer = undefined;
    }
}

module.exports = { connectTestDb, disconnectTestDb };
