const { sql } = require('./_lib/db');

// Point de contrôle public, sans authentification : permet de surveiller la disponibilité
// du site et de la connexion à la base de données (utile avec un service de monitoring externe).
module.exports = async (req, res) => {
  const startedAt = Date.now();
  let dbConnected = false;
  try {
    if (sql) {
      await sql`SELECT 1`;
      dbConnected = true;
    }
  } catch (err) {
    console.error('Health check — erreur base de données :', err.message);
  }

  const healthy = dbConnected;
  res.status(healthy ? 200 : 503)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(JSON.stringify({
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      database: dbConnected ? 'connected' : 'unreachable',
      responseTimeMs: Date.now() - startedAt,
      timestamp: new Date().toISOString()
    }));
};
