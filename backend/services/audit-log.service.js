const AuditLog = require('../models/audit-log.schema');

const prohibitedSummaryKey = /password|token|secret|cookie|authorization|ip|agent|email|content|file|payload|signature/i;

function assertSafeSummary(summary) {
  if (summary === undefined) return;

  if (summary === null || Object.getPrototypeOf(summary) !== Object.prototype) {
    throw new Error('Audit entries require a safe audit summary.');
  }

  for (const [key, value] of Object.entries(summary)) {
    if (prohibitedSummaryKey.test(key) || typeof value !== 'string') {
      throw new Error('Audit entries require a safe audit summary.');
    }
  }
}

async function recordAudit({ actor, action, target, summary }) {
  assertSafeSummary(summary);
  const auditLog = new AuditLog({ actor, action, target, summary });
  await auditLog.validate();
  return AuditLog.create(auditLog.toObject());
}

async function recordAuditSafely({ actor, action, target, summary, requestId }) {
  try {
    return await recordAudit({ actor, action, target, summary });
  } catch (error) {
    try {
      console.warn(JSON.stringify({
        event: 'audit_log_failure',
        requestId,
        action
      }));
    } catch (loggingError) {
      // Audit persistence must never disrupt the successful action being audited.
    }
    return null;
  }
}

module.exports = { recordAudit, recordAuditSafely };
