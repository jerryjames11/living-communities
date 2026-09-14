// create-admin.js — creates or resets the admin login directly in the database.
//
// This is the host-independent way to get into the admin account. It doesn't matter which
// company is hosting the app (Render, Railway, Fly, your own server, or somewhere new next
// year) — the admin account is a row in your Postgres database, not something the host stores.
// As long as you have the database's connection string, this script works, and the account it
// creates/resets keeps working no matter where the app itself is running.
//
// Usage (run from this project's folder, with DATABASE_URL set — either in your shell or in a
// .env file here):
//
//   node create-admin.js you@example.com "A strong password"
//
// Run it again anytime with the same email to RESET that admin's password (useful if you forget
// it, or after moving to a new host/database and want to make sure the account is there).
// Run it with a different email to add a second admin.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = (m[2] || '').trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

function hash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function id(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const password = String(process.argv[3] || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: node create-admin.js you@example.com "A strong password"');
    console.error('(that email doesn\'t look valid)');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Usage: node create-admin.js you@example.com "A strong password"');
    console.error('(password must be at least 8 characters)');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it in your shell, or copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const useSSL = /sslmode=require/.test(process.env.DATABASE_URL) || process.env.PGSSL === 'true';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false });

  const salt = newSalt();
  const passwordHash = hash(password, salt);

  const existing = (await pool.query('SELECT id, role FROM users WHERE lower(email)=lower($1)', [email])).rows[0];

  if (existing) {
    await pool.query(
      'UPDATE users SET role=$1, password_hash=$2, salt=$3, suspended=false WHERE id=$4',
      ['admin', passwordHash, salt, existing.id]
    );
    console.log(`Updated existing account (${existing.role} -> admin) and reset its password: ${email}`);
  } else {
    await pool.query(
      'INSERT INTO users (id, role, name, email, password_hash, salt) VALUES ($1,$2,$3,$4,$5,$6)',
      [id('usr'), 'admin', 'Admin', email, passwordHash, salt]
    );
    console.log(`Created a new admin account: ${email}`);
  }

  console.log('You can log in with this email and the password you just set, on whichever host is currently serving the site.');
  await pool.end();
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
