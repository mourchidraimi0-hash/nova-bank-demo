/* ==========================================================================
   NOVA BANK — couche de données (client réseau vers /api/*)
   Toutes les données sont désormais centralisées côté serveur (Vercel
   Functions + Neon Postgres) : chaque inscription, virement ou action admin
   est visible par tous les visiteurs et par le back-office, quel que soit
   le navigateur ou l'appareil utilisé. Seul le jeton de session (bearer
   token) est conservé localement, pour savoir "qui vous êtes" sur cet
   appareil — jamais les données du compte elles-mêmes.
   ========================================================================== */

const DB = (() => {

  const KEYS = {
    TOKEN: 'novabank_token',
    ADMIN_TOKEN: 'novabank_admin_token'
  };

  // ---------------------------------------------------------------- jetons de session
  function getToken() { return localStorage.getItem(KEYS.TOKEN); }
  function setToken(t) { localStorage.setItem(KEYS.TOKEN, t); }
  function clearToken() { localStorage.removeItem(KEYS.TOKEN); }

  function getAdminToken() { return localStorage.getItem(KEYS.ADMIN_TOKEN); }
  function setAdminToken(t) { localStorage.setItem(KEYS.ADMIN_TOKEN, t); }
  function clearAdminToken() { localStorage.removeItem(KEYS.ADMIN_TOKEN); }

  async function api(endpoint, { method = 'POST', body, admin = false, query } = {}) {
    const token = admin ? getAdminToken() : getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    let url = `/api/${endpoint}`;
    if (query) url += '?' + new URLSearchParams(query).toString();
    let res;
    try {
      res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    } catch (e) {
      return { ok: false, error: 'network_error' };
    }
    try { return await res.json(); } catch (e) { return { ok: false, error: 'invalid_response' }; }
  }

  // ---------------------------------------------------------------- utils (purement d'affichage — les références réelles sont générées côté serveur)
  function uid(prefix = '') {
    return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  function nowIso() { return new Date().toISOString(); }
  // Code de confirmation à 6 chiffres généré et vérifié côté navigateur (aucun SMS réel) —
  // utilisé pour la double confirmation visuelle d'un virement avant envoi au serveur.
  function generate2FACode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }
  function formatMoney(amount, currency) {
    const n = Number(amount || 0);
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'EUR' }).format(n);
    } catch (e) {
      return n.toFixed(2) + ' ' + (currency || '');
    }
  }

  // ---------------------------------------------------------------- clients — inscription / connexion
  async function createUser(data) {
    const r = await api('auth', { body: { action: 'signup', ...data } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return { user: r.user, verificationToken: r.verificationToken, emailSent: r.emailSent };
  }

  // Étape 1 : mot de passe. En cas de succès, renvoie { ok:true, requiresTwoFactor:true, userId,
  // emailSent, demoCode? } — aucune session n'est créée avant la vérification du code (étape 2).
  async function login(identifier, password) {
    return api('auth', { body: { action: 'login', identifier, password } });
  }

  // Étape 2 : code de connexion reçu par e-mail (ou affiché à l'écran en secours).
  async function verifyLoginCode(userId, code) {
    const r = await api('auth', { body: { action: 'loginVerify', userId, code } });
    if (!r.ok) return r;
    setToken(r.token);
    return { ok: true, user: r.user };
  }

  async function getCurrentUser() {
    if (!getToken()) return null;
    const r = await api('auth', { method: 'GET', query: { action: 'me' } });
    if (!r.ok) { if (r.error === 'not_authenticated') clearToken(); return null; }
    return r.user;
  }

  function logout() {
    const token = getToken();
    clearToken();
    if (token) {
      fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'logout' })
      }).catch(() => {});
    }
  }

  async function changePassword(userId, currentPassword, newPassword) {
    const r = await api('auth', { body: { action: 'changePassword', currentPassword, newPassword } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  // Démo : aucun serveur d'e-mail réel — le lien de réinitialisation est renvoyé directement
  // pour être affiché à l'écran, sur le même principe que le code 2FA de l'espace admin.
  async function requestPasswordReset(identifier) {
    const r = await api('auth', { body: { action: 'requestPasswordReset', identifier } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return { resetToken: r.resetToken, emailSent: r.emailSent };
  }

  async function resetPassword(token, newPassword) {
    const r = await api('auth', { body: { action: 'resetPassword', token, newPassword } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  // Même principe : jeton réel affiché à l'écran, faute de serveur d'e-mail.
  async function verifyEmail(token) {
    const r = await api('auth', { body: { action: 'verifyEmail', token } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  async function resendVerification() {
    const r = await api('auth', { body: { action: 'resendVerification' } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return { verificationToken: r.verificationToken, emailSent: r.emailSent };
  }

  async function updateProfile(fields) {
    const r = await api('client', { body: { action: 'updateProfile', ...fields } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return getCurrentUser();
  }

  async function requireClientAuth() {
    const user = await getCurrentUser();
    if (!user) { window.location.href = 'connexion.html'; return null; }
    if (user.status === 'suspended') { logout(); window.location.href = 'connexion.html'; return null; }
    return user;
  }

  // ---------------------------------------------------------------- transactions (calcul local à partir des données du compte courant)
  function getAvailableBalance(user) {
    const pending = (user.transactions || [])
      .filter(t => t.type === 'transfer_out' && (t.status === 'pending' || t.status === 'processing'))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    return user.balance - pending;
  }
  function getPendingOutTotal(user) {
    return (user.transactions || [])
      .filter(t => t.type === 'transfer_out' && (t.status === 'pending' || t.status === 'processing'))
      .reduce((sum, t) => sum + Number(t.amount), 0);
  }

  async function markNotificationRead(userId, notifId) {
    await api('client', { body: { action: 'markNotificationRead', id: notifId } });
  }
  async function markAllNotificationsRead() {
    await api('client', { body: { action: 'markAllNotificationsRead' } });
  }

  async function createTransfer(userId, data) {
    const r = await api('client', {
      body: {
        action: 'createTransfer',
        amount: data.amount, beneficiary: data.beneficiary, bankName: data.bankName,
        ibanDest: data.iban, bic: data.bic, reason: data.reason, executionDate: data.executionDate
      }
    });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return { ref: r.ref };
  }

  // ---------------------------------------------------------------- épargne
  function getSavingsGoals(user) { return user.savingsGoals || []; }

  async function createSavingsGoal(userId, { name, targetAmount, icon }) {
    const r = await api('client', { body: { action: 'createSavingsGoal', name, targetAmount, icon } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return getCurrentUser();
  }
  async function contributeToSavingsGoal(userId, goalId, amount) {
    const r = await api('client', { body: { action: 'contributeToSavingsGoal', id: goalId, amount } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return getCurrentUser();
  }
  async function withdrawFromSavingsGoal(userId, goalId, amount) {
    const r = await api('client', { body: { action: 'withdrawFromSavingsGoal', id: goalId, amount } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return getCurrentUser();
  }
  async function deleteSavingsGoal(userId, goalId) {
    const r = await api('client', { body: { action: 'deleteSavingsGoal', id: goalId } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return getCurrentUser();
  }

  // ---------------------------------------------------------------- carte(s)
  function getCards(user) { return user.cards || []; }
  async function toggleCardFreeze(userId, cardId) {
    const r = await api('client', { body: { action: 'toggleCardFreeze', id: cardId } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return getCurrentUser();
  }

  // ---------------------------------------------------------------- admin — connexion (deux étapes : identifiants, puis code affiché à l'écran)
  // Démo : aucun SMS n'est jamais envoyé. Le code est retourné directement par le serveur
  // pour être affiché à l'utilisateur, conformément à l'exigence de transparence totale.
  async function adminLoginStep1(username, password) {
    return api('admin', { body: { action: 'loginStep1', username, password } });
  }
  async function adminLoginStep2(adminId, code) {
    const r = await api('admin', { body: { action: 'loginStep2', adminId, code } });
    if (!r.ok) return r;
    setAdminToken(r.token);
    return r;
  }

  async function getAdminSession() {
    if (!getAdminToken()) return null;
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'me' } });
    if (!r.ok) { if (r.error === 'not_authenticated') clearAdminToken(); return null; }
    return { adminId: r.admin.id, name: r.admin.name, role: r.admin.role };
  }
  const refreshAdminSession = getAdminSession;

  function adminLogout() {
    const token = getAdminToken();
    clearAdminToken();
    if (token) {
      fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'logout' })
      }).catch(() => {});
    }
  }

  async function requireAdminAuth() {
    const session = await getAdminSession();
    if (!session) { window.location.href = 'admin-connexion.html'; return null; }
    return session;
  }

  function roleLabel(role) {
    return { super_admin: 'Super Admin', admin: 'Admin', support: 'Support' }[role] || role;
  }
  function canManageAccounts(role) { return role === 'admin' || role === 'super_admin'; }
  function canManageAdmins(role) { return role === 'super_admin'; }

  // ---------------------------------------------------------------- admin — actions sur les comptes clients
  async function getUserById(id) {
    if (getAdminToken()) {
      const r = await api('admin', { method: 'GET', admin: true, query: { action: 'client', id } });
      return r.ok ? r.client : null;
    }
    const me = await getCurrentUser();
    return (me && me.id === id) ? me : null;
  }

  async function getAllClients({ page = 1, pageSize = 20, q = '', status = 'all' } = {}) {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'clients', page, pageSize, q, status } });
    return r.ok ? { clients: r.clients, total: r.total, page: r.page, pageSize: r.pageSize } : { clients: [], total: 0, page: 1, pageSize };
  }

  async function suspendUser(userId, reason, note) {
    const r = await api('admin', { admin: true, body: { action: 'suspendUser', userId, reason } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    if (note) await addAdminNote(userId, note);
    return true;
  }
  async function reactivateUser(userId) {
    const r = await api('admin', { admin: true, body: { action: 'reactivateUser', userId } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }
  async function activateUser(userId) {
    const r = await api('admin', { admin: true, body: { action: 'activateUser', userId } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }
  async function requestMoreInfo(userId, message) {
    const r = await api('admin', { admin: true, body: { action: 'requestMoreInfo', userId, message } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  // Un motif est systématiquement exigé et journalisé : aucun ajustement de solde silencieux n'est possible.
  async function adjustBalance(userId, type, amount, reason, displayName) {
    if (!reason || !reason.trim()) throw new Error('A reason is required for any balance adjustment.');
    const signed = type === 'credit' ? Math.abs(Number(amount)) : -Math.abs(Number(amount));
    const r = await api('admin', { admin: true, body: { action: 'adjustBalance', userId, amount: signed, reason, displayName } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return { ref: r.ref };
  }

  async function updateTransactionStatus(userId, trxRef, newStatus) {
    const r = await api('admin', { admin: true, body: { action: 'updateTransactionStatus', ref: trxRef, status: newStatus } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  async function addAdminNote(userId, text) {
    const r = await api('admin', { admin: true, body: { action: 'addNote', userId, text } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  // ---------------------------------------------------------------- admin — gestion des comptes admin (super_admin)
  async function getAdmins() {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'admins' } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return r.admins;
  }
  async function createAdmin({ username, password, name, role }) {
    const r = await api('admin', { admin: true, body: { action: 'createAdmin', username, password, name, role } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return { id: r.id };
  }
  async function setAdminActive(adminId, active) {
    const r = await api('admin', { admin: true, body: { action: 'setAdminActive', adminId, active } });
    if (!r.ok) throw new Error(errorMessage(r.error));
    return true;
  }

  // ---------------------------------------------------------------- admin — statistiques et journal
  async function getAllOperations({ page = 1, pageSize = 25, q = '', status = 'all' } = {}) {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'operations', page, pageSize, q, status } });
    return r.ok ? { operations: r.operations, total: r.total, page: r.page, pageSize: r.pageSize } : { operations: [], total: 0, page: 1, pageSize };
  }
  async function getStats() {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'stats' } });
    return r.ok ? r.stats : { totalClients: 0, newClients30d: 0, activeAccounts: 0, suspendedAccounts: 0, pendingKyc: 0, pendingOps: 0, balancesByCurrency: {} };
  }
  async function getSignupSeries(days = 14) {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'signupSeries', days } });
    return r.ok ? { labels: r.labels, counts: r.counts } : { labels: [], counts: [] };
  }
  async function getOpsVolumeSeries(days = 14) {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'opsSeries', days } });
    return r.ok ? { labels: r.labels, counts: r.counts } : { labels: [], counts: [] };
  }
  async function getActivityLog({ page = 1, pageSize = 25, q = '' } = {}) {
    const r = await api('admin', { method: 'GET', admin: true, query: { action: 'journal', page, pageSize, q } });
    return r.ok ? { entries: r.entries, total: r.total, page: r.page, pageSize: r.pageSize } : { entries: [], total: 0, page: 1, pageSize };
  }

  // ---------------------------------------------------------------- messages d'erreur (fr)
  function errorMessage(code) {
    const messages = {
      missing_fields: 'Please fill in all required fields.',
      email_taken: 'This email address is already associated with an account.',
      not_found: 'Account not found.',
      wrong_password: 'Incorrect password.',
      suspended: 'This account is suspended.',
      not_authenticated: 'Your session has expired. Please log in again.',
      insufficient_funds: 'Insufficient available balance.',
      invalid_amount: 'Invalid amount.',
      weak_password: 'Password must be at least 8 characters long, with at least one letter and one digit.',
      rate_limited: 'Too many attempts. Please wait a few minutes before trying again.',
      invalid_token: 'This link is invalid or has already been used. Please start over.',
      account_disabled: 'This admin account has been disabled.',
      forbidden: "You don't have permission to perform this action.",
      username_taken: 'This username is already used by another admin account.',
      invalid_role: 'Invalid role.',
      cannot_modify_self: 'You cannot modify your own account this way.',
      last_super_admin: 'Cannot deactivate the last active Super Admin account.',
      captcha_failed: 'Anti-bot verification failed. Please try again.',
      email_not_verified: "Your email address is not yet confirmed. Confirm it from your dashboard to make a transfer.",
      already_verified: 'Your email address is already confirmed.',
      reason_required: 'A reason is required for this action.',
      invalid_credentials: 'Incorrect credentials.',
      code_expired: 'The code has expired. Please log in again.',
      invalid_code: 'Incorrect code.',
      server_error: 'An error occurred. Please try again.',
      network_error: 'Unable to reach the server. Check your connection.'
    };
    return messages[code] || 'An error occurred.';
  }

  return {
    KEYS, uid, nowIso, generate2FACode, formatMoney,
    createUser, login, verifyLoginCode, getCurrentUser, logout, requireClientAuth, changePassword, updateProfile,
    requestPasswordReset, resetPassword, verifyEmail, resendVerification,
    getAvailableBalance, getPendingOutTotal, markNotificationRead, markAllNotificationsRead, createTransfer,
    getSavingsGoals, createSavingsGoal, contributeToSavingsGoal, withdrawFromSavingsGoal, deleteSavingsGoal,
    getCards, toggleCardFreeze,
    adminLoginStep1, adminLoginStep2, getAdminSession, refreshAdminSession, adminLogout, requireAdminAuth,
    roleLabel, canManageAccounts, canManageAdmins,
    getUserById, getAllClients, suspendUser, reactivateUser, activateUser, requestMoreInfo,
    adjustBalance, updateTransactionStatus, addAdminNote,
    getAdmins, createAdmin, setAdminActive,
    getAllOperations, getStats, getSignupSeries, getOpsVolumeSeries, getActivityLog,
    errorMessage
  };
})();
