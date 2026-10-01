// Feature 1 (Authentication) and Feature 11 (Profile Management).
// There is NO public sign-up: accounts are created by the coordinator (or the first-admin bootstrap).
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { loadUser } = require('../middleware/auth');
const { hash, compare } = require('../utils/password');
const { HttpError, asyncHandler, blankToNull } = require('../utils/http');

const sessionUser = (u) => ({
  user_id: u.user_id, school_id: u.school_id, full_name: u.full_name, email: u.email, phone_number: u.phone_number,
  role: u.role, must_change_password: !!u.must_change_password,
  student_id: u.student_id || undefined, supervisor_id: u.supervisor_id || undefined,
});

// POST /api/auth/login   { identifier: email OR student/employee ID, password }
const login = asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier || req.body.email || '').trim();
  const password = String(req.body.password || '');
  if (!identifier || !password) throw new HttpError(400, 'Enter your school email or ID, and your password.');

  const [rows] = await pool.query('SELECT * FROM Users WHERE email = ? OR school_id = ? LIMIT 1', [identifier.toLowerCase(), identifier]);
  const u = rows[0];
  if (!u || !(await compare(password, u.password))) throw new HttpError(401, 'Incorrect email/ID or password.');
  if (!u.is_active) throw new HttpError(403, 'This account has been deactivated. Please contact your OJT coordinator.');

  await pool.query('UPDATE Users SET last_login_at = NOW() WHERE user_id = ?', [u.user_id]);
  const token = jwt.sign({ user_id: u.user_id, role: u.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  res.json({ token, user: sessionUser(await loadUser(u.user_id)) });
});

// GET /api/auth/me
const me = asyncHandler(async (req, res) => res.json(sessionUser(req.user)));

// PATCH /api/auth/me   { full_name?, phone_number? }
const updateMe = asyncHandler(async (req, res) => {
  const name = blankToNull(req.body.full_name);
  await pool.query('UPDATE Users SET full_name = COALESCE(?, full_name), phone_number = ? WHERE user_id = ?',
    [name, blankToNull(req.body.phone_number), req.user.user_id]);
  res.json(sessionUser(await loadUser(req.user.user_id)));
});

// POST /api/auth/change-password   { current_password, new_password }
const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) throw new HttpError(400, 'Enter your current and new password.');
  if (String(new_password).length < 8) throw new HttpError(400, 'The new password must be at least 8 characters.');
  if (new_password === current_password) throw new HttpError(400, 'The new password must be different from the current one.');
  const [[u]] = await pool.query('SELECT password FROM Users WHERE user_id = ?', [req.user.user_id]);
  if (!(await compare(current_password, u.password))) throw new HttpError(400, 'Your current password is incorrect.');
  await pool.query('UPDATE Users SET password = ?, must_change_password = FALSE WHERE user_id = ?', [await hash(new_password), req.user.user_id]);
  res.json({ message: 'Password updated.', user: sessionUser(await loadUser(req.user.user_id)) });
});

module.exports = { login, me, updateMe, changePassword };
