const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const connectDB = require('../config/dbConnect');
const User = require('../models/user.schema');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');

test.after(async () => {
  await disconnectTestDb();
});

test('database startup migrates legacy USER roles idempotently without changing current roles', async () => {
  const uri = await connectTestDb();
  const legacyId = new mongoose.Types.ObjectId();
  const instructorId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();

  await User.collection.insertMany([
    { _id: legacyId, fullName: 'Legacy Student', email: 'legacy@example.com', password: 'hash', role: 'USER' },
    { _id: instructorId, fullName: 'Current Instructor', email: 'instructor@example.com', password: 'hash', role: 'INSTRUCTOR' },
    { _id: adminId, fullName: 'Current Administrator', email: 'admin@example.com', password: 'hash', role: 'ADMIN' }
  ]);

  await mongoose.disconnect();
  await connectDB(uri);

  const afterStartup = await User.find({ _id: { $in: [legacyId, instructorId, adminId] } }).lean();
  const rolesAfterStartup = new Map(afterStartup.map((user) => [user.email, user.role]));
  assert.equal(rolesAfterStartup.get('legacy@example.com'), 'STUDENT');
  assert.equal(rolesAfterStartup.get('instructor@example.com'), 'INSTRUCTOR');
  assert.equal(rolesAfterStartup.get('admin@example.com'), 'ADMIN');

  await mongoose.disconnect();
  await connectDB(uri);
  const afterSecondStartup = await User.findById(legacyId).lean();
  assert.equal(afterSecondStartup.role, 'STUDENT');

});
