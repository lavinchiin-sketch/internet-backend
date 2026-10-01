const { pool } = require('../config/db');
const { asyncHandler, getPage, pageResult } = require('../utils/http');

// GET /api/notifications?unread=1
const list = asyncHandler(async (req, res) => {
  const pg = getPage(req, 30);
  const W = 'WHERE user_id = ?' + (req.query.unread === '1' ? ' AND is_read = FALSE' : '');
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM Notifications ${W}`, [req.user.user_id]);
  const [rows] = await pool.query(`SELECT * FROM Notifications ${W} ORDER BY notification_id DESC LIMIT ? OFFSET ?`, [req.user.user_id, pg.limit, pg.offset]);
  res.json(pageResult(rows, total, pg));
});
const unreadCount = asyncHandler(async (req, res) => {
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM Notifications WHERE user_id = ? AND is_read = FALSE', [req.user.user_id]);
  res.json({ unread });
});
const markRead = asyncHandler(async (req, res) => {
  await pool.query('UPDATE Notifications SET is_read = TRUE WHERE notification_id = ? AND user_id = ?', [req.params.id, req.user.user_id]);
  res.json({ message: 'ok' });
});
const markAllRead = asyncHandler(async (req, res) => {
  await pool.query('UPDATE Notifications SET is_read = TRUE WHERE user_id = ?', [req.user.user_id]);
  res.json({ message: 'ok' });
});
module.exports = { list, unreadCount, markRead, markAllRead };
