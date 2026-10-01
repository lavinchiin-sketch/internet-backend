// Students: list/search, detail, bulk import (student ID + school email), edit, status.
const { pool, withTx } = require('../config/db');
const { hash, generatePassword } = require('../utils/password');
const { HttpError, asyncHandler, getPage, pageResult, isEmail, blankToNull } = require('../utils/http');
const { audit } = require('../utils/audit');
const { notifyCoordinators } = require('../utils/notify');

const STUDENT_SELECT = `
  SELECT sp.student_id, u.user_id, u.school_id, u.full_name, u.email, u.phone_number, u.is_active, u.last_login_at,
         sp.program, sp.year_level, sp.section, sp.required_hours, sp.completed_hours, sp.ojt_status, sp.term_id,
         sp.company_id, sp.supervisor_id, sp.start_date, sp.end_date,
         c.company_name, c.is_partner, sup_u.full_name AS supervisor_name, sup_u.email AS supervisor_email,
         sup.position AS supervisor_position, t.school_year, t.semester,
         ROUND(sp.completed_hours / NULLIF(sp.required_hours, 0) * 100, 1) AS progress_percent,
         (SELECT pl.source FROM Placement pl WHERE pl.student_id = sp.student_id AND pl.status = 'approved'
            ORDER BY pl.placement_id DESC LIMIT 1) AS placement_source,
         (SELECT COUNT(*) FROM Daily_report d WHERE d.student_id = sp.student_id AND d.verify_status = 'flagged') AS flagged_logs,
         (SELECT COUNT(*) FROM Daily_report d WHERE d.student_id = sp.student_id AND d.verify_status = 'pending') AS pending_logs
  FROM Student_profile sp
  JOIN Users u ON u.user_id = sp.user_id
  LEFT JOIN Company c ON c.company_id = sp.company_id
  LEFT JOIN Supervisor_profile sup ON sup.supervisor_id = sp.supervisor_id
  LEFT JOIN Users sup_u ON sup_u.user_id = sup.user_id
  LEFT JOIN Ojt_term t ON t.term_id = sp.term_id`;

const SORTS = {
  name: 'u.full_name ASC', school_id: 'u.school_id ASC', progress: 'progress_percent DESC',
  progress_asc: 'progress_percent ASC', newest: 'sp.student_id DESC', status: 'sp.ojt_status ASC',
};

