// Features 2, 4, 6 — dashboards and analytics for each role.
const { pool } = require('../config/db');
const { asyncHandler, HttpError } = require('../utils/http');

const n = (v) => Number(v) || 0;

// GET /api/dashboard/coordinator
const coordinator = asyncHandler(async (req, res) => {
  const [[st]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(ojt_status='ongoing') AS ongoing, SUM(ojt_status='looking') AS looking, SUM(ojt_status='not_started') AS not_started,
            SUM(ojt_status='pending_approval') AS pending_approval, SUM(ojt_status='completed') AS completed, SUM(ojt_status='dropped') AS dropped FROM Student_profile`);
  const [[pending]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM Placement WHERE status='pending') AS placements,
            (SELECT COUNT(*) FROM Document WHERE status='pending') AS documents,
            (SELECT COUNT(*) FROM Complaint WHERE status IN ('open','under_review')) AS complaints,
            (SELECT COUNT(*) FROM Daily_report WHERE verify_status='flagged') AS flagged_logs,
            (SELECT COUNT(*) FROM Daily_report WHERE verify_status='pending' AND report_date < CURDATE()) AS stale_pending_logs`);
  const [[cos]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(is_partner) AS partners FROM Company WHERE status = 'active'`);
  const [attendance] = await pool.query(
    `SELECT report_date AS date, SUM(verify_status='verified') AS verified, SUM(verify_status='pending') AS pending, SUM(verify_status='flagged') AS flagged
     FROM Daily_report WHERE report_date >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) GROUP BY report_date ORDER BY report_date`);
  const [byProgram] = await pool.query(
    `SELECT COALESCE(program,'Unspecified') AS program, COUNT(*) AS students,
            ROUND(AVG(completed_hours / NULLIF(required_hours,0) * 100), 1) AS avg_progress FROM Student_profile GROUP BY program ORDER BY students DESC LIMIT 8`);
  const [[hours]] = await pool.query('SELECT COALESCE(SUM(completed_hours),0) AS completed, COALESCE(SUM(required_hours),0) AS required FROM Student_profile WHERE ojt_status IN (\'ongoing\',\'completed\')');
  const [activity] = await pool.query(
    `SELECT a.log_id, a.action, a.entity, a.details, a.created_at, u.full_name FROM Audit_log a LEFT JOIN Users u ON u.user_id = a.user_id ORDER BY a.log_id DESC LIMIT 8`);
  const [term] = await pool.query('SELECT * FROM Ojt_term WHERE is_active = TRUE LIMIT 1');
  res.json({
    students: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, n(v)])),
    pending: Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, n(v)])),
    companies: { total: n(cos.total), partners: n(cos.partners) },
    attendance, byProgram, hours: { completed: n(hours.completed), required: n(hours.required) }, activity, term: term[0] || null,
  });
});

// GET /api/dashboard/reports   (charts for the Reports page)
const reports = asyncHandler(async (req, res) => {
  const q = (sql) => pool.query(sql).then(([r]) => r);
  res.json({
    attendanceByStatus: await q('SELECT verify_status AS label, COUNT(*) AS value FROM Daily_report GROUP BY verify_status'),
    complaintsByCategory: await q('SELECT category AS label, COUNT(*) AS value FROM Complaint GROUP BY category'),
    complaintsByStatus: await q('SELECT status AS label, COUNT(*) AS value FROM Complaint GROUP BY status'),
    placementsBySource: await q("SELECT source AS label, COUNT(*) AS value FROM Placement WHERE status='approved' GROUP BY source"),
    internsByPartnership: await q(
      `SELECT IF(c.is_partner, 'Partner company', 'Non-partner company') AS label, COUNT(*) AS value
       FROM Student_profile sp JOIN Company c ON c.company_id = sp.company_id WHERE sp.ojt_status IN ('ongoing','completed') GROUP BY c.is_partner`),
    tasksByStatus: await q('SELECT status AS label, COUNT(*) AS value FROM Task_assignment GROUP BY status'),
    studentsByStatus: await q('SELECT ojt_status AS label, COUNT(*) AS value FROM Student_profile GROUP BY ojt_status'),
    avgRatingByCompany: await q(
      `SELECT c.company_name AS label, ROUND(AVG(e.rating), 2) AS value, COUNT(*) AS responses FROM Evaluation e
       JOIN Company c ON c.company_id = e.company_id WHERE e.type = 'student_to_company' GROUP BY c.company_id ORDER BY value DESC LIMIT 10`),
    avgRatingByProgram: await q(
      `SELECT COALESCE(sp.program,'Unspecified') AS label, ROUND(AVG(e.rating), 2) AS value, COUNT(*) AS responses FROM Evaluation e
       JOIN Student_profile sp ON sp.student_id = e.student_id WHERE e.type = 'supervisor_to_student' GROUP BY sp.program ORDER BY value DESC`),
    progressByProgram: await q(
      `SELECT COALESCE(program,'Unspecified') AS label, ROUND(AVG(completed_hours / NULLIF(required_hours,0) * 100), 1) AS value, COUNT(*) AS responses
       FROM Student_profile GROUP BY program ORDER BY value DESC`),
  });
});

// GET /api/dashboard/supervisor
const supervisor = asyncHandler(async (req, res) => {
  const sid = req.user.supervisor_id;
  if (!sid) throw new HttpError(404, 'No supervisor profile is linked to this account.');
  const [[company]] = await pool.query(
    `SELECT c.* FROM Supervisor_profile sup LEFT JOIN Company c ON c.company_id = sup.company_id WHERE sup.supervisor_id = ?`, [sid]);
  const [interns] = await pool.query(
    `SELECT sp.student_id, u.full_name, u.school_id, sp.program, sp.completed_hours, sp.required_hours,
            ROUND(sp.completed_hours / NULLIF(sp.required_hours,0) * 100, 1) AS progress_percent,
            (SELECT CASE WHEN d.time_out IS NOT NULL THEN 'out' ELSE 'in' END FROM Daily_report d WHERE d.student_id = sp.student_id AND d.report_date = CURDATE()) AS today_status,
            (SELECT COUNT(*) FROM Daily_report d WHERE d.student_id = sp.student_id AND d.verify_status = 'pending') AS pending_logs
     FROM Student_profile sp JOIN Users u ON u.user_id = sp.user_id WHERE sp.supervisor_id = ? AND sp.ojt_status = 'ongoing' ORDER BY u.full_name`, [sid]);
  const [[c]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM Daily_report d JOIN Student_profile sp ON sp.student_id = d.student_id WHERE sp.supervisor_id = ? AND d.verify_status = 'pending' AND d.time_out IS NOT NULL) AS pending_logs,
            (SELECT COUNT(*) FROM Task_assignment WHERE assigned_by = ? AND status = 'submitted') AS tasks_to_review,
            (SELECT COUNT(*) FROM Task_assignment WHERE assigned_by = ? AND status IN ('assigned','revision') AND due_date < CURDATE()) AS overdue_tasks,
            (SELECT COUNT(*) FROM Task_assignment WHERE assigned_by = ? AND status IN ('assigned','revision')) AS open_tasks`, [sid, sid, sid, sid]);
  res.json({
    company: company && company.company_id ? company : null, interns,
    stats: { interns: interns.length, timed_in_today: interns.filter((i) => i.today_status).length, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, n(v)])) },
  });
});

