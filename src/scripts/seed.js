// Optional demo data: an active term, a few requirements, 2 companies (1 partner, 1 not),
// a supervisor, and 5 students (imported the same way the coordinator UI does it).
require('dotenv').config();
const { pool, withTx } = require('../config/db');
const { createSupervisorAccount } = require('../controllers/usersController');
const { importStudentsProgrammatic } = require('./_seedHelpers');

(async () => {
  console.log('[Seed] Starting...');
  const [[existingTerm]] = await pool.query('SELECT term_id FROM Ojt_term LIMIT 1');
  let termId = existingTerm?.term_id;
  if (!termId) {
    const [t] = await pool.query(
      "INSERT INTO Ojt_term (school_year, semester, default_required_hours, is_active) VALUES ('2026-2027','1st Semester',486,TRUE)");
    termId = t.insertId;
  }
  await pool.query(
    `INSERT IGNORE INTO Requirement (requirement_id, term_id, name, description, is_required) VALUES
     (1, ?, 'Endorsement Letter', 'Signed by the OJT coordinator', TRUE),
     (2, ?, 'Parent/Guardian Consent', 'Required for minors', TRUE),
     (3, ?, 'Medical Certificate', 'Fit-to-work certificate', TRUE),
     (4, ?, 'MOA / Acceptance Letter', 'From the training company', TRUE)`, [termId, termId, termId, termId]);

  const [[partner]] = await pool.query('SELECT company_id FROM Company WHERE company_name = ?', ['TechNova Solutions']);
  const partnerId = partner ? partner.company_id : (await pool.query(
    "INSERT INTO Company (company_name, address, industry, is_partner, moa_status, source) VALUES ('TechNova Solutions','Lingayen, Pangasinan','IT Services',TRUE,'active','school')"))[0].insertId;

  const [[coord]] = await pool.query("SELECT user_id FROM Users WHERE role='coordinator' LIMIT 1");
  let supervisorId;
  const [[existingSup]] = await pool.query('SELECT supervisor_id FROM Supervisor_profile sp JOIN Users u ON u.user_id = sp.user_id WHERE u.email = ?', ['maria.santos@technova.com']);
  if (existingSup) supervisorId = existingSup.supervisor_id;
  else {
    const created = await withTx((conn) => createSupervisorAccount(conn,
      { full_name: 'Maria Santos', email: 'maria.santos@technova.com', company_id: partnerId, position: 'IT Manager', department: 'Software Development' }, coord?.user_id));
    supervisorId = created.supervisor_id;
    console.log(`[Seed] Supervisor: ${created.email} / ${created.temp_password}`);
  }

  const rows = [
    { school_id: '21-00123', full_name: 'Juan Dela Cruz', email: 'juan.delacruz@psu.edu.ph', program: 'BSIT', year_level: '4th Year', section: 'BSIT-4A' },
    { school_id: '21-00124', full_name: 'Maria Clara Reyes', email: 'mariaclara.reyes@psu.edu.ph', program: 'BSIT', year_level: '4th Year', section: 'BSIT-4A' },
    { school_id: '21-00125', full_name: 'Jose Rizal Santos', email: 'joserizal.santos@psu.edu.ph', program: 'BSCS', year_level: '4th Year', section: 'BSCS-4A' },
    { school_id: '21-00126', full_name: 'Ana Sofia Garcia', email: 'anasofia.garcia@psu.edu.ph', program: 'BSIT', year_level: '4th Year', section: 'BSIT-4B' },
    { school_id: '21-00127', full_name: 'Mark Anthony Cruz', email: 'markanthony.cruz@psu.edu.ph', program: 'BSCS', year_level: '4th Year', section: 'BSCS-4B' },
  ];
  const { created, skipped } = await importStudentsProgrammatic(rows, { term_id: termId, created_by: coord?.user_id });
  created.slice(0, 1).forEach((c) => console.log(`[Seed] Sample student login: ${c.email} / ${c.temp_password} (password = student ID by default)`));
  console.log(`[Seed] Students: ${created.length} created, ${skipped.length} already existed.`);
  console.log('[Seed] Done.');
  process.exit(0);
})().catch((e) => { console.error('[Seed] Failed:', e.message); process.exit(1); });
