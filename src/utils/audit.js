const { pool } = require('../config/db');
// Never let an audit failure break the real request.
async function audit(userId, action, entity = null, entityId = null, details = null) {
  try {
    await pool.query('INSERT INTO Audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)',
      [userId || null, action, entity, entityId, details ? String(details).slice(0, 500) : null]);
  } catch (e) { console.error('[audit]', e.message); }
}
module.exports = { audit };
