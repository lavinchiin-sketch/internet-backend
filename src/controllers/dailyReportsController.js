// Feature 3 — attendance with photo proof.
//   Student:    time-in (photo) -> time-out (photo optional) — server time is used, so it cannot be faked.
//   Supervisor: verify or flag. Verified hours are added to the student's completed hours automatically.
const { pool, withTx } = require('../config/db');
const { HttpError, asyncHandler, getPage, pageResult, blankToNull, uploadUrl } = require('../utils/http');
const { notify, notifyCoordinators } = require('../utils/notify');

const REPORT_SELECT = `
  SELECT d.*, u.full_name AS student_name, u.school_id, sp.program, sp.company_id, c.company_name, sp.supervisor_id AS student_supervisor_id
  FROM Daily_report d
  JOIN Student_profile sp ON sp.student_id = d.student_id
  JOIN Users u ON u.user_id = sp.user_id
  LEFT JOIN Company c ON c.company_id = sp.company_id`;

const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const LUNCH = () => (process.env.LUNCH_BREAK_HOURS === undefined ? 1 : Number(process.env.LUNCH_BREAK_HOURS) || 0);

// Prefer a shift still in progress (even if it started yesterday, e.g. a night shift);
// otherwise fall back to today's completed log, if any.
async function todayRow(studentId) {
  const [[open]] = await pool.query(`${REPORT_SELECT} WHERE d.student_id = ? AND d.time_out IS NULL ORDER BY d.report_id DESC LIMIT 1`, [studentId]);
  if (open) return open;
  const [[today]] = await pool.query(`${REPORT_SELECT} WHERE d.student_id = ? AND d.report_date = CURDATE() ORDER BY d.report_id DESC LIMIT 1`, [studentId]);
  return today || null;
}

// GET /api/daily-reports/today   (student)
const getToday = asyncHandler(async (req, res) => {
  const [[now]] = await pool.query('SELECT CURDATE() AS date, CURTIME() AS time');
  res.json({ now, report: await todayRow(req.user.student_id) });
});

// POST /api/daily-reports/time-in   multipart: photo (required), lat, lng
const timeIn = asyncHandler(async (req, res) => {
  const sid = req.user.student_id;
  const [[s]] = await pool.query('SELECT ojt_status, supervisor_id FROM Student_profile WHERE student_id = ?', [sid]);
  if (!s || s.ojt_status !== 'ongoing' || !s.supervisor_id) throw new HttpError(403, 'You need an approved OJT placement before you can log attendance.');
  if (!req.file) throw new HttpError(400, 'A photo is required to time in.');
  const [exist] = await pool.query("SELECT report_id FROM Daily_report WHERE student_id = ? AND time_out IS NULL", [sid]);
  if (exist.length) throw new HttpError(409, 'You already timed in and have not timed out yet.');
  const [dup] = await pool.query('SELECT report_id FROM Daily_report WHERE student_id = ? AND report_date = CURDATE()', [sid]);
  if (dup.length) throw new HttpError(409, 'You already logged attendance today.');
  await pool.query(
    `INSERT INTO Daily_report (student_id, report_date, time_in, photo_in, lat_in, lng_in) VALUES (?, CURDATE(), NOW(), ?, ?, ?)`,
    [sid, uploadUrl(req.file), num(req.body.lat), num(req.body.lng)]);
  res.status(201).json(await todayRow(sid));
});

// POST /api/daily-reports/time-out   multipart: photo (optional), tasks_completed, lat, lng
const timeOut = asyncHandler(async (req, res) => {
  const sid = req.user.student_id;
  const [[r]] = await pool.query(
    `SELECT report_id, TIMESTAMPDIFF(MINUTE, time_in, NOW()) AS mins FROM Daily_report
     WHERE student_id = ? AND time_out IS NULL ORDER BY report_id DESC LIMIT 1`, [sid]);
  if (!r) throw new HttpError(404, "You haven't timed in, or you already timed out.");
  let hours = Math.max(r.mins, 0) / 60;
  if (hours > 5) hours -= LUNCH();
  hours = Math.round(Math.min(Math.max(hours, 0), 16) * 100) / 100; // 16h cap guards against a forgotten time-out
  await pool.query(
    `UPDATE Daily_report SET time_out = NOW(), tasks_completed = ?, photo_out = ?, lat_out = ?, lng_out = ?, hours_rendered = ? WHERE report_id = ?`,
    [blankToNull(req.body.tasks_completed), uploadUrl(req.file), num(req.body.lat), num(req.body.lng), hours, r.report_id]);
  res.json(await todayRow(sid));
});

