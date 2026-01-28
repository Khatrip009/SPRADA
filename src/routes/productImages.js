// src/routes/productImages.js
'use strict';

const express = require('express');
const router = express.Router();
const { validate: isUuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const UPLOAD_ROOT = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'); // adjust if needed
const { buildImageUrl } = require('../lib/buildUrl');

/**
 * productImages routes (mounted at /api/product-images)
 * - GET /?product_id=...       => list product images for a product
 * - GET /:id                   => single image detail
 * - POST /                     => create image record (body: { product_id, filename or url, is_primary?, width?, height?, filesize? })
 * - PATCH /:id                 => update image metadata (filename, url, is_primary, width, height, filesize)
 *
 * Notes:
 * - Ensures transaction-local GUCs app.user_id and app.user_role are set inside req.txRun transactions
 *   so Postgres RLS policies that check current_setting('app.user_id', true) / app.user_role will see them.
 * - Adds optional diagnostic query inside transactions to log effective settings (can be removed later).
 */

/* ===========================
   Helpers
   =========================== */

function badRequest(res, msg = 'bad_request') {
  return res.status(400).json({ ok: false, error: msg });
}

function publicUrlForRow(row) {
  if (!row) return null;
  if (row.url) return buildImageUrl(row.url);
  if (row.filename) {
    const p = `/uploads/products/${row.filename}`;
    return buildImageUrl(p);
  }
  return null;
}

/* ===========================
   Helper: set transaction GUCs
   =========================== */
async function setAppUserGucs(client, req) {
  try {
    const userId = req.user && (req.user.id || req.user.user_id || req.user.sub)
      ? String(req.user.id || req.user.user_id || req.user.sub)
      : null;
    if (userId) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    }
  } catch (err) {
    console.warn('[setAppUserGucs] set_config(app.user_id) failed:', err && err.message ? err.message : err);
  }

  try {
    const userRole = req.user && (req.user.role || req.user.role_id || req.user.roleId)
      ? String(req.user.role || req.user.role_id || req.user.roleId)
      : null;
    if (userRole) {
      await client.query("SELECT set_config('app.user_role', $1, true)", [userRole]);
    }
  } catch (err) {
    console.warn('[setAppUserGucs] set_config(app.user_role) failed:', err && err.message ? err.message : err);
  }
}

/* ===========================
   Helper: basic auth guard
   =========================== */
function requireAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

/* ===========================
   OPTIONS handlers (CORS preflight)
   =========================== */
router.options('/', (req, res) => res.sendStatus(204));
router.options('/:id', (req, res) => res.sendStatus(204));

/* ===========================
   Utility: normalize & validate UUID param/value
   - returns { ok: true, value } or { ok: false, err }
   =========================== */
function normalizeUuidCandidate(maybe) {
  // Accept string-like inputs; also guard arrays accidentally produced by repeated query params.
  if (Array.isArray(maybe)) maybe = maybe[0];
  const s = (maybe == null) ? '' : String(maybe).trim();
  if (!s) return { ok: false, err: 'missing_parameter' };
  if (!isUuid(s)) return { ok: false, err: 'invalid_uuid' };
  return { ok: true, value: s };
}

