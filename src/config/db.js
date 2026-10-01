// src/config/db.js — MySQL connection pool.
// Works locally (DB_*), on Railway (MYSQL* variables or MYSQL_URL) and on Aiven (DB_SSL=true).
require('dotenv').config();
const mysql = require('mysql2/promise');

function resolveConfig() {
  const env = process.env;
  let cfg;
  const url = env.DATABASE_URL || env.MYSQL_URL;
  if (env.DB_HOST) {
    cfg = {
      host: env.DB_HOST,
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || 'root',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || 'internet_ojt',
    };
  } else if (url && url.startsWith('mysql')) {
    const u = new URL(url);
    cfg = {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace('/', '') || 'railway',
    };
  } else {
    cfg = {
      host: env.MYSQLHOST || 'localhost',
      port: Number(env.MYSQLPORT || 3306),
      user: env.MYSQLUSER || 'root',
      password: env.MYSQLPASSWORD || env.DB_PASSWORD || '',
      database: env.MYSQLDATABASE || env.DB_NAME || 'internet_ojt',
    };
  }
  if (env.DB_SSL === 'true') cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}

const dbConfig = resolveConfig();
const TZ = process.env.DB_TIMEZONE || '+08:00';

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,      // DATE/DATETIME/TIME come back as plain strings (no timezone surprises)
  decimalNumbers: true,   // DECIMAL/SUM() come back as numbers
});

// Make CURDATE()/CURTIME()/NOW() follow the school's timezone on every connection.
pool.on('connection', (conn) => {
  conn.query(`SET time_zone = '${TZ}'`);
});

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log(`[DB] Connected to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    conn.release();
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  }
}

// Run several statements atomically.
async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTx, dbConfig, testConnection };
