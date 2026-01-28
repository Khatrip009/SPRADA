// src/routes/users.js
'use strict';

const express = require('express');
const router = express.Router();
let argon2 = null;
try { argon2 = require('argon2'); } catch (e) { /* argon2 optional; create will fail if no password provided */ }

/**
 * Helper: send consistent error JSON (development shows details)
 */
function sendErr(res, status, msg, details = null) {
  const body = { ok: false, error: msg };
  if (process.env.NODE_ENV !== 'production' && details) body.details = details;
  return res.status(status).json(body);
}

/**
 * Normalize user row for response (strip password_hash)
 */
function normalizeUserRow(row) {
  if (!row) return null;
  const copy = { ...row };
  delete copy.password_hash;
  return copy;
}

/* ------------------------
   GET /api/users
   - supports ?page=&limit=&q=
   - returns { users: [...], total }
   ------------------------ */
router.get('/', async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '12', 10)));
  const q = (req.query.q || '').trim();
  const offset = (page - 1) * limit;

  try {
    // Build WHERE clause
    const where = [];
    const params = [];
    let idx = 1;

    if (q) {
      where.push(`(email ILIKE $${idx} OR full_name ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // total count
    const countSql = `SELECT count(*)::int as total FROM users ${whereSql}`;
    const countRes = await req.db.query(countSql, params);
    const total = (countRes.rows && countRes.rows[0] && countRes.rows[0].total) || 0;

    // list rows
    const listSql = `SELECT id, email, full_name, role_id, is_active, created_at, updated_at
                     FROM users
                     ${whereSql}
                     ORDER BY created_at DESC
                     LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const rows = (await req.db.query(listSql, params)).rows || [];

    return res.json({ ok: true, users: rows, total });
  } catch (err) {
    console.error('[users.get] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

/* ------------------------
   GET /api/users/:id
   ------------------------ */
router.get('/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!id) return sendErr(res, 400, 'id required');

  try {
    const row = (await req.db.query('SELECT id, email, full_name, role_id, is_active, created_at, updated_at FROM users WHERE id = $1', [id])).rows[0];
    if (!row) return sendErr(res, 404, 'user_not_found');
    return res.json({ ok: true, user: row });
  } catch (err) {
    console.error('[users.getById] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

/* ------------------------
   POST /api/users
   body: { email, full_name, role_id, password, is_active }
   ------------------------ */
router.post('/', async (req, res, next) => {
  const { email, full_name, role_id = 3, password, is_active = true } = req.body || {};

  if (!email || !full_name) return sendErr(res, 400, 'email_and_full_name_required');

  try {
    // Hash password if provided
    let password_hash = null;
    if (password) {
      if (!argon2) {
        return sendErr(res, 500, 'password_hashing_unavailable');
      }
      password_hash = await argon2.hash(String(password));
    }

    // Use transaction if available (req.txRun). Fall back to single query.
    const runner = req.txRun ? (fn => req.txRun(fn)) : (async fn => await fn(req.db));

    const created = await runner(async (client) => {
      // Insert user and return created row
      const sql = `INSERT INTO users (email, full_name, role_id, is_active, password_hash, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, now(), now())
                   RETURNING id, email, full_name, role_id, is_active, created_at, updated_at`;
      const params = [String(email).toLowerCase(), String(full_name), Number(role_id), !!is_active, password_hash];
      const r = await (client.query ? client.query(sql, params) : client.query(sql, params));
      return r.rows[0];
    });

    return res.status(201).json({ ok: true, user: created });
  } catch (err) {
    console.error('[users.create] error:', err && err.message ? err.message : err);

    // Unique violation on email
    if (err.code === '23505') {
      return sendErr(res, 400, 'email_exists', err.detail || err.message);
    }

    // Foreign key on role_id
    if (err.code === '23503') {
      return sendErr(res, 400, 'invalid_role_id', err.detail || err.message);
    }

    return next(err);
  }
});

/* ------------------------
   PUT /api/users/:id
   body may contain: { full_name?, role_id?, is_active? }
   ------------------------ */
router.put('/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!id) return sendErr(res, 400, 'id required');

  const { full_name, role_id, is_active } = req.body || {};

  if (typeof full_name === 'undefined' && typeof role_id === 'undefined' && typeof is_active === 'undefined') {
    return sendErr(res, 400, 'no_update_fields');
  }

  // Build update dynamically
  const updates = [];
  const params = [];
  let idx = 1;
  if (typeof full_name !== 'undefined') { updates.push(`full_name = $${idx++}`); params.push(String(full_name)); }
  if (typeof role_id !== 'undefined') { updates.push(`role_id = $${idx++}`); params.push(Number(role_id)); }
  if (typeof is_active !== 'undefined') { updates.push(`is_active = $${idx++}`); params.push(Boolean(is_active)); }

  if (updates.length === 0) return sendErr(res, 400, 'no_valid_fields');

  params.push(id);
  const sql = `UPDATE users SET ${updates.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING id, email, full_name, role_id, is_active, created_at, updated_at`;

  try {
    const r = await req.db.query(sql, params);
    if (!r.rows || r.rows.length === 0) return sendErr(res, 404, 'user_not_found');
    return res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    console.error('[users.update] error:', err && err.message ? err.message : err);
    if (err.code === '23503') return sendErr(res, 400, 'invalid_role_id', err.message);
    return next(err);
  }
});

/* ------------------------
   PUT /api/users/:id/password
   body: { password }
   ------------------------ */
router.put('/:id/password', async (req, res, next) => {
  const id = req.params.id;
  const { password } = req.body || {};
  if (!id) return sendErr(res, 400, 'id required');
  if (!password || String(password).length < 6) return sendErr(res, 400, 'password_too_short_or_missing');

  if (!argon2) return sendErr(res, 500, 'password_hashing_unavailable');

  try {
    const hash = await argon2.hash(String(password));
    const r = await req.db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 RETURNING id, email, full_name, role_id, is_active, created_at, updated_at', [hash, id]);
    if (!r.rows || r.rows.length === 0) return sendErr(res, 404, 'user_not_found');
    return res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    console.error('[users.changePassword] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

/* ------------------------
   DELETE /api/users/:id
   ------------------------ */
router.delete('/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!id) return sendErr(res, 400, 'id required');

  try {
    // Optionally protect deletion of system admin: you can add checks here if necessary.
    const r = await req.db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (!r.rows || r.rows.length === 0) return sendErr(res, 404, 'user_not_found');
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[users.delete] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

module.exports = router;
