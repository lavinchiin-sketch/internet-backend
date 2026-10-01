// src/config/initDb.js
//   npm run db:init   -> create the database (if allowed) and all tables (safe to re-run)
//   npm run db:reset  -> DROP the database first, then recreate everything (deletes all data!)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { dbConfig } = require('./db');

async function main() {
  const reset = process.argv.includes('--reset');
  const { database, ...serverCfg } = dbConfig;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  const admin = await mysql.createConnection({ ...serverCfg, multipleStatements: true });
  try {
    if (reset) {
      console.log(`[DB Init] Dropping database "${database}"...`);
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (e) {
      console.log(`[DB Init] Could not create database (${e.code}); assuming "${database}" already exists.`);
    }
    await admin.query(`USE \`${database}\``);
    console.log('[DB Init] Running schema.sql...');
    await admin.query(sql);
    const [rows] = await admin.query('SHOW TABLES');
    console.log(`[DB Init] Done. ${rows.length} tables ready in "${database}".`);
  } catch (err) {
    console.error('[DB Init] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await admin.end();
  }
}
main();
