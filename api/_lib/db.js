// Helper partagé par toutes les fonctions serverless — connexion Neon, hachage,
// sessions, réponses JSON. Fichier préfixé par "_" : Vercel ne le publie pas
// comme endpoint, seuls les modules le important y ont accès.

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING;

if (!connectionString) {
  console.error('Aucune variable de connexion Neon trouvée (DATABASE_URL / POSTGRES_URL).');
}

const sql = connectionString ? neon(connectionString) : null;

function uid(prefix) {
  return prefix + crypto.randomBytes(9).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- validation des mots de passe
// Exigée côté serveur : le contrôle JS dans le navigateur peut toujours être contourné
// par un appel direct à l'API. 8 caractères minimum, au moins une lettre et un chiffre.
function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

// ---------------------------------------------------------------- limitation de débit (brute force / spam)
// Compteur à fenêtre fixe stocké en base : les instances serverless ne partagent pas de
// mémoire entre elles, donc un compteur en mémoire process serait contournable en boucle.
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function checkRateLimit({ key, max, windowMinutes }) {
  const rows = await sql`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(mins => ${windowMinutes})
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(mins => ${windowMinutes})
                   THEN now() ELSE rate_limits.window_start END
    RETURNING count
  `;
  return rows[0].count <= max;
}

// ---------------------------------------------------------------- CAPTCHA (Cloudflare Turnstile)
// Vérifie le jeton résolu par le widget côté client auprès de Cloudflare. La clé secrète
// n'existe que côté serveur (variable d'environnement) — jamais exposée au navigateur.
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) { console.error('TURNSTILE_SECRET_KEY manquante.'); return false; }
  if (!token) return false;
  try {
    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp) params.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Erreur de vérification Turnstile :', err.message);
    return false;
  }
}

// ---------------------------------------------------------------- envoi d'e-mail (Resend)
// Sans domaine personnalisé vérifié chez Resend, l'expéditeur de test onboarding@resend.dev
// ne peut délivrer qu'à l'adresse du propriétaire du compte Resend (limitation anti-abus du
// service, pas de notre code). L'échec d'envoi n'empêche jamais l'inscription : le lien reste
// aussi affiché à l'écran comme filet de sécurité pour tous les autres comptes de démonstration.
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('RESEND_API_KEY manquante.'); return { ok: false, error: 'missing_api_key' }; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'NOVA BANK <onboarding@resend.dev>', to: [to], subject, html })
    });
    const data = await res.json();
    if (!res.ok) { console.error('Erreur Resend :', data); return { ok: false, error: data.message || 'send_failed' }; }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('Erreur d\'envoi e-mail :', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------- mots de passe (scrypt, natif Node — pas de dépendance)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- références
function generateAccountNumber() {
  let n = '';
  for (let i = 0; i < 10; i++) n += Math.floor(Math.random() * 10);
  return 'NOVA-' + n.slice(0, 4) + '-' + n.slice(4, 8) + n.slice(8);
}
function generateIBAN() {
  let n = '';
  for (let i = 0; i < 16; i++) n += Math.floor(Math.random() * 10);
  return 'HK' + Math.floor(10 + Math.random() * 89) + ' NOVA ' + n.match(/.{1,4}/g).join(' ');
}
function generateTrxRef() {
  const letters = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  let digits = '';
  for (let i = 0; i < 6; i++) digits += Math.floor(Math.random() * 10);
  return `TRX-${letters}-${digits}`;
}
function generate2FACode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---------------------------------------------------------------- sessions (table sessions, token bearer)
const SESSION_HOURS = 12;
const ADMIN_SESSION_MINUTES = 30;

async function createSession({ userId = null, isAdmin = false, adminId = null, role = null, name = null }) {
  const token = crypto.randomBytes(32).toString('hex');
  const minutes = isAdmin ? ADMIN_SESSION_MINUTES : SESSION_HOURS * 60;
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  await sql`
    INSERT INTO sessions (token, user_id, is_admin, admin_id, role, name, expires_at)
    VALUES (${token}, ${userId}, ${isAdmin}, ${adminId}, ${role}, ${name}, ${expiresAt})
  `;
  return { token, expiresAt };
}

async function getSession(token) {
  if (!token) return null;
  const rows = await sql`SELECT * FROM sessions WHERE token = ${token} LIMIT 1`;
  const session = rows[0];
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await sql`DELETE FROM sessions WHERE token = ${token}`;
    return null;
  }
  return session;
}

