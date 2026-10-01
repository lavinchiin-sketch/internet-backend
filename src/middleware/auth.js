// JWT check + fresh user/profile lookup on every request (so deactivating an account takes effect immediately).
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { HttpError, asyncHandler } = require('../utils/http');

async function loadUser(userId) {
  const [rows] = await pool.query(
    `SELECT u.user_id, u.school_id, u.full_name, u.email, u.phone_number, u.role, u.is_active, u.must_change_password,
            sp.student_id, sup.supervisor_id, sup.company_id AS supervisor_company_id
     FROM Users u
     LEFT JOIN Student_profile sp ON sp.user_id = u.user_id
     LEFT JOIN Supervisor_profile sup ON sup.user_id = u.user_id
     WHERE u.user_id = ?`, [userId]);
  return rows[0] || null;
}

function build(allowMustChange) {
  return asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Please sign in.');
    let decoded;
    try { decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET); }
    catch { throw new HttpError(401, 'Your session expired. Please sign in again.'); }

    const user = await loadUser(decoded.user_id);
    if (!user || !user.is_active) throw new HttpError(401, 'This account is not active.');
    if (user.must_change_password && !allowMustChange) {
      const err = new HttpError(403, 'You must change your temporary password first.');
      err.code = 'PASSWORD_CHANGE_REQUIRED';
      throw err;
    }
    req.user = user;
    next();
  });
}

module.exports = { authenticate: build(false), authenticateLoose: build(true), loadUser };
