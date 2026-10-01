const { withTx } = require('../config/db');
const { createStudentAccount } = require('../controllers/studentsController');
async function importStudentsProgrammatic(rows, opts) {
  const created = []; const skipped = [];
  for (const row of rows) {
    try { created.push(await withTx((conn) => createStudentAccount(conn, row, { password_mode: 'student_id', ...opts }))); }
    catch (e) { skipped.push({ ...row, reason: e.message }); }
  }
  return { created, skipped };
}
module.exports = { importStudentsProgrammatic };
