// src/routes/push.js
const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { pool } = require('../db');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
let webpushReady = false;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC, VAPID_PRIVATE);
    webpushReady = true;
    console.log('web-push: VAPID keys loaded');
  } catch (err) {
    console.warn('web-push: invalid VAPID keys, push disabled until valid keys are provided.', err && err.message ? err.message : err);
    webpushReady = false;
  }
} else {
  console.warn('web-push: VAPID_PUBLIC / VAPID_PRIVATE not set. Push notifications disabled.');
  webpushReady = false;
}

function looksLikeUuid(s) {
  if (!s || typeof s !== 'string') return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s.trim());
}

/**
 * GET /api/push/public
 * Returns { publicKey: '...' } to help clients subscribe (VAPID public key).
 */
router.get('/public', async (req, res) => {
  try {
    if (!VAPID_PUBLIC) return res.status(404).json({ error: 'vapid_not_configured' });
    return res.json({ publicKey: VAPID_PUBLIC });
  } catch (err) {
    console.error('[push.GET /api/push/public] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/push/subscribe
 * body: { visitor_id, subscription, browser }
 * Note: visitor_id may be a UUID (visitor row) OR a session string. If not a UUID, we will store NULL in visitor_id column
 * to avoid uuid parse errors.
 */
router.post('/subscribe', async (req, res) => {
  const { visitor_id, subscription, browser } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'visitor_id_and_subscription_required' });

  const endpoint = subscription.endpoint;
  const public_key = (subscription.keys && subscription.keys.p256dh) ? subscription.keys.p256dh : (subscription.p256dh || '') ;
  const auth = (subscription.keys && subscription.keys.auth) ? subscription.keys.auth : (subscription.auth || '');

  try {
    // only pass visitor_id to DB if it looks like a UUID; otherwise insert NULL
    const visitorUuid = looksLikeUuid(visitor_id) ? visitor_id : null;

    // Use parameterized insert. If visitorUuid is null, set visitor_id = NULL.
    const q = `
      INSERT INTO push_subscriptions (visitor_id, endpoint, public_key, auth, browser, created_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (md5(endpoint)) DO NOTHING
      RETURNING id
    `;
    const params = [visitorUuid, endpoint, public_key || '', auth || '', browser || null];
    const { rows } = await pool.query(q, params);

    // If ON CONFLICT DO NOTHING happened, rows will be empty. Return ok anyway.
    return res.json({ ok: true, id: (rows && rows[0] && rows[0].id) || null });
  } catch (err) {
    console.error('[push.POST /api/push/subscribe] error', err && err.stack ? err.stack : err);
    // give safer error message
    return res.status(500).json({ error: 'server_error', detail: process.env.NODE_ENV !== 'production' ? (err.message || String(err)) : undefined });
  }
});

/**
 * POST /api/push/send
 * body: { subscription_id, payload }
 */
router.post('/send', async (req, res) => {
  if (!webpushReady) return res.status(503).json({ error: 'push_not_configured' });

  const { subscription_id, payload } = req.body || {};
  if (!subscription_id || !payload) return res.status(400).json({ error: 'subscription_id_and_payload_required' });

  try {
    const { rows } = await pool.query('SELECT endpoint, public_key, auth FROM push_subscriptions WHERE id = $1', [subscription_id]);
    if (!rows || !rows[0]) return res.status(404).json({ error: 'not_found' });
    const s = rows[0];
    const pushSub = { endpoint: s.endpoint, keys: { p256dh: s.public_key, auth: s.auth } };
    await webpush.sendNotification(pushSub, JSON.stringify(payload));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[push.POST /api/push/send] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'send_failed', detail: err && err.message ? err.message : undefined });
  }
});

/**
 * GET /api/push/list?max_age_days=180&prune_invalid=true
 * - prunes by age (last_ping / created_at)
 * - optionally probes invalid subscriptions (requires VAPID)
 */
router.get('/list', async (req, res) => {
  const maxAgeDays = Math.max(1, Number(req.query.max_age_days || 180));
  const pruneInvalid = String(req.query.prune_invalid || 'false').toLowerCase() === 'true';
  const db = req.db || req.app?.locals?.db || pool;

  try {
    if (!db || typeof db.query !== 'function') throw new Error('db pool missing');

    // 1) prune by age using last_ping (if available) or created_at
    const pruneAgeQ = `
      DELETE FROM push_subscriptions
      WHERE (last_ping IS NOT NULL AND last_ping < now() - ($1::int || ' days')::interval)
         OR (last_ping IS NULL AND created_at < now() - ($1::int || ' days')::interval)
      RETURNING id
    `;
    const { rows: prunedAgeRows } = await db.query(pruneAgeQ, [maxAgeDays]);
    const pruned_age_count = prunedAgeRows ? prunedAgeRows.length : 0;

    let pruned_invalid_count = 0;

    if (pruneInvalid && webpushReady) {
      const { rows: subs } = await db.query('SELECT id, endpoint, public_key, auth FROM push_subscriptions');
      if (Array.isArray(subs) && subs.length > 0) {
        for (const s of subs) {
          const pushSub = { endpoint: s.endpoint, keys: { p256dh: s.public_key, auth: s.auth } };
          try {
            await webpush.sendNotification(pushSub, JSON.stringify({ ping: true }), { TTL: 60 });
            // update last_ping for subscription
            try {
              await db.query('UPDATE push_subscriptions SET last_ping = now() WHERE id = $1', [s.id]);
            } catch (uerr) { /* ignore */ }
          } catch (err) {
            const code = (err && err.statusCode) || (err && err.status) || null;
            if (code === 410 || code === 404) {
              try {
                await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
                pruned_invalid_count++;
              } catch (delErr) {
                console.warn('[push.list] failed to delete stale subscription', s.id, delErr && delErr.message ? delErr.message : delErr);
              }
            } else {
              console.warn('[push.list] probe error (kept subscription):', s.id, err && err.message ? err.message : err);
            }
          }
        }
      }
    }

    const { rows: activeRows } = await db.query(`
      SELECT id, visitor_id, endpoint, browser, created_at, last_ping
      FROM push_subscriptions
      ORDER BY last_ping DESC NULLS LAST, created_at DESC
      LIMIT 500
    `);

    return res.json({
      pruned_age_count,
      pruned_invalid_count,
      active_count: (activeRows || []).length,
      subscriptions: activeRows || []
    });
  } catch (err) {
    console.error('[push.GET /api/push/list] error:', err && err.stack ? err.stack : err);
    const payload = { error: 'server_error' };
    if (process.env.NODE_ENV !== 'production') payload.detail = (err && err.message) || String(err);
    return res.status(500).json(payload);
  }
});

module.exports = router;