async function refreshSession(token, isAdmin) {
  const minutes = isAdmin ? ADMIN_SESSION_MINUTES : SESSION_HOURS * 60;
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  await sql`UPDATE sessions SET expires_at = ${expiresAt} WHERE token = ${token}`;
}

async function destroySession(token) {
  if (!token) return;
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

function getBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

async function destroyAllUserSessions(userId) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND is_admin = false`;
}

async function destroyAllAdminSessions(adminId) {
  await sql`DELETE FROM sessions WHERE admin_id = ${adminId} AND is_admin = true`;
}

// ---------------------------------------------------------------- réinitialisation du mot de passe
// Démo : ce site n'a pas de serveur d'e-mail réel. Le jeton (aléatoire, à usage unique,
// expirant après 30 minutes) est généré et vérifié exactement comme dans un vrai système —
// seule la remise se fait à l'écran plutôt que par e-mail, comme pour le code 2FA admin.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
  await sql`
    INSERT INTO password_resets (token_hash, user_id, expires_at, used)
    VALUES (${hashToken(token)}, ${userId}, ${expiresAt}, false)
  `;
  return token;
}

async function consumePasswordResetToken(token) {
  const tokenHash = hashToken(token);
  const rows = await sql`SELECT * FROM password_resets WHERE token_hash = ${tokenHash} LIMIT 1`;
  const row = rows[0];
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return null;
  await sql`UPDATE password_resets SET used = true WHERE token_hash = ${tokenHash}`;
  return row.user_id;
}

// ---------------------------------------------------------------- vérification d'e-mail
// Même principe que la réinitialisation de mot de passe : jeton réel à usage unique,
// affiché à l'écran faute de serveur d'e-mail. Expire après 24h (plus long que le
// reset : l'utilisateur n'est pas forcément pressé de confirmer juste après l'inscription).
async function createEmailVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60000).toISOString();
  await sql`
    INSERT INTO email_verifications (token_hash, user_id, expires_at, used)
    VALUES (${hashToken(token)}, ${userId}, ${expiresAt}, false)
  `;
  return token;
}

async function consumeEmailVerificationToken(token) {
  const tokenHash = hashToken(token);
  const rows = await sql`SELECT * FROM email_verifications WHERE token_hash = ${tokenHash} LIMIT 1`;
  const row = rows[0];
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return null;
  await sql`UPDATE email_verifications SET used = true WHERE token_hash = ${tokenHash}`;
  return row.user_id;
}

// ---------------------------------------------------------------- schéma (création idempotente, exécutée une fois par instance)
let schemaReady = null;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      birth_date TEXT,
      address TEXT,
      currency TEXT NOT NULL DEFAULT 'EUR',
      password_hash TEXT NOT NULL,
      account_number TEXT UNIQUE NOT NULL,
      iban TEXT NOT NULL,
      balance NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      suspend_reason TEXT,
      kyc_id_photo JSONB,
      kyc_id_document JSONB,
      kyc_status TEXT DEFAULT 'none',
      email_verified BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_login TIMESTAMPTZ
    )`;
    // Migration : la colonne n'existe pas encore sur les bases déjà en production.
    // DEFAULT true préserve les comptes déjà créés (jamais bloqués rétroactivement) ;
    // seule l'inscription force explicitement false pour les nouveaux comptes.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true`;
    await sql`CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      date TIMESTAMPTZ DEFAULT now(),
      user_agent TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS transactions (
      ref TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      description TEXT,
      amount NUMERIC NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      settled BOOLEAN DEFAULT false,
      admin_name TEXT,
      beneficiary TEXT,
      bank_name TEXT,
      iban_dest TEXT,
      bic TEXT,
      reason TEXT,
      execution_date TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      type TEXT,
      date TIMESTAMPTZ DEFAULT now(),
      read BOOLEAN DEFAULT false
    )`;
    await sql`CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      author TEXT,
      role TEXT,
      text TEXT,
      date TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS savings_goals (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      target_amount NUMERIC,
      current_amount NUMERIC DEFAULT 0,
      icon TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      last4 TEXT,
      frozen BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    // Migration : la colonne n'existe pas encore sur les bases déjà en production.
    await sql`ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`;
    await sql`CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      date TIMESTAMPTZ DEFAULT now(),
      admin_id TEXT,
      admin_name TEXT,
      role TEXT,
      action TEXT,
      detail TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT,
      is_admin BOOLEAN DEFAULT false,
      admin_id TEXT,
      role TEXT,
      name TEXT,
      expires_at TIMESTAMPTZ NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS pending_2fa (
      admin_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INT NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT false
    )`;
    await sql`CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT false
    )`;
    await sql`CREATE TABLE IF NOT EXISTS pending_client_2fa (
      user_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`;

    // Index — les clés primaires sont déjà indexées automatiquement ; ceux-ci accélèrent
    // les filtres/tris utilisés par le back-office (fiche client, listes paginées, stats).
    await sql`CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_savings_goals_user_id ON savings_goals(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cards_user_id ON cards(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_activity_log_date ON activity_log(date DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_email_verifications_user_id ON email_verifications(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified)`;

    // Admins par défaut (créés une seule fois — mots de passe hachés avec scrypt)
    const existing = await sql`SELECT COUNT(*)::int AS n FROM admins`;
    if (existing[0].n === 0) {
      const defaults = [
        { username: 'superadmin', password: 'SuperAdmin123!', role: 'super_admin', name: 'Alexandra Wong' },
        { username: 'admin', password: 'Admin123!', role: 'admin', name: 'Marc Chen' },
        { username: 'support', password: 'Support123!', role: 'support', name: 'Julie Tan' }
      ];
      for (const a of defaults) {
        await sql`
          INSERT INTO admins (id, username, password_hash, role, name)
          VALUES (${uid('ADM-')}, ${a.username}, ${hashPassword(a.password)}, ${a.role}, ${a.name})
          ON CONFLICT (username) DO NOTHING
        `;
      }
    }
  })();
  return schemaReady;
}

// ---------------------------------------------------------------- journal (append-only)
async function logActivity({ adminId = null, adminName = 'Système', role = null, action, detail }) {
  await sql`
    INSERT INTO activity_log (id, admin_id, admin_name, role, action, detail)
    VALUES (${uid('LOG-')}, ${adminId}, ${adminName}, ${role}, ${action}, ${detail || ''})
  `;
}

// ---------------------------------------------------------------- utilitaires réponse
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') { resolve(req.body); return; }
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body));
}
function fail(res, status, error, extra) {
  send(res, status, Object.assign({ ok: false, error }, extra || {}));
}

module.exports = {
  sql, uid, nowIso, hashPassword, verifyPassword, isStrongPassword,
  getClientIp, checkRateLimit, verifyTurnstile, sendEmail,
  generateAccountNumber, generateIBAN, generateTrxRef, generate2FACode,
  createSession, getSession, refreshSession, destroySession, destroyAllUserSessions, destroyAllAdminSessions, getBearerToken,
  createPasswordResetToken, consumePasswordResetToken,
  createEmailVerificationToken, consumeEmailVerificationToken,
  ensureSchema, logActivity, readJsonBody, send, fail
};
