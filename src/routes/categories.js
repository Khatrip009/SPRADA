// -----------------------------
// src/routes/categories.js
// (updated) — adds pagination, trade_type filtering and search for website use
// -----------------------------

const express2 = require('express');
const router2 = express2.Router();
const { v4: uuidv42 } = require('uuid');

const ALLOWED_TRADE_TYPES2 = new Set(['import', 'export', 'both']);

/* -----------------------------------------------------------------------
   Helpers
------------------------------------------------------------------------ */
function slugify(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeTradeTypeInput2(v) {
  if (v == null) return null;
  try {
    const s = String(v).trim().toLowerCase();
    if (!s) return null;
    return ALLOWED_TRADE_TYPES2.has(s) ? s : null;
  } catch {
    return null;
  }
}

function requireAuth2(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  return null;
}

function requireEditorOrAdmin2(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  const role = Number(req.user.role); // 1 = admin, 2 = editor
  if (role === 1 || role === 2) return null;
  return res.status(403).json({ ok: false, error: "forbidden" });
}

/* -----------------------------------------------------------------------
   GET /api/categories
   Supports: ?include_counts=true, ?page, ?limit, ?q, ?trade_type
------------------------------------------------------------------------ */
router2.get('/', async (req, res) => {
  const db = req.db;
  const includeCounts = String(req.query.include_counts || "").toLowerCase() === "true";

  try {
    if (!db) throw new Error("database pool unavailable");

    // Pagination params (useable by website)
    const page = Math.max(1, Number(req.query.page || 1));
    let limit = Math.max(1, Number(req.query.limit || 100));
    if (limit > 1000) limit = 1000; // safe upper bound
    const offset = (page - 1) * limit;

    const q = (req.query.q || null);
    const trade_type = (req.query.trade_type ?? null);

    const filters = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      filters.push(`(c.name ILIKE $${params.length} OR c.slug ILIKE $${params.length} OR c.description ILIKE $${params.length})`);
    }

    if (trade_type) {
      const nt = normalizeTradeTypeInput2(trade_type);
      if (nt === null) return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
      params.push(nt);
      filters.push(`(c.trade_type = $${params.length})`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    if (includeCounts) {
      // If includeCounts is true, return all matching categories with product_count and paginated
      const qtext = `
        SELECT c.id, c.slug, c.name, c.description, c.parent_id, c.trade_type,
               COALESCE(pc.product_count, 0) AS product_count
        FROM categories c
        LEFT JOIN (
          SELECT category_id, COUNT(*)::int AS product_count
          FROM products
          GROUP BY category_id
        ) pc ON pc.category_id = c.id
        ${where}
        ORDER BY c.sort_order NULLS LAST, c.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(limit, offset);
      const { rows } = await db.query(qtext, params);

      // total count for pagination
      let total = 0;
      try {
        const countQ = `SELECT COUNT(*)::int AS total FROM categories c ${where}`;
        const countParams = params.slice(0, params.length - 2);
        const cr = await db.query(countQ, countParams);
        total = cr.rows[0]?.total ?? 0;
      } catch (countErr) {
        console.warn('[categories.GET] count failed', countErr && countErr.message ? countErr.message : countErr);
      }

      const total_pages = total != null ? Math.ceil(total / limit) : null;

      return res.json({ ok: true, categories: rows, page, limit, total, total_pages });
    }

    // default (no counts): return paginated categories
    const qtextNoCounts = `SELECT id, slug, name, description, parent_id, trade_type FROM categories ${where} ORDER BY sort_order NULLS LAST, name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await db.query(qtextNoCounts, params);

    // total
    let total = 0;
    try {
      const countQ = `SELECT COUNT(*)::int AS total FROM categories c ${where}`;
      const countParams = params.slice(0, params.length - 2);
      const cr = await db.query(countQ, countParams);
      total = cr.rows[0]?.total ?? 0;
    } catch (countErr) {
      console.warn('[categories.GET] count failed', countErr && countErr.message ? countErr.message : countErr);
    }

    const total_pages = total != null ? Math.ceil(total / limit) : null;

    return res.json({ ok: true, categories: rows, page, limit, total, total_pages });
  } catch (err) {
    console.error('[categories.GET /] error:', err);
    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

/* -----------------------------------------------------------------------
   GET /api/categories/:id
------------------------------------------------------------------------ */
router2.get('/:id', async (req, res) => {
  const db = req.db;
  const id = req.params.id;

  try {
    if (!db) throw new Error("database pool unavailable");

    const { rows } = await db.query(
      `SELECT id, slug, name, description, parent_id, trade_type FROM categories WHERE id=$1 LIMIT 1`,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });

    return res.json({ ok: true, category: rows[0] });
  } catch (err) {
    console.error("[categories.GET /:id] error:", err);
    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

/* -----------------------------------------------------------------------
   POST /api/categories
   Body: { name, slug?, description?, parent_id?, sort_order?, trade_type? }
   Roles: admin/editor only
------------------------------------------------------------------------ */
router2.post('/', async (req, res) => {
  if (requireEditorOrAdmin2(req, res)) return;

  const db = req.db;
  const body = req.body || {};

  try {
    if (!db) throw new Error("database pool unavailable");

    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    const trade_type_input = body.trade_type ?? 'both';
    const normalized = normalizeTradeTypeInput2(trade_type_input);
    if (normalized === null) {
      return res.status(400).json({ ok: false, error: "invalid_trade_type" });
    }
    const trade_type = normalized;

    const newId = uuidv42();
    const slug = slugify(body.slug || body.name);
    const description = body.description || null;
    const parent_id = body.parent_id || null;
    const sort_order = Number.isInteger(body.sort_order) ? body.sort_order : 0;

    // Use transaction if available
    if (req.txRun) {
      const created = await req.txRun(async client => {
        const dup = await client.query(`SELECT id FROM categories WHERE slug=$1 LIMIT 1`, [slug]);
        if (dup.rows[0]) throw Object.assign(new Error("slug_conflict"), { status: 409 });

        await client.query(
          `INSERT INTO categories (id, slug, name, description, parent_id, sort_order, trade_type, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())`,
          [newId, slug, body.name, description, parent_id, sort_order, trade_type]
        );

        const r = await client.query(
          `SELECT id, slug, name, description, parent_id, trade_type FROM categories WHERE id=$1`,
          [newId]
        );

        return r.rows[0];
      });

      return res.status(201).json({ ok: true, category: created });
    }

    // fallback (no txRun)
    const dup = await db.query(`SELECT id FROM categories WHERE slug=$1 LIMIT 1`, [slug]);
    if (dup.rows[0]) return res.status(409).json({ ok: false, error: "slug_conflict" });

    await db.query(
      `INSERT INTO categories (id, slug, name, description, parent_id, sort_order, trade_type, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())`,
      [newId, slug, body.name, description, parent_id, sort_order, trade_type]
    );

    const r = await db.query(
      `SELECT id, slug, name, description, parent_id, trade_type FROM categories WHERE id=$1`,
      [newId]
    );

    return res.status(201).json({ ok: true, category: r.rows[0] });
  } catch (err) {
    console.error("[categories.POST] error:", err);

    if (err.status === 409) {
      return res.status(409).json({ ok: false, error: "slug_conflict" });
    }

    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

/* -----------------------------------------------------------------------
   PUT /api/categories/:id
   Roles: admin/editor only
------------------------------------------------------------------------ */
router2.put('/:id', async (req, res) => {
  if (requireEditorOrAdmin2(req, res)) return;

  const db = req.db;
  const id = req.params.id;
  const body = req.body || {};

  try {
    if (!db) throw new Error("database pool unavailable");

    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ ok: false, error: "name_required" });
    }

    const trade_type_input = body.trade_type ?? null;
    let trade_type = null;
    if (trade_type_input != null) {
      const normalized = normalizeTradeTypeInput2(trade_type_input);
      if (normalized === null) {
        return res.status(400).json({ ok: false, error: "invalid_trade_type" });
      }
      trade_type = normalized;
    }

    const slug = slugify(body.slug || body.name);
    const description = body.description || null;
    const parent_id = body.parent_id || null;
    const sort_order = Number.isInteger(body.sort_order) ? body.sort_order : 0;

    if (req.txRun) {
      const updated = await req.txRun(async client => {
        const exists = await client.query(`SELECT id FROM categories WHERE id=$1 LIMIT 1`, [id]);
        if (!exists.rows[0])
          throw Object.assign(new Error("not_found"), { status: 404 });

        const dup = await client.query(
          `SELECT id FROM categories WHERE slug=$1 AND id != $2 LIMIT 1`,
          [slug, id]
        );
        if (dup.rows[0])
          throw Object.assign(new Error("slug_conflict"), { status: 409 });

        const q = `
          UPDATE categories SET
            name=$1, slug=$2, description=$3, parent_id=$4, sort_order=$5,
            trade_type=$6, updated_at=now()
          WHERE id=$7
          RETURNING id, slug, name, description, parent_id, trade_type
        `;

        const r = await client.query(q, [body.name, slug, description, parent_id, sort_order, trade_type || 'both', id]);
        return r.rows[0];
      });

      return res.json({ ok: true, category: updated });
    }

    // fallback
    const exists = await db.query(`SELECT id FROM categories WHERE id=$1 LIMIT 1`, [id]);
    if (!exists.rows[0]) return res.status(404).json({ ok: false, error: "not_found" });

    const dup = await db.query(`SELECT id FROM categories WHERE slug=$1 AND id != $2 LIMIT 1`, [
      slug,
      id,
    ]);
    if (dup.rows[0]) return res.status(409).json({ ok: false, error: "slug_conflict" });

    const q = `
      UPDATE categories SET
        name=$1, slug=$2, description=$3, parent_id=$4, sort_order=$5, trade_type=$6, updated_at=now()
      WHERE id=$7
      RETURNING id, slug, name, description, parent_id, trade_type
    `;
    const r = await db.query(q, [body.name, slug, description, parent_id, sort_order, trade_type || 'both', id]);

    return res.json({ ok: true, category: r.rows[0] });
  } catch (err) {
    console.error("[categories.PUT] error:", err);

    if (err.status === 404)
      return res.status(404).json({ ok: false, error: "not_found" });

    if (err.status === 409)
      return res.status(409).json({ ok: false, error: "slug_conflict" });

    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

/* -----------------------------------------------------------------------
   DELETE /api/categories/:id
   Roles: admin/editor only
------------------------------------------------------------------------ */
router2.delete('/:id', async (req, res) => {
  if (requireEditorOrAdmin2(req, res)) return;

  const db = req.db;
  const id = req.params.id;

  try {
    if (!db) throw new Error("database pool unavailable");

    if (req.txRun) {
      await req.txRun(async client => {
        const r = await client.query(`DELETE FROM categories WHERE id=$1 RETURNING id`, [id]);
        if (!r.rows[0])
          throw Object.assign(new Error("not_found"), { status: 404 });
        return true;
      });
      return res.json({ ok: true });
    }

    // fallback
    const r = await db.query(`DELETE FROM categories WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "not_found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[categories.DELETE] error:", err);

    if (err.status === 404)
      return res.status(404).json({ ok: false, error: "not_found" });

    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

module.exports = router2;
