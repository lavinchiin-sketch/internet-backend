// Feature 8 + "Set OJT Requirements" — the coordinator defines requirements, students upload, coordinator reviews.
const { pool } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull, requireFields, uploadUrl } = require('../utils/http');
const { notify } = require('../utils/notify');

// ---------- Requirements (coordinator manages, everyone reads) ----------
const listRequirements = asyncHandler(async (req, res) => {
  const showAll = req.user.role === 'coordinator' && req.query.include_inactive === '1';
  const [rows] = await pool.query(
    `SELECT r.*, t.school_year, t.semester,
       (SELECT COUNT(*) FROM Document d WHERE d.requirement_id = r.requirement_id AND d.status = 'approved') AS approved_count
     FROM Requirement r LEFT JOIN Ojt_term t ON t.term_id = r.term_id
     ${showAll ? '' : 'WHERE r.is_active = TRUE'} ORDER BY r.is_required DESC, r.requirement_id`);
  res.json(rows);
});
const createRequirement = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const [r] = await pool.query('INSERT INTO Requirement (name, description, is_required, term_id) VALUES (?, ?, ?, ?)',
    [req.body.name.trim(), blankToNull(req.body.description), req.body.is_required !== false, req.body.term_id || null]);
  res.status(201).json({ requirement_id: r.insertId });
});
const updateRequirement = asyncHandler(async (req, res) => {
  const b = req.body;
  const [r] = await pool.query(
    'UPDATE Requirement SET name = COALESCE(?, name), description = ?, is_required = COALESCE(?, is_required), is_active = COALESCE(?, is_active) WHERE requirement_id = ?',
    [blankToNull(b.name), blankToNull(b.description), b.is_required === undefined ? null : !!b.is_required, b.is_active === undefined ? null : !!b.is_active, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Requirement not found.');
  res.json({ message: 'Requirement updated.' });
});

// ---------- Student ----------
// GET /api/documents/mine — checklist: every requirement with the student's latest upload for it
const myChecklist = asyncHandler(async (req, res) => {
  const sid = req.user.student_id || 0;
  const [reqs] = await pool.query('SELECT * FROM Requirement WHERE is_active = TRUE ORDER BY is_required DESC, requirement_id');
  const [docs] = await pool.query('SELECT * FROM Document WHERE student_id = ? ORDER BY document_id DESC', [sid]);
  res.json({
    requirements: reqs.map((r) => ({ ...r, document: docs.find((d) => d.requirement_id === r.requirement_id) || null,
      attempts: docs.filter((d) => d.requirement_id === r.requirement_id).length })),
    others: docs.filter((d) => !d.requirement_id),
  });
});

// POST /api/documents   multipart: file, requirement_id? | doc_type?   (student)
const upload = asyncHandler(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a file to upload.');
  let docType = blankToNull(req.body.doc_type); let reqId = req.body.requirement_id ? Number(req.body.requirement_id) : null;
  if (reqId) {
    const [[r]] = await pool.query('SELECT name FROM Requirement WHERE requirement_id = ? AND is_active = TRUE', [reqId]);
    if (!r) throw new HttpError(400, 'Requirement not found.');
    docType = r.name;
  }
  if (!docType) throw new HttpError(400, 'Enter a document name.');
  const [r] = await pool.query('INSERT INTO Document (student_id, requirement_id, doc_type, file_path, original_name) VALUES (?, ?, ?, ?, ?)',
    [req.user.student_id, reqId, docType, uploadUrl(req.file), req.file.originalname]);
  res.status(201).json({ document_id: r.insertId });
});

// ---------- Coordinator ----------
const DOC_SELECT = `
  SELECT d.*, u.full_name AS student_name, u.school_id, sp.program, c.company_name
  FROM Document d JOIN Student_profile sp ON sp.student_id = d.student_id JOIN Users u ON u.user_id = sp.user_id
  LEFT JOIN Company c ON c.company_id = sp.company_id`;

// GET /api/documents?status=&student_id=&requirement_id=&search=
const listDocuments = asyncHandler(async (req, res) => {
  const pg = getPage(req); const q = req.query; const where = []; const params = [];
  if (q.status) { where.push('d.status = ?'); params.push(q.status); }
  if (q.student_id) { where.push('d.student_id = ?'); params.push(q.student_id); }
  if (q.requirement_id) { where.push('d.requirement_id = ?'); params.push(q.requirement_id); }
  if (q.search) { where.push('(u.full_name LIKE ? OR u.school_id LIKE ? OR d.doc_type LIKE ?)'); params.push(...Array(3).fill(`%${q.search}%`)); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Document d JOIN Student_profile sp ON sp.student_id = d.student_id JOIN Users u ON u.user_id = sp.user_id ${W}`, params);
  const [rows] = await pool.query(`${DOC_SELECT} ${W} ORDER BY (d.status = 'pending') DESC, d.document_id DESC LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

// PATCH /api/documents/:id/review   { status: 'approved' | 'rejected', remarks? }
const reviewDocument = asyncHandler(async (req, res) => {
  const { status, remarks } = req.body;
  if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, "status must be 'approved' or 'rejected'.");
  if (status === 'rejected' && !String(remarks || '').trim()) throw new HttpError(400, 'Tell the student why the document was rejected.');
  const [[d]] = await pool.query('SELECT d.document_id, d.doc_type, sp.user_id FROM Document d JOIN Student_profile sp ON sp.student_id = d.student_id WHERE d.document_id = ?', [req.params.id]);
  if (!d) throw new HttpError(404, 'Document not found.');
  await pool.query('UPDATE Document SET status = ?, remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE document_id = ?', [status, blankToNull(remarks), req.user.user_id, d.document_id]);
  await notify(d.user_id, { title: `Document ${status}`, message: status === 'approved' ? `${d.doc_type} was approved.` : `${d.doc_type}: ${String(remarks).slice(0, 150)}`, type: 'document', link: '/requirements' });
  res.json({ message: `Document ${status}.` });
});

// GET /api/documents/student/:studentId   (coordinator, or the student's own supervisor)
const studentDocuments = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`${DOC_SELECT} WHERE d.student_id = ? ORDER BY d.document_id DESC`, [req.params.studentId]);
  res.json(rows);
});

module.exports = { listRequirements, createRequirement, updateRequirement, myChecklist, upload, listDocuments, reviewDocument, studentDocuments };
