// Allowed browser origins. Empty CORS_ORIGINS = allow all (development only).
function corsOptions() {
  const list = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (list.length === 0) return { origin: true };
  return {
    origin(origin, cb) {
      if (!origin || list.includes(origin.replace(/\/$/, ''))) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
  };
}
module.exports = { corsOptions };