// GET /api/daily-reports/mine?from=&to=&status=&page=   (student)
const myReports = asyncHandler(async (req, res) => {
  const pg = getPage(req, 31); const q = req.query;
  const where = ['d.student_id = ?']; const params = [req.user.student_id || 0];
  if (q.from) { where.push('d.report_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('d.report_date <= ?'); params.push(q.to); }
  if (q.status) { where.push('d.verify_status = ?'); params.push(q.status); }
  const W = where.join(' AND ');
  const [[sum]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN verify_status='verified' THEN hours_rendered END),0) AS verified_hours,
            COALESCE(SUM(CASE WHEN verify_status='pending' THEN hours_rendered END),0) AS pending_hours,
            SUM(verify_status='flagged') AS flagged FROM Daily_report d WHERE ${W}`, params);
  const [rows] = await pool.query(`${REPORT_SELECT} WHERE ${W} ORDER BY d.report_date DESC LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json({ ...pageResult(rows, sum.total, pg), summary: sum });
});

// GET /api/daily-reports   (supervisor: own interns; coordinator: everyone)
const listReports = asyncHandler(async (req, res) => {
  const pg = getPage(req); const q = req.query; const where = []; const params = [];
  if (req.user.role === 'supervisor') { where.push('sp.supervisor_id = ?'); params.push(req.user.supervisor_id || 0); }
  if (q.student_id) { where.push('d.student_id = ?'); params.push(q.student_id); }
  if (q.company_id) { where.push('sp.company_id = ?'); params.push(q.company_id); }
  if (q.program) { where.push('sp.program = ?'); params.push(q.program); }
  if (q.status) { where.push('d.verify_status = ?'); params.push(q.status); }
  if (q.from) { where.push('d.report_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('d.report_date <= ?'); params.push(q.to); }
  if (q.search) { where.push('(u.full_name LIKE ? OR u.school_id LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Daily_report d JOIN Student_profile sp ON sp.student_id = d.student_id JOIN Users u ON u.user_id = sp.user_id ${W}`, params);
  const [rows] = await pool.query(`${REPORT_SELECT} ${W} ORDER BY d.report_date DESC, d.report_id DESC LIMIT ? OFFSET ?`, [...params, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});

// Review one log inside a transaction. Adds/removes the log's hours exactly once.
async function reviewOne(conn, user, id, status, remarks) {
  const [[r]] = await conn.query(
    `SELECT d.*, sp.supervisor_id AS student_supervisor, sp.user_id AS student_user, sp.required_hours, sp.completed_hours
     FROM Daily_report d JOIN Student_profile sp ON sp.student_id = d.student_id WHERE d.report_id = ? FOR UPDATE`, [id]);
  if (!r) throw new HttpError(404, 'Log not found.');
  if (user.role === 'supervisor' && r.student_supervisor !== user.supervisor_id) throw new HttpError(403, 'This log belongs to another supervisor’s intern.');
  if (status === 'verified' && !r.time_out) throw new HttpError(400, 'This student has not timed out yet, so the log cannot be verified.');
  if (status === 'flagged' && !String(remarks || '').trim()) throw new HttpError(400, 'Add a remark explaining why you flagged this log.');

  let delta = 0; let credited = r.hours_credited;
  if (status === 'verified' && !r.hours_credited) { delta = r.hours_rendered; credited = 1; }
  if (status === 'flagged' && r.hours_credited) { delta = -r.hours_rendered; credited = 0; }

  await conn.query(
    'UPDATE Daily_report SET verify_status = ?, verified_by = ?, verified_at = NOW(), supervisor_remarks = ?, hours_credited = ? WHERE report_id = ?',
    [status, user.supervisor_id || null, blankToNull(remarks), credited, id]);
  if (delta !== 0) await conn.query('UPDATE Student_profile SET completed_hours = GREATEST(completed_hours + ?, 0) WHERE student_id = ?', [delta, r.student_id]);

  if (status === 'flagged') await notify(r.student_user, { title: 'Attendance log flagged', message: `Your log for ${r.report_date} was flagged: ${String(remarks).slice(0, 150)}`, type: 'attendance', link: '/attendance' }, conn);
  const before = Number(r.completed_hours); const after = before + delta;
  return { reachedTarget: delta > 0 && before < r.required_hours && after >= r.required_hours, student_user: r.student_user, student_id: r.student_id };
}

// PATCH /api/daily-reports/:id/review   { status: 'verified' | 'flagged', remarks? }
const review = asyncHandler(async (req, res) => {
  const { status, remarks } = req.body;
  if (!['verified', 'flagged'].includes(status)) throw new HttpError(400, "status must be 'verified' or 'flagged'.");
  const out = await withTx((conn) => reviewOne(conn, req.user, Number(req.params.id), status, remarks));
  if (out.reachedTarget) {
    await notify(out.student_user, { title: 'Required hours completed', message: 'You reached your required OJT hours. Congratulations!', type: 'attendance', link: '/dashboard' });
    await notifyCoordinators({ title: 'Student completed required hours', message: 'A student reached the required OJT hours.', type: 'attendance', link: `/students/${out.student_id}` });
  }
  res.json({ message: `Log marked as ${status}.` });
});

// POST /api/daily-reports/review-bulk   { ids: [...], status: 'verified' }
const reviewBulk = asyncHandler(async (req, res) => {
  const { ids, status, remarks } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Select at least one log.');
  if (!['verified', 'flagged'].includes(status)) throw new HttpError(400, "status must be 'verified' or 'flagged'.");
  let ok = 0; const failed = [];
  for (const id of ids) {
    try { await withTx((conn) => reviewOne(conn, req.user, Number(id), status, remarks)); ok++; }
    catch (e) { if (!e.status) throw e; failed.push({ id, reason: e.message }); }
  }
  res.json({ updated: ok, failed });
});

module.exports = { getToday, timeIn, timeOut, myReports, listReports, review, reviewBulk };
