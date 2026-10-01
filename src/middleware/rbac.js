const { HttpError } = require('../utils/http');
// Usage: router.get('/x', authenticate, authorize('coordinator'), handler)
const authorize = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, `Access denied. Requires role: ${roles.join(' or ')}.`));
module.exports = authorize;
