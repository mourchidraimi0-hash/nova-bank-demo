/* ==========================================================================
   NOVA BANK — couche de données (localStorage uniquement)
   Aucune donnée n'est jamais envoyée à un serveur.
   ========================================================================== */

const DB = (() => {

  const KEYS = {
    USERS: 'novabank_users',
    SESSION: 'novabank_session',
    ADMINS: 'novabank_admins',
    ADMIN_SESSION: 'novabank_admin_session',
    LOG: 'novabank_activity_log'
  };

  const ADMIN_SESSION_MINUTES = 30;

  // ---------------------------------------------------------------- utils
  function uid(prefix = '') {
    return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function nowIso() { return new Date().toISOString(); }

  async function sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

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

  function formatMoney(amount, currency) {
    const n = Number(amount || 0);
    try {
      return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'EUR' }).format(n);
    } catch (e) {
      return n.toFixed(2) + ' ' + (currency || '');
    }
  }

  // ---------------------------------------------------------------- storage
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  function getUsers() { return readJSON(KEYS.USERS, []); }
  function saveUsers(users) { writeJSON(KEYS.USERS, users); }

  // ---------------------------------------------------------------- activity log (append-only)
  function logActivity(action, detail, adminOverride) {
    const log = readJSON(KEYS.LOG, []);
    const admin = adminOverride || getAdminSession();
    log.push({
      id: uid('LOG-'),
      date: nowIso(),
      adminId: admin ? admin.id : null,
      adminName: admin ? admin.name : 'Système',
      role: admin ? admin.role : null,
      action,
      detail: detail || ''
    });
    writeJSON(KEYS.LOG, log);
  }
  function getActivityLog() {
    return readJSON(KEYS.LOG, []).slice().reverse();
  }

  // ---------------------------------------------------------------- clients
  async function createUser(data) {
    const users = getUsers();
    const passwordHash = await sha256(data.password);
    let cardLast4 = '';
    for (let i = 0; i < 4; i++) cardLast4 += Math.floor(Math.random() * 10);
    const user = {
      id: uid('USR-'),
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      birthDate: data.birthDate,
      address: data.address,
      currency: data.currency || 'EUR',
      passwordHash,
      accountNumber: generateAccountNumber(),
      iban: generateIBAN(),
      balance: 0,
      status: 'active',
      kyc: {
        idPhoto: data.idPhotoMeta || null,
        idDocument: data.idDocumentMeta || null,
        status: (data.idPhotoMeta || data.idDocumentMeta) ? 'submitted' : 'none'
      },
      createdAt: nowIso(),
      lastLogin: null,
      loginHistory: [],
      transactions: [],
      notes: [],
      notifications: [],
      savingsGoals: [],
      cards: [{ id: uid('CARD-'), label: 'Carte principale', last4: cardLast4, frozen: false, createdAt: nowIso() }],
      suspendReason: null,
      termsAccepted: true
    };
    users.push(user);
    saveUsers(users);
    logActivity('inscription_client', `Nouveau compte ${user.accountNumber} (${user.firstName} ${user.lastName})`, { id: null, name: 'Client', role: null });
    return user;
  }

  function findUserByIdentifier(identifier) {
    const id = (identifier || '').trim().toLowerCase();
    return getUsers().find(u =>
      u.id.toLowerCase() === id ||
      u.email.toLowerCase() === id ||
      u.accountNumber.toLowerCase() === id
    ) || null;
  }

  function getUserById(id) {
    const user = getUsers().find(u => u.id === id) || null;
    return user ? backfillUserFields(user) : null;
  }

  // Migration douce : garantit que les comptes créés avant l'ajout des cartes/objectifs d'épargne
  // disposent bien de ces champs, sans jamais écraser des données existantes.
  function backfillUserFields(user) {
    let changed = false;
    if (!user.savingsGoals) { user.savingsGoals = []; changed = true; }
    if (!user.cards) {
      let last4 = '';
      for (let i = 0; i < 4; i++) last4 += Math.floor(Math.random() * 10);
      user.cards = [{ id: uid('CARD-'), label: 'Carte principale', last4, frozen: false, createdAt: nowIso() }];
      changed = true;
    }
    if (changed) updateUser(user);
    return user;
  }

  function updateUser(updated) {
    const users = getUsers();
    const idx = users.findIndex(u => u.id === updated.id);
    if (idx > -1) { users[idx] = updated; saveUsers(users); }
    return updated;
  }

  async function login(identifier, password) {
    const user = findUserByIdentifier(identifier);
    if (!user) return { ok: false, error: 'not_found' };
    if (user.status === 'suspended') return { ok: false, error: 'suspended', reason: user.suspendReason };
    const hash = await sha256(password);
    if (hash !== user.passwordHash) return { ok: false, error: 'wrong_password' };
    user.lastLogin = nowIso();
    user.loginHistory.unshift({ date: nowIso(), userAgent: navigator.userAgent });
    user.loginHistory = user.loginHistory.slice(0, 20);
    updateUser(user);
    writeJSON(KEYS.SESSION, { userId: user.id });
    return { ok: true, user };
  }

  function getCurrentUser() {
    const session = readJSON(KEYS.SESSION, null);
    if (!session) return null;
    return getUserById(session.userId);
  }

  function logout() { localStorage.removeItem(KEYS.SESSION); }

  async function changePassword(userId, currentPassword, newPassword) {
    const user = getUserById(userId);
    if (!user) throw new Error('Compte introuvable.');
    const hash = await sha256(currentPassword);
    if (hash !== user.passwordHash) throw new Error('Mot de passe actuel incorrect.');
    user.passwordHash = await sha256(newPassword);
    updateUser(user);
    addNotification(user, 'Votre mot de passe a été modifié avec succès.', 'success');
    logActivity('changement_mot_de_passe', `${user.firstName} ${user.lastName} a changé son mot de passe`, { id: null, name: 'Client', role: null });
    return true;
  }

  function requireClientAuth() {
    const user = getCurrentUser();
    if (!user) { window.location.href = 'connexion.html'; return null; }
    if (user.status === 'suspended') { logout(); window.location.href = 'connexion.html'; return null; }
    return user;
  }

  // ---------------------------------------------------------------- transactions
  function getAvailableBalance(user) {
    const pending = user.transactions
      .filter(t => t.type === 'transfer_out' && (t.status === 'pending' || t.status === 'processing'))
      .reduce((sum, t) => sum + Number(t.amount), 0);
    return user.balance - pending;
  }
  function getPendingOutTotal(user) {
    return user.transactions
      .filter(t => t.type === 'transfer_out' && (t.status === 'pending' || t.status === 'processing'))
      .reduce((sum, t) => sum + Number(t.amount), 0);
  }

  function addNotification(user, message, type) {
    user.notifications.unshift({ id: uid('NOTIF-'), message, type: type || 'info', date: nowIso(), read: false });
    updateUser(user);
  }

  function markNotificationRead(userId, notifId) {
    const user = getUserById(userId);
    if (!user) return;
    const n = user.notifications.find(x => x.id === notifId);
    if (n) n.read = true;
    updateUser(user);
  }

  function createTransfer(userId, data) {
    const user = getUserById(userId);
    if (!user) return null;
    const trx = {
      ref: generateTrxRef(),
      type: 'transfer_out',
      description: `Virement vers ${data.beneficiary}`,
      beneficiary: data.beneficiary,
      bankName: data.bankName,
      ibanDest: data.iban,
      bic: data.bic,
      amount: Number(data.amount),
      currency: data.currency,
      reason: data.reason,
      executionDate: data.executionDate,
      status: 'pending',
      settled: false,
      adminName: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    user.transactions.unshift(trx);
    updateUser(user);
    logActivity('virement_initie', `${user.firstName} ${user.lastName} — ${trx.ref} — ${formatMoney(trx.amount, trx.currency)} vers ${trx.beneficiary}`, { id: null, name: 'Client', role: null });
    return trx;
  }

  // ---------------------------------------------------------------- épargne
  // Les objectifs d'épargne sont une simple réserve interne : mettre de côté débite
  // réellement le solde disponible du compte (mouvement interne, réglé immédiatement,
  // jamais soumis à validation admin puisqu'aucun tiers n'est impliqué).
  function getSavingsGoals(user) { return user.savingsGoals || []; }

  function createSavingsGoal(userId, { name, targetAmount, icon }) {
    const user = getUserById(userId);
    if (!user) return null;
    const goal = {
      id: uid('GOAL-'), name, targetAmount: Number(targetAmount), currentAmount: 0,
      icon: icon || 'fa-piggy-bank', createdAt: nowIso()
    };
    if (!user.savingsGoals) user.savingsGoals = [];
    user.savingsGoals.push(goal);
    updateUser(user);
    logActivity('objectif_epargne_cree', `${user.firstName} ${user.lastName} a créé l'objectif « ${name} » (${formatMoney(goal.targetAmount, user.currency)})`, { id: null, name: 'Client', role: null });
    return goal;
  }

  function contributeToSavingsGoal(userId, goalId, amount) {
    const user = getUserById(userId);
    if (!user) return null;
    const goal = (user.savingsGoals || []).find(g => g.id === goalId);
    if (!goal) return null;
    const amt = Number(amount);
    if (amt <= 0 || amt > getAvailableBalance(user)) throw new Error('Montant invalide ou solde disponible insuffisant.');
    user.balance -= amt;
    goal.currentAmount += amt;
    const trx = {
      ref: generateTrxRef(), type: 'debit', description: `Mise de côté — Objectif « ${goal.name} »`,
      amount: amt, currency: user.currency, status: 'confirmed', settled: true, adminName: null,
      createdAt: nowIso(), updatedAt: nowIso()
    };
    user.transactions.unshift(trx);
    updateUser(user);
    logActivity('epargne_contribution', `${user.firstName} ${user.lastName} a mis de côté ${formatMoney(amt, user.currency)} sur « ${goal.name} »`, { id: null, name: 'Client', role: null });
    return goal;
  }

  function withdrawFromSavingsGoal(userId, goalId, amount) {
    const user = getUserById(userId);
    if (!user) return null;
    const goal = (user.savingsGoals || []).find(g => g.id === goalId);
    if (!goal) return null;
    const amt = Number(amount);
    if (amt <= 0 || amt > goal.currentAmount) throw new Error('Montant invalide.');
    user.balance += amt;
    goal.currentAmount -= amt;
    const trx = {
      ref: generateTrxRef(), type: 'credit', description: `Retrait — Objectif « ${goal.name} »`,
      amount: amt, currency: user.currency, status: 'confirmed', settled: true, adminName: null,
      createdAt: nowIso(), updatedAt: nowIso()
    };
    user.transactions.unshift(trx);
    updateUser(user);
    logActivity('epargne_retrait', `${user.firstName} ${user.lastName} a récupéré ${formatMoney(amt, user.currency)} depuis « ${goal.name} »`, { id: null, name: 'Client', role: null });
    return goal;
  }

  function deleteSavingsGoal(userId, goalId) {
    const user = getUserById(userId);
    if (!user) return;
    const goal = (user.savingsGoals || []).find(g => g.id === goalId);
    if (!goal) return;
    if (goal.currentAmount > 0) user.balance += goal.currentAmount;
    user.savingsGoals = user.savingsGoals.filter(g => g.id !== goalId);
    updateUser(user);
    logActivity('objectif_epargne_supprime', `${user.firstName} ${user.lastName} a supprimé l'objectif « ${goal.name} »`, { id: null, name: 'Client', role: null });
  }

  // ---------------------------------------------------------------- carte(s)
  function getCards(user) { return user.cards || []; }

  function toggleCardFreeze(userId, cardId) {
    const user = getUserById(userId);
    if (!user) return null;
    const card = (user.cards || []).find(c => c.id === cardId);
    if (!card) return null;
    card.frozen = !card.frozen;
    updateUser(user);
    logActivity('carte_gel', `${user.firstName} ${user.lastName} a ${card.frozen ? 'gelé' : 'dégelé'} sa carte ${card.label}`, { id: null, name: 'Client', role: null });
    return card;
  }

  // ---------------------------------------------------------------- admin — accounts
  const DEFAULT_ADMINS = [
    { username: 'superadmin', password: 'SuperAdmin123!', role: 'super_admin', name: 'Alexandra Wong' },
    { username: 'admin', password: 'Admin123!', role: 'admin', name: 'Marc Chen' },
    { username: 'support', password: 'Support123!', role: 'support', name: 'Julie Tan' }
  ];

  async function ensureDefaultAdmins() {
    let admins = readJSON(KEYS.ADMINS, []);
    if (admins.length) return admins;
    admins = [];
    for (const a of DEFAULT_ADMINS) {
      admins.push({
        id: uid('ADM-'),
        username: a.username,
        passwordHash: await sha256(a.password),
        role: a.role,
        name: a.name,
        createdAt: nowIso()
      });
    }
    writeJSON(KEYS.ADMINS, admins);
    return admins;
  }

  function getAdmins() { return readJSON(KEYS.ADMINS, []); }
  function saveAdmins(list) { writeJSON(KEYS.ADMINS, list); }

  async function adminLogin(username, password) {
    const admins = getAdmins();
    const admin = admins.find(a => a.username.toLowerCase() === (username || '').trim().toLowerCase());
    if (!admin) return { ok: false, error: 'not_found' };
    const hash = await sha256(password);
    if (hash !== admin.passwordHash) return { ok: false, error: 'wrong_password' };
    return { ok: true, admin };
  }

  function startAdminSession(admin) {
    const session = {
      adminId: admin.id, name: admin.name, role: admin.role, username: admin.username,
      expiresAt: Date.now() + ADMIN_SESSION_MINUTES * 60000
    };
    writeJSON(KEYS.ADMIN_SESSION, session);
    logActivity('connexion_admin', `Connexion de ${admin.name} (${roleLabel(admin.role)})`, { id: admin.id, name: admin.name, role: admin.role });
    return session;
  }

  function getAdminSession() {
    const s = readJSON(KEYS.ADMIN_SESSION, null);
    if (!s) return null;
    if (Date.now() > s.expiresAt) { localStorage.removeItem(KEYS.ADMIN_SESSION); return null; }
    return s;
  }

  function refreshAdminSession() {
    const s = readJSON(KEYS.ADMIN_SESSION, null);
    if (!s) return null;
    if (Date.now() > s.expiresAt) { localStorage.removeItem(KEYS.ADMIN_SESSION); return null; }
    s.expiresAt = Date.now() + ADMIN_SESSION_MINUTES * 60000;
    writeJSON(KEYS.ADMIN_SESSION, s);
    return s;
  }

  function adminLogout() {
    const s = getAdminSession();
    if (s) logActivity('deconnexion_admin', `Déconnexion de ${s.name}`, s);
    localStorage.removeItem(KEYS.ADMIN_SESSION);
  }

  function requireAdminAuth() {
    const s = getAdminSession();
    if (!s) { window.location.href = 'admin-connexion.html'; return null; }
    return s;
  }

  function roleLabel(role) {
    return { super_admin: 'Super Admin', admin: 'Admin', support: 'Support' }[role] || role;
  }
  function canManageAccounts(role) { return role === 'admin' || role === 'super_admin'; }
  function canManageAdmins(role) { return role === 'super_admin'; }

  // ---------------------------------------------------------------- admin — client account actions
  function suspendUser(userId, reason, note) {
    const admin = getAdminSession();
    const user = getUserById(userId);
    if (!user) return;
    user.status = 'suspended';
    user.suspendReason = reason;
    updateUser(user);
    addNotification(user, `Votre compte a été suspendu. Motif : ${reason}`, 'danger');
    if (note) addAdminNote(userId, note);
    logActivity('suspension_compte', `Compte ${user.accountNumber} (${user.firstName} ${user.lastName}) suspendu — motif : ${reason}`);
  }

  function reactivateUser(userId) {
    const user = getUserById(userId);
    if (!user) return;
    user.status = 'active';
    user.suspendReason = null;
    updateUser(user);
    addNotification(user, 'Votre compte a été réactivé. Vous pouvez de nouveau accéder à votre espace client.', 'success');
    logActivity('reactivation_compte', `Compte ${user.accountNumber} (${user.firstName} ${user.lastName}) réactivé`);
  }

  function activateUser(userId) {
    const user = getUserById(userId);
    if (!user) return;
    user.status = 'active';
    user.suspendReason = null;
    updateUser(user);
    addNotification(user, 'Votre compte a été activé.', 'success');
    logActivity('activation_compte', `Compte ${user.accountNumber} (${user.firstName} ${user.lastName}) activé`);
  }

  function requestMoreInfo(userId, message) {
    const user = getUserById(userId);
    if (!user) return;
    user.status = 'pending_info';
    updateUser(user);
    addNotification(user, `Informations complémentaires demandées : ${message}`, 'warn');
    logActivity('demande_informations', `Demande d'informations à ${user.firstName} ${user.lastName} : ${message}`);
  }

  function adjustBalance(userId, type, amount, reason) {
    if (!reason || !reason.trim()) throw new Error('Un motif est obligatoire pour tout ajustement de solde.');
    const admin = getAdminSession();
    const user = getUserById(userId);
    if (!user) return null;
    const amt = Number(amount);
    const ref = generateTrxRef();
    if (type === 'credit') user.balance += amt;
    else user.balance -= amt;
    const trx = {
      ref, type: type === 'credit' ? 'credit' : 'debit',
      description: reason,
      amount: amt, currency: user.currency,
      status: 'confirmed', settled: true,
      adminName: admin ? admin.name : 'Administrateur',
      createdAt: nowIso(), updatedAt: nowIso()
    };
    user.transactions.unshift(trx);
    updateUser(user);
    addNotification(user, `Votre solde a été ${type === 'credit' ? 'crédité' : 'débité'} de ${formatMoney(amt, user.currency)} — ${reason}`, 'info');
    logActivity('ajustement_solde', `${type === 'credit' ? 'Crédit' : 'Débit'} de ${formatMoney(amt, user.currency)} sur le compte ${user.accountNumber} — motif : ${reason} — réf ${ref}`);
    return trx;
  }

  function updateTransactionStatus(userId, trxRef, newStatus) {
    const admin = getAdminSession();
    const user = getUserById(userId);
    if (!user) return null;
    const trx = user.transactions.find(t => t.ref === trxRef);
    if (!trx) return null;
    const oldStatus = trx.status;
    trx.status = newStatus;
    trx.updatedAt = nowIso();

    if (newStatus === 'confirmed' && !trx.settled && trx.type === 'transfer_out') {
      user.balance -= Number(trx.amount);
      trx.settled = true;
      addNotification(user, `Votre virement ${trx.ref} de ${formatMoney(trx.amount, trx.currency)} vers ${trx.beneficiary} a été confirmé et débité de votre compte.`, 'success');
    } else if ((newStatus === 'rejected' || newStatus === 'cancelled') && oldStatus !== newStatus) {
      if (trx.type === 'transfer_out') {
        addNotification(user, `Votre virement ${trx.ref} de ${formatMoney(trx.amount, trx.currency)} vers ${trx.beneficiary} a été ${newStatus === 'rejected' ? 'rejeté' : 'annulé'}. ${trx.settled ? "Le montant déjà débité vous a été recrédité." : "Aucun montant n'a été débité."}`, 'warn');
      } else {
        addNotification(user, `L'opération ${trx.ref} (${trx.description}) a été ${newStatus === 'rejected' ? 'rejetée' : 'annulée'} et son effet sur votre solde a été annulé.`, 'warn');
      }
      if (trx.settled) {
        // Un crédit avait augmenté le solde : l'annulation le diminue. Un débit/virement avait diminué le solde : l'annulation le recrédite.
        if (trx.type === 'credit') user.balance -= Number(trx.amount);
        else user.balance += Number(trx.amount);
        trx.settled = false;
      }
    } else if (newStatus === 'processing') {
      addNotification(user, `Votre virement ${trx.ref} est en cours de traitement par nos équipes.`, 'info');
    }
    updateUser(user);
    logActivity('changement_statut_operation', `Opération ${trx.ref} (${user.firstName} ${user.lastName}) : ${oldStatus} → ${newStatus}`);
    return trx;
  }

  function addAdminNote(userId, text) {
    const admin = getAdminSession();
    const user = getUserById(userId);
    if (!user) return;
    user.notes.unshift({ author: admin ? admin.name : 'Administrateur', role: admin ? admin.role : null, text, date: nowIso() });
    updateUser(user);
    logActivity('note_ajoutee', `Note ajoutée sur le compte ${user.accountNumber} (${user.firstName} ${user.lastName})`);
  }

  // ---------------------------------------------------------------- admin — stats
  function getAllOperations() {
    const ops = [];
    getUsers().forEach(u => {
      u.transactions.forEach(t => ops.push({ ...t, userId: u.id, clientName: `${u.firstName} ${u.lastName}`, accountNumber: u.accountNumber }));
    });
    return ops.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function getStats() {
    const users = getUsers();
    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    const balancesByCurrency = {};
    users.forEach(u => { balancesByCurrency[u.currency] = (balancesByCurrency[u.currency] || 0) + u.balance; });
    const ops = getAllOperations();
    return {
      totalClients: users.length,
      newClients30d: users.filter(u => new Date(u.createdAt).getTime() >= thirtyDaysAgo).length,
      activeAccounts: users.filter(u => u.status === 'active').length,
      suspendedAccounts: users.filter(u => u.status === 'suspended').length,
      pendingKyc: users.filter(u => u.kyc && u.kyc.status === 'submitted').length,
      pendingOps: ops.filter(o => o.status === 'pending' || o.status === 'processing').length,
      balancesByCurrency
    };
  }

  function getSignupSeries(days = 14) {
    const users = getUsers();
    const labels = [], counts = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      labels.push(d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
      counts.push(users.filter(u => { const c = new Date(u.createdAt); return c >= d && c < next; }).length);
    }
    return { labels, counts };
  }

  function getOpsVolumeSeries(days = 14) {
    const ops = getAllOperations();
    const labels = [], counts = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      labels.push(d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
      counts.push(ops.filter(o => { const c = new Date(o.createdAt); return c >= d && c < next; }).length);
    }
    return { labels, counts };
  }

  return {
    KEYS, uid, nowIso, sha256, generateAccountNumber, generateIBAN, generateTrxRef, generate2FACode, formatMoney,
    getUsers, saveUsers, createUser, findUserByIdentifier, getUserById, updateUser,
    login, getCurrentUser, logout, requireClientAuth, changePassword,
    getAvailableBalance, getPendingOutTotal, addNotification, markNotificationRead, createTransfer,
    getSavingsGoals, createSavingsGoal, contributeToSavingsGoal, withdrawFromSavingsGoal, deleteSavingsGoal,
    getCards, toggleCardFreeze,
    ensureDefaultAdmins, getAdmins, saveAdmins, adminLogin, startAdminSession, getAdminSession,
    refreshAdminSession, adminLogout, requireAdminAuth, roleLabel, canManageAccounts, canManageAdmins,
    suspendUser, reactivateUser, activateUser, requestMoreInfo, adjustBalance, updateTransactionStatus, addAdminNote,
    getAllOperations, getStats, getSignupSeries, getOpsVolumeSeries, logActivity, getActivityLog
  };
})();
