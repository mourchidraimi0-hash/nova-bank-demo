const {
  sql, uid, hashPassword, verifyPassword, generateAccountNumber, generateIBAN,
  createSession, getSession, refreshSession, destroySession, getBearerToken,
  ensureSchema, logActivity, readJsonBody, send, fail
} = require('./_lib/db');

// ---------------------------------------------------------------- mise en forme utilisateur (snake_case -> camelCase, identique au modèle historique)
async function serializeUser(row) {
  const [transactions, notifications, notes, savingsGoals, cards, loginHistory] = await Promise.all([
    sql`SELECT * FROM transactions WHERE user_id = ${row.id} ORDER BY created_at DESC`,
    sql`SELECT * FROM notifications WHERE user_id = ${row.id} ORDER BY date DESC`,
    sql`SELECT * FROM notes WHERE user_id = ${row.id} ORDER BY date DESC`,
    sql`SELECT * FROM savings_goals WHERE user_id = ${row.id} ORDER BY created_at ASC`,
    sql`SELECT * FROM cards WHERE user_id = ${row.id} ORDER BY created_at ASC`,
    sql`SELECT * FROM login_history WHERE user_id = ${row.id} ORDER BY date DESC LIMIT 20`
  ]);
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    birthDate: row.birth_date,
    address: row.address,
    currency: row.currency,
    accountNumber: row.account_number,
    iban: row.iban,
    balance: Number(row.balance),
    status: row.status,
    suspendReason: row.suspend_reason,
    kyc: { idPhoto: row.kyc_id_photo, idDocument: row.kyc_id_document, status: row.kyc_status },
    createdAt: row.created_at,
    lastLogin: row.last_login,
    loginHistory: loginHistory.map(h => ({ date: h.date, userAgent: h.user_agent })),
    transactions: transactions.map(serializeTransaction),
    notifications: notifications.map(n => ({ id: n.id, message: n.message, type: n.type, date: n.date, read: n.read })),
    notes: notes.map(n => ({ author: n.author, role: n.role, text: n.text, date: n.date })),
    savingsGoals: savingsGoals.map(g => ({ id: g.id, name: g.name, targetAmount: Number(g.target_amount), currentAmount: Number(g.current_amount), icon: g.icon, createdAt: g.created_at })),
    cards: cards.map(c => ({ id: c.id, label: c.label, last4: c.last4, frozen: c.frozen, createdAt: c.created_at }))
  };
}
function serializeTransaction(t) {
  return {
    ref: t.ref, type: t.type, description: t.description, amount: Number(t.amount), currency: t.currency,
    status: t.status, settled: t.settled, adminName: t.admin_name, beneficiary: t.beneficiary,
    bankName: t.bank_name, ibanDest: t.iban_dest, bic: t.bic, reason: t.reason, executionDate: t.execution_date,
    createdAt: t.created_at, updatedAt: t.updated_at
  };
}

module.exports = async (req, res) => {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const action = req.query.action;
      if (action === 'me') {
        const token = getBearerToken(req);
        const session = await getSession(token);
        if (!session || session.is_admin || !session.user_id) return fail(res, 401, 'not_authenticated');
        await refreshSession(token, false);
        const rows = await sql`SELECT * FROM users WHERE id = ${session.user_id} LIMIT 1`;
        if (!rows[0]) return fail(res, 404, 'not_found');
        return send(res, 200, { ok: true, user: await serializeUser(rows[0]) });
      }
      return fail(res, 400, 'unknown_action');
    }

    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const body = await readJsonBody(req);
    const action = body.action;

    if (action === 'signup') {
      const { firstName, lastName, email, phone, birthDate, address, currency, password, idPhotoMeta, idDocumentMeta } = body;
      if (!firstName || !lastName || !email || !password) return fail(res, 400, 'missing_fields');
      const existing = await sql`SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
      if (existing[0]) return fail(res, 409, 'email_taken');

      const id = uid('USR-');
      const accountNumber = generateAccountNumber();
      const iban = generateIBAN();
      const kycStatus = (idPhotoMeta || idDocumentMeta) ? 'submitted' : 'none';

      await sql`
        INSERT INTO users (id, first_name, last_name, email, phone, birth_date, address, currency, password_hash, account_number, iban, balance, status, kyc_id_photo, kyc_id_document, kyc_status)
        VALUES (${id}, ${firstName}, ${lastName}, ${email}, ${phone || null}, ${birthDate || null}, ${address || null}, ${currency || 'EUR'}, ${hashPassword(password)}, ${accountNumber}, ${iban}, 0, 'active', ${idPhotoMeta ? JSON.stringify(idPhotoMeta) : null}, ${idDocumentMeta ? JSON.stringify(idDocumentMeta) : null}, ${kycStatus})
      `;
      let last4 = ''; for (let i = 0; i < 4; i++) last4 += Math.floor(Math.random() * 10);
      await sql`INSERT INTO cards (id, user_id, label, last4, frozen) VALUES (${uid('CARD-')}, ${id}, 'Carte principale', ${last4}, false)`;
      await logActivity({ adminName: 'Client', action: 'inscription_client', detail: `Nouveau compte ${accountNumber} (${firstName} ${lastName})` });

      const rows = await sql`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
      return send(res, 200, { ok: true, user: await serializeUser(rows[0]) });
    }

    if (action === 'login') {
      const { identifier, password } = body;
      if (!identifier || !password) return fail(res, 400, 'missing_fields');
      const id = String(identifier).trim().toLowerCase();
      const rows = await sql`
        SELECT * FROM users
        WHERE lower(id) = ${id} OR lower(email) = ${id} OR lower(account_number) = ${id}
        LIMIT 1
      `;
      const user = rows[0];
      if (!user) return fail(res, 401, 'not_found');
      if (user.status === 'suspended') return fail(res, 403, 'suspended', { reason: user.suspend_reason });
      if (!verifyPassword(password, user.password_hash)) return fail(res, 401, 'wrong_password');

      await sql`UPDATE users SET last_login = now() WHERE id = ${user.id}`;
      const ua = (req.headers['user-agent'] || '').slice(0, 300);
      await sql`INSERT INTO login_history (user_id, user_agent) VALUES (${user.id}, ${ua})`;
      const { token } = await createSession({ userId: user.id, isAdmin: false });

      const fresh = await sql`SELECT * FROM users WHERE id = ${user.id} LIMIT 1`;
      return send(res, 200, { ok: true, token, user: await serializeUser(fresh[0]) });
    }

    if (action === 'logout') {
      await destroySession(getBearerToken(req));
      return send(res, 200, { ok: true });
    }

    if (action === 'changePassword') {
      const token = getBearerToken(req);
      const session = await getSession(token);
      if (!session || session.is_admin || !session.user_id) return fail(res, 401, 'not_authenticated');
      const { currentPassword, newPassword } = body;
      const rows = await sql`SELECT * FROM users WHERE id = ${session.user_id} LIMIT 1`;
      const user = rows[0];
      if (!user || !verifyPassword(currentPassword, user.password_hash)) return fail(res, 401, 'wrong_password');
      await sql`UPDATE users SET password_hash = ${hashPassword(newPassword)} WHERE id = ${user.id}`;
      await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${user.id}, 'Votre mot de passe a été modifié avec succès.', 'success')`;
      await logActivity({ adminName: 'Client', action: 'changement_mot_de_passe', detail: `${user.first_name} ${user.last_name} a changé son mot de passe` });
      return send(res, 200, { ok: true });
    }

    return fail(res, 400, 'unknown_action');
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'server_error', { message: err.message });
  }
};
