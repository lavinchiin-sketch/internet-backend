// Companies — partner or not. Students may train at companies with no school partnership.
const { pool } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull, requireFields } = require('../utils/http');
const { audit } = require('../utils/audit');

const COMPANY_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM Student_profile s WHERE s.company_id = c.company_id AND s.ojt_status = 'ongoing') AS interns,
    (SELECT COUNT(*) FROM Supervisor_profile sp WHERE sp.company_id = c.company_id) AS supervisors
  FROM Company c`;

// GET /api/companies?search=&partner=1|0&status=active|inactive&all=1
const listCompanies = asyncHandler(async (req, res) => {
  const pg = getPage(req);
  const where = []; const params = [];
  // Students and supervisors only ever see active companies.
  if (req.user.role !== 'coordinator') where.push("c.status = 'active'");
  else if (req.query.status) { where.push('c.status = ?'); params.push(req.query.status); }
  if (req.query.partner === '1' || req.query.partner === '0') { where.push('c.is_partner = ?'); params.push(Number(req.query.partner)); }
  if (req.query.search) { where.push('(c.company_name LIKE ? OR c.industry LIKE ? OR c.address LIKE ?)'); params.push(...Array(3).fill(`%${req.query.search}%`)); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM Company c ${W}`, params);
  const [rows] = await pool.query(`${COMPANY_SELECT} ${W} ORDER BY c.is_partner DESC, c.company_name LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

// GET /api/companies/:id
const getCompany = asyncHandler(async (req, res) => {
  const [[c]] = await pool.query(`${COMPANY_SELECT} WHERE c.company_id = ?`, [req.params.id]);
  if (!c) throw new HttpError(404, 'Company not found.');
  const [interns] = await pool.query(
    `SELECT sp.student_id, u.full_name, u.school_id, sp.program, sp.completed_hours, sp.required_hours
     FROM Student_profile sp JOIN Users u ON u.user_id = sp.user_id WHERE sp.company_id = ? AND sp.ojt_status = 'ongoing' ORDER BY u.full_name`, [req.params.id]);
  const [supervisors] = await pool.query(
    `SELECT sup.supervisor_id, u.full_name, u.email, sup.position FROM Supervisor_profile sup JOIN Users u ON u.user_id = sup.user_id WHERE sup.company_id = ?`, [req.params.id]);
  res.json({ ...c, intern_list: interns, supervisor_list: supervisors });
});

function fields(b) {
  const partner = !!b.is_partner;
  return [b.company_name.trim(), blankToNull(b.address), blankToNull(b.industry), blankToNull(b.contact_person),
    blankToNull(b.contact_email), blankToNull(b.contact_phone), partner,
    ['none', 'pending', 'active', 'expired'].includes(b.moa_status) ? b.moa_status : (partner ? 'active' : 'none'), blankToNull(b.moa_expiry)];
}

// POST /api/companies   (coordinator)
const createCompany = asyncHandler(async (req, res) => {
  requireFields(req.body, ['company_name']);
  const [r] = await pool.query(
    `INSERT INTO Company (company_name, address, industry, contact_person, contact_email, contact_phone, is_partner, moa_status, moa_expiry, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'school')`, fields(req.body));
  await audit(req.user.user_id, 'company.create', 'Company', r.insertId, req.body.company_name);
  res.status(201).json({ company_id: r.insertId });
});

// PATCH /api/companies/:id   (coordinator)
const updateCompany = asyncHandler(async (req, res) => {
  requireFields(req.body, ['company_name']);
  const [r] = await pool.query(
    `UPDATE Company SET company_name=?, address=?, industry=?, contact_person=?, contact_email=?, contact_phone=?, is_partner=?, moa_status=?, moa_expiry=?,
       status = COALESCE(?, status) WHERE company_id = ?`,
    [...fields(req.body), ['active', 'inactive'].includes(req.body.status) ? req.body.status : null, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Company not found.');
  await audit(req.user.user_id, 'company.update', 'Company', Number(req.params.id), req.body.company_name);
  res.json({ message: 'Company updated.' });
});

module.exports = { listCompanies, getCompany, createCompany, updateCompany };
