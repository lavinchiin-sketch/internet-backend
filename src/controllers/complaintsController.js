// Feature 5 — concerns and incident reports.
const { pool } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull, requireFields, uploadUrl } = require('../utils/http');
const { notify, notifyCoordinators } = require('../utils/notify');

const CAT = ['safety', 'harassment', 'workload', 'schedule', 'allowance', 'other'];
const SELECT = `
  SELECT c.*, u.full_name AS filed_by_name, u.role AS filed_by_role, u.school_id, co.company_name
  FROM Complaint c JOIN Users u ON u.user_id = c.filed_by LEFT JOIN Company co ON co.company_id = c.company_id`;

// POST /api/complaints   multipart: category, severity, subject, description, evidence (optional file)
const fileComplaint = asyncHandler(async (req, res) => {
  requireFields(req.body, ['subject', 'description']);
  const b = req.body;
  let companyId = null;
  if (req.user.role === 'student') {
    const [[s]] = await pool.query('SELECT company_id FROM Student_profile WHERE student_id = ?', [req.user.student_id]); companyId = s ? s.company_id : null;
  } else if (req.user.role === 'supervisor') companyId = req.user.supervisor_company_id || null;
  const [r] = await pool.query(
    'INSERT INTO Complaint (filed_by, company_id, category, severity, subject, description, evidence_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.user.user_id, companyId, CAT.includes(b.category) ? b.category : 'other', ['low', 'medium', 'high'].includes(b.severity) ? b.severity : 'medium',
     b.subject.trim(), b.description.trim(), uploadUrl(req.file)]);
  await notifyCoordinators({ title: b.severity === 'high' ? 'HIGH severity concern filed' : 'New concern filed', message: b.subject.trim(), type: 'complaint', link: '/complaints' });
  res.status(201).json({ complaint_id: r.insertId });
});

// GET /api/complaints?status=&category=&severity=&search=   (coordinator: all, others: their own)
const listComplaints = asyncHandler(async (req, res) => {
  const pg = getPage(req); const q = req.query; const where = []; const params = [];
  if (req.user.role !== 'coordinator') { where.push('c.filed_by = ?'); params.push(req.user.user_id); }
  for (const f of ['status', 'category', 'severity']) if (q[f]) { where.push(`c.${f} = ?`); params.push(q[f]); }
  if (q.search) { where.push('(c.subject LIKE ? OR u.full_name LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM Complaint c JOIN Users u ON u.user_id = c.filed_by ${W}`, params);
  const [rows] = await pool.query(
    `${SELECT} ${W} ORDER BY (c.status IN ('open','under_review')) DESC, FIELD(c.severity,'high','medium','low'), c.complaint_id DESC LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

// PATCH /api/complaints/:id   { status, resolution_notes }   (coordinator)
const updateComplaint = asyncHandler(async (req, res) => {
  const { status, resolution_notes } = req.body;
  if (!['under_review', 'resolved', 'dismissed', 'open'].includes(status)) throw new HttpError(400, 'Invalid status.');
  if (['resolved', 'dismissed'].includes(status) && !String(resolution_notes || '').trim()) throw new HttpError(400, 'Add resolution notes so the person knows the outcome.');
  const [[c]] = await pool.query('SELECT filed_by, subject FROM Complaint WHERE complaint_id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Complaint not found.');
  const closed = ['resolved', 'dismissed'].includes(status);
  await pool.query('UPDATE Complaint SET status = ?, resolution_notes = ?, resolved_by = ?, resolved_at = ? WHERE complaint_id = ?',
    [status, blankToNull(resolution_notes), closed ? req.user.user_id : null, closed ? new Date() : null, req.params.id]);
  await notify(c.filed_by, { title: `Your concern is ${status.replace('_', ' ')}`, message: c.subject, type: 'complaint', link: '/concerns' });
  res.json({ message: 'Complaint updated.' });
});

module.exports = { fileComplaint, listComplaints, updateComplaint };
