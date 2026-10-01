const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function initSchema() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    multipleStatements: true,
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await conn.query(sql);
  await conn.end();
  console.log('[DB] Schema ready');
}

module.exports = initSchema;