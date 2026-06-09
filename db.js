// SQLite-laag voor accounts, sessies, account↔PIN-koppeling en licenties.
//
// Schema overzicht:
//   users          — accounts (email + bcrypt password_hash + email_verified)
//   sessions       — actieve sessies (token → user_id)
//   account_pins   — koppel-tabel (PIN → user_id, 1 PIN max 1 owner)
//   licenses      — paid/trial state per user_id
//   orphan_licenses — pre-migratie licenties die nog niet aan een account
//                     gekoppeld zijn (bewaren paid status zodat bestaande
//                     gebruikers hun license terug krijgen via email-match
//                     bij signup).
//
// Migratie: bij eerste server-start met een bestaande licenses.json wordt
// die data ge-imporerd naar orphan_licenses. Een nieuwe user die signupt
// met een matching customer_email krijgt automatisch de license + PIN's
// gekoppeld. Trial-only orphans worden geïmporteerd maar onbruikbaar — zo
// stoppen we trial-misbruik door re-creatie van accounts.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.RENDER_DISK_PATH || __dirname;
const DB_FILE = path.join(DATA_DIR, 'rallypoint.db');
const LICENSES_JSON = path.join(DATA_DIR, 'licenses.json');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_token TEXT,
    reset_token TEXT,
    reset_expires INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS account_pins (
    pin TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    paired_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pins_user ON account_pins(user_id);

CREATE TABLE IF NOT EXISTS licenses (
    user_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'none',
    plan TEXT,
    expires_at INTEGER,
    trial_used_at INTEGER,
    trial_ends_at INTEGER,
    ls_subscription_id TEXT,
    ls_order_id TEXT,
    customer_email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orphan_licenses (
    pin TEXT PRIMARY KEY,
    customer_email TEXT COLLATE NOCASE,
    status TEXT,
    plan TEXT,
    expires_at INTEGER,
    trial_used_at INTEGER,
    trial_ends_at INTEGER,
    ls_subscription_id TEXT,
    ls_order_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orphan_email ON orphan_licenses(customer_email);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
`);

// Profile fields toevoegen aan users tabel — idempotent door try/catch op
// "duplicate column" errors (ALTER TABLE ADD COLUMN IF NOT EXISTS pas vanaf
// SQLite 3.35, en niet altijd beschikbaar).
function addColumnIfMissing(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
}
addColumnIfMissing('users', 'display_name', 'TEXT');
addColumnIfMissing('users', 'avatar_url', 'TEXT');
addColumnIfMissing('users', 'favorite_sport', 'INTEGER');
addColumnIfMissing('users', 'is_public', 'INTEGER NOT NULL DEFAULT 0');

// --- Eenmalige migratie: licenses.json → orphan_licenses ---
function migrateLicensesJsonIfNeeded() {
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get('migrated_json');
  if (done) return;
  if (!fs.existsSync(LICENSES_JSON)) {
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run('migrated_json', 'no-json');
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LICENSES_JSON, 'utf8') || '{}');
    const insert = db.prepare(`
      INSERT OR IGNORE INTO orphan_licenses
      (pin, customer_email, status, plan, expires_at, trial_used_at, trial_ends_at, ls_subscription_id, ls_order_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let count = 0;
    for (const pin of Object.keys(raw)) {
      const lic = raw[pin] || {};
      insert.run(
        pin,
        lic.customer_email || null,
        lic.status || 'none',
        lic.plan || null,
        lic.expires_at || null,
        lic.trial_used_at || null,
        lic.trial_ends_at || null,
        lic.ls_subscription_id || null,
        lic.ls_order_id || null,
        lic.created_at || Date.now()
      );
      count++;
    }
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run('migrated_json', String(count));
    console.log('[db] migrated', count, 'licenses from JSON → orphan_licenses');
  } catch (e) {
    console.error('[db] JSON migration failed:', e && e.message);
  }
}
migrateLicensesJsonIfNeeded();

// --- Prepared statements ---
const stmts = {
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  createUser: db.prepare(`
    INSERT INTO users (email, password_hash, verify_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  setEmailVerified: db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, updated_at = ? WHERE id = ?'),
  setVerifyToken: db.prepare('UPDATE users SET verify_token = ?, updated_at = ? WHERE id = ?'),
  getUserByVerifyToken: db.prepare('SELECT * FROM users WHERE verify_token = ?'),
  setResetToken: db.prepare('UPDATE users SET reset_token = ?, reset_expires = ?, updated_at = ? WHERE id = ?'),
  getUserByResetToken: db.prepare('SELECT * FROM users WHERE reset_token = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, updated_at = ? WHERE id = ?'),

  createSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  pruneExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  pairPin: db.prepare('INSERT INTO account_pins (pin, user_id, paired_at) VALUES (?, ?, ?)'),
  unpairPin: db.prepare('DELETE FROM account_pins WHERE pin = ? AND user_id = ?'),
  getPinOwner: db.prepare('SELECT * FROM account_pins WHERE pin = ?'),
  getPinsForUser: db.prepare('SELECT * FROM account_pins WHERE user_id = ? ORDER BY paired_at'),

  getLicense: db.prepare('SELECT * FROM licenses WHERE user_id = ?'),
  upsertLicense: db.prepare(`
    INSERT INTO licenses (user_id, status, plan, expires_at, trial_used_at, trial_ends_at, ls_subscription_id, ls_order_id, customer_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      plan = excluded.plan,
      expires_at = excluded.expires_at,
      trial_used_at = COALESCE(licenses.trial_used_at, excluded.trial_used_at),
      trial_ends_at = excluded.trial_ends_at,
      ls_subscription_id = COALESCE(excluded.ls_subscription_id, licenses.ls_subscription_id),
      ls_order_id = COALESCE(excluded.ls_order_id, licenses.ls_order_id),
      customer_email = COALESCE(excluded.customer_email, licenses.customer_email),
      updated_at = excluded.updated_at
  `),

  getOrphansByEmail: db.prepare('SELECT * FROM orphan_licenses WHERE customer_email = ?'),
  deleteOrphan: db.prepare('DELETE FROM orphan_licenses WHERE pin = ?'),

  updateProfile: db.prepare(`
    UPDATE users SET
      display_name = COALESCE(?, display_name),
      avatar_url = COALESCE(?, avatar_url),
      favorite_sport = COALESCE(?, favorite_sport),
      is_public = COALESCE(?, is_public),
      updated_at = ?
    WHERE id = ?
  `),
};

// Periodieke cleanup van expired sessions (1× per uur)
setInterval(() => {
  try { stmts.pruneExpiredSessions.run(Date.now()); } catch (e) {}
}, 60 * 60 * 1000);

// --- Public API ---
function randomHex(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }

function getUserById(id) { return stmts.getUserById.get(id); }
function getUserByEmail(email) { return stmts.getUserByEmail.get(String(email || '').toLowerCase()); }

function createUser(email, passwordHash) {
  const now = Date.now();
  const verifyToken = randomHex(24);
  const res = stmts.createUser.run(String(email).toLowerCase(), passwordHash, verifyToken, now, now);
  return { id: res.lastInsertRowid, verifyToken };
}

function markEmailVerified(userId) { stmts.setEmailVerified.run(Date.now(), userId); }
function getUserByVerifyToken(token) { return stmts.getUserByVerifyToken.get(token); }

function setResetToken(userId) {
  const token = randomHex(24);
  const expires = Date.now() + (60 * 60 * 1000); // 1u geldig
  stmts.setResetToken.run(token, expires, Date.now(), userId);
  return token;
}
function getUserByResetToken(token) {
  const u = stmts.getUserByResetToken.get(token);
  if (!u) return null;
  if (!u.reset_expires || u.reset_expires < Date.now()) return null;
  return u;
}
function updatePassword(userId, passwordHash) {
  stmts.updatePassword.run(passwordHash, Date.now(), userId);
  stmts.deleteUserSessions.run(userId);   // alle sessies invalideren na wachtwoord-reset
}

function createSession(userId, daysValid = 30) {
  const token = randomHex(32);
  const expires = Date.now() + (daysValid * 24 * 60 * 60 * 1000);
  stmts.createSession.run(token, userId, expires, Date.now());
  return { token, expiresAt: expires };
}
function getSessionUser(token) {
  if (!token) return null;
  const s = stmts.getSession.get(token, Date.now());
  if (!s) return null;
  return getUserById(s.user_id);
}
function deleteSession(token) { stmts.deleteSession.run(token); }

function pairPin(pin, userId) {
  const owner = stmts.getPinOwner.get(pin);
  if (owner) {
    return owner.user_id === userId ? { ok: true, alreadyOwned: true } : { ok: false, error: 'pin_taken' };
  }
  stmts.pairPin.run(pin, userId, Date.now());
  return { ok: true };
}
function unpairPin(pin, userId) { stmts.unpairPin.run(pin, userId); }
function getPinOwner(pin) { return stmts.getPinOwner.get(pin); }
function getUserByPin(pin) {
  const owner = stmts.getPinOwner.get(pin);
  if (!owner) return null;
  return getUserById(owner.user_id);
}
function getPinsForUser(userId) { return stmts.getPinsForUser.all(userId); }

function getLicense(userId) { return stmts.getLicense.get(userId); }
function upsertLicense(userId, fields) {
  const now = Date.now();
  const existing = stmts.getLicense.get(userId) || {};
  stmts.upsertLicense.run(
    userId,
    fields.status || existing.status || 'none',
    fields.plan || existing.plan || null,
    fields.expires_at !== undefined ? fields.expires_at : (existing.expires_at || null),
    fields.trial_used_at !== undefined ? fields.trial_used_at : (existing.trial_used_at || null),
    fields.trial_ends_at !== undefined ? fields.trial_ends_at : (existing.trial_ends_at || null),
    fields.ls_subscription_id !== undefined ? fields.ls_subscription_id : (existing.ls_subscription_id || null),
    fields.ls_order_id !== undefined ? fields.ls_order_id : (existing.ls_order_id || null),
    fields.customer_email !== undefined ? fields.customer_email : (existing.customer_email || null),
    existing.created_at || now,
    now
  );
}

// Claim alle orphan-licenses voor deze email: voeg paid licenses samen tot
// user's licentie en pair de PINs aan dit account. Trial-only orphans → niets
// (anders kan iemand de trial opnieuw "claimen").
function claimOrphansForUser(userId, email) {
  if (!email) return { claimed: 0 };
  const orphans = stmts.getOrphansByEmail.all(String(email).toLowerCase());
  let claimed = 0;
  for (const o of orphans) {
    const isPaid = o.ls_subscription_id || o.ls_order_id;
    if (!isPaid) continue;
    // Koppel PIN aan dit account (skip als al van iemand anders)
    const owner = stmts.getPinOwner.get(o.pin);
    if (!owner) {
      stmts.pairPin.run(o.pin, userId, Date.now());
    } else if (owner.user_id !== userId) {
      continue;   // PIN al van andere account → skip
    }
    // Update licensie: merge in
    upsertLicense(userId, {
      status: o.status,
      plan: o.plan,
      expires_at: o.expires_at,
      ls_subscription_id: o.ls_subscription_id,
      ls_order_id: o.ls_order_id,
      customer_email: o.customer_email,
    });
    stmts.deleteOrphan.run(o.pin);
    claimed++;
  }
  return { claimed };
}

function updateProfile(userId, fields) {
  stmts.updateProfile.run(
    fields.display_name === undefined ? null : (fields.display_name || null),
    fields.avatar_url === undefined ? null : (fields.avatar_url || null),
    fields.favorite_sport === undefined ? null : (fields.favorite_sport == null ? null : Number(fields.favorite_sport)),
    fields.is_public === undefined ? null : (fields.is_public ? 1 : 0),
    Date.now(),
    userId
  );
}

// Wijzig e-mailadres + reset verified-status + nieuwe verify-token zodat user
// 't nieuwe adres moet bevestigen. Roept caller om de mail te versturen.
function changeEmail(userId, newEmail) {
  const verifyToken = randomHex(24);
  db.prepare(`
    UPDATE users SET email = ?, email_verified = 0, verify_token = ?, updated_at = ?
    WHERE id = ?
  `).run(String(newEmail).toLowerCase(), verifyToken, Date.now(), userId);
}

function deleteUser(userId) {
  // FOREIGN KEYs in sessions/account_pins/licenses cascaden door ON DELETE CASCADE.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

module.exports = {
  randomHex,
  getUserById, getUserByEmail, createUser,
  markEmailVerified, getUserByVerifyToken,
  setResetToken, getUserByResetToken, updatePassword,
  createSession, getSessionUser, deleteSession,
  pairPin, unpairPin, getPinOwner, getUserByPin, getPinsForUser,
  getLicense, upsertLicense, claimOrphansForUser,
  updateProfile, changeEmail, deleteUser,
};
