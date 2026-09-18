const {
  sql, uid, hashPassword, verifyPassword, isStrongPassword, getClientIp, checkRateLimit, verifyTurnstile, sendEmail,
  generateAccountNumber, generateIBAN, generate2FACode,
  createSession, getSession, refreshSession, destroySession, destroyAllUserSessions, getBearerToken,
  createPasswordResetToken, consumePasswordResetToken,
  createEmailVerificationToken, consumeEmailVerificationToken,
  ensureSchema, logActivity, readJsonBody, send, fail
} = require('./_lib/db');

const SITE_URL = 'https://www.novabk.pro';

function verificationEmailHtml(firstName, link) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#15181B;">Hello ${firstName},</h2>
      <p>Thank you for signing up with NOVA BANK. Confirm your email address to enable outgoing transfers on your account:</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${link}" style="background:#22C55E;color:#15181B;font-weight:bold;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;">Confirm my email address</a>
      </p>
      <p style="color:#5B6167;font-size:.85rem;">This link expires in 24 hours and can only be used once. If the button doesn't work, copy this link: ${link}</p>
      <p style="color:#5B6167;font-size:.8rem;margin-top:24px;">NOVA BANK is a fictional technical demo site, with no real banking license.</p>
    </div>`;
}

function passwordResetEmailHtml(firstName, link) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#15181B;">Hello ${firstName},</h2>
      <p>You requested a password reset for your NOVA BANK account. Click below to choose a new one:</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${link}" style="background:#22C55E;color:#15181B;font-weight:bold;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;">Reset my password</a>
      </p>
      <p style="color:#5B6167;font-size:.85rem;">This link expires in 30 minutes and can only be used once. If the button doesn't work, copy this link: ${link}</p>
      <p style="color:#5B6167;font-size:.85rem;">If you did not request this, simply ignore this email — your current password remains unchanged.</p>
      <p style="color:#5B6167;font-size:.8rem;margin-top:24px;">NOVA BANK is a fictional technical demo site, with no real banking license.</p>
    </div>`;
}

