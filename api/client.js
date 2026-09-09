const {
  sql, uid, generateTrxRef, getSession, refreshSession, getBearerToken,
  ensureSchema, logActivity, readJsonBody, send, fail
} = require('./_lib/db');

async function requireClient(req) {
  const token = getBearerToken(req);
  const session = await getSession(token);
  if (!session || session.is_admin || !session.user_id) return null;
  await refreshSession(token, false);
  return session.user_id;
}

module.exports = async (req, res) => {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

    const userId = await requireClient(req);
    if (!userId) return fail(res, 401, 'not_authenticated');

    const body = await readJsonBody(req);
    const action = body.action;

    const userRows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
    const user = userRows[0];
    if (!user) return fail(res, 404, 'not_found');
    if (user.status === 'suspended') return fail(res, 403, 'suspended', { reason: user.suspend_reason });

    // ---------------------------------------------------------------- virement
    // Le solde réel n'est débité qu'à la confirmation par l'administrateur (voir api/admin.js,
    // action updateTransactionStatus). Avant cela, le montant est simplement retenu dans le
    // "solde disponible" calculé côté client (solde - virements sortants en attente).
    if (action === 'createTransfer') {
      const { amount, beneficiary, bankName, ibanDest, bic, reason, executionDate } = body;
      const amt = Number(amount);
      if (!amt || amt <= 0) return fail(res, 400, 'invalid_amount');
      if (!beneficiary || !ibanDest) return fail(res, 400, 'missing_fields');

      const pendingRows = await sql`
        SELECT COALESCE(SUM(amount), 0)::float AS total FROM transactions
        WHERE user_id = ${userId} AND type = 'transfer_out' AND status IN ('pending', 'processing')
      `;
      const availableBalance = Number(user.balance) - Number(pendingRows[0].total);
      if (amt > availableBalance) return fail(res, 400, 'insufficient_funds');

      const ref = generateTrxRef();
      await sql`
        INSERT INTO transactions (ref, user_id, type, description, amount, currency, status, settled, beneficiary, bank_name, iban_dest, bic, reason, execution_date)
        VALUES (${ref}, ${userId}, 'transfer_out', ${'Virement vers ' + beneficiary}, ${amt}, ${user.currency}, 'pending', false, ${beneficiary}, ${bankName || null}, ${ibanDest}, ${bic || null}, ${reason || null}, ${executionDate || null})
      `;
      await logActivity({ adminName: user.first_name + ' ' + user.last_name, action: 'virement_initie', detail: `${ref} — ${amt} ${user.currency} vers ${beneficiary}` });
      return send(res, 200, { ok: true, ref });
    }

    // ---------------------------------------------------------------- notifications
    if (action === 'markNotificationRead') {
      const { id } = body;
      await sql`UPDATE notifications SET read = true WHERE id = ${id} AND user_id = ${userId}`;
      return send(res, 200, { ok: true });
    }
    if (action === 'markAllNotificationsRead') {
      await sql`UPDATE notifications SET read = true WHERE user_id = ${userId}`;
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- épargne
    if (action === 'createSavingsGoal') {
      const { name, targetAmount, icon } = body;
      if (!name || !targetAmount) return fail(res, 400, 'missing_fields');
      const id = uid('GOAL-');
      await sql`INSERT INTO savings_goals (id, user_id, name, target_amount, current_amount, icon) VALUES (${id}, ${userId}, ${name}, ${Number(targetAmount)}, 0, ${icon || 'fa-piggy-bank'})`;
      return send(res, 200, { ok: true, id });
    }
    if (action === 'contributeToSavingsGoal') {
      const { id, amount } = body;
      const amt = Number(amount);
      if (!amt || amt <= 0) return fail(res, 400, 'invalid_amount');
      const pendingRows = await sql`
        SELECT COALESCE(SUM(amount), 0)::float AS total FROM transactions
        WHERE user_id = ${userId} AND type = 'transfer_out' AND status IN ('pending', 'processing')
      `;
      const availableBalance = Number(user.balance) - Number(pendingRows[0].total);
      if (amt > availableBalance) return fail(res, 400, 'insufficient_funds');
      const goalRows = await sql`SELECT * FROM savings_goals WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
      const goal = goalRows[0];
      if (!goal) return fail(res, 404, 'not_found');
      await sql`UPDATE users SET balance = balance - ${amt} WHERE id = ${userId}`;
      await sql`UPDATE savings_goals SET current_amount = current_amount + ${amt} WHERE id = ${id}`;
      const ref = generateTrxRef();
      await sql`
        INSERT INTO transactions (ref, user_id, type, description, amount, currency, status, settled)
        VALUES (${ref}, ${userId}, 'debit', ${'Mise de côté — Objectif « ' + goal.name + ' »'}, ${amt}, ${user.currency}, 'confirmed', true)
      `;
      return send(res, 200, { ok: true });
    }
    if (action === 'withdrawFromSavingsGoal') {
      const { id, amount } = body;
      const amt = Number(amount);
      const goalRows = await sql`SELECT * FROM savings_goals WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
      const goal = goalRows[0];
      if (!goal) return fail(res, 404, 'not_found');
      if (!amt || amt <= 0 || amt > Number(goal.current_amount)) return fail(res, 400, 'invalid_amount');
      await sql`UPDATE savings_goals SET current_amount = current_amount - ${amt} WHERE id = ${id}`;
      await sql`UPDATE users SET balance = balance + ${amt} WHERE id = ${userId}`;
      const ref = generateTrxRef();
      await sql`
        INSERT INTO transactions (ref, user_id, type, description, amount, currency, status, settled)
        VALUES (${ref}, ${userId}, 'credit', ${'Retrait — Objectif « ' + goal.name + ' »'}, ${amt}, ${user.currency}, 'confirmed', true)
      `;
      return send(res, 200, { ok: true });
    }
    if (action === 'deleteSavingsGoal') {
      const { id } = body;
      const goalRows = await sql`SELECT * FROM savings_goals WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
      const goal = goalRows[0];
      if (!goal) return fail(res, 404, 'not_found');
      if (Number(goal.current_amount) > 0) {
        await sql`UPDATE users SET balance = balance + ${Number(goal.current_amount)} WHERE id = ${userId}`;
      }
      await sql`DELETE FROM savings_goals WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- profil
    if (action === 'updateProfile') {
      const { phone, address, currency } = body;
      await sql`
        UPDATE users SET
          phone = COALESCE(${phone ?? null}, phone),
          address = COALESCE(${address ?? null}, address),
          currency = COALESCE(${currency ?? null}, currency)
        WHERE id = ${userId}
      `;
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- cartes
    if (action === 'toggleCardFreeze') {
      const { id } = body;
      const cardRows = await sql`SELECT * FROM cards WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
      const card = cardRows[0];
      if (!card) return fail(res, 404, 'not_found');
      await sql`UPDATE cards SET frozen = ${!card.frozen} WHERE id = ${id}`;
      return send(res, 200, { ok: true, frozen: !card.frozen });
    }

    return fail(res, 400, 'unknown_action');
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'server_error', { message: err.message });
  }
};
