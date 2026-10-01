// Placements: the school assigns students OR students find their own company (coordinator approves).
const { pool, withTx } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull, requireFields, isEmail, uploadUrl } = require('../utils/http');
const { notify, notifyCoordinators } = require('../utils/notify');
const { audit } = require('../utils/audit');
const { createSupervisorAccount } = require('./usersController');

const PLACEMENT_SELECT = `
  SELECT pl.*, u.full_name AS student_name, u.school_id, u.email AS student_email, sp.program, sp.year_level, sp.section,
         c.company_name, c.is_partner, sup_u.full_name AS supervisor_name
  FROM Placement pl
  JOIN Student_profile sp ON sp.student_id = pl.student_id
  JOIN Users u ON u.user_id = sp.user_id
  LEFT JOIN Company c ON c.company_id = pl.company_id
  LEFT JOIN Supervisor_profile sup ON sup.supervisor_id = pl.supervisor_id
  LEFT JOIN Users sup_u ON sup_u.user_id = sup.user_id`;

// POST /api/placements   (student) — "I found my own OJT". multipart: acceptance_letter (optional file)
const submitRequest = asyncHandler(async (req, res) => {
  const b = req.body; const sid = req.user.student_id;
  if (!sid) throw new HttpError(403, 'No student profile.');
  const [[s]] = await pool.query('SELECT ojt_status FROM Student_profile WHERE student_id = ?', [sid]);
  if (['ongoing', 'pending_approval'].includes(s.ojt_status)) throw new HttpError(409, s.ojt_status === 'ongoing'
    ? 'You already have an approved placement. Ask your coordinator if you need to change it.' : 'You already have a request waiting for approval.');
  if (s.ojt_status === 'completed') throw new HttpError(409, 'Your OJT is already completed.');

  let companyId = b.company_id ? Number(b.company_id) : null;
  if (!companyId) requireFields(b, ['proposed_company_name', 'proposed_company_address']);
  requireFields(b, ['proposed_supervisor_name', 'proposed_supervisor_email', 'start_date']);
  if (!isEmail(String(b.proposed_supervisor_email).trim())) throw new HttpError(400, "Enter a valid email for your company supervisor.");

  const id = await withTx(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO Placement (student_id, company_id, source, status, proposed_company_name, proposed_company_address, proposed_industry, proposed_contact,
         proposed_supervisor_name, proposed_supervisor_email, proposed_supervisor_phone, proposed_supervisor_position, start_date, end_date, acceptance_letter, student_remarks)
       VALUES (?, ?, 'self_sourced', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sid, companyId, blankToNull(b.proposed_company_name), blankToNull(b.proposed_company_address), blankToNull(b.proposed_industry), blankToNull(b.proposed_contact),
       b.proposed_supervisor_name.trim(), b.proposed_supervisor_email.trim().toLowerCase(), blankToNull(b.proposed_supervisor_phone), blankToNull(b.proposed_supervisor_position),
       b.start_date, blankToNull(b.end_date), uploadUrl(req.file), blankToNull(b.student_remarks)]);
    await conn.query("UPDATE Student_profile SET ojt_status = 'pending_approval' WHERE student_id = ?", [sid]);
    return r.insertId;
  });
  await notifyCoordinators({ title: 'New OJT placement request', message: `${req.user.full_name} submitted their own OJT company for approval.`, type: 'placement', link: '/placements' });
  res.status(201).json({ placement_id: id });
});

// GET /api/placements/mine   (student)
const myPlacements = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`${PLACEMENT_SELECT} WHERE pl.student_id = ? ORDER BY pl.placement_id DESC`, [req.user.student_id || 0]);
  res.json(rows);
});

// POST /api/placements/:id/cancel   (student, only while pending)
const cancelRequest = asyncHandler(async (req, res) => {
  await withTx(async (conn) => {
    const [r] = await conn.query("UPDATE Placement SET status = 'cancelled' WHERE placement_id = ? AND student_id = ? AND status = 'pending'", [req.params.id, req.user.student_id]);
    if (!r.affectedRows) throw new HttpError(404, 'No pending request found.');
    await conn.query("UPDATE Student_profile SET ojt_status = 'looking' WHERE student_id = ?", [req.user.student_id]);
  });
  res.json({ message: 'Request cancelled.' });
});

