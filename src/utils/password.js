const bcrypt = require('bcryptjs');

const hash = (plain) => bcrypt.hash(plain, 10);
const compare = (plain, hashed) => bcrypt.compare(plain, hashed);

// Readable temporary password, e.g. "Kf7mQ2xR9p" (no look-alike characters).
function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
module.exports = { hash, compare, generatePassword };
