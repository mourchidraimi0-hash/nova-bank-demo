const {
  sql, uid, hashPassword, verifyPassword, generate2FACode, generateTrxRef,
  getClientIp, checkRateLimit,
  createSession, getSession, refreshSession, destroySession, getBearerToken,
  ensureSchema, logActivity, readJsonBody, send, fail
} = require('./_lib/db');

// Codes 2FA stockés en base (table pending_2fa) — les instances serverless ne sont pas garanties
// stables entre deux requêtes. Le code est aussi renvoyé au client pour affichage à l'écran :
// aucun SMS réel n'est envoyé, conformément aux exigences de transparence de la démo.

function serializeTransaction(t) {
  return {
    ref: t.ref, type: t.type, description: t.description, amount: Number(t.amount), currency: t.currency,
    status: t.status, settled: t.settled, adminName: t.admin_name, beneficiary: t.beneficiary,
    bankName: t.bank_name, ibanDest: t.iban_dest, bic: t.bic, reason: t.reason, executionDate: t.execution_date,
    createdAt: t.created_at, updatedAt: t.updated_at, userId: t.user_id
  };
}

async function serializeClient(row) {
  const [transactions, notes, cards] = await Promise.all([
    sql`SELECT * FROM transactions WHERE user_id = ${row.id} ORDER BY created_at DESC`,
    sql`SELECT * FROM notes WHERE user_id = ${row.id} ORDER BY date DESC`,
    sql`SELECT * FROM cards WHERE user_id = ${row.id} ORDER BY created_at ASC`
  ]);
  return {
    id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
    birthDate: row.birth_date, address: row.address, currency: row.currency, accountNumber: row.account_number,
    iban: row.iban, balance: Number(row.balance), status: row.status, suspendReason: row.suspend_reason,
    kyc: { idPhoto: row.kyc_id_photo, idDocument: row.kyc_id_document, status: row.kyc_status },
    createdAt: row.created_at, lastLogin: row.last_login,
    transactions: transactions.map(serializeTransaction),
    notes: notes.map(n => ({ author: n.author, role: n.role, text: n.text, date: n.date })),
    cards: cards.map(c => ({ id: c.id, label: c.label, last4: c.last4, frozen: c.frozen, createdAt: c.created_at }))
  };
}

function parsePaging(req, defaultPageSize = 20) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function requireAdmin(req) {
  const token = getBearerToken(req);
  const session = await getSession(token);
  if (!session || !session.is_admin) return null;
  await refreshSession(token, true);
  return session;
}

