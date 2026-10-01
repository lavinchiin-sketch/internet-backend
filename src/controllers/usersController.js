// Coordinator: manage supervisor and coordinator accounts.
const { pool, withTx } = require('../config/db');
const { hash, generatePassword } = require('../utils/password');
const { HttpError, asyncHandler, getPage, pageResult, isEmail, blankToNull, requireFields } = require('../utils/http');
const { audit } = require('../utils/audit');

// Shared with the placement-approval flow: create a supervisor user + profile.
async function createSupervisorAccount(conn, { full_name, email, phone_number, company_id, position, department, password }, createdBy) {
  const em = String(email).trim().toLowerCase();
  if (!isEmail(em)) throw new HttpError(400, 'Enter a valid supervisor email.');
  const [dup] = await conn.query('SELECT user_id FROM Users WHERE email = ?', [em]);
  if (dup.length) throw new HttpError(409, `An account with ${em} already exists.`);
  const temp = password || generatePassword();
  const [u] = await conn.query(
    `INSERT INTO Users (full_name, email, phone_number, password, role, must_change_password, created_by)
     VALUES (?, ?, ?, ?, 'supervisor', TRUE, ?)`, [full_name.trim(), em, blankToNull(phone_number), await hash(temp), createdBy || null]);
  const [p] = await conn.query('INSERT INTO Supervisor_profile (user_id, company_id, position, department) VALUES (?, ?, ?, ?)',
    [u.insertId, company_id || null, blankToNull(position), blankToNull(department)]);
  return { user_id: u.insertId, supervisor_id: p.insertId, email: em, temp_password: temp };
}

// POST /api/users/supervisors
const createSupervisor = asyncHandler(async (req, res) => {
  requireFields(req.body, ['full_name', 'email']);
  const out = await withTx((conn) => createSupervisorAccount(conn, req.body, req.user.user_id));
  await audit(req.user.user_id, 'supervisor.create', 'Supervisor_profile', out.supervisor_id, req.body.email);
  res.status(201).json(out);
});

// POST /api/users/coordinators
const createCoordinator = asyncHandler(async (req, res) => {
  requireFields(req.body, ['full_name', 'email']);
  const em = String(req.body.email).trim().toLowerCase();
  if (!isEmail(em)) throw new HttpError(400, 'Enter a valid email.');
  const temp = req.body.password || generatePassword();
  const [r] = await pool.query(
    `INSERT INTO Users (full_name, email, phone_number, password, role, must_change_password, created_by)
     VALUES (?, ?, ?, ?, 'coordinator', TRUE, ?)`, [req.body.full_name.trim(), em, blankToNull(req.body.phone_number), await hash(temp), req.user.user_id]);
  await audit(req.user.user_id, 'coordinator.create', 'Users', r.insertId, em);
  res.status(201).json({ user_id: r.insertId, email: em, temp_password: temp });
});

// GET /api/users?role=supervisor&search=&active=1&company_id=
const listUsers = asyncHandler(async (req, res) => {
  const pg = getPage(req);
  const role = req.query.role || 'supervisor';
  const where = role === 'all' ? ["u.role IN ('supervisor','coordinator')"] : ['u.role = ?'];
  const params = role === 'all' ? [] : [role];
  if (req.query.search) { where.push('(u.full_name LIKE ? OR u.email LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
  if (req.query.active === '1' || req.query.active === '0') { where.push('u.is_active = ?'); params.push(Number(req.query.active)); }
  if (req.query.company_id) { where.push('sup.company_id = ?'); params.push(req.query.company_id); }
  const from = `FROM Users u LEFT JOIN Supervisor_profile sup ON sup.user_id = u.user_id LEFT JOIN Company c ON c.company_id = sup.company_id WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from}`, params);
  const [rows] = await pool.query(
    `SELECT u.user_id, u.full_name, u.email, u.phone_number, u.role, u.is_active, u.last_login_at, u.created_at,
            sup.supervisor_id, sup.position, sup.department, sup.company_id, c.company_name,
            (SELECT COUNT(*) FROM Student_profile s WHERE s.supervisor_id = sup.supervisor_id AND s.ojt_status = 'ongoing') AS interns
     ${from} ORDER BY u.full_name LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

// PATCH /api/users/:id   { full_name?, email?, phone_number?, is_active?, company_id?, position?, department? }
const updateUser = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query('SELECT * FROM Users WHERE user_id = ?', [id]);
  if (!u) throw new HttpError(404, 'User not found.');
  if (id === req.user.user_id && req.body.is_active === false) throw new HttpError(400, 'You cannot deactivate your own account.');
  const b = req.body;
  if (b.email !== undefined && !isEmail(String(b.email).trim())) throw new HttpError(400, 'Enter a valid email.');
  await withTx(async (conn) => {
    await conn.query(
      `UPDATE Users SET full_name = ?, email = ?, phone_number = ?, is_active = ? WHERE user_id = ?`,
      [b.full_name ? b.full_name.trim() : u.full_name, b.email ? b.email.trim().toLowerCase() : u.email,
       b.phone_number !== undefined ? blankToNull(b.phone_number) : u.phone_number,
       b.is_active !== undefined ? !!b.is_active : u.is_active, id]);
    if (u.role === 'supervisor' && (b.company_id !== undefined || b.position !== undefined || b.department !== undefined)) {
      await conn.query(
        `UPDATE Supervisor_profile SET company_id = COALESCE(?, company_id), position = COALESCE(?, position), department = COALESCE(?, department) WHERE user_id = ?`,
        [b.company_id || null, blankToNull(b.position), blankToNull(b.department), id]);
    }
  });
  await audit(req.user.user_id, b.is_active === false ? 'user.deactivate' : 'user.update', 'Users', id, u.email);
  res.json({ message: 'Account updated.' });
});

// POST /api/users/:id/reset-password   { password? }  -> returns the new temporary password ONCE
const resetPassword = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query('SELECT user_id, email, school_id, role FROM Users WHERE user_id = ?', [id]);
  if (!u) throw new HttpError(404, 'User not found.');
  const temp = req.body.password || (req.body.use_school_id && u.school_id ? u.school_id : generatePassword());
  await pool.query('UPDATE Users SET password = ?, must_change_password = TRUE WHERE user_id = ?', [await hash(temp), id]);
  await audit(req.user.user_id, 'user.reset_password', 'Users', id, u.email);
  res.json({ email: u.email, temp_password: temp });
});

module.exports = { createSupervisor, createCoordinator, listUsers, updateUser, resetPassword, createSupervisorAccount };