function loginCodeEmailHtml(firstName, code) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="color:#15181B;">Hello ${firstName},</h2>
      <p>Here is your one-time login code to access your NOVA BANK client portal:</p>
      <p style="text-align:center;margin:28px 0;">
        <span style="display:inline-block;background:#ECFDF5;color:#047857;font-size:2rem;font-weight:bold;letter-spacing:.3em;padding:14px 24px;border-radius:8px;">${code}</span>
      </p>
      <p style="color:#5B6167;font-size:.85rem;">This code expires in 5 minutes and can only be used once.</p>
      <p style="color:#5B6167;font-size:.85rem;">If you did not attempt to log in, change your password immediately from the Security page.</p>
      <p style="color:#5B6167;font-size:.8rem;margin-top:24px;">NOVA BANK is a fictional technical demo site, with no real banking license.</p>
    </div>`;
}

// ---------------------------------------------------------------- mise en forme utilisateur (snake_case -> camelCase, identique au modèle historique)
async function serializeUser(row) {
  // Les notes internes (table "notes") sont volontairement exclues d'ici : ce sont des
  // annotations réservées aux administrateurs (voir admin.js/serializeClient), jamais destinées
  // au client concerné.
  const [transactions, notifications, savingsGoals, cards, loginHistory] = await Promise.all([
    sql`SELECT * FROM transactions WHERE user_id = ${row.id} ORDER BY created_at DESC`,
    sql`SELECT * FROM notifications WHERE user_id = ${row.id} ORDER BY date DESC`,
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
    emailVerified: row.email_verified,
    kyc: { idPhoto: row.kyc_id_photo, idDocument: row.kyc_id_document, status: row.kyc_status },
    createdAt: row.created_at,
    lastLogin: row.last_login,
    loginHistory: loginHistory.map(h => ({ date: h.date, userAgent: h.user_agent })),
    transactions: transactions.map(serializeTransaction),
    notifications: notifications.map(n => ({ id: n.id, message: n.message, type: n.type, date: n.date, read: n.read })),
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
      const allowed = await checkRateLimit({ key: `signup:${getClientIp(req)}`, max: 5, windowMinutes: 60 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { firstName, lastName, email, phone, birthDate, address, currency, password, idPhotoMeta, idDocumentMeta, turnstileToken } = body;
      const captchaOk = await verifyTurnstile(turnstileToken, getClientIp(req));
      if (!captchaOk) return fail(res, 400, 'captcha_failed');

      if (!firstName || !lastName || !email || !password) return fail(res, 400, 'missing_fields');
      if (!isStrongPassword(password)) return fail(res, 400, 'weak_password');
      const existing = await sql`SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
      if (existing[0]) return fail(res, 409, 'email_taken');

      const id = uid('USR-');
      const accountNumber = generateAccountNumber();
      const iban = generateIBAN();
      const kycStatus = (idPhotoMeta || idDocumentMeta) ? 'submitted' : 'none';

      await sql`
        INSERT INTO users (id, first_name, last_name, email, phone, birth_date, address, currency, password_hash, account_number, iban, balance, status, kyc_id_photo, kyc_id_document, kyc_status, email_verified)
        VALUES (${id}, ${firstName}, ${lastName}, ${email}, ${phone || null}, ${birthDate || null}, ${address || null}, ${currency || 'EUR'}, ${hashPassword(password)}, ${accountNumber}, ${iban}, 0, 'active', ${idPhotoMeta ? JSON.stringify(idPhotoMeta) : null}, ${idDocumentMeta ? JSON.stringify(idDocumentMeta) : null}, ${kycStatus}, false)
      `;
      let last4 = ''; for (let i = 0; i < 4; i++) last4 += Math.floor(Math.random() * 10);
      const cardLabel = 'Carte principale';
      await sql`INSERT INTO cards (id, user_id, label, last4, frozen) VALUES (${uid('CARD-')}, ${id}, ${cardLabel}, ${last4}, false)`;
      await logActivity({ adminName: 'Client', action: 'inscription_client', detail: `Nouveau compte ${accountNumber} (${firstName} ${lastName})` });

      const verificationToken = await createEmailVerificationToken(id);
      const verifyLink = `${SITE_URL}/verification-email.html?token=${encodeURIComponent(verificationToken)}`;
      const emailResult = await sendEmail({
        to: email,
        subject: 'Confirmez votre adresse e-mail — NOVA BANK',
        html: verificationEmailHtml(firstName, verifyLink)
      });
      if (!emailResult.ok) {
        console.error(`E-mail de confirmation non envoyé pour ${email} : ${emailResult.error}`);
      }

      const rows = await sql`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
      return send(res, 200, { ok: true, user: await serializeUser(rows[0]), verificationToken, emailSent: emailResult.ok });
    }

    if (action === 'login') {
      const allowed = await checkRateLimit({ key: `login:${getClientIp(req)}`, max: 10, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { identifier, password, turnstileToken } = body;
      const captchaOk = await verifyTurnstile(turnstileToken, getClientIp(req));
      if (!captchaOk) return fail(res, 400, 'captcha_failed');

      if (!identifier || !password) return fail(res, 400, 'missing_fields');
      const id = String(identifier).trim().toLowerCase();
      const rows = await sql`
        SELECT * FROM users
        WHERE lower(id) = ${id} OR lower(email) = ${id} OR lower(account_number) = ${id}
        LIMIT 1
      `;
      const user = rows[0];
      // Message unique ("invalid_credentials") que le compte existe ou non, et que le mot de
      // passe soit correct ou non : distinguer "compte introuvable" de "mot de passe incorrect"
      // permettrait à un attaquant de tester une liste d'identifiants pour savoir lesquels
      // correspondent à un compte réel (énumération de comptes).
      if (!user) return fail(res, 401, 'invalid_credentials');

      // Limite par compte en plus de la limite par IP : empêche un attaquant disposant de
      // plusieurs adresses IP de cibler un seul compte par force brute.
      const accountAllowed = await checkRateLimit({ key: `login_account:${user.id}`, max: 8, windowMinutes: 15 });
      if (!accountAllowed) return fail(res, 429, 'rate_limited');

      if (user.status === 'suspended') return fail(res, 403, 'suspended', { reason: user.suspend_reason });
      if (!verifyPassword(password, user.password_hash)) return fail(res, 401, 'invalid_credentials');

      // ---------------------------------------------------------------- 2FA (code à usage unique par e-mail)
      // Mot de passe validé, mais aucune session n'est encore créée : elle ne le sera qu'après
      // vérification du code (action loginVerify). Le code est envoyé par e-mail réel (Resend) ;
      // en secours (compte non vérifié chez Resend), il est aussi renvoyé pour affichage à
      // l'écran, comme partout ailleurs sur ce site de démonstration.
      const code = generate2FACode();
      const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
      await sql`
        INSERT INTO pending_client_2fa (user_id, code, expires_at) VALUES (${user.id}, ${code}, ${expiresAt})
        ON CONFLICT (user_id) DO UPDATE SET code = ${code}, expires_at = ${expiresAt}
      `;
      const emailResult = await sendEmail({
        to: user.email,
        subject: 'Votre code de connexion — NOVA BANK',
        html: loginCodeEmailHtml(user.first_name, code)
      });
      if (!emailResult.ok) {
        console.error(`Code de connexion non envoyé pour ${user.email} : ${emailResult.error}`);
      }

      return send(res, 200, {
        ok: true,
        requiresTwoFactor: true,
        userId: user.id,
        emailSent: emailResult.ok,
        demoCode: emailResult.ok ? undefined : code
      });
    }

    if (action === 'loginVerify') {
      const allowed = await checkRateLimit({ key: `login_verify:${getClientIp(req)}`, max: 10, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { userId, code } = body;
      if (!userId || !code) return fail(res, 400, 'missing_fields');

      const accountAllowed = await checkRateLimit({ key: `login_verify_account:${userId}`, max: 8, windowMinutes: 5 });
      if (!accountAllowed) return fail(res, 429, 'rate_limited');

      const pendingRows = await sql`SELECT * FROM pending_client_2fa WHERE user_id = ${userId} LIMIT 1`;
      const pending = pendingRows[0];
      if (!pending || new Date(pending.expires_at).getTime() < Date.now()) return fail(res, 401, 'code_expired');
      if (pending.code !== String(code).trim()) return fail(res, 401, 'invalid_code');
      await sql`DELETE FROM pending_client_2fa WHERE user_id = ${userId}`;

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) return fail(res, 404, 'not_found');
      if (user.status === 'suspended') return fail(res, 403, 'suspended', { reason: user.suspend_reason });

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

      const allowed = await checkRateLimit({ key: `changepw:${getClientIp(req)}`, max: 8, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { currentPassword, newPassword } = body;
      if (!isStrongPassword(newPassword)) return fail(res, 400, 'weak_password');
      const rows = await sql`SELECT * FROM users WHERE id = ${session.user_id} LIMIT 1`;
      const user = rows[0];
      if (!user || !verifyPassword(currentPassword, user.password_hash)) return fail(res, 401, 'wrong_password');
      await sql`UPDATE users SET password_hash = ${hashPassword(newPassword)} WHERE id = ${user.id}`;
      const changePwMsg = 'Votre mot de passe a été modifié avec succès.';
      await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${user.id}, ${changePwMsg}, 'success')`;
      await logActivity({ adminName: 'Client', action: 'changement_mot_de_passe', detail: `${user.first_name} ${user.last_name} a changé son mot de passe` });
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- réinitialisation du mot de passe (sans email réel)
    // Démo : aucun serveur d'e-mail n'est connecté à ce site. Le jeton de réinitialisation est
    // réel (aléatoire, à usage unique, expire après 30 minutes) mais renvoyé directement au
    // client pour être affiché à l'écran, exactement comme le code 2FA de l'espace admin.
    if (action === 'requestPasswordReset') {
      const allowed = await checkRateLimit({ key: `pwreset:${getClientIp(req)}`, max: 5, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { identifier } = body;
      if (!identifier) return fail(res, 400, 'missing_fields');
      const id = String(identifier).trim().toLowerCase();
      const rows = await sql`
        SELECT * FROM users
        WHERE lower(id) = ${id} OR lower(email) = ${id} OR lower(account_number) = ${id}
        LIMIT 1
      `;
      const user = rows[0];

      // Sécurité : la réponse est identique que le compte existe ou non (et qu'il soit suspendu
      // ou non) — sinon un attaquant peut tester une liste d'identifiants pour savoir lesquels
      // correspondent à un compte réel (énumération de comptes). Le jeton ne transite jamais
      // dans la réponse API quand l'e-mail est effectivement parti, pour la même raison que
      // demoCode côté 2FA : uniquement en secours si l'envoi a échoué.
      let emailSent = false;
      let resetToken;
      if (user && user.status !== 'suspended') {
        resetToken = await createPasswordResetToken(user.id);
        const resetLink = `${SITE_URL}/reinitialisation.html?token=${encodeURIComponent(resetToken)}`;
        const emailResult = await sendEmail({
          to: user.email,
          subject: 'Réinitialisation de votre mot de passe — NOVA BANK',
          html: passwordResetEmailHtml(user.first_name, resetLink)
        });
        emailSent = emailResult.ok;
        if (!emailResult.ok) {
          console.error(`E-mail de réinitialisation non envoyé pour ${user.email} : ${emailResult.error}`);
        }
        await logActivity({ adminName: 'Client', action: 'demande_reinitialisation_mdp', detail: `Demande de réinitialisation pour ${user.account_number}` });
      }
      return send(res, 200, { ok: true, emailSent, resetToken: emailSent ? undefined : resetToken });
    }

    if (action === 'resetPassword') {
      const allowed = await checkRateLimit({ key: `pwresetconfirm:${getClientIp(req)}`, max: 10, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { token, newPassword } = body;
      if (!token || !newPassword) return fail(res, 400, 'missing_fields');
      if (!isStrongPassword(newPassword)) return fail(res, 400, 'weak_password');

      const userId = await consumePasswordResetToken(token);
      if (!userId) return fail(res, 400, 'invalid_token');

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) return fail(res, 404, 'not_found');

      await sql`UPDATE users SET password_hash = ${hashPassword(newPassword)} WHERE id = ${userId}`;
      await destroyAllUserSessions(userId);
      const notifMsg = "Votre mot de passe a été réinitialisé. Si vous n'êtes pas à l'origine de cette action, contactez le support immédiatement.";
      await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${userId}, ${notifMsg}, 'warning')`;
      await logActivity({ adminName: `${user.first_name} ${user.last_name}`, action: 'reinitialisation_mdp', detail: `Mot de passe réinitialisé pour ${user.account_number} — toutes les sessions actives ont été révoquées` });
      return send(res, 200, { ok: true });
    }

    // ---------------------------------------------------------------- vérification de l'e-mail (sans email réel)
    // Démo : le jeton est réel (à usage unique, expire après 24h) mais affiché à l'écran au
    // lieu d'être envoyé par e-mail. Tant qu'il n'est pas confirmé, les virements sortants
    // sont bloqués (voir api/client.js) — les comptes déjà existants avant cette fonctionnalité
    // restent, eux, marqués vérifiés pour ne pas être bloqués rétroactivement.
    if (action === 'verifyEmail') {
      const allowed = await checkRateLimit({ key: `verifyemail:${getClientIp(req)}`, max: 10, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const { token } = body;
      if (!token) return fail(res, 400, 'missing_fields');

      const userId = await consumeEmailVerificationToken(token);
      if (!userId) return fail(res, 400, 'invalid_token');

      const rows = await sql`SELECT * FROM users WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) return fail(res, 404, 'not_found');

      await sql`UPDATE users SET email_verified = true WHERE id = ${userId}`;
      const notifMsg = 'Votre adresse e-mail a été confirmée avec succès.';
      await sql`INSERT INTO notifications (id, user_id, message, type) VALUES (${uid('NOTIF-')}, ${userId}, ${notifMsg}, 'success')`;
      await logActivity({ adminName: `${user.first_name} ${user.last_name}`, action: 'verification_email', detail: `E-mail confirmé pour ${user.account_number}` });
      return send(res, 200, { ok: true });
    }

    if (action === 'resendVerification') {
      const authToken = getBearerToken(req);
      const session = await getSession(authToken);
      if (!session || session.is_admin || !session.user_id) return fail(res, 401, 'not_authenticated');

      const allowed = await checkRateLimit({ key: `resendverif:${getClientIp(req)}`, max: 5, windowMinutes: 15 });
      if (!allowed) return fail(res, 429, 'rate_limited');

      const rows = await sql`SELECT * FROM users WHERE id = ${session.user_id} LIMIT 1`;
      const user = rows[0];
      if (!user) return fail(res, 404, 'not_found');
      if (user.email_verified) return fail(res, 400, 'already_verified');

      const verificationToken = await createEmailVerificationToken(user.id);
      const verifyLink = `${SITE_URL}/verification-email.html?token=${encodeURIComponent(verificationToken)}`;
      const emailResult = await sendEmail({
        to: user.email,
        subject: 'Confirmez votre adresse e-mail — NOVA BANK',
        html: verificationEmailHtml(user.first_name, verifyLink)
      });
      if (!emailResult.ok) {
        console.error(`E-mail de confirmation non envoyé pour ${user.email} : ${emailResult.error}`);
      }
      return send(res, 200, { ok: true, verificationToken, emailSent: emailResult.ok });
    }

    return fail(res, 400, 'unknown_action');
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'server_error');
  }
};