module.exports = async (req, res) => {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const action = req.query.action;
      const session = await requireAdmin(req);
      if (!session) return fail(res, 401, 'not_authenticated');

      if (action === 'me') {
        return send(res, 200, { ok: true, admin: { id: session.admin_id, role: session.role, name: session.name } });
      }
      if (action === 'stats') {
        const [totalClients, newClients30d, activeAccounts, suspendedAccounts, pendingKyc, pendingOps, balances] = await Promise.all([
          sql`SELECT COUNT(*)::int AS n FROM users`,
          sql`SELECT COUNT(*)::int AS n FROM users WHERE created_at > now() - interval '30 days'`,
          sql`SELECT COUNT(*)::int AS n FROM users WHERE status = 'active'`,
          sql`SELECT COUNT(*)::int AS n FROM users WHERE status = 'suspended'`,
          sql`SELECT COUNT(*)::int AS n FROM users WHERE kyc_status = 'submitted'`,
          sql`SELECT COUNT(*)::int AS n FROM transactions WHERE status IN ('pending', 'processing')`,
          sql`SELECT currency, SUM(balance)::float AS total FROM users GROUP BY currency`
        ]);
        const balancesByCurrency = {};
        balances.forEach(b => { balancesByCurrency[b.currency] = b.total; });
        return send(res, 200, {
          ok: true,
          stats: {
            totalClients: totalClients[0].n, newClients30d: newClients30d[0].n,
            activeAccounts: activeAccounts[0].n, suspendedAccounts: suspendedAccounts[0].n,
            pendingKyc: pendingKyc[0].n, pendingOps: pendingOps[0].n, balancesByCurrency
          }
        });
      }
      if (action === 'signupSeries' || action === 'opsSeries') {
        const days = Math.min(90, Number(req.query.days) || 14);
        const rows = action === 'signupSeries'
          ? await sql`
              SELECT to_char(d.day, 'DD/MM') AS label, COUNT(u.*)::int AS count
              FROM generate_series(current_date - (${days - 1}::int), current_date, interval '1 day') AS d(day)
              LEFT JOIN users u ON date_trunc('day', u.created_at) = d.day
              GROUP BY d.day ORDER BY d.day
            `
          : await sql`
              SELECT to_char(d.day, 'DD/MM') AS label, COUNT(t.*)::int AS count
              FROM generate_series(current_date - (${days - 1}::int), current_date, interval '1 day') AS d(day)
              LEFT JOIN transactions t ON date_trunc('day', t.created_at) = d.day
              GROUP BY d.day ORDER BY d.day
            `;
        return send(res, 200, { ok: true, labels: rows.map(r => r.label), counts: rows.map(r => r.count) });
      }
      if (action === 'clients') {
        const { page, pageSize, offset } = parsePaging(req);
        const q = (req.query.q || '').trim();
        const qLike = `%${q}%`;
        const status = req.query.status || 'all';
        const [countRows, rows] = await Promise.all([
          sql`
            SELECT COUNT(*)::int AS n FROM users
            WHERE (${q} = '' OR first_name ILIKE ${qLike} OR last_name ILIKE ${qLike} OR email ILIKE ${qLike} OR account_number ILIKE ${qLike} OR id ILIKE ${qLike})
              AND (${status} = 'all' OR status = ${status})
          `,
          sql`
            SELECT * FROM users
            WHERE (${q} = '' OR first_name ILIKE ${qLike} OR last_name ILIKE ${qLike} OR email ILIKE ${qLike} OR account_number ILIKE ${qLike} OR id ILIKE ${qLike})
              AND (${status} = 'all' OR status = ${status})
            ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}
          `
        ]);
        return send(res, 200, { ok: true, clients: await Promise.all(rows.map(serializeClient)), total: countRows[0].n, page, pageSize });
      }
      if (action === 'client') {
        const rows = await sql`SELECT * FROM users WHERE id = ${req.query.id} LIMIT 1`;
        if (!rows[0]) return fail(res, 404, 'not_found');
        return send(res, 200, { ok: true, client: await serializeClient(rows[0]) });
      }
      if (action === 'operations') {
        const { page, pageSize, offset } = parsePaging(req, 25);
        const q = (req.query.q || '').trim();
        const qLike = `%${q}%`;
        const status = req.query.status || 'all';
        const [countRows, rows] = await Promise.all([
          sql`
            SELECT COUNT(*)::int AS n FROM transactions t JOIN users u ON u.id = t.user_id
            WHERE (${status} = 'all' OR t.status = ${status})
              AND (${q} = '' OR t.ref ILIKE ${qLike} OR t.beneficiary ILIKE ${qLike} OR u.first_name ILIKE ${qLike} OR u.last_name ILIKE ${qLike})
          `,
          sql`
            SELECT t.*, u.first_name, u.last_name, u.account_number FROM transactions t
            JOIN users u ON u.id = t.user_id
            WHERE (${status} = 'all' OR t.status = ${status})
              AND (${q} = '' OR t.ref ILIKE ${qLike} OR t.beneficiary ILIKE ${qLike} OR u.first_name ILIKE ${qLike} OR u.last_name ILIKE ${qLike})
            ORDER BY t.created_at DESC LIMIT ${pageSize} OFFSET ${offset}
          `
        ]);
        return send(res, 200, {
          ok: true,
          operations: rows.map(r => ({ ...serializeTransaction(r), clientName: `${r.first_name} ${r.last_name}`, accountNumber: r.account_number })),
          total: countRows[0].n, page, pageSize
        });
      }
      if (action === 'journal') {
        const { page, pageSize, offset } = parsePaging(req, 25);
        const q = (req.query.q || '').trim();
        const qLike = `%${q}%`;
        const [countRows, rows] = await Promise.all([
          sql`SELECT COUNT(*)::int AS n FROM activity_log WHERE (${q} = '' OR action ILIKE ${qLike} OR detail ILIKE ${qLike} OR admin_name ILIKE ${qLike})`,
          sql`
            SELECT * FROM activity_log
            WHERE (${q} = '' OR action ILIKE ${qLike} OR detail ILIKE ${qLike} OR admin_name ILIKE ${qLike})
            ORDER BY date DESC LIMIT ${pageSize} OFFSET ${offset}
          `
        ]);
        return send(res, 200, {
          ok: true,
          entries: rows.map(r => ({ id: r.id, date: r.date, adminId: r.admin_id, adminName: r.admin_name, role: r.role, action: r.action, detail: r.detail })),
          total: countRows[0].n, page, pageSize
        });
      }
      return fail(res, 400, 'unknown_action');
    }

    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const body = await readJsonBody(req);
    const action = body.action;

    // ---------------------------------------------------------------- connexion (étape 1 : identifiants -> code 2FA affiché à l'écran)
    if (action === 'loginStep1') {
      const allowed = await checkRateLimit({ key: `admin_login:${getClientIp(req)}`, max: 5, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { username, password } = body;
      if (!username || !password) return fail(res, 400, 'missing_fields');
      const rows = await sql`SELECT * FROM admins WHERE lower(username) = lower(${username}) LIMIT 1`;
      const admin = rows[0];
      if (!admin || !verifyPassword(password, admin.password_hash)) return fail(res, 401, 'invalid_credentials');
      const code = generate2FACode();
      const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
      await sql`
        INSERT INTO pending_2fa (admin_id, code, expires_at) VALUES (${admin.id}, ${code}, ${expiresAt})
        ON CONFLICT (admin_id) DO UPDATE SET code = ${code}, expires_at = ${expiresAt}
      `;
      // Démo : aucun SMS réel n'est envoyé. Le code est renvoyé directement pour affichage à l'écran.
      return send(res, 200, { ok: true, adminId: admin.id, demoCode: code });
    }

    // ---------------------------------------------------------------- connexion (étape 2 : validation du code)
    if (action === 'loginStep2') {
      const allowed = await checkRateLimit({ key: `admin_2fa:${getClientIp(req)}`, max: 8, windowMinutes: 5 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { adminId, code } = body;
      const pendingRows = await sql`SELECT * FROM pending_2fa WHERE admin_id = ${adminId} LIMIT 1`;
      const pending = pendingRows[0];
      if (!pending || new Date(pending.expires_at).getTime() < Date.now()) return fail(res, 401, 'code_expired');
      if (pending.code !== String(code).trim()) return fail(res, 401, 'invalid_code');
      await sql`DELETE FROM pending_2fa WHERE admin_id = ${adminId}`;
      const adminRows = await sql`SELECT * FROM admins WHERE id = ${adminId} LIMIT 1`;
      const admin = adminRows[0];
      if (!admin) return fail(res, 404, 'not_found');
      const { token } = await createSession({ isAdmin: true, adminId: admin.id, role: admin.role, name: admin.name });
      await logActivity({ adminId: admin.id, adminName: admin.name, role: admin.role, action: 'connexion_admin', detail: `Connexion de ${admin.name}` });
      return send(res, 200, { ok: true, token, admin: { id: admin.id, role: admin.role, name: admin.name } });
    }

    if (action === 'logout') {
      const session = await requireAdmin(req);
      if (session) await logActivity({ adminId: session.admin_id, adminName: session.name, role: session.role, action: 'deconnexion_admin', detail: `Déconnexion de ${session.name}` });
      await destroySession(getBearerToken(req));
      return send(res, 200, { ok: true });
    }

    // Tout le reste exige une session admin active
    const session = await requireAdmin(req);
    if (!session) return fail(res, 401, 'not_authenticated');
    const actorName = session.name, actorRole = session.role, actorId = session.admin_id;

    if (action === 'suspendUser' || action === 'reactivateUser' || action === 'activateUser') {
      const { userId, reason } = body;
      if (action === 'suspendUser' && !reason) return fail(res, 400, 'reason_required');
      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows[0]) return fail(res, 404, 'not_found');
      const status = action === 'suspendUser' ? 'suspended' : 'active';
      await sql`UPDATE users SET status = ${status}, suspend_reason = ${action === 'suspendUser' ? reason : null} WHERE id = ${userId}`;
      const actionKey = action === 'suspendUser' ? 'suspension_compte' : action === 'reactivateUser' ? 'reactivation_compte' : 'activation_compte';
      const detail = action === 'suspendUser' ? `Compte ${rows[0].account_number} suspendu — motif : ${reason}` : `Compte ${rows[0].account_number} ${action === 'reactivateUser' ? 'réactivé' : 'activé'}`;
      await logActivity({ adminId: actorId, adminName: actorName, role: actorRole, action: actionKey, detail });
      return send(res, 200, { ok: true });
    }

    if (action === 'requestMoreInfo') {
      const { userId, message } = body;
      if (!message) return fail(res, 400, 'missing_fields');
      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      if (!rows[0]) return fail(res, 404, 'not_found');
      await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${userId}, ${message}, 'warning')`;
      await sql`INSERT INTO notes (user_id, author, role, text) VALUES (${userId}, ${actorName}, ${actorRole}, ${'Demande d\'informations envoyée : ' + message})`;
      await logActivity({ adminId: actorId, adminName: actorName, role: actorRole, action: 'demande_informations', detail: `À ${rows[0].account_number} : ${message}` });
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- ajustement de solde (motif obligatoire, jamais silencieux, journalisé)
    if (action === 'adjustBalance') {
      const { userId, amount, reason } = body;
      const amt = Number(amount);
      if (!amt || amt === 0) return fail(res, 400, 'invalid_amount');
      if (!reason || !reason.trim()) return fail(res, 400, 'reason_required');
      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) return fail(res, 404, 'not_found');

      const ref = generateTrxRef();
      await sql`UPDATE users SET balance = balance + ${amt} WHERE id = ${userId}`;
      await sql`
        INSERT INTO transactions (ref, user_id, type, description, amount, currency, status, settled, admin_name, reason)
        VALUES (${ref}, ${userId}, ${amt > 0 ? 'credit' : 'debit'}, ${reason}, ${Math.abs(amt)}, ${user.currency}, 'confirmed', true, ${actorName}, ${reason})
      `;
      await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${userId}, ${(amt > 0 ? 'Votre compte a été crédité de ' : 'Votre compte a été débité de ') + Math.abs(amt) + ' ' + user.currency + '. Motif : ' + reason}, 'info')`;
      await logActivity({ adminId: actorId, adminName: actorName, role: actorRole, action: 'ajustement_solde', detail: `${ref} — ${amt > 0 ? '+' : ''}${amt} ${user.currency} sur ${user.account_number} — motif : ${reason}` });
      return send(res, 200, { ok: true, ref });
    }

    if (action === 'addNote') {
      const { userId, text } = body;
      if (!text || !text.trim()) return fail(res, 400, 'missing_fields');
      await sql`INSERT INTO notes (user_id, author, role, text) VALUES (${userId}, ${actorName}, ${actorRole}, ${text})`;
      await logActivity({ adminId: actorId, adminName: actorName, role: actorRole, action: 'note_ajoutee', detail: `Note ajoutée sur le client ${userId}` });
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- statut d'opération (règlement / rejet — réversion cohérente selon le type)
    if (action === 'updateTransactionStatus') {
      const { ref, status: newStatus } = body;
      const rows = await sql`SELECT * FROM transactions WHERE ref = ${ref} LIMIT 1`;
      const trx = rows[0];
      if (!trx) return fail(res, 404, 'not_found');
      const userRows = await sql`SELECT * FROM users WHERE id = ${trx.user_id} LIMIT 1`;
      const user = userRows[0];
      const amt = Number(trx.amount);
      const oldStatus = trx.status;
      let settled = trx.settled;

      if (newStatus === 'confirmed' && !trx.settled && trx.type === 'transfer_out') {
        await sql`UPDATE users SET balance = balance - ${amt} WHERE id = ${trx.user_id}`;
        settled = true;
        await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${trx.user_id}, ${`Votre virement ${ref} de ${amt} ${trx.currency} vers ${trx.beneficiary} a été confirmé et débité de votre compte.`}, 'success')`;
      } else if ((newStatus === 'rejected' || newStatus === 'cancelled') && oldStatus !== newStatus) {
        const verb = newStatus === 'rejected' ? 'rejeté' : 'annulé';
        const message = trx.type === 'transfer_out'
          ? `Votre virement ${ref} de ${amt} ${trx.currency} vers ${trx.beneficiary} a été ${verb}. ${trx.settled ? 'Le montant déjà débité vous a été recrédité.' : "Aucun montant n'a été débité."}`
          : `L'opération ${ref} (${trx.description}) a été ${newStatus === 'rejected' ? 'rejetée' : 'annulée'} et son effet sur votre solde a été annulé.`;
        await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${trx.user_id}, ${message}, 'warning')`;
        if (trx.settled) {
          // Un crédit avait augmenté le solde : l'annulation le diminue. Un débit/virement avait diminué le solde : l'annulation le recrédite.
          if (trx.type === 'credit') await sql`UPDATE users SET balance = balance - ${amt} WHERE id = ${trx.user_id}`;
          else await sql`UPDATE users SET balance = balance + ${amt} WHERE id = ${trx.user_id}`;
          settled = false;
        }
      } else if (newStatus === 'processing') {
        await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${trx.user_id}, ${`Votre virement ${ref} est en cours de traitement par nos équipes.`}, 'info')`;
      }

      await sql`UPDATE transactions SET status = ${newStatus}, settled = ${settled}, updated_at = now() WHERE ref = ${ref}`;
      await logActivity({ adminId: actorId, adminName: actorName, role: actorRole, action: 'changement_statut_operation', detail: `Opération ${ref} (${user.first_name} ${user.last_name}) : ${oldStatus} → ${newStatus}` });
      return send(res, 200, { ok: true });
    }

    return fail(res, 400, 'unknown_action');
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'server_error', { message: err.message });
  }
};
