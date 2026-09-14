# NOVA BANK — site de démonstration

Site vitrine et espace client d'une banque **fictive**, construit comme démonstration technique full-stack : front-end statique, API serverless et base de données réelle. Aucune licence bancaire, aucune opération financière réelle — voir les [mentions légales](a-propos.html#mentions-legales) et les [CGU](conditions-generales.html).

**En ligne :** [www.novabk.pro](https://www.novabk.pro)

## Stack technique

- **Front-end** : HTML/CSS/JS statique, sans framework ni étape de build.
- **Back-end** : fonctions serverless [Vercel](https://vercel.com) (`api/*.js`).
- **Base de données** : [Neon](https://neon.tech) (Postgres serverless), via `@neondatabase/serverless`.
- **E-mail transactionnel** : [Resend](https://resend.com).
- **Anti-bot** : [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) à l'inscription.
- **Suivi** : Vercel Web Analytics + Speed Insights.

## Structure

```
api/
  _lib/db.js     — client SQL, sessions, hash de mots de passe, rate limiting, e-mail, Turnstile
  auth.js        — inscription, connexion (+ 2FA), mot de passe oublié, vérification e-mail
  client.js      — virements, épargne, notifications, profil, cartes
  admin.js       — connexion admin (+ 2FA), gestion clients, opérations, journal d'activité
  health.js      — sonde de disponibilité publique (/api/health)
js/db.js         — client HTTP appelé par les pages (wrapper autour de /api/*)
*.html           — pages publiques et espace client/admin
```

## Fonctionnalités

- Ouverture de compte avec vérification anti-robot (Turnstile) et confirmation d'e-mail réelle.
- Connexion à double authentification (mot de passe + code à usage unique envoyé par e-mail, avec repli à l'écran si l'envoi échoue) — côté client et côté admin.
- Réinitialisation de mot de passe par e-mail réel.
- Virements, objectifs d'épargne, gestion des cartes, notifications, historique de connexions.
- Back-office admin : suivi des clients et opérations, suspension/réactivation de comptes, ajustements de solde, journal d'activité, gestion des comptes admin.
- Limitation de débit (par IP et par compte) sur les actions sensibles (connexion, réinitialisation).
- En-têtes de sécurité (CSP, HSTS, X-Frame-Options...) et `robots.txt` / `sitemap.xml`.

## Variables d'environnement (Vercel)

| Variable | Usage |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` / `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` | Connexion Neon Postgres |
| `TURNSTILE_SECRET_KEY` | Validation serveur du CAPTCHA à l'inscription |
| `RESEND_API_KEY` | Envoi des e-mails transactionnels |

## Déploiement

Déploiement continu sur Vercel à chaque push sur `main`. Le domaine `novabk.pro` redirige vers `www.novabk.pro`, qui sert le site.