/* --------------------------------------------------------------------------
   GET /  (list images for a product)
   query: product_id (required)
-------------------------------------------------------------------------- */
router.get('/', async (req, res, next) => {
  try {
    const db = req.db;
    if (!db) return res.status(500).json({ ok: false, error: 'server_db_not_attached' });

    const rawProductId = req.query.product_id;
    const norm = normalizeUuidCandidate(rawProductId);
    if (!norm.ok) {
      // Diagnostic: log when incoming value exists but is invalid/empty so client can be fixed.
      console.warn('[productImages.GET] invalid product_id:', rawProductId, 'from', req.ip);
      return badRequest(res, norm.err === 'missing_parameter' ? 'missing_parameter: product_id required' : 'invalid_parameter: product_id must be uuid');
    }
    const productId = norm.value;

    const q = `
      SELECT id, product_id, filename, url, is_primary, width, height, filesize, created_at
      FROM product_images
      WHERE product_id = $1
      ORDER BY is_primary DESC NULLS LAST, created_at ASC
    `;
    const r = await db.query(q, [productId]);
    const items = r.rows.map(img => ({
      id: img.id,
      url: publicUrlForRow(img),
      filename: img.filename || null,
      is_primary: !!img.is_primary,
      width: img.width == null ? null : Number(img.width),
      height: img.height == null ? null : Number(img.height),
      filesize: img.filesize == null ? null : Number(img.filesize),
      created_at: img.created_at
    }));

    return res.json({ ok: true, product_id: productId, items });
  } catch (err) {
    console.error('[productImages.GET /] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

/* --------------------------------------------------------------------------
   GET /:id  (single image)
-------------------------------------------------------------------------- */
router.get('/:id', async (req, res, next) => {
  try {
    const db = req.db;
    if (!db) return res.status(500).json({ ok: false, error: 'server_db_not_attached' });

    const norm = normalizeUuidCandidate(req.params.id);
    if (!norm.ok) {
      console.warn('[productImages.GET /:id] invalid id param:', req.params.id, 'from', req.ip);
      return badRequest(res, norm.err === 'missing_parameter' ? 'missing_parameter: id required' : 'invalid_parameter: id must be uuid');
    }
    const id = norm.value;

    const q = `
      SELECT id, product_id, filename, url, is_primary, width, height, filesize, created_at
      FROM product_images WHERE id = $1 LIMIT 1
    `;
    const r = await db.query(q, [id]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
    const img = r.rows[0];
    const out = {
      id: img.id,
      product_id: img.product_id,
      url: publicUrlForRow(img),
      filename: img.filename || null,
      is_primary: !!img.is_primary,
      width: img.width == null ? null : Number(img.width),
      height: img.height == null ? null : Number(img.height),
      filesize: img.filesize == null ? null : Number(img.filesize),
      created_at: img.created_at
    };
    return res.json({ ok: true, image: out });
  } catch (err) {
    console.error('[productImages.GET /:id] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

/* --------------------------------------------------------------------------
   POST /  (create image record)
   body: { product_id, filename (or url), is_primary?, width?, height?, filesize? }
   Requires authentication (at least).
-------------------------------------------------------------------------- */
router.post('/', async (req, res, next) => {
  try {
    const db = req.db;
    if (!db) return res.status(500).json({ ok: false, error: 'server_db_not_attached' });

    // Require authentication for creating product images
    if (!requireAuth(req, res)) return;

    const { product_id: rawProductId, filename, url, is_primary, width, height, filesize } = req.body || {};

    // Validate product_id strictly
    const norm = normalizeUuidCandidate(rawProductId);
    if (!norm.ok) {
      console.warn('[productImages.POST] invalid product_id:', rawProductId, 'from', req.ip);
      return badRequest(res, norm.err === 'missing_parameter' ? 'missing_parameter: product_id required' : 'invalid_parameter: product_id must be uuid');
    }
    const product_id = norm.value;

    if (!filename && !url) return res.status(400).json({ ok: false, error: 'missing_parameter', message: 'filename or url required' });

    const storedFilename = filename || null;
    const storedUrl = url || null;

    // optional product validation (still good to keep)
    try {
      const pr = await db.query('SELECT id FROM products WHERE id = $1 LIMIT 1', [product_id]);
      if (!pr.rows[0]) return res.status(400).json({ ok: false, error: 'invalid_product_id' });
    } catch (prodErr) {
      console.warn('[productImages.POST] product validation failed:', prodErr && prodErr.message ? prodErr.message : prodErr);
    }

    if (typeof req.txRun === 'function') {
      // Use transaction helper and ensure GUCs are set inside the transaction
      const created = await req.txRun(async (client) => {
        // Set app.user_id and app.user_role visible to RLS
        await setAppUserGucs(client, req);

        // Diagnostic: show what RLS will see (optional)
        try {
          const diag = await client.query(`
            SELECT current_setting('app.user_id', true) AS app_user_id,
                   current_setting('app.user_role', true) AS app_user_role,
                   current_user, session_user
          `);
          console.debug('[productImages.POST][tx][diag]', diag.rows[0]);
        } catch (dErr) {
          console.warn('[productImages.POST][tx][diag] failed', dErr && dErr.message ? dErr.message : dErr);
        }

        // If setting primary, clear other primaries for this product
        if (is_primary === true) {
          await client.query('UPDATE product_images SET is_primary = false WHERE product_id = $1', [product_id]);
        }

        const q = `
          INSERT INTO product_images
            (product_id, filename, url, is_primary, width, height, filesize, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          RETURNING *
        `;
        const vals = [product_id, storedFilename, storedUrl, !!is_primary, width ?? null, height ?? null, filesize ?? null];
        const r = await client.query(q, vals);
        return r.rows[0];
      }, {
        // also pass them in to the txRun wrapper for completeness
        userId: req.user && (req.user.id || req.user.user_id || req.user.sub) ? String(req.user.id || req.user.user_id || req.user.sub) : null,
        userRole: req.user && (req.user.role || req.user.role_id) ? String(req.user.role || req.user.role_id) : null
      });

      const out = {
        id: created.id,
        product_id: created.product_id,
        url: publicUrlForRow(created),
        filename: created.filename || null,
        is_primary: !!created.is_primary,
        width: created.width == null ? null : Number(created.width),
        height: created.height == null ? null : Number(created.height),
        filesize: created.filesize == null ? null : Number(created.filesize),
        created_at: created.created_at
      };
      return res.status(201).json({ ok: true, image: out });
    }

    // fallback: no req.txRun available — plain insert
    const q = `
      INSERT INTO product_images
        (product_id, filename, url, is_primary, width, height, filesize, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING *
    `;
    const r = await db.query(q, [product_id, storedFilename, storedUrl, !!is_primary, width ?? null, height ?? null, filesize ?? null]);
    const created = r.rows[0];
    const out = {
      id: created.id,
      product_id: created.product_id,
      url: publicUrlForRow(created),
      filename: created.filename || null,
      is_primary: !!created.is_primary,
      width: created.width == null ? null : Number(created.width),
      height: created.height == null ? null : Number(created.height),
      filesize: created.filesize == null ? null : Number(created.filesize),
      created_at: created.created_at
    };
    return res.status(201).json({ ok: true, image: out });
  } catch (err) {
    console.error('[productImages.POST /] error:', err && err.message ? err.message : err);
    return next(err);
  }
});

/* --------------------------------------------------------------------------
   PATCH /:id  (update image metadata)
-------------------------------------------------------------------------- */
router.patch('/:id', async (req, res, next) => {
  try {
    const db = req.db;
    if (!db) return res.status(500).json({ ok: false, error: 'server_db_not_attached' });

    // Require authentication
    if (!requireAuth(req, res)) return;

    // Validate id param
    const normId = normalizeUuidCandidate(req.params.id);
    if (!normId.ok) {
      console.warn('[productImages.PATCH] invalid id param:', req.params.id, 'from', req.ip);
      return badRequest(res, normId.err === 'missing_parameter' ? 'missing_parameter: id required' : 'invalid_parameter: id must be uuid');
    }
    const id = normId.value;

    const body = req.body || {};

    if (typeof req.txRun !== 'function') {
      const fields = [];
      const params = [];
      let idx = 1;
      if (body.filename !== undefined) { fields.push(`filename=$${idx++}`); params.push(body.filename); }
      if (body.url !== undefined) { fields.push(`url=$${idx++}`); params.push(body.url); }
      if (body.is_primary !== undefined) { fields.push(`is_primary=$${idx++}`); params.push(body.is_primary); }
      if (body.width !== undefined) { fields.push(`width=$${idx++}`); params.push(body.width); }
      if (body.height !== undefined) { fields.push(`height=$${idx++}`); params.push(body.height); }
      if (body.filesize !== undefined) { fields.push(`filesize=$${idx++}`); params.push(body.filesize); }

      if (!fields.length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });

      const q = `UPDATE product_images SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`;
      params.push(id);
      const r = await db.query(q, params);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
      const img = r.rows[0];
      const out = {
        id: img.id,
        url: publicUrlForRow(img),
        filename: img.filename || null,
        is_primary: !!img.is_primary,
        width: img.width == null ? null : Number(img.width),
        height: img.height == null ? null : Number(img.height),
        filesize: img.filesize == null ? null : Number(img.filesize),
        created_at: img.created_at
      };
      return res.json({ ok: true, image: out });
    }

    // Transactional update (req.txRun present)
    const updated = await req.txRun(async (client) => {
      // Set app user gucs inside this transaction so RLS can see them
      await setAppUserGucs(client, req);

      // Diagnostic: see settings visible to RLS
      try {
        const diag = await client.query(`
          SELECT current_setting('app.user_id', true) AS app_user_id,
                 current_setting('app.user_role', true) AS app_user_role,
                 current_user, session_user
        `);
        console.debug('[productImages.PATCH][tx][diag]', diag.rows[0]);
      } catch (dErr) {
        console.warn('[productImages.PATCH][tx][diag] failed', dErr && dErr.message ? dErr.message : dErr);
      }

      const cur = await client.query('SELECT id, product_id, filename, url, is_primary, width, height, filesize, created_at FROM product_images WHERE id = $1 LIMIT 1', [id]);
      const curRow = cur.rows[0];
      if (!curRow) throw Object.assign(new Error('not_found'), { status: 404 });

      if (body.is_primary === true) {
        await client.query('UPDATE product_images SET is_primary = false WHERE product_id = $1 AND id <> $2', [curRow.product_id, id]);
      }

      const fields = [];
      const params = [];
      let idx = 1;
      if (body.filename !== undefined) { fields.push(`filename=$${idx++}`); params.push(body.filename); }
      if (body.url !== undefined) { fields.push(`url=$${idx++}`); params.push(body.url); }
      if (body.is_primary !== undefined) { fields.push(`is_primary=$${idx++}`); params.push(body.is_primary); }
      if (body.width !== undefined) { fields.push(`width=$${idx++}`); params.push(body.width); }
      if (body.height !== undefined) { fields.push(`height=$${idx++}`); params.push(body.height); }
      if (body.filesize !== undefined) { fields.push(`filesize=$${idx++}`); params.push(body.filesize); }

      if (fields.length) {
        const q = `UPDATE product_images SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`;
        params.push(id);
        const ur = await client.query(q, params);
        return ur.rows[0];
      }
      return curRow;
    }, {
      userId: req.user && (req.user.id || req.user.user_id || req.user.sub) ? String(req.user.id || req.user.user_id || req.user.sub) : null,
      userRole: req.user && (req.user.role || req.user.role_id) ? String(req.user.role || req.user.role_id) : null
    });

    const out = {
      id: updated.id,
      url: publicUrlForRow(updated),
      filename: updated.filename || null,
      is_primary: !!updated.is_primary,
      width: updated.width == null ? null : Number(updated.width),
      height: updated.height == null ? null : Number(updated.height),
      filesize: updated.filesize == null ? null : Number(updated.filesize),
      created_at: updated.created_at
    };
    return res.json({ ok: true, image: out });
  } catch (err) {
    console.error('[productImages.PATCH /:id] error:', err && err.message ? err.message : err);
    if (err && err.status === 404) return res.status(404).json({ ok: false, error: 'not_found' });
    return next(err);
  }
});

// ----- DELETE /:id -----
router.delete('/:id', async (req, res, next) => {
  try {
    const db = req.db;
    const id = req.params.id;
    if (!db) return res.status(500).json({ ok: false, error: 'server_db_not_attached' });

    // basic id validation (uuid-like simple check)
    if (!id || String(id).trim() === '') {
      return res.status(400).json({ ok: false, error: 'missing_id' });
    }

    // Use transaction helper if available so we can set GUCs and rely on RLS
    if (typeof req.txRun === 'function') {
      const deleted = await req.txRun(async (client) => {
        // set GUCs so RLS can evaluate
        try {
          const userId = req.user && (req.user.id || req.user.user_id || req.user.sub) ? String(req.user.id || req.user.user_id || req.user.sub) : null;
          if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
          const userRole = req.user && (req.user.role || req.user.role_id) ? String(req.user.role || req.user.role_id) : null;
          if (userRole) await client.query("SELECT set_config('app.user_role', $1, true)", [userRole]);
        } catch (e) {
          console.warn('[productImages.DELETE] set_config failed (non-fatal):', e && e.message ? e.message : e);
        }

        // load current row
        const cur = await client.query('SELECT id, product_id, filename, url FROM product_images WHERE id = $1 LIMIT 1', [id]);
        if (!cur.rows[0]) throw Object.assign(new Error('not_found'), { status: 404 });
        const row = cur.rows[0];

        // delete DB row
        await client.query('DELETE FROM product_images WHERE id = $1', [id]);

        // return row info for optional file deletion
        return row;
      }, {
        userId: req.user && (req.user.id || req.user.user_id || req.user.sub) ? String(req.user.id || req.user.user_id || req.user.sub) : null,
        userRole: req.user && (req.user.role || req.user.role_id) ? String(req.user.role || req.user.role_id) : null
      });

      // Optionally delete file from disk if filename exists
      if (deleted && deleted.filename) {
        try {
          const safeName = path.basename(deleted.filename); // prevents path traversal
          const filePath = path.join(UPLOAD_ROOT, 'products', safeName);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
            console.debug('[productImages.DELETE] removed file', filePath);
          } else {
            console.debug('[productImages.DELETE] file not found on disk', filePath);
          }
        } catch (fsErr) {
          console.warn('[productImages.DELETE] failed to remove file (non-fatal):', fsErr && fsErr.message ? fsErr.message : fsErr);
        }
      }

      return res.json({ ok: true, id });
    }

    // fallback if req.txRun not present - do non-transactional delete
    const cur = await db.query('SELECT id, filename FROM product_images WHERE id=$1 LIMIT 1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });

    await db.query('DELETE FROM product_images WHERE id = $1', [id]);

    // try delete file local (best-effort)
    if (cur.rows[0].filename) {
      try {
        const safeName = path.basename(cur.rows[0].filename);
        const filePath = path.join(UPLOAD_ROOT, 'products', safeName);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        console.warn('[productImages.DELETE] fallback file delete failed (non-fatal)', e && e.message ? e.message : e);
      }
    }

    return res.json({ ok: true, id });
  } catch (err) {
    if (err && err.status === 404) return res.status(404).json({ ok: false, error: 'not_found' });
    console.error('[productImages.DELETE /:id] error:', err && err.message ? err.message : err);
    return next(err);
  }
});


module.exports = router;