// GET /api/dashboard/student
const student = asyncHandler(async (req, res) => {
  const sid = req.user.student_id;
  if (!sid) throw new HttpError(404, 'No student profile is linked to this account. Please contact your coordinator.');
  const [[p]] = await pool.query(
    `SELECT sp.*, c.company_name, c.is_partner, sup_u.full_name AS supervisor_name, t.school_year, t.semester,
            ROUND(sp.completed_hours / NULLIF(sp.required_hours,0) * 100, 1) AS progress_percent
     FROM Student_profile sp LEFT JOIN Company c ON c.company_id = sp.company_id
     LEFT JOIN Supervisor_profile sup ON sup.supervisor_id = sp.supervisor_id LEFT JOIN Users sup_u ON sup_u.user_id = sup.user_id
     LEFT JOIN Ojt_term t ON t.term_id = sp.term_id WHERE sp.student_id = ?`, [sid]);
  const [[tasks]] = await pool.query(
    `SELECT SUM(status='assigned') AS assigned, SUM(status='revision') AS revision, SUM(status='submitted') AS submitted, SUM(status='completed') AS completed,
            SUM(due_date < CURDATE() AND status IN ('assigned','revision')) AS overdue FROM Task_assignment WHERE student_id = ?`, [sid]);
  const [[reqs]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM Requirement WHERE is_active AND is_required) AS total,
            (SELECT COUNT(DISTINCT d.requirement_id) FROM Document d JOIN Requirement r ON r.requirement_id = d.requirement_id
               WHERE d.student_id = ? AND d.status = 'approved' AND r.is_active AND r.is_required) AS approved,
            (SELECT COUNT(DISTINCT d.requirement_id) FROM Document d JOIN Requirement r ON r.requirement_id = d.requirement_id
               WHERE d.student_id = ? AND d.status = 'pending' AND r.is_active AND r.is_required) AS pending`, [sid, sid]);
  const [nextTasks] = await pool.query(
    `SELECT task_id, title, due_date, status, priority, (due_date < CURDATE()) AS is_overdue FROM Task_assignment
     WHERE student_id = ? AND status IN ('assigned','revision') ORDER BY (due_date IS NULL), due_date LIMIT 5`, [sid]);
  const [[week]] = await pool.query(
    `SELECT COALESCE(SUM(hours_rendered),0) AS hours FROM Daily_report WHERE student_id = ? AND report_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`, [sid]);
  const [[today]] = await pool.query('SELECT * FROM Daily_report WHERE student_id = ? AND report_date = CURDATE()', [sid]);
  res.json({
    profile: p, today: today || null, week_hours: n(week.hours), next_tasks: nextTasks,
    tasks: Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, n(v)])),
    requirements: { total: n(reqs.total), approved: n(reqs.approved), pending: n(reqs.pending) },
  });
});

module.exports = { coordinator, reports, supervisor, student };
