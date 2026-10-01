// Feature 10 — two-way assessment with a criteria rubric.
const { pool } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull } = require('../utils/http');
const { notifyCoordinators, notify } = require('../utils/notify');

const CRITERIA = {
  student: [ // used by supervisors and coordinators
    { key: 'punctuality', label: 'Punctuality & attendance' }, { key: 'quality_of_work', label: 'Quality of work' },
    { key: 'productivity', label: 'Productivity' }, { key: 'initiative', label: 'Initiative & resourcefulness' },
    { key: 'teamwork', label: 'Teamwork' }, { key: 'communication', label: 'Communication' },
    { key: 'professionalism', label: 'Professionalism & attitude' },
  ],
  company: [ // used by students rating their training company
    { key: 'learning', label: 'Learning opportunities' }, { key: 'supervision', label: 'Supervision & guidance' },
    { key: 'environment', label: 'Work environment' }, { key: 'relevance', label: 'Relevance to my course' },
    { key: 'welfare', label: 'Safety & welfare' },
  ],
};
const getCriteria = asyncHandler(async (req, res) => res.json(CRITERIA));

function score(scores, list) {
  const out = {}; let sum = 0;
  for (const c of list) {
    const v = Number(scores && scores[c.key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, `Rate "${c.label}" from 1 to 5.`);
    out[c.key] = v; sum += v;
  }
  return { out, avg: Math.round((sum / list.length) * 100) / 100 };
}

// POST /api/evaluations   { student_id?, period, criteria_scores: {key: 1-5}, comments }
const create = asyncHandler(async (req, res) => {
  const b = req.body; const period = ['midterm', 'final', 'other'].includes(b.period) ? b.period : 'other';
  let type; let studentId; let companyId = null;
  if (req.user.role === 'student') {
    type = 'student_to_company'; studentId = req.user.student_id;
    const [[s]] = await pool.query('SELECT company_id FROM Student_profile WHERE student_id = ?', [studentId]);
    if (!s || !s.company_id) throw new HttpError(400, 'You need a company placement before you can rate your training.');
    companyId = s.company_id;
  } else {
    type = req.user.role === 'supervisor' ? 'supervisor_to_student' : 'coordinator_to_student';
    studentId = Number(b.student_id);
    const [[s]] = await pool.query('SELECT student_id, supervisor_id, company_id, user_id FROM Student_profile WHERE student_id = ?', [studentId]);
    if (!s) throw new HttpError(404, 'Student not found.');
    if (req.user.role === 'supervisor' && s.supervisor_id !== req.user.supervisor_id) throw new HttpError(403, 'This student is not your intern.');
    companyId = s.company_id;
  }
  const { out, avg } = score(b.criteria_scores, type === 'student_to_company' ? CRITERIA.company : CRITERIA.student);
  const [r] = await pool.query(
    'INSERT INTO Evaluation (type, period, student_id, company_id, evaluator_id, rating, criteria_scores, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [type, period, studentId, companyId, req.user.user_id, avg, JSON.stringify(out), blankToNull(b.comments)]);
  if (type !== 'student_to_company') {
    const [[s]] = await pool.query('SELECT user_id FROM Student_profile WHERE student_id = ?', [studentId]);
    await notify(s.user_id, { title: 'You received an evaluation', message: `Overall rating: ${avg} / 5`, type: 'evaluation', link: '/feedback' });
  }
  if (type === 'supervisor_to_student') await notifyCoordinators({ title: 'Supervisor evaluation submitted', message: `Overall ${avg} / 5`, type: 'evaluation', link: '/evaluations' });
  res.status(201).json({ evaluation_id: r.insertId, rating: avg });
});

// GET /api/evaluations?type=&student_id=&company_id=
const list = asyncHandler(async (req, res) => {
  const pg = getPage(req); const q = req.query; const where = []; const params = [];
  if (req.user.role === 'student') { where.push('e.student_id = ?'); params.push(req.user.student_id || 0); }
  if (req.user.role === 'supervisor') { where.push("e.evaluator_id = ? AND e.type = 'supervisor_to_student'"); params.push(req.user.user_id); }
  if (q.type) { where.push('e.type = ?'); params.push(q.type); }
  if (q.student_id && req.user.role !== 'student') { where.push('e.student_id = ?'); params.push(q.student_id); }
  if (q.company_id) { where.push('e.company_id = ?'); params.push(q.company_id); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const FROM = `FROM Evaluation e JOIN Student_profile sp ON sp.student_id = e.student_id JOIN Users su ON su.user_id = sp.user_id
                JOIN Users ev ON ev.user_id = e.evaluator_id LEFT JOIN Company c ON c.company_id = e.company_id`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM} ${W}`, params);
  const [rows] = await pool.query(
    `SELECT e.*, su.full_name AS student_name, su.school_id, ev.full_name AS evaluator_name, c.company_name ${FROM} ${W} ORDER BY e.evaluation_id DESC LIMIT ? OFFSET ?`,
    [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows.map((r) => ({ ...r, criteria_scores: typeof r.criteria_scores === 'string' ? JSON.parse(r.criteria_scores) : r.criteria_scores })), total, pg));
});

module.exports = { getCriteria, create, list };
