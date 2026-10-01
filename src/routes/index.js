// Every API route in one place: who can call it, and which handler runs.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, authenticateLoose } = require('../middleware/auth');
const authorize = require('../middleware/rbac');
const { upload } = require('../middleware/upload');

const auth = require('../controllers/authController');
const users = require('../controllers/usersController');
const students = require('../controllers/studentsController');
const companies = require('../controllers/companiesController');
const terms = require('../controllers/termsController');
const placements = require('../controllers/placementsController');
const reports = require('../controllers/dailyReportsController');
const tasks = require('../controllers/tasksController');
const docs = require('../controllers/documentsController');
const complaints = require('../controllers/complaintsController');
const evals = require('../controllers/evaluationsController');
const notifs = require('../controllers/notificationsController');
const dash = require('../controllers/dashboardController');

const router = express.Router();
const coordinator = [authenticate, authorize('coordinator')];
const student = [authenticate, authorize('student')];
const supervisor = [authenticate, authorize('supervisor')];
const staff = [authenticate, authorize('supervisor', 'coordinator')];
const anyone = [authenticate];

// ----- Auth (no public sign-up) -----
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Please try again in a few minutes.' } });
router.post('/auth/login', loginLimiter, auth.login);
router.get('/auth/me', authenticateLoose, auth.me);
router.patch('/auth/me', authenticateLoose, auth.updateMe);
router.post('/auth/change-password', authenticateLoose, auth.changePassword);

// ----- Users (coordinator) -----
router.get('/users', ...coordinator, users.listUsers);
router.post('/users/supervisors', ...coordinator, users.createSupervisor);
router.post('/users/coordinators', ...coordinator, users.createCoordinator);
router.patch('/users/:id', ...coordinator, users.updateUser);
router.post('/users/:id/reset-password', ...coordinator, users.resetPassword);

// ----- Students -----
router.get('/students/me', ...student, students.getMe);
router.post('/students/me/intent', ...student, students.setIntent);
router.get('/students/programs', ...anyone, students.listPrograms);
router.post('/students/import', ...coordinator, students.importStudents);
router.get('/students', ...staff, students.listStudents);
router.post('/students', ...coordinator, students.createStudent);
router.get('/students/:id', ...staff, students.getStudent);
router.patch('/students/:id', ...coordinator, students.updateStudent);
router.patch('/students/:id/status', ...coordinator, students.setStatus);

// ----- Terms, companies -----
router.get('/terms', ...anyone, terms.listTerms);
router.post('/terms', ...coordinator, terms.createTerm);
router.patch('/terms/:id', ...coordinator, terms.updateTerm);
router.post('/terms/:id/activate', ...coordinator, terms.activateTerm);

router.get('/companies', ...anyone, companies.listCompanies);
router.get('/companies/:id', ...anyone, companies.getCompany);
router.post('/companies', ...coordinator, companies.createCompany);
router.patch('/companies/:id', ...coordinator, companies.updateCompany);

// ----- Placements -----
router.post('/placements', ...student, upload.single('acceptance_letter'), placements.submitRequest);
router.get('/placements/mine', ...student, placements.myPlacements);
router.post('/placements/:id/cancel', ...student, placements.cancelRequest);
router.get('/placements', ...coordinator, placements.listPlacements);
router.post('/placements/assign', ...coordinator, placements.assignStudents);
router.post('/placements/:id/approve', ...coordinator, placements.approve);
router.post('/placements/:id/reject', ...coordinator, placements.reject);

// ----- Attendance -----
router.get('/daily-reports/today', ...student, reports.getToday);
router.post('/daily-reports/time-in', ...student, upload.single('photo'), reports.timeIn);
router.post('/daily-reports/time-out', ...student, upload.single('photo'), reports.timeOut);
router.get('/daily-reports/mine', ...student, reports.myReports);
router.get('/daily-reports', ...staff, reports.listReports);
router.post('/daily-reports/review-bulk', ...staff, reports.reviewBulk);
router.patch('/daily-reports/:id/review', ...staff, reports.review);

// ----- Tasks -----
router.post('/tasks', ...supervisor, tasks.createTasks);
router.get('/tasks', ...anyone, tasks.listTasks);
router.patch('/tasks/submissions/:id/review', ...supervisor, tasks.reviewSubmission);
router.get('/tasks/:id', ...anyone, tasks.getTask);
router.post('/tasks/:id/submit', ...student, upload.single('file'), tasks.submitTask);
router.delete('/tasks/:id', ...supervisor, tasks.deleteTask);

// ----- Requirements & documents -----
router.get('/requirements', ...anyone, docs.listRequirements);
router.post('/requirements', ...coordinator, docs.createRequirement);
router.patch('/requirements/:id', ...coordinator, docs.updateRequirement);
router.get('/documents/mine', ...student, docs.myChecklist);
router.post('/documents', ...student, upload.single('file'), docs.upload);
router.get('/documents', ...coordinator, docs.listDocuments);
router.get('/documents/student/:studentId', ...staff, docs.studentDocuments);
router.patch('/documents/:id/review', ...coordinator, docs.reviewDocument);

// ----- Complaints, evaluations, notifications -----
router.post('/complaints', ...anyone, upload.single('evidence'), complaints.fileComplaint);
router.get('/complaints', ...anyone, complaints.listComplaints);
router.patch('/complaints/:id', ...coordinator, complaints.updateComplaint);

router.get('/evaluations/criteria', ...anyone, evals.getCriteria);
router.post('/evaluations', ...anyone, evals.create);
router.get('/evaluations', ...anyone, evals.list);

router.get('/notifications', ...anyone, notifs.list);
router.get('/notifications/unread-count', ...anyone, notifs.unreadCount);
router.patch('/notifications/read-all', ...anyone, notifs.markAllRead);
router.patch('/notifications/:id/read', ...anyone, notifs.markRead);

// ----- Dashboards -----
router.get('/dashboard/coordinator', ...coordinator, dash.coordinator);
router.get('/dashboard/reports', ...coordinator, dash.reports);
router.get('/dashboard/supervisor', ...supervisor, dash.supervisor);
router.get('/dashboard/student', ...student, dash.student);

module.exports = router;
