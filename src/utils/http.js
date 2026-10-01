// Small helpers shared by every controller.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Pagination: ?page=1&limit=20   (or ?all=1 for dropdowns, capped at 1000)
function getPage(req, defaultLimit = 20) {
  const all = req.query.all === '1';
  const limit = all ? 1000 : Math.min(Math.max(Number(req.query.limit) || defaultLimit, 1), 200);
  const page = all ? 1 : Math.max(Number(req.query.page) || 1, 1);
  return { page, limit, offset: (page - 1) * limit };
}
const pageResult = (data, total, pg) => ({
  data, total, page: pg.page, limit: pg.limit, pages: Math.max(Math.ceil(total / pg.limit), 1),
});

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const blankToNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || String(body[f]).trim() === '');
  if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}.`);
}

// Public URL path stored in the database for an uploaded file (always forward slashes).
const uploadUrl = (file) => (file ? `/uploads/${file.filename}` : null);

module.exports = { HttpError, asyncHandler, getPage, pageResult, isEmail, clean, blankToNull, requireFields, uploadUrl };
