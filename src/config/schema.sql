-- =====================================================================
-- INTERNet: OJT Monitoring & Analytics System — MySQL 8 schema (v2)
-- Safe to run more than once (every statement is idempotent).
-- Select your database first (e.g. `USE internet_ojt;` or the `railway`
-- database on Railway). `npm run db:init` does this for you.
-- Tables are listed in dependency order.
-- =====================================================================

-- 1. OJT_TERM — school year / semester the students are enrolled in
CREATE TABLE IF NOT EXISTS Ojt_term (
  term_id                INT AUTO_INCREMENT PRIMARY KEY,
  school_year            VARCHAR(20)  NOT NULL,               -- e.g. 2026-2027
  semester               VARCHAR(30)  NOT NULL,               -- 1st Semester / 2nd Semester / Summer
  start_date             DATE,
  end_date               DATE,
  default_required_hours INT          NOT NULL DEFAULT 486,
  is_active              BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_term (school_year, semester)
) ENGINE=InnoDB;

-- 2. USERS — one account per person, for every role
CREATE TABLE IF NOT EXISTS Users (
  user_id              INT AUTO_INCREMENT PRIMARY KEY,
  school_id            VARCHAR(30)  NULL UNIQUE,              -- student number / employee number
  full_name            VARCHAR(150) NOT NULL,
  email                VARCHAR(150) NOT NULL UNIQUE,          -- always stored lowercase
  phone_number         VARCHAR(30),
  password             VARCHAR(255) NOT NULL,                 -- bcrypt hash
  role                 ENUM('student','supervisor','coordinator') NOT NULL,
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN      NOT NULL DEFAULT FALSE,
  last_login_at        DATETIME,
  created_by           INT          NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- 3. COMPANY — any company a student trains at (partner or not)
CREATE TABLE IF NOT EXISTS Company (
  company_id      INT AUTO_INCREMENT PRIMARY KEY,
  company_name    VARCHAR(150) NOT NULL,
  address         VARCHAR(255),
  industry        VARCHAR(100),
  contact_person  VARCHAR(150),
  contact_email   VARCHAR(150),
  contact_phone   VARCHAR(30),
  is_partner      BOOLEAN      NOT NULL DEFAULT FALSE,        -- has a school partnership / MOA
  moa_status      ENUM('none','pending','active','expired') NOT NULL DEFAULT 'none',
  moa_expiry      DATE,
  source          ENUM('school','student') NOT NULL DEFAULT 'school',   -- who introduced this company
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  suggested_by    INT          NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_company_partner (is_partner),
  INDEX idx_company_name (company_name),
  FOREIGN KEY (suggested_by) REFERENCES Users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 4. SUPERVISOR_PROFILE — extends a supervisor's Users record
CREATE TABLE IF NOT EXISTS Supervisor_profile (
  supervisor_id  INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL UNIQUE,
  company_id     INT NULL,
  position       VARCHAR(100),
  department     VARCHAR(100),
  FOREIGN KEY (user_id)    REFERENCES Users(user_id)     ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES Company(company_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5. STUDENT_PROFILE — extends a student's Users record with OJT data
CREATE TABLE IF NOT EXISTS Student_profile (
  student_id       INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL UNIQUE,
  term_id          INT NULL,
  program          VARCHAR(150),
  year_level       VARCHAR(20),
  section          VARCHAR(30),
  required_hours   INT           NOT NULL DEFAULT 486,
  completed_hours  DECIMAL(6,2)  NOT NULL DEFAULT 0,
  teacher_id       INT NULL,                                  -- adviser / coordinator
  ojt_status       ENUM('not_started','looking','pending_approval','ongoing','completed','dropped')
                   NOT NULL DEFAULT 'not_started',
  company_id       INT NULL,                                  -- current approved placement
  supervisor_id    INT NULL,
  start_date       DATE,
  end_date         DATE,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_student_status (ojt_status),
  INDEX idx_student_program (program),
  FOREIGN KEY (user_id)       REFERENCES Users(user_id)                     ON DELETE CASCADE,
  FOREIGN KEY (term_id)       REFERENCES Ojt_term(term_id)                  ON DELETE SET NULL,
  FOREIGN KEY (teacher_id)    REFERENCES Users(user_id)                     ON DELETE SET NULL,
  FOREIGN KEY (company_id)    REFERENCES Company(company_id)                ON DELETE SET NULL,
  FOREIGN KEY (supervisor_id) REFERENCES Supervisor_profile(supervisor_id)  ON DELETE SET NULL
) ENGINE=InnoDB;

-- 6. PLACEMENT — how a student got their OJT (school-assigned or self-sourced)
CREATE TABLE IF NOT EXISTS Placement (
  placement_id              INT AUTO_INCREMENT PRIMARY KEY,
  student_id                INT NOT NULL,
  company_id                INT NULL,
  supervisor_id             INT NULL,
  source                    ENUM('school_assigned','self_sourced') NOT NULL,
  status                    ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  proposed_company_name     VARCHAR(150),                     -- used when the company is not in the system yet
  proposed_company_address  VARCHAR(255),
  proposed_industry         VARCHAR(100),
  proposed_contact          VARCHAR(150),
  proposed_supervisor_name  VARCHAR(150),
  proposed_supervisor_email VARCHAR(150),
  proposed_supervisor_phone VARCHAR(30),
  proposed_supervisor_position VARCHAR(100),
  start_date                DATE,
  end_date                  DATE,
  acceptance_letter         VARCHAR(255),
  student_remarks           VARCHAR(500),
  reviewer_remarks          VARCHAR(500),
  reviewed_by               INT NULL,
  reviewed_at               DATETIME,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_placement_status (status),
  FOREIGN KEY (student_id)    REFERENCES Student_profile(student_id)       ON DELETE CASCADE,
  FOREIGN KEY (company_id)    REFERENCES Company(company_id)               ON DELETE SET NULL,
  FOREIGN KEY (supervisor_id) REFERENCES Supervisor_profile(supervisor_id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by)   REFERENCES Users(user_id)                    ON DELETE SET NULL
) ENGINE=InnoDB;

-- 7. DAILY_REPORT — one attendance log per student per day (photo-verified)
CREATE TABLE IF NOT EXISTS Daily_report (
  report_id          INT AUTO_INCREMENT PRIMARY KEY,
  student_id         INT NOT NULL,
  report_date        DATE NOT NULL,               -- the shift's calendar day (set from time_in)
  time_in            DATETIME,                     -- full timestamp so overnight shifts compute correctly
  time_out           DATETIME,
  tasks_completed    VARCHAR(1000),
  photo_in           VARCHAR(255),
  photo_out          VARCHAR(255),
  lat_in             DECIMAL(10,7),
  lng_in             DECIMAL(10,7),
  lat_out            DECIMAL(10,7),
  lng_out            DECIMAL(10,7),
  hours_rendered     DECIMAL(5,2) NOT NULL DEFAULT 0,
  hours_credited     BOOLEAN      NOT NULL DEFAULT FALSE,     -- already added to completed_hours?
  verify_status      ENUM('pending','verified','flagged') NOT NULL DEFAULT 'pending',
  verified_by        INT NULL,                                -- supervisor_id
  verified_at        DATETIME,
  supervisor_remarks VARCHAR(500),
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_day (student_id, report_date),
  INDEX idx_report_status (verify_status),
  INDEX idx_report_date (report_date),
  FOREIGN KEY (student_id)  REFERENCES Student_profile(student_id)       ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES Supervisor_profile(supervisor_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 8. TASK_ASSIGNMENT — work delegated by a supervisor to an intern
CREATE TABLE IF NOT EXISTS Task_assignment (
  task_id       INT AUTO_INCREMENT PRIMARY KEY,
  student_id    INT NOT NULL,
  assigned_by   INT NOT NULL,                              -- supervisor_id
  title         VARCHAR(150) NOT NULL,
  description   VARCHAR(1000),
  priority      ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
  due_date      DATE,
  status        ENUM('assigned','submitted','revision','completed') NOT NULL DEFAULT 'assigned',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_task_status (status),
  INDEX idx_task_due (due_date),
  FOREIGN KEY (student_id)  REFERENCES Student_profile(student_id)       ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES Supervisor_profile(supervisor_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 9. TASK_SUBMISSION — the student's work for a task (a task can have many attempts)
CREATE TABLE IF NOT EXISTS Task_submission (
  submission_id   INT AUTO_INCREMENT PRIMARY KEY,
  task_id         INT NOT NULL,
  file_attachment VARCHAR(255),
  original_name   VARCHAR(255),
  notes           VARCHAR(1000),
  submitted_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  review_status   ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  feedback        VARCHAR(1000),
  reviewed_by     INT NULL,                              -- supervisor_id
  reviewed_at     DATETIME,
  INDEX idx_submission_review (review_status),
  FOREIGN KEY (task_id)     REFERENCES Task_assignment(task_id)          ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES Supervisor_profile(supervisor_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 10. REQUIREMENT — documents the school requires ("Set OJT Requirements")
CREATE TABLE IF NOT EXISTS Requirement (
  requirement_id INT AUTO_INCREMENT PRIMARY KEY,
  term_id        INT NULL,
  name           VARCHAR(150) NOT NULL,
  description    VARCHAR(500),
  is_required    BOOLEAN NOT NULL DEFAULT TRUE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (term_id) REFERENCES Ojt_term(term_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 11. DOCUMENT — files uploaded by students (linked to a requirement when applicable)
CREATE TABLE IF NOT EXISTS Document (
  document_id    INT AUTO_INCREMENT PRIMARY KEY,
  student_id     INT NOT NULL,
  requirement_id INT NULL,
  doc_type       VARCHAR(150),
  file_path      VARCHAR(255) NOT NULL,
  original_name  VARCHAR(255),
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  remarks        VARCHAR(500),
  reviewed_by    INT NULL,                               -- user_id of the reviewer
  reviewed_at    DATETIME,
  uploaded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_document_status (status),
  FOREIGN KEY (student_id)     REFERENCES Student_profile(student_id) ON DELETE CASCADE,
  FOREIGN KEY (requirement_id) REFERENCES Requirement(requirement_id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by)    REFERENCES Users(user_id)              ON DELETE SET NULL
) ENGINE=InnoDB;

-- 12. COMPLAINT — concerns and incident reports
CREATE TABLE IF NOT EXISTS Complaint (
  complaint_id     INT AUTO_INCREMENT PRIMARY KEY,
  filed_by         INT NOT NULL,                         -- user_id
  company_id       INT NULL,
  category         ENUM('safety','harassment','workload','schedule','allowance','other') NOT NULL DEFAULT 'other',
  severity         ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  subject          VARCHAR(150) NOT NULL,
  description      VARCHAR(2000),
  evidence_path    VARCHAR(255),
  status           ENUM('open','under_review','resolved','dismissed') NOT NULL DEFAULT 'open',
  resolution_notes VARCHAR(1000),
  resolved_by      INT NULL,                             -- coordinator user_id
  resolved_at      DATETIME,
  date_filed       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_complaint_status (status),
  FOREIGN KEY (filed_by)    REFERENCES Users(user_id)      ON DELETE CASCADE,
  FOREIGN KEY (company_id)  REFERENCES Company(company_id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES Users(user_id)      ON DELETE SET NULL
) ENGINE=InnoDB;

-- 13. EVALUATION — two-way assessment; criteria scores stored as JSON
CREATE TABLE IF NOT EXISTS Evaluation (
  evaluation_id   INT AUTO_INCREMENT PRIMARY KEY,
  type            ENUM('supervisor_to_student','student_to_company','coordinator_to_student') NOT NULL,
  period          ENUM('midterm','final','other') NOT NULL DEFAULT 'other',
  student_id      INT NOT NULL,                          -- the student being evaluated / the evaluator's student
  company_id      INT NULL,                              -- company being evaluated (student_to_company)
  evaluator_id    INT NOT NULL,                          -- user_id of whoever wrote it
  rating          DECIMAL(3,2) NOT NULL,                 -- overall, 1.00 – 5.00
  criteria_scores JSON,
  comments        VARCHAR(2000),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_eval_type (type),
  FOREIGN KEY (student_id)   REFERENCES Student_profile(student_id) ON DELETE CASCADE,
  FOREIGN KEY (company_id)   REFERENCES Company(company_id)         ON DELETE SET NULL,
  FOREIGN KEY (evaluator_id) REFERENCES Users(user_id)              ON DELETE CASCADE
) ENGINE=InnoDB;

-- 14. NOTIFICATIONS — in-app alerts
CREATE TABLE IF NOT EXISTS Notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  title           VARCHAR(150),
  message         VARCHAR(500),
  type            VARCHAR(50),
  link            VARCHAR(120),
  is_read         BOOLEAN  NOT NULL DEFAULT FALSE,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_user (user_id, is_read),
  FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 15. AUDIT_LOG — who did what (imports, approvals, resets, ...)
CREATE TABLE IF NOT EXISTS Audit_log (
  log_id     INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  action     VARCHAR(80)  NOT NULL,
  entity     VARCHAR(50),
  entity_id  INT,
  details    VARCHAR(500),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at),
  FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;
