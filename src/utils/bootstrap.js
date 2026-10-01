// Creates the first coordinator from ADMIN_* env vars if the system has none yet.
const { pool } = require('../config/db');
const { hash } = require('./password');

async function ensureAdmin() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM Users WHERE role = 'coordinator'");
  if (n > 0) return;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('[Bootstrap] No coordinator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run `npm run admin:create`.');
    return;
  }
  await pool.query(
    "INSERT INTO Users (full_name, email, password, role, must_change_password) VALUES (?, ?, ?, 'coordinator', FALSE)",
    [ADMIN_NAME || 'OJT Coordinator', ADMIN_EMAIL.toLowerCase(), await hash(ADMIN_PASSWORD)]
  );
  console.log(`[Bootstrap] First coordinator created: ${ADMIN_EMAIL}`);
}
module.exports = { ensureAdmin };
