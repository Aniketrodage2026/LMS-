const User = require('../models/user.schema');

async function migrateLegacyUserRoles() {
  return User.updateMany(
    { role: 'USER' },
    { $set: { role: 'STUDENT' } }
  );
}

module.exports = { migrateLegacyUserRoles };
