// Feature 12 — supervisors assign tasks, interns submit work, supervisors review (with revisions).
const { pool, withTx } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull, requireFields, uploadUrl } = require('../utils/http');
const { notify } = require('../utils/notify');

const TASK_SELECT = `
  SELECT t.*, u.full_name AS student_name, u.school_id, sp.user_id AS student_user, sup_u.full_name AS supervisor_name,
         (t.due_date IS NOT NULL AND t.due_date < CURDATE() AND t.status IN ('assigned','revision')) AS is_overdue,
         (SELECT COUNT(*) FROM Task_submission s WHERE s.task_id = t.task_id) AS submissions
  FROM Task_assignment t
  JOIN Student_profile sp ON sp.student_id = t.student_id
  JOIN Users u ON u.user_id = sp.user_id
  JOIN Supervisor_profile sup ON sup.supervisor_id = t.assigned_by
  JOIN Users sup_u ON sup_u.user_id = sup.user_id`;

// POST /api/tasks   { student_ids: [...], title, description?, priority?, due_date? }   (supervisor)
const createTasks = asyncHandler(async (req, res) => {
  requireFields(req.body, ['title']);
  const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids : (req.body.student_id ? [req.body.student_id] : []);
  if (!ids.length) throw new HttpError(400, 'Choose at least one intern.');
  const b = req.body; let created = 0;
  await withTx(async (conn) => {
    for (const sid of ids) {
      const [[s]] = await conn.query('SELECT user_id, supervisor_id FROM Student_profile WHERE student_id = ?', [sid]);
      if (!s || s.supervisor_id !== req.user.supervisor_id) throw new HttpError(403, 'You can only assign tasks to your own interns.');
      await conn.query(
        'INSERT INTO Task_assignment (student_id, assigned_by, title, description, priority, due_date) VALUES (?, ?, ?, ?, ?, ?)',
        [sid, req.user.supervisor_id, b.title.trim(), blankToNull(b.description), ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal', blankToNull(b.due_date)]);
      await notify(s.user_id, { title: 'New task assigned', message: b.title.trim(), type: 'task', link: '/tasks' }, conn);
      created++;
    }
  });
  res.status(201).json({ created });
});

// GET /api/tasks?status=&student_id=&overdue=1&search=
const listTasks = asyncHandler(async (req, res) => {
  const pg = getPage(req); const q = req.query; const where = []; const params = [];
  if (req.user.role === 'student') { where.push('t.student_id = ?'); params.push(req.user.student_id || 0); }
  if (req.user.role === 'supervisor') { where.push('t.assigned_by = ?'); params.push(req.user.supervisor_id || 0); }
  if (q.status) { where.push('t.status = ?'); params.push(q.status); }
  if (q.student_id && req.user.role !== 'student') { where.push('t.student_id = ?'); params.push(q.student_id); }
  if (q.overdue === '1') where.push("t.due_date < CURDATE() AND t.status IN ('assigned','revision')");
  if (q.search) { where.push('(t.title LIKE ? OR u.full_name LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Task_assignment t JOIN Student_profile sp ON sp.student_id = t.student_id JOIN Users u ON u.user_id = sp.user_id ${W}`, params);
  const [rows] = await pool.query(
    `${TASK_SELECT} ${W} ORDER BY (t.status = 'submitted') DESC, (t.due_date IS NULL), t.due_date ASC, t.task_id DESC LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

async function loadTask(req) {
  const [[t]] = await pool.query(`${TASK_SELECT} WHERE t.task_id = ?`, [req.params.id]);
  if (!t) throw new HttpError(404, 'Task not found.');
  if (req.user.role === 'student' && t.student_id !== req.user.student_id) throw new HttpError(403, 'Not your task.');
  if (req.user.role === 'supervisor' && t.assigned_by !== req.user.supervisor_id) throw new HttpError(403, 'Not your task.');
  return t;
}

// GET /api/tasks/:id   task + all submissions
const getTask = asyncHandler(async (req, res) => {
  const t = await loadTask(req);
  const [subs] = await pool.query('SELECT * FROM Task_submission WHERE task_id = ? ORDER BY submission_id DESC', [t.task_id]);
  res.json({ ...t, submission_list: subs });
});

// POST /api/tasks/:id/submit   multipart: file (optional), notes   (student)
const submitTask = asyncHandler(async (req, res) => {
  const t = await loadTask(req);
  if (!['assigned', 'revision'].includes(t.status)) throw new HttpError(409, 'This task cannot be submitted right now.');
  if (!req.file && !String(req.body.notes || '').trim()) throw new HttpError(400, 'Attach a file or write a note about your work.');
  await withTx(async (conn) => {
    await conn.query('INSERT INTO Task_submission (task_id, file_attachment, original_name, notes) VALUES (?, ?, ?, ?)',
      [t.task_id, uploadUrl(req.file), req.file ? req.file.originalname : null, blankToNull(req.body.notes)]);
    await conn.query("UPDATE Task_assignment SET status = 'submitted' WHERE task_id = ?", [t.task_id]);
    const [[sup]] = await conn.query('SELECT user_id FROM Supervisor_profile WHERE supervisor_id = ?', [t.assigned_by]);
    await notify(sup.user_id, { title: 'Task submitted', message: `${t.student_name} submitted "${t.title}".`, type: 'task', link: '/tasks' }, conn);
  });
  res.status(201).json({ message: 'Submitted.' });
});

// PATCH /api/tasks/submissions/:id/review   { review_status: 'approved' | 'rejected', feedback? }   (supervisor)
const reviewSubmission = asyncHandler(async (req, res) => {
  const { review_status, feedback } = req.body;
  if (!['approved', 'rejected'].includes(review_status)) throw new HttpError(400, "review_status must be 'approved' or 'rejected'.");
  if (review_status === 'rejected' && !String(feedback || '').trim()) throw new HttpError(400, 'Tell the intern what needs to be fixed.');
  await withTx(async (conn) => {
    const [[s]] = await conn.query(
      `SELECT s.*, t.assigned_by, t.title, t.student_id, sp.user_id AS student_user FROM Task_submission s
       JOIN Task_assignment t ON t.task_id = s.task_id JOIN Student_profile sp ON sp.student_id = t.student_id WHERE s.submission_id = ? FOR UPDATE`, [req.params.id]);
    if (!s) throw new HttpError(404, 'Submission not found.');
    if (s.assigned_by !== req.user.supervisor_id) throw new HttpError(403, 'Not your task.');
    if (s.review_status !== 'pending') throw new HttpError(409, 'Already reviewed.');
    await conn.query('UPDATE Task_submission SET review_status = ?, feedback = ?, reviewed_by = ?, reviewed_at = NOW() WHERE submission_id = ?',
      [review_status, blankToNull(feedback), req.user.supervisor_id, s.submission_id]);
    await conn.query('UPDATE Task_assignment SET status = ? WHERE task_id = ?', [review_status === 'approved' ? 'completed' : 'revision', s.task_id]);
    await notify(s.student_user, {
      title: review_status === 'approved' ? 'Task approved' : 'Task needs revision',
      message: review_status === 'approved' ? `"${s.title}" was approved.` : `"${s.title}": ${String(feedback).slice(0, 150)}`, type: 'task', link: '/tasks' }, conn);
  });
  res.json({ message: `Submission ${review_status}.` });
});

// DELETE /api/tasks/:id   (supervisor, only if nothing was submitted yet)
const deleteTask = asyncHandler(async (req, res) => {
  const t = await loadTask(req);
  if (t.submissions > 0) throw new HttpError(409, 'This task already has submissions and cannot be deleted.');
  await pool.query('DELETE FROM Task_assignment WHERE task_id = ?', [t.task_id]);
  res.json({ message: 'Task deleted.' });
});

module.exports = { createTasks, listTasks, getTask, submitTask, reviewSubmission, deleteTask };
