// -----------------------------
// src/routes/categories.js
// FINAL — pagination, trade_type, search + image support (Supabase storage)
// -----------------------------

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const ALLOWED_TRADE_TYPES = new Set(['import', 'export', 'both']);

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

function normalizeTradeType(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return ALLOWED_TRADE_TYPES.has(s) ? s : null;
}

function normalizeImagePath(v) {
  if (!v) return null;
  const s = String(v).trim();
  // enforce supabase categories folder
  if (!s.startsWith('/categories/')) {
    throw new Error('invalid_image_path');
  }
  return s;
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
router.get('/', async (req, res) => {
  const db = req.db;
  try {
    if (!db) throw new Error("database pool unavailable");

    const includeCounts = String(req.query.include_counts) === 'true';
    const page = Math.max(1, Number(req.query.page || 1));
    let limit = Math.min(1000, Math.max(1, Number(req.query.limit || 100)));
    const offset = (page - 1) * limit;

    const params = [];
    const filters = [];

    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      filters.push(`(c.name ILIKE $${params.length} OR c.slug ILIKE $${params.length} OR c.description ILIKE $${params.length})`);
    }

    if (req.query.trade_type) {
      const tt = normalizeTradeType(req.query.trade_type);
      if (!tt) return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
      params.push(tt);
      filters.push(`c.trade_type = $${params.length}`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    if (includeCounts) {
      const qtext = `
        SELECT
          c.id, c.slug, c.name, c.description, c.parent_id,
          c.trade_type, c.image,
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

      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM categories c ${where}`,
        params.slice(0, params.length - 2)
      );

      const total = countRes.rows[0]?.total || 0;
      return res.json({
        ok: true,
        categories: rows,
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit)
      });
    }

    const qtext = `
      SELECT id, slug, name, description, parent_id, trade_type, image
      FROM categories c
      ${where}
      ORDER BY sort_order NULLS LAST, name
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);

    const { rows } = await db.query(qtext, params);

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM categories c ${where}`,
      params.slice(0, params.length - 2)
    );

    const total = countRes.rows[0]?.total || 0;

    return res.json({
      ok: true,
      categories: rows,
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('[categories.GET]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});


/* -----------------------------------------------------------------------
   GET /api/categories/:id
------------------------------------------------------------------------ */
router.get('/:id', async (req, res) => {
  const db = req.db;
  try {
    const { rows } = await db.query(
      `SELECT id, slug, name, description, parent_id, trade_type, image
       FROM categories WHERE id=$1 LIMIT 1`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, category: rows[0] });
  } catch (err) {
    console.error('[categories.GET/:id]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* -----------------------------------------------------------------------
   POST /api/categories
   Body: { name, slug?, description?, parent_id?, sort_order?, trade_type? }
   Roles: admin/editor only
------------------------------------------------------------------------ */
/* -----------------------------------------------------------------------
   POST /api/categories
   Body:
   {
     name,
     slug?,
     description?,
     parent_id?,
     sort_order?,
     trade_type?,
     image?   // "/categories/industrial-machinery.jpg"
   }
------------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const body = req.body || {};

  try {
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ ok: false, error: 'name_required' });
    }

    const id = uuidv4();
    const slug = slugify(body.slug || body.name);

    const trade_type = normalizeTradeType(body.trade_type || 'both');
    if (!trade_type) {
      return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
    }

    const image = normalizeImagePath(body.image);

    // slug uniqueness check
    const dup = await db.query(
      `SELECT id FROM categories WHERE slug=$1 LIMIT 1`,
      [slug]
    );
    if (dup.rows[0]) {
      return res.status(409).json({ ok: false, error: 'slug_conflict' });
    }

    await db.query(
      `INSERT INTO categories (
        id,
        slug,
        name,
        description,
        parent_id,
        sort_order,
        trade_type,
        image,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [
        id,
        slug,
        body.name.trim(),
        body.description || null,
        body.parent_id || null,
        Number.isInteger(body.sort_order) ? body.sort_order : 0,
        trade_type,
        image
      ]
    );

    const { rows } = await db.query(
      `SELECT
         id, slug, name, description, parent_id,
         sort_order, trade_type, image,
         created_at, updated_at
       FROM categories
       WHERE id=$1`,
      [id]
    );

    return res.status(201).json({ ok: true, category: rows[0] });
  } catch (err) {
    console.error('[categories.POST]', err);

    if (err.message === 'invalid_image_path') {
      return res.status(400).json({
        ok: false,
        error: 'image_must_be_in_categories_folder'
      });
    }

    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* -----------------------------------------------------------------------
   PUT /api/categories/:id
   Roles: admin/editor only
------------------------------------------------------------------------ */
/* -----------------------------------------------------------------------
   PUT /api/categories/:id
   Body:
   {
     name,
     slug?,
     description?,
     parent_id?,
     sort_order?,
     trade_type?,
     image?
   }
------------------------------------------------------------------------ */
router.put('/:id', async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const body = req.body || {};
  const id = req.params.id;

  try {
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ ok: false, error: 'name_required' });
    }

    const slug = slugify(body.slug || body.name);

    const trade_type = normalizeTradeType(body.trade_type || 'both');
    if (!trade_type) {
      return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
    }

    const image = normalizeImagePath(body.image);

    // ensure category exists
    const exists = await db.query(
      `SELECT id FROM categories WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!exists.rows[0]) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    // slug uniqueness (excluding self)
    const dup = await db.query(
      `SELECT id FROM categories WHERE slug=$1 AND id!=$2 LIMIT 1`,
      [slug, id]
    );
    if (dup.rows[0]) {
      return res.status(409).json({ ok: false, error: 'slug_conflict' });
    }

    const { rows } = await db.query(
      `UPDATE categories SET
        name=$1,
        slug=$2,
        description=$3,
        parent_id=$4,
        sort_order=$5,
        trade_type=$6,
        image=$7
      WHERE id=$8
      RETURNING
        id, slug, name, description, parent_id,
        sort_order, trade_type, image,
        created_at, updated_at`,
      [
        body.name.trim(),
        slug,
        body.description || null,
        body.parent_id || null,
        Number.isInteger(body.sort_order) ? body.sort_order : 0,
        trade_type,
        image,
        id
      ]
    );

    return res.json({ ok: true, category: rows[0] });
  } catch (err) {
    console.error('[categories.PUT]', err);

    if (err.message === 'invalid_image_path') {
      return res.status(400).json({
        ok: false,
        error: 'image_must_be_in_categories_folder'
      });
    }

    return res.status(500).json({ ok: false, error: 'server_error' });
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
