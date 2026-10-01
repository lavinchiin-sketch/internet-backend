// OJT terms (school year + semester). One term is "active" at a time; new students join the active term.
const { pool, withTx } = require('../config/db');
const { HttpError, asyncHandler, blankToNull, requireFields } = require('../utils/http');

const listTerms = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, (SELECT COUNT(*) FROM Student_profile s WHERE s.term_id = t.term_id) AS students
     FROM Ojt_term t ORDER BY t.school_year DESC, t.term_id DESC`);
  res.json(rows);
});

const createTerm = asyncHandler(async (req, res) => {
  requireFields(req.body, ['school_year', 'semester']);
  const b = req.body;
  const id = await withTx(async (conn) => {
    if (b.is_active) await conn.query('UPDATE Ojt_term SET is_active = FALSE');
    const [r] = await conn.query(
      'INSERT INTO Ojt_term (school_year, semester, start_date, end_date, default_required_hours, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [b.school_year.trim(), b.semester.trim(), blankToNull(b.start_date), blankToNull(b.end_date), Number(b.default_required_hours) || 486, !!b.is_active]);
    return r.insertId;
  });
  res.status(201).json({ term_id: id });
});

const updateTerm = asyncHandler(async (req, res) => {
  const b = req.body;
  const [r] = await pool.query(
    `UPDATE Ojt_term SET school_year = COALESCE(?, school_year), semester = COALESCE(?, semester), start_date = ?, end_date = ?,
       default_required_hours = COALESCE(?, default_required_hours) WHERE term_id = ?`,
    [blankToNull(b.school_year), blankToNull(b.semester), blankToNull(b.start_date), blankToNull(b.end_date), Number(b.default_required_hours) || null, req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Term not found.');
  res.json({ message: 'Term updated.' });
});

const activateTerm = asyncHandler(async (req, res) => {
  await withTx(async (conn) => {
    await conn.query('UPDATE Ojt_term SET is_active = FALSE');
    const [r] = await conn.query('UPDATE Ojt_term SET is_active = TRUE WHERE term_id = ?', [req.params.id]);
    if (!r.affectedRows) throw new HttpError(404, 'Term not found.');
  });
  res.json({ message: 'Term is now active.' });
});

module.exports = { listTerms, createTerm, updateTerm, activateTerm };
