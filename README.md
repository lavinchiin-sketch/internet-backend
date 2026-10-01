# INTERNet Backend (v2)

Node.js + Express + MySQL API for the INTERNet OJT Monitoring & Analytics System.

## What changed in v2
- **No public sign-up.** The system bootstraps its first coordinator from `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` on first run.
- **Bulk student import** (`POST /api/students/import`) — add hundreds of students at once by Student ID + school email, instead of one at a time. Default password = the student's own ID (they're forced to change it on first login).
- **Self-sourced OJT.** A student can propose their own company (`POST /api/placements`); the coordinator approves it (`POST /api/placements/:id/approve`), which can create a brand-new, non-partner `Company` and a new supervisor account on the fly. The coordinator can instead assign students to a company directly (`POST /api/placements/assign`).
- **Companies don't require a partnership.** `Company.is_partner` and `moa_status` track this, but any company can be used.
- **Attendance now auto-computes hours.** Time-in/time-out are stamped by the *server clock* (not client input), hours are computed automatically (minus a configurable lunch break), and verifying a log adds those hours to the student's `completed_hours` exactly once.
- **Terms, Requirements, Placements, Audit log** tables added; richer dashboards.
- **Rate-limited login**, `must_change_password` flow, CORS allow-list for production, Railway/Aiven-friendly DB config.

## Setup
```bash
npm install
cp .env.example .env      # fill in DB_PASSWORD, JWT_SECRET, ADMIN_EMAIL/ADMIN_PASSWORD
npm run db:init            # creates the database + tables (safe to re-run)
npm run dev                 # http://localhost:5000 — creates the first coordinator automatically
npm run db:seed             # optional: sample term, companies, supervisor, 5 students
```

`npm run db:reset` drops and recreates the database from scratch (deletes all data).

## First login
Whatever you set as `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` — that account is created automatically the first time the server starts, if no coordinator exists yet.

## API surface (high level)
- `auth`: login, me, change-password (no public register)
- `users`: coordinator creates/edits supervisor & coordinator accounts
- `students`: list/search/detail, **bulk import**, status, "I need/found an OJT" intent
- `terms`, `requirements`: school year/semester, document checklist definitions
- `companies`: partner or not; students/supervisors only see active ones
- `placements`: self-sourced requests + approval, or direct school assignment
- `daily-reports`: time-in / time-out (photo, geolocation optional), review (verify/flag), bulk review
- `tasks`: assign, submit, review (approve/needs-revision)
- `documents`: requirement checklist uploads + review
- `complaints`, `evaluations` (rubric-based), `notifications`
- `dashboard`: role-specific summaries + `/dashboard/reports` for charts

Every list endpoint supports `?page=&limit=` (or `?all=1` for dropdowns) and returns `{ data, total, page, limit, pages }`.

## Deploying
- **Railway**: no `DB_*` vars needed — `MYSQLHOST`/`MYSQLUSER`/etc. (or `MYSQL_URL`) are detected automatically. Attach a **Volume** at the path you set in `UPLOAD_DIR` so uploaded files survive redeploys.
- **Aiven**: set `DB_SSL=true`.
- Set `CORS_ORIGINS` to your deployed frontend URLs (comma-separated) once you're live.
