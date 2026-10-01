const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { dbConfig } = require('../config/db');

async function initSchema() {
  const conn = await mysql.createConnection({
    ...dbConfig,
    multipleStatements: true,
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await conn.query(sql);
  await conn.end();
  console.log('[DB] Schema ready');
}

module.exports = initSchema;