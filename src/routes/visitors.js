// src/routes/visitors.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/**
 * Very simple UUID v4-ish check (for safety)
 */
function looksLikeUuid(s) {
  if (!s || typeof s !== 'string') return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s.trim());
}

/**
 * Acquire a client from pool and optionally set a session guard variable.
 * If your RLS policies require current_setting('app.is_backend') = '1', set
 * DB_USE_SESSION_GUARD=1 in your environment and this helper will set it.
 */
async function getClient() {
  const client = await pool.connect();
  try {
    if (process.env.DB_USE_SESSION_GUARD && process.env.DB_USE_SESSION_GUARD !== '0') {
      // tolerate failure (current_setting could not exist); don't throw
      try {
        await client.query("SET LOCAL app.is_backend = '1'");
      } catch (e) {
        // ignore: server may not have the setting or role may not allow it
        // but don't let this block normal operation
        // console.debug('[visitors] could not set session guard:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    client.release();
    throw e;
  }
  return client;
}

/**
 * Resolve visitor id:
 *  - if maybeUuidOrSession looks like UUID -> return it
 *  - otherwise upsert the visitors table (SELECT FOR UPDATE -> UPDATE OR INSERT)
 *
 * Uses a dedicated client so caller can include further statements (e.g. insert analytics_event) in the same transaction.
 *
 * Returns: { visitorId, client }
 * Caller is responsible for COMMIT/ROLLBACK and client.release()
 */
async function resolveVisitorIdWithClient(maybeUuidOrSession, ip = null, ua = null, meta = {}) {
  if (looksLikeUuid(maybeUuidOrSession)) {
    // we return null client to indicate no DB client was acquired by us
    return { visitorId: maybeUuidOrSession.trim(), client: null, usedTransaction: false };
  }

  const session_id = String(maybeUuidOrSession || '').trim();
  if (!session_id) throw new Error('session_id empty');

  const client = await getClient();

  try {
    // start transaction
    await client.query('BEGIN');

    // try to find existing visitor row for this session_id (lock row if found)
    const selQ = `SELECT id, metadata, ip, user_agent FROM public.visitors WHERE session_id = $1 LIMIT 1 FOR UPDATE`;
    const selRes = await client.query(selQ, [session_id]);

    if (selRes.rows && selRes.rows.length > 0) {
      const existing = selRes.rows[0];
      const existingMeta = existing.metadata || {};
      // merge metadata: existing first, then incoming meta (incoming keys override)
      const mergedMeta = Object.assign({}, existingMeta, meta || {});

      const updQ = `
        UPDATE public.visitors
           SET last_seen = now(),
               ip = COALESCE($1, ip),
               user_agent = COALESCE($2, user_agent),
               metadata = $3
         WHERE id = $4
         RETURNING id
      `;
      const updRes = await client.query(updQ, [ip || null, ua || null, mergedMeta, existing.id]);
      if (updRes.rows && updRes.rows[0] && updRes.rows[0].id) {
        // do not commit here — caller should commit/rollback so they can include more statements
        return { visitorId: updRes.rows[0].id, client, usedTransaction: true };
      } else {
        throw new Error('failed_update_visitor');
      }
    } else {
      // insert new visitor
      const insQ = `
        INSERT INTO public.visitors (session_id, ip, user_agent, metadata, first_seen, last_seen)
        VALUES ($1, $2, $3, $4, now(), now())
        RETURNING id
      `;
      const insRes = await client.query(insQ, [session_id, ip || null, ua || null, meta || {}]);
      if (insRes.rows && insRes.rows[0] && insRes.rows[0].id) {
        return { visitorId: insRes.rows[0].id, client, usedTransaction: true };
      } else {
        throw new Error('failed_create_visitor');
      }
    }
  } catch (err) {
    // rollback handled by caller if necessary; but we should rollback here to be safe
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    client.release();
    throw err;
  }
}

/* POST /api/visitors/identify
   body: { session_id, ip?, ua?, meta? }
   returns: { visitor_id }
*/
router.post('/identify', async (req, res) => {
  const { session_id, ip: bodyIp, ua: bodyUa, meta = {} } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const ip = bodyIp || req.ip || (req.headers && req.headers['x-forwarded-for']) || null;
  const ua = bodyUa || req.get('User-Agent') || null;

  let client = null;
  try {
    // resolveVisitorIdWithClient will start a transaction and return client
    const { visitorId, client: gotClient, usedTransaction } = await resolveVisitorIdWithClient(session_id, ip, ua, meta);
    client = gotClient;

    if (usedTransaction && client) {
      await client.query('COMMIT');
      client.release();
    }

    return res.json({ visitor_id: visitorId });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { }
      client.release();
    }
    console.error('[visitors.identify] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

/* POST /api/visitors/event
   body: { visitor_id | session_id, event_type, event_props? }
   - If session_id provided it will be upserted to visitors table first.
   - Both upsert and analytics insert are performed in a single transaction for consistency.
*/
/* POST /api/visitors/event
   body: { visitor_id | session_id, event_type, event_props? }
   - If session_id provided it will be upserted to visitors table first.
   - Both upsert and analytics insert are performed in a single transaction for consistency.
*/
router.post('/event', async (req, res) => {
  const { visitor_id, session_id, event_type, event_props = {} } = req.body || {};

  if (!event_type) return res.status(400).json({ error: 'event_type required' });
  if (!visitor_id && !session_id) return res.status(400).json({ error: 'visitor_id or session_id required' });

  // prefer explicit visitor_id
  const incoming = visitor_id || session_id;
  const ip = req.ip || (req.headers && req.headers['x-forwarded-for']) || null;
  const ua = req.get('User-Agent') || null;

  let client = null;
  try {
    // Resolve visitor id using a client and keep same client for analytics insert
    const { visitorId, client: gotClient, usedTransaction } = await resolveVisitorIdWithClient(incoming, ip, ua, {});
    client = gotClient;

    // If resolveVisitorId returned a visitorId but no client (incoming was already a UUID),
    // open a client here so we can perform the analytics insert in a transaction for consistency.
    if (!client) {
      client = await getClient();
      await client.query('BEGIN');

      // Verify the visitor actually exists. If not, create a minimal visitor row so FK holds.
      // (This accepts the supplied UUID as the new visitor.id.)
      const checkQ = `SELECT id FROM public.visitors WHERE id = $1 LIMIT 1`;
      const checkRes = await client.query(checkQ, [visitorId]);

      if (!checkRes.rows || checkRes.rows.length === 0) {
        // Insert a minimal visitor record with the provided UUID to satisfy FK.
        // session_id is left NULL (we don't have one), metadata is empty object.
        const insertVisitorQ = `
          INSERT INTO public.visitors (id, session_id, ip, user_agent, metadata, first_seen, last_seen)
          VALUES ($1, NULL, $2, $3, $4, now(), now())
        `;
        await client.query(insertVisitorQ, [visitorId, ip || null, ua || null, {}]);
      }
    }

    // At this point we have a client and a valid visitorId row in DB.
    const insertQ = `
      INSERT INTO public.analytics_events (visitor_id, event_type, event_props)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `;
    await client.query(insertQ, [visitorId, event_type, event_props || {}]);

    // commit transaction
    await client.query('COMMIT');
    client.release();

    return res.json({ ok: true, visitor_id: visitorId });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { }
      client.release();
    }
    console.error('[visitors.event] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
});

/**
 * GET /api/visitors/list
 * Query params:
 *   - limit (optional, default 50)
 *   - since (optional ISO timestamp) — return visitors seen after this time
 *
 * Response: [{ id, session_id, ip, user_agent, metadata, first_seen, last_seen, events_count }, ...]
 */
router.get('/list', async (req, res) => {
  const qLimit = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const since = req.query.since ? new Date(req.query.since) : null;

  // If pool not present, return demo data so frontend doesn't 404
  if (!pool || typeof pool.query !== 'function') {
    console.warn('[visitors.list] DB pool not available — returning demo data');
    const now = new Date();
    const demo = Array.from({ length: Math.min(10, qLimit) }).map((_, i) => ({
      id: `demo-${i + 1}`,
      session_id: `session-demo-${i + 1}`,
      ip: `127.0.0.${i + 1}`,
      user_agent: `DemoAgent/1.0 (demo ${i + 1})`,
      metadata: { demo: true, idx: i + 1 },
      first_seen: new Date(now.getTime() - (i + 1) * 1000 * 60 * 60).toISOString(),
      last_seen: new Date(now.getTime() - i * 1000 * 60).toISOString(),
      events_count: Math.floor(Math.random() * 10)
    }));
    return res.json(demo);
  }

  try {
    // Build query with optional since filter
    const params = [qLimit];
    let whereClause = '';
    if (since && !Number.isNaN(since.getTime())) {
      // Use parameterized since at position 2
      params.push(since.toISOString());
      whereClause = `WHERE v.last_seen >= $2`;
    }

    // Query: select visitor columns and count of analytics events
    // NOTE: metadata is returned as JSON (Postgres json/jsonb)
    const sql = `
      SELECT
        v.id,
        v.session_id,
        v.ip,
        v.user_agent,
        v.metadata,
        to_char(v.first_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen,
        to_char(v.last_seen  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
        COALESCE(a.event_count, 0) AS events_count
      FROM public.visitors v
      LEFT JOIN (
        SELECT visitor_id, COUNT(*) AS event_count
        FROM public.analytics_events
        GROUP BY visitor_id
      ) a ON a.visitor_id = v.id
      ${whereClause}
      ORDER BY v.last_seen DESC NULLS LAST
      LIMIT $1
    `;

    const result = await pool.query(sql, params);

    // Normalize rows: ensure metadata is object if text
    const rows = (result.rows || []).map(r => {
      let meta = r.metadata;
      try {
        if (typeof meta === 'string') meta = JSON.parse(meta);
      } catch (e) { /* keep as-is */ }
      return {
        id: r.id,
        session_id: r.session_id,
        ip: r.ip,
        user_agent: r.user_agent,
        metadata: meta || {},
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        events_count: Number(r.events_count || 0)
      };
    });

    return res.json(rows);
  } catch (err) {
    console.error('[visitors.list] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
});


module.exports = router;
