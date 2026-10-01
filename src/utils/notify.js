// Create in-app notifications (and push them live over Socket.IO when connected).
const { pool } = require('../config/db');
let io = null;
const setIo = (instance) => { io = instance; };

async function notify(userId, { title, message, type = 'info', link = null }, conn = pool) {
  if (!userId) return;
  await conn.query(
    'INSERT INTO Notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
    [userId, title, message, type, link]
  );
  if (io) io.to(`user:${userId}`).emit('notification', { title, message, type, link });
}

async function notifyCoordinators(payload, conn = pool) {
  const [rows] = await conn.query("SELECT user_id FROM Users WHERE role = 'coordinator' AND is_active = TRUE");
  for (const r of rows) await notify(r.user_id, payload, conn);
}

module.exports = { notify, notifyCoordinators, setIo };
