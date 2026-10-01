// Usage: npm run admin:create -- "Full Name" email@psu.edu.ph StrongPassword
require('dotenv').config();
const { pool } = require('../config/db');
const { hash } = require('../utils/password');
(async () => {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) { console.log('Usage: npm run admin:create -- "Full Name" email password'); process.exit(1); }
  await pool.query("INSERT INTO Users (full_name, email, password, role) VALUES (?, ?, ?, 'coordinator')", [name, email.toLowerCase(), await hash(password)]);
  console.log(`Coordinator created: ${email}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