// GET /api/placements?status=&source=&search=   (coordinator)
const listPlacements = asyncHandler(async (req, res) => {
  const pg = getPage(req); const where = []; const params = [];
  if (req.query.status) { where.push('pl.status = ?'); params.push(req.query.status); }
  if (req.query.source) { where.push('pl.source = ?'); params.push(req.query.source); }
  if (req.query.search) { where.push('(u.full_name LIKE ? OR u.school_id LIKE ? OR c.company_name LIKE ? OR pl.proposed_company_name LIKE ?)'); params.push(...Array(4).fill(`%${req.query.search}%`)); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Placement pl JOIN Student_profile sp ON sp.student_id = pl.student_id JOIN Users u ON u.user_id = sp.user_id LEFT JOIN Company c ON c.company_id = pl.company_id ${W}`, params);
  const [rows] = await pool.query(`${PLACEMENT_SELECT} ${W} ORDER BY (pl.status = 'pending') DESC, pl.placement_id DESC LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

// POST /api/placements/assign   (coordinator) — school assigns many students to one company/supervisor
//   { student_ids: [..], company_id, supervisor_id, start_date, end_date? }
const assignStudents = asyncHandler(async (req, res) => {
  const { student_ids, company_id, supervisor_id, start_date, end_date } = req.body;
  if (!Array.isArray(student_ids) || !student_ids.length) throw new HttpError(400, 'Select at least one student.');
  requireFields(req.body, ['company_id', 'supervisor_id']);
  const [[sup]] = await pool.query('SELECT sup.supervisor_id, sup.user_id, sup.company_id FROM Supervisor_profile sup WHERE sup.supervisor_id = ?', [supervisor_id]);
  if (!sup) throw new HttpError(400, 'Supervisor not found.');
  const [[c]] = await pool.query('SELECT company_name FROM Company WHERE company_id = ?', [company_id]);
  if (!c) throw new HttpError(400, 'Company not found.');
  const start = blankToNull(start_date) || new Date().toISOString().slice(0, 10);

  let done = 0;
  await withTx(async (conn) => {
    for (const sid of student_ids) {
      const [[s]] = await conn.query('SELECT sp.student_id, sp.user_id, sp.ojt_status FROM Student_profile sp WHERE sp.student_id = ?', [sid]);
      if (!s || s.ojt_status === 'completed') continue;
      await conn.query("UPDATE Placement SET status = 'cancelled' WHERE student_id = ? AND status = 'pending'", [sid]);
      await conn.query(
        `INSERT INTO Placement (student_id, company_id, supervisor_id, source, status, start_date, end_date, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, 'school_assigned', 'approved', ?, ?, ?, NOW())`, [sid, company_id, supervisor_id, start, blankToNull(end_date), req.user.user_id]);
      await conn.query("UPDATE Student_profile SET company_id = ?, supervisor_id = ?, ojt_status = 'ongoing', start_date = ? WHERE student_id = ?", [company_id, supervisor_id, start, sid]);
      await notify(s.user_id, { title: 'OJT placement assigned', message: `You have been assigned to ${c.company_name}. You can now log your attendance.`, type: 'placement', link: '/placement' }, conn);
      done++;
    }
  });
  await notify(sup.user_id, { title: 'New interns assigned', message: `${done} student(s) were assigned to you.`, type: 'placement', link: '/interns' });
  await audit(req.user.user_id, 'placement.assign', 'Placement', null, `${done} students -> ${c.company_name}`);
  res.json({ assigned: done });
});

// POST /api/placements/:id/approve   (coordinator)
//   { company_id? | new_company?: {...}, supervisor_id? | new_supervisor?: {...}, start_date?, end_date?, reviewer_remarks?, is_partner? }
// Falls back to what the student proposed. Creates the company / supervisor account when they are new.
const approve = asyncHandler(async (req, res) => {
  const b = req.body; let newSupervisorCreds = null;
  const result = await withTx(async (conn) => {
    const [[pl]] = await conn.query('SELECT * FROM Placement WHERE placement_id = ? FOR UPDATE', [req.params.id]);
    if (!pl) throw new HttpError(404, 'Request not found.');
    if (pl.status !== 'pending') throw new HttpError(409, 'This request was already reviewed.');
    const [[stu]] = await conn.query('SELECT sp.user_id FROM Student_profile sp WHERE sp.student_id = ?', [pl.student_id]);

    // 1) company
    let companyId = b.company_id || pl.company_id || null;
    if (!companyId) {
      const nc = b.new_company || {};
      const name = blankToNull(nc.company_name) || pl.proposed_company_name;
      if (!name) throw new HttpError(400, 'A company name is required.');
      const [c] = await conn.query(
        `INSERT INTO Company (company_name, address, industry, contact_person, contact_email, contact_phone, is_partner, moa_status, source, suggested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'student', ?)`,
        [name, blankToNull(nc.address) || pl.proposed_company_address, blankToNull(nc.industry) || pl.proposed_industry, blankToNull(nc.contact_person) || pl.proposed_contact,
         blankToNull(nc.contact_email), blankToNull(nc.contact_phone), !!(nc.is_partner ?? b.is_partner), (nc.is_partner ?? b.is_partner) ? 'active' : 'none', stu.user_id]);
      companyId = c.insertId;
    }

    // 2) supervisor
    let supervisorId = b.supervisor_id || pl.supervisor_id || null;
    if (!supervisorId) {
      const ns = b.new_supervisor || {};
      const email = (blankToNull(ns.email) || pl.proposed_supervisor_email || '').toLowerCase();
      const name = blankToNull(ns.full_name) || pl.proposed_supervisor_name;
      if (!email || !name) throw new HttpError(400, 'A supervisor is required (choose one or provide name and email).');
      const [ex] = await conn.query(
        `SELECT u.user_id, u.role, sup.supervisor_id FROM Users u LEFT JOIN Supervisor_profile sup ON sup.user_id = u.user_id WHERE u.email = ?`, [email]);
      if (ex.length) {
        if (ex[0].role !== 'supervisor') throw new HttpError(409, `${email} already belongs to a ${ex[0].role} account.`);
        supervisorId = ex[0].supervisor_id;
      } else {
        const created = await createSupervisorAccount(conn, {
          full_name: name, email, phone_number: blankToNull(ns.phone_number) || pl.proposed_supervisor_phone, company_id: companyId,
          position: blankToNull(ns.position) || pl.proposed_supervisor_position, department: ns.department,
        }, req.user.user_id);
        supervisorId = created.supervisor_id; newSupervisorCreds = { email: created.email, temp_password: created.temp_password, full_name: name };
      }
    }
    const [[supRow]] = await conn.query('SELECT user_id FROM Supervisor_profile WHERE supervisor_id = ?', [supervisorId]);
    if (!supRow) throw new HttpError(400, 'Supervisor not found.');

    const start = blankToNull(b.start_date) || pl.start_date;
    await conn.query(
      `UPDATE Placement SET status = 'approved', company_id = ?, supervisor_id = ?, start_date = ?, end_date = COALESCE(?, end_date),
         reviewer_remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE placement_id = ?`,
      [companyId, supervisorId, start, blankToNull(b.end_date), blankToNull(b.reviewer_remarks), req.user.user_id, pl.placement_id]);
    await conn.query("UPDATE Student_profile SET company_id = ?, supervisor_id = ?, ojt_status = 'ongoing', start_date = ? WHERE student_id = ?", [companyId, supervisorId, start, pl.student_id]);
    await notify(stu.user_id, { title: 'OJT placement approved', message: 'Your OJT company was approved. You can now log your attendance.', type: 'placement', link: '/placement' }, conn);
    await notify(supRow.user_id, { title: 'New intern assigned', message: 'A student was assigned to you.', type: 'placement', link: '/interns' }, conn);
    return { placement_id: pl.placement_id, company_id: companyId, supervisor_id: supervisorId };
  });
  await audit(req.user.user_id, 'placement.approve', 'Placement', result.placement_id);
  res.json({ ...result, new_supervisor: newSupervisorCreds });
});

// POST /api/placements/:id/reject   { reviewer_remarks }   (coordinator)
const reject = asyncHandler(async (req, res) => {
  requireFields(req.body, ['reviewer_remarks']);
  await withTx(async (conn) => {
    const [[pl]] = await conn.query('SELECT * FROM Placement WHERE placement_id = ? FOR UPDATE', [req.params.id]);
    if (!pl) throw new HttpError(404, 'Request not found.');
    if (pl.status !== 'pending') throw new HttpError(409, 'This request was already reviewed.');
    await conn.query("UPDATE Placement SET status = 'rejected', reviewer_remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE placement_id = ?", [req.body.reviewer_remarks.trim(), req.user.user_id, pl.placement_id]);
    await conn.query("UPDATE Student_profile SET ojt_status = 'looking' WHERE student_id = ?", [pl.student_id]);
    const [[stu]] = await conn.query('SELECT user_id FROM Student_profile WHERE student_id = ?', [pl.student_id]);
    await notify(stu.user_id, { title: 'OJT request needs changes', message: req.body.reviewer_remarks.trim().slice(0, 200), type: 'placement', link: '/placement' }, conn);
  });
  await audit(req.user.user_id, 'placement.reject', 'Placement', Number(req.params.id));
  res.json({ message: 'Request rejected.' });
});

module.exports = { submitRequest, myPlacements, cancelRequest, listPlacements, assignStudents, approve, reject };