// GET /api/students   (coordinator: all; supervisor: only their own interns)
const listStudents = asyncHandler(async (req, res) => {
  const pg = getPage(req);
  const q = req.query;
  const where = []; const params = [];
  if (req.user.role === 'supervisor') { where.push('sp.supervisor_id = ?'); params.push(req.user.supervisor_id || 0); }
  if (q.search) {
    where.push('(u.full_name LIKE ? OR u.school_id LIKE ? OR u.email LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  if (q.program) { where.push('sp.program = ?'); params.push(q.program); }
  if (q.status) { where.push('sp.ojt_status = ?'); params.push(q.status); }
  if (q.term_id) { where.push('sp.term_id = ?'); params.push(q.term_id); }
  if (q.company_id) { where.push('sp.company_id = ?'); params.push(q.company_id); }
  if (q.supervisor_id && req.user.role === 'coordinator') { where.push('sp.supervisor_id = ?'); params.push(q.supervisor_id); }
  if (q.unassigned === '1') where.push("sp.ojt_status IN ('not_started','looking')");
  if (q.active === '1' || q.active === '0') { where.push('u.is_active = ?'); params.push(Number(q.active)); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Student_profile sp JOIN Users u ON u.user_id = sp.user_id ${W}`, params);
  const [rows] = await pool.query(`${STUDENT_SELECT} ${W} ORDER BY ${SORTS[q.sort] || SORTS.name} LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

async function studentDetail(studentId) {
  const [[s]] = await pool.query(`${STUDENT_SELECT} WHERE sp.student_id = ?`, [studentId]);
  if (!s) return null;
  const [[att]] = await pool.query(
    `SELECT COUNT(*) AS total_logs, SUM(verify_status='verified') AS verified, SUM(verify_status='pending') AS pending,
            SUM(verify_status='flagged') AS flagged, MAX(report_date) AS last_log
     FROM Daily_report WHERE student_id = ?`, [studentId]);
  const [[tasks]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status='completed') AS completed, SUM(status='submitted') AS submitted,
            SUM(status IN ('assigned','revision')) AS open_tasks FROM Task_assignment WHERE student_id = ?`, [studentId]);
  const [[docs]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status='approved') AS approved, SUM(status='pending') AS pending, SUM(status='rejected') AS rejected
     FROM Document WHERE student_id = ?`, [studentId]);
  const [placements] = await pool.query(
    `SELECT pl.*, c.company_name FROM Placement pl LEFT JOIN Company c ON c.company_id = pl.company_id
     WHERE pl.student_id = ? ORDER BY pl.placement_id DESC`, [studentId]);
  return { ...s, attendance: att, tasks, documents: docs, placements };
}

// GET /api/students/:id
const getStudent = asyncHandler(async (req, res) => {
  const d = await studentDetail(Number(req.params.id));
  if (!d) throw new HttpError(404, 'Student not found.');
  if (req.user.role === 'supervisor' && d.supervisor_id !== req.user.supervisor_id) throw new HttpError(403, 'This student is not assigned to you.');
  res.json(d);
});

// GET /api/students/me
const getMe = asyncHandler(async (req, res) => {
  if (!req.user.student_id) throw new HttpError(404, 'No student profile is linked to this account. Contact your coordinator.');
  const d = await studentDetail(req.user.student_id);
  res.json({ ...d, current_placement: d.placements[0] || null });
});

// GET /api/students/programs   distinct programs (for filters)
const listPrograms = asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT DISTINCT program FROM Student_profile WHERE program IS NOT NULL AND program <> '' ORDER BY program");
  res.json(rows.map((r) => r.program));
});

async function activeTerm(conn = pool) {
  const [[t]] = await conn.query('SELECT * FROM Ojt_term WHERE is_active = TRUE ORDER BY term_id DESC LIMIT 1');
  return t || null;
}

// Creates a user + student profile. Returns credentials. Throws HttpError for validation problems.
async function createStudentAccount(conn, row, opts) {
  const school_id = String(row.school_id || '').trim();
  const full_name = String(row.full_name || '').trim();
  const email = String(row.email || '').trim().toLowerCase();
  if (!school_id) throw new HttpError(400, 'Student ID is missing.');
  if (!full_name) throw new HttpError(400, 'Name is missing.');
  if (!isEmail(email)) throw new HttpError(400, `"${row.email || ''}" is not a valid email.`);
  const [dup] = await conn.query('SELECT user_id, school_id, email FROM Users WHERE email = ? OR school_id = ?', [email, school_id]);
  if (dup.length) throw new HttpError(409, dup[0].school_id === school_id ? `Student ID ${school_id} already exists.` : `Email ${email} already exists.`);

  const temp = opts.password_mode === 'random' ? generatePassword() : school_id;
  const [u] = await conn.query(
    `INSERT INTO Users (school_id, full_name, email, phone_number, password, role, must_change_password, created_by)
     VALUES (?, ?, ?, ?, ?, 'student', TRUE, ?)`,
    [school_id, full_name, email, blankToNull(row.phone_number || row.phone), await hash(temp), opts.created_by]);
  const [p] = await conn.query(
    `INSERT INTO Student_profile (user_id, term_id, program, year_level, section, required_hours, teacher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [u.insertId, opts.term_id || null, blankToNull(row.program), blankToNull(row.year_level), blankToNull(row.section),
     Number(row.required_hours) || opts.required_hours || 486, opts.created_by]);
  return { user_id: u.insertId, student_id: p.insertId, school_id, full_name, email, temp_password: temp };
}

// POST /api/students/import   { rows: [...], term_id?, password_mode: 'student_id' | 'random' }
// The frontend sends this in small batches so 500+ students import with a progress bar.
const importStudents = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, 'No rows to import.');
  if (rows.length > 100) throw new HttpError(400, 'Send at most 100 rows per request.');
  const term = req.body.term_id ? { term_id: Number(req.body.term_id) } : await activeTerm();
  const [[t]] = term ? await pool.query('SELECT default_required_hours FROM Ojt_term WHERE term_id = ?', [term.term_id]) : [[null]];
  const opts = {
    password_mode: req.body.password_mode === 'random' ? 'random' : 'student_id',
    term_id: term ? term.term_id : null, required_hours: t ? t.default_required_hours : 486, created_by: req.user.user_id,
  };
  const created = []; const skipped = [];
  for (const [i, row] of rows.entries()) {
    try {
      created.push(await withTx((conn) => createStudentAccount(conn, row, opts)));
    } catch (e) {
      if (!e.status) throw e;
      skipped.push({ index: row._row ?? i, school_id: row.school_id, email: row.email, reason: e.message });
    }
  }
  if (created.length) await audit(req.user.user_id, 'students.import', 'Student_profile', null, `${created.length} created, ${skipped.length} skipped`);
  res.status(201).json({ created, skipped });
});

// POST /api/students   single add (same rules as import)
const createStudent = asyncHandler(async (req, res) => {
  const term = req.body.term_id ? { term_id: Number(req.body.term_id) } : await activeTerm();
  const out = await withTx((conn) => createStudentAccount(conn, req.body, {
    password_mode: req.body.password_mode === 'random' ? 'random' : 'student_id',
    term_id: term ? term.term_id : null, required_hours: Number(req.body.required_hours) || 486, created_by: req.user.user_id,
  }));
  await audit(req.user.user_id, 'student.create', 'Student_profile', out.student_id, out.school_id);
  res.status(201).json(out);
});

// PATCH /api/students/:id   (coordinator)
const updateStudent = asyncHandler(async (req, res) => {
  const id = Number(req.params.id); const b = req.body;
  const [[s]] = await pool.query(
    `SELECT sp.*, u.full_name, u.email, u.school_id, u.phone_number FROM Student_profile sp JOIN Users u ON u.user_id = sp.user_id WHERE sp.student_id = ?`, [id]);
  if (!s) throw new HttpError(404, 'Student not found.');
  if (b.email !== undefined && !isEmail(String(b.email).trim())) throw new HttpError(400, 'Enter a valid email.');
  await withTx(async (conn) => {
    await conn.query('UPDATE Users SET full_name = ?, email = ?, school_id = ?, phone_number = ? WHERE user_id = ?',
      [b.full_name ? b.full_name.trim() : s.full_name, b.email ? b.email.trim().toLowerCase() : s.email,
       b.school_id ? String(b.school_id).trim() : s.school_id, b.phone_number !== undefined ? blankToNull(b.phone_number) : s.phone_number, s.user_id]);
    await conn.query(
      'UPDATE Student_profile SET program = ?, year_level = ?, section = ?, required_hours = ?, term_id = ? WHERE student_id = ?',
      [b.program !== undefined ? blankToNull(b.program) : s.program, b.year_level !== undefined ? blankToNull(b.year_level) : s.year_level,
       b.section !== undefined ? blankToNull(b.section) : s.section, Number(b.required_hours) || s.required_hours, b.term_id || s.term_id, id]);
  });
  await audit(req.user.user_id, 'student.update', 'Student_profile', id, s.school_id);
  res.json({ message: 'Student updated.' });
});

// PATCH /api/students/:id/status   { ojt_status }   (coordinator)
const setStatus = asyncHandler(async (req, res) => {
  const { ojt_status } = req.body;
  if (!['not_started', 'looking', 'pending_approval', 'ongoing', 'completed', 'dropped'].includes(ojt_status)) throw new HttpError(400, 'Invalid status.');
  const [r] = await pool.query(
    "UPDATE Student_profile SET ojt_status = ?, end_date = IF(? IN ('completed','dropped'), CURDATE(), end_date) WHERE student_id = ?",
    [ojt_status, ojt_status, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Student not found.');
  await audit(req.user.user_id, 'student.status', 'Student_profile', Number(req.params.id), ojt_status);
  res.json({ message: 'Status updated.' });
});

// POST /api/students/me/intent   { intent: 'self_sourcing' | 'need_assignment' }
const setIntent = asyncHandler(async (req, res) => {
  const [[s]] = await pool.query('SELECT ojt_status FROM Student_profile WHERE student_id = ?', [req.user.student_id]);
  if (!s) throw new HttpError(404, 'No student profile.');
  if (!['not_started', 'looking'].includes(s.ojt_status)) throw new HttpError(409, 'You already have a placement in progress.');
  const status = req.body.intent === 'self_sourcing' ? 'looking' : 'not_started';
  await pool.query('UPDATE Student_profile SET ojt_status = ? WHERE student_id = ?', [status, req.user.student_id]);
  if (status === 'not_started') await notifyCoordinators({ title: 'Student needs a placement', message: `${req.user.full_name} asked the school to assign an OJT company.`, type: 'placement', link: '/students' });
  res.json({ ojt_status: status });
});

module.exports = { listStudents, getStudent, getMe, listPrograms, importStudents, createStudent, updateStudent, setStatus, setIntent, activeTerm, STUDENT_SELECT, createStudentAccount };
