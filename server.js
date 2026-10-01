require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const app = require('./src/app');
const { testConnection } = require('./src/config/db');
const { corsOptions } = require('./src/config/cors');
const { ensureAdmin } = require('./src/utils/bootstrap');
const { setIo } = require('./src/utils/notify');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('[Config] JWT_SECRET is missing or too short (use at least 16 random characters).');
  process.exit(1);
}

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Socket.IO: authenticated users join a private room and receive live notifications.
const io = new Server(server, { cors: corsOptions() });
io.use((socket, next) => {
  try { socket.userId = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET).user_id; next(); }
  catch { next(new Error('unauthorized')); }
});
io.on('connection', (socket) => socket.join(`user:${socket.userId}`));
setIo(io);

(async () => {
  await testConnection();
  await ensureAdmin();
  server.listen(PORT, '0.0.0.0', () => console.log(`[Server] INTERNet API running on port ${PORT}`));
})();
