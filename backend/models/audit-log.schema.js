const mongoose = require('mongoose');

const actions = [
  'ROLE_CHANGED',
  'COURSE_CREATED',
  'COURSE_UPDATED',
  'COURSE_PUBLISHED',
  'COURSE_DELETED',
  'LECTURE_CREATED',
  'LECTURE_DELETED',
  'QUIZ_CREATED',
  'QUIZ_UPDATED',
  'QUIZ_PUBLISHED',
  'QUIZ_DELETED',
  'ASSIGNMENT_CREATED',
  'ASSIGNMENT_UPDATED',
  'ASSIGNMENT_PUBLISHED',
  'ASSIGNMENT_DELETED',
  'SUBMISSION_GRADED',
  'PURCHASE_VERIFIED',
  'CERTIFICATE_GENERATED'
];

const targetSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    immutable: true,
    enum: ['USER', 'COURSE', 'LECTURE', 'QUIZ', 'ASSIGNMENT', 'SUBMISSION', 'PURCHASE', 'CERTIFICATE']
  },
  id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    immutable: true
  }
}, { _id: false });

const auditLogSchema = new mongoose.Schema({
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
    index: true
  },
  action: {
    type: String,
    required: true,
    immutable: true,
    enum: actions
  },
  target: {
    type: targetSchema,
    required: true,
    immutable: true
  },
  summary: {
    type: Map,
    of: String,
    immutable: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true,
    index: true
  }
}, {
  versionKey: false
});

auditLogSchema.index({ createdAt: -1, _id: -1 });

function appendOnlyError() {
  return new Error('AuditLog records are append-only.');
}

auditLogSchema.pre('save', function () {
  if (!this.isNew) throw appendOnlyError();
});

auditLogSchema.pre('bulkWrite', function () {
  throw appendOnlyError();
});

for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete'
]) {
  auditLogSchema.pre(operation, function () {
    throw appendOnlyError();
  });
}

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.actions = actions;
