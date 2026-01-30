// src/routes/products.js
// (updated) — includes pagination, trade_type filtering, category filters
// -----------------------------

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { parse } = require('csv-parse/sync'); // npm i csv-parse
const { buildImageUrl } = require('../lib/buildUrl');

const ALLOWED_TRADE_TYPES = new Set(['import', 'export', 'both']);

/* Normalize trade_type input to null or one of allowed values */
function normalizeTradeTypeInput(v) {
  if (v == null) return null;
  try {
    const s = String(v).trim().toLowerCase();
    if (!s) return null;
    return ALLOWED_TRADE_TYPES.has(s) ? s : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
   ROLE HELPERS
-------------------------------------------------------------------------- */
function requireAuth(req, res) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return null;
}

function requireEditorOrAdmin(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // adapt to your user object shape: assuming numeric role (1=admin,2=editor)
  const role = Number(req.user.role || req.user.role_id || req.user.roleId || 0);
  if (role === 1 || role === 2) return null;

  return res.status(403).json({ ok: false, error: 'forbidden' });
}

/* Format product row for frontend */
function formatPublicRow(row) {
  let category = null;
  try {
    if (row.category && typeof row.category === 'string') category = JSON.parse(row.category);
    else category = row.category || null;
  } catch {
    category = null;
  }

  // decide effective_trade_type: product trade_type if set else category.trade_type (if available) else 'both'
  const product_trade_type = (row.trade_type == null) ? null : String(row.trade_type);
  const category_trade_type = category && category.trade_type ? category.trade_type : null;
  const effective_trade_type = product_trade_type || category_trade_type || 'both';

  // Normalize og_image and primary_image to canonical full URLs
  function normalizeSupabaseUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `https://kwthxsumqqssiywdcevx.supabase.co/storage/v1/object/public/sprada_storage/${path}`;
}

const ogImage = normalizeSupabaseUrl(
  row.og_image || (row.metadata && row.metadata.og_image) || null
);

  const primaryImage = row.primary_image
  ? row.primary_image.startsWith('http')
    ? row.primary_image
    : `https://kwthxsumqqssiywdcevx.supabase.co/storage/v1/object/public/sprada_storage/products/${row.primary_image}`
  : null;

  return {
    id: row.id,
    sku: row.sku || null,
    title: row.title,
    slug: row.slug,
    short_description: row.short_description || row.description || null,
    description: row.description || null,
    price: row.price,
    currency: row.currency,
    moq: row.moq || 1,
    available_qty: row.available_qty == null ? null : Number(row.available_qty),
    is_published: !!row.is_published,
    og_image: ogImage,
    metadata: row.metadata || {},
    category: category ? { ...category, trade_type: category_trade_type || 'both' } : null,
    trade_type: product_trade_type, // explicit product-level value (nullable)
    effective_trade_type, // computed effective value for convenience
    primary_image: primaryImage || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

/* helper to set app.user_id for RLS inside a transaction */
async function setAppUserIdIfPresent(client, req) {
  try {
    const userId = req.user && (req.user.id || req.user.user_id || req.user.sub) ? String(req.user.id || req.user.user_id || req.user.sub) : null;
    if (userId) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    }
  } catch (err) {
    // don't fail the transaction for this; just warn
    console.warn('[setAppUserIdIfPresent] set_config failed:', err && err.message ? err.message : err);
  }
}

/* --------------------------------------------------------------------------
   GET /api/products  (Public + supports q, category, limit, pagination, trade_type)
   Query params supported:
     - page (default 1)
     - limit (default 24, max 500)
     - category_id
     - category_slug
     - q (search on title/slug/short_description)
     - order (e.g. price.asc or created_at.desc)
     - trade_type (import|export|both)
-------------------------------------------------------------------------- */
router.get('/', async (req, res) => {
  const db = req.db;
  try {
    if (!db || typeof db.query !== 'function')
      throw new Error('db pool missing');

    const page = Math.max(1, Number(req.query.page || 1));
    let limit = Math.max(1, Number(req.query.limit || 24));
    if (limit > 500) limit = 500;

    const offset = (page - 1) * limit;

    const { category_id, category_slug, q, order, trade_type } = req.query;

    const filters = [];
    const params = [];

    if (category_id) {
      params.push(category_id);
      filters.push(`p.category_id = $${params.length}`);
    }

    if (category_slug) {
      params.push(category_slug);
      filters.push(`c.slug = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      filters.push(`(p.title ILIKE $${params.length} OR p.slug ILIKE $${params.length} OR p.short_description ILIKE $${params.length})`);
    }

    // trade_type filter: product-level OR inherited from category
    if (trade_type) {
      const tt = String(trade_type).toLowerCase();
      if (!ALLOWED_TRADE_TYPES.has(tt)) {
        return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
      }
      params.push(tt);
      // Use NULLIF + lower to treat '' or whitespace as NULL and compare lower-case values.
      // Condition: effective product trade_type (NULLIF(lower(p.trade_type),'') or c.trade_type) = $n
      filters.push(`(COALESCE(NULLIF(lower(p.trade_type),''), lower(c.trade_type)) = $${params.length})`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    let orderSql = 'p.created_at DESC';
    if (order) {
      const m = order.match(/^([a-zA-Z_]+)\.(asc|desc)$/i);
      const allowed = new Set(['created_at', 'price', 'title', 'available_qty']);
      if (m && allowed.has(m[1])) {
        orderSql = `p.${m[1]} ${m[2].toUpperCase()}`;
      }
    }

    const qtext = `
      SELECT
        p.id, p.sku, p.title, p.slug, p.short_description, p.description,
        p.price, p.currency, p.moq, p.available_qty, p.is_published,
        p.og_image, p.metadata, p.created_at, p.updated_at, p.trade_type,
        jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'trade_type', c.trade_type) AS category,
        pi.url AS primary_image
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT url
        FROM product_images
        WHERE product_id = p.id AND is_primary = TRUE
        ORDER BY sort_order DESC, created_at DESC
        LIMIT 1
      ) pi ON TRUE
      ${where}
      ORDER BY ${orderSql}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);

    const { rows } = await db.query(qtext, params);

    // Count
    let total = null;
    try {
      const countQ =
        `SELECT COUNT(*)::int AS total
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         ${where}`;
      const countParams = params.slice(0, params.length - 2);
      const cr = await db.query(countQ, countParams);
      total = cr.rows[0]?.total ?? 0;
    } catch (countErr) {
      console.warn('[products.GET] count failed', countErr && countErr.message ? countErr.message : countErr);
    }

    const total_pages = total != null ? Math.ceil(total / limit) : null;

    return res.json({
      ok: true,
      products: rows.map(formatPublicRow),
      page,
      limit,
      total,
      total_pages
    });
  } catch (err) {
    console.error('[products.GET] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', detail: err.message });
  }
});

/* --------------------------------------------------------------------------
   GET /api/products/:slug (Public)
-------------------------------------------------------------------------- */
router.get('/:slug', async (req, res) => {
  const db = req.db;
  const slug = req.params.slug;

  try {
    if (!db || typeof db.query !== 'function')
      throw new Error('db pool missing');

    const q = `
      SELECT p.*, 
        jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'trade_type', c.trade_type) AS category,
        pi.url AS primary_image
      FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN LATERAL (
            SELECT url FROM product_images
            WHERE product_id = p.id AND is_primary = TRUE
            ORDER BY sort_order DESC, created_at DESC LIMIT 1
        ) pi ON TRUE
      WHERE p.slug = $1 LIMIT 1;
    `;
    const r = await db.query(q, [slug]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });

    return res.json({ ok: true, product: formatPublicRow(r.rows[0]) });
  } catch (err) {
    console.error('[products.GET/:slug] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', detail: err.message });
  }
});

/* --------------------------------------------------------------------------
   POST /api/products  (Admin/Editor)
-------------------------------------------------------------------------- */
router.post('/', async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const {
    title, slug, description, short_description,
    price = 0, currency = 'USD', category_id,
    moq = 1, sku = null, available_qty = 0,
    is_published = false, metadata = {}, og_image = null,
    trade_type = null
  } = req.body || {};

  if (!title || !slug)
    return res.status(400).json({ ok: false, error: 'title_and_slug_required' });

  // normalize and validate trade_type (coerce empty -> null)
  const normalizedTradeType = normalizeTradeTypeInput(trade_type);
  if (trade_type != null && normalizedTradeType === null) {
    return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
  }

  try {
    const newId = uuidv4();

    const created = await req.txRun(async (client) => {
      // ensure app.user_id is set for RLS
      await setAppUserIdIfPresent(client, req);

      await client.query(`
        INSERT INTO products
          (id, sku, title, slug, description, short_description,
           price, currency, category_id, moq, available_qty, is_published,
           metadata, og_image, trade_type, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
      `, [
        newId, sku, title, slug, description, short_description,
        price, currency, category_id || null, moq, available_qty,
        !!is_published, metadata || {}, og_image || null, normalizedTradeType
      ]);

      const r = await client.query('SELECT p.*, jsonb_build_object(\'id\', c.id, \'slug\', c.slug, \'name\', c.name, \'trade_type\', c.trade_type) AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id=$1 LIMIT 1', [newId]);
      return r.rows[0];
    });

    return res.status(201).json({ ok: true, product: formatPublicRow(created) });
  } catch (err) {
    console.error('[products.POST] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', detail: err.message });
  }
});

/* --------------------------------------------------------------------------
   PUT /api/products/:id  (Admin/Editor)
-------------------------------------------------------------------------- */
router.put('/:id', async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const id = req.params.id;
  const body = req.body || {};

  if (!body.title) return res.status(400).json({ ok: false, error: 'title_required' });

  // normalize + validate trade_type if provided
  if (body.trade_type !== undefined) {
    const nt = normalizeTradeTypeInput(body.trade_type);
    if (body.trade_type != null && nt === null) {
      return res.status(400).json({ ok: false, error: 'invalid_trade_type' });
    }
    // replace provided value with normalized one so later the dynamic UPDATE stores normalized value (or null)
    body.trade_type = nt;
  }

  try {
    const updated = await req.txRun(async (client) => {
      // Set app.user_id for RLS evaluation
      try {
        const userId = req.user && (req.user.id || req.user.user_id || req.user.sub) ? String(req.user.id || req.user.user_id || req.user.sub) : null;
        if (userId) {
          await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        }
      } catch (err) {
        console.warn('[products.PUT] set_config failed (non-fatal):', err && err.message ? err.message : err);
      }

      // DIAGNOSTIC: check DB role and privileges so we can see why permission denied occurs
      try {
        const diag = await client.query(`
          SELECT current_user, session_user,
                 has_table_privilege(current_user, 'public.products', 'UPDATE') AS can_update,
                 has_table_privilege(current_user, 'public.products', 'SELECT') AS can_select,
                 current_setting('app.user_id', true) AS app_user_id
        `);
        const drow = diag.rows[0] || {};
        console.debug('[products.PUT][diag] current_user=', drow.current_user, 'session_user=', drow.session_user, 'can_update=', drow.can_update, 'can_select=', drow.can_select, 'app_user_id=', drow.app_user_id);

        if (!drow.can_update) {
          const err = new Error('db_role_lacks_update_privilege');
          err.status = 403;
          err.detail = {
            current_user: drow.current_user,
            session_user: drow.session_user,
            can_update: drow.can_update,
            can_select: drow.can_select,
            app_user_id: drow.app_user_id
          };
          throw err;
        }
      } catch (diagErr) {
        console.warn('[products.PUT][diag] privilege check failed (non-fatal):', diagErr && diagErr.message ? diagErr.message : diagErr);
      }

      // Build update dynamically to allow optional trade_type
      const allowed = [
        'sku','title','slug','description','short_description','price','currency',
        'category_id','moq','available_qty','is_published','metadata','og_image','trade_type'
      ];

      const sets = [];
      const params = [];
      let idx = 1;
      for (const k of allowed) {
        if (body[k] !== undefined) {
          sets.push(`${k} = $${idx++}`);
          params.push(body[k]);
        }
      }

      if (sets.length === 0) {
        throw Object.assign(new Error('no_update_fields'), { status: 400 });
      }

      // append updated_at and id param
      params.push(id);
      const q = `
        UPDATE products SET
          ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING *
      `;
      const r = await client.query(q, params);
      if (!r.rows[0]) {
        const notFoundErr = new Error('not_found');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      // attach category object
      const full = await client.query(`SELECT p.*, jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'trade_type', c.trade_type) AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id=$1 LIMIT 1`, [id]);
      return full.rows[0];
    });

    return res.json({ ok: true, product: formatPublicRow(updated) });
  } catch (err) {
    if (err && err.message === 'db_role_lacks_update_privilege') {
      console.error('[products.PUT] DB role lacks UPDATE privilege:', err.detail);
      return res.status(403).json({
        ok: false,
        error: 'db_role_lacks_update_privilege',
        message: 'The database role your backend connection uses does not have UPDATE permission on public.products. See logs for diagnostic info.',
        detail: err.detail
      });
    }

    console.error('[products.PUT] error during tx (diag included):', err && err.message ? err.message : err);
    const code = err && err.status === 404 ? 404 : (err && err.status === 400 ? 400 : 500);
    return res.status(code).json({
      ok: false,
      error: err && err.status === 404 ? 'not_found' : (err && err.status === 400 ? 'bad_request' : 'server_error'),
      detail: err && err.message ? err.message : String(err)
    });
  }
});

/* --------------------------------------------------------------------------
   DELETE /api/products/:id  (Admin/Editor)
-------------------------------------------------------------------------- */
router.delete('/:id', async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const id = req.params.id;
  try {
    await req.txRun(async (client) => {
      await setAppUserIdIfPresent(client, req);

      const r = await client.query('DELETE FROM products WHERE id=$1 RETURNING id', [id]);
      if (!r.rows[0]) throw Object.assign(new Error('not_found'), { status: 404 });
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[products.DELETE] error:', err);
    const code = err.status === 404 ? 404 : 500;
    return res.status(code).json({
      ok: false,
      error: err.status === 404 ? 'not_found' : 'server_error',
      detail: err.message
    });
  }
});

/* --------------------------------------------------------------------------
   POST /api/products/import-csv  (Admin/Editor)
   CSV may optionally include 'trade_type' column for product-level value
-------------------------------------------------------------------------- */
router.post('/import-csv', async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  try {
    let csvText = '';

    if (req.is && req.is('text/*')) {
      csvText = await new Promise((resolve) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => resolve(data));
      });
    } else if (typeof req.body === 'string') csvText = req.body;
    else if (req.body?.csv) csvText = req.body.csv;

    if (!csvText) return res.status(400).json({ ok: false, error: 'csv_required' });

    const records = parse(csvText, { columns: true, trim: true, skip_empty_lines: true });
    if (!records.length) return res.status(400).json({ ok: false, error: 'no_rows' });

    const results = { processed: records.length, created: 0, updated: 0, errors: [] };

    await req.txRun(async (client) => {
      await setAppUserIdIfPresent(client, req);

      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        try {
          const title = (r.title || '').trim();
          const slug = (r.slug || title.toLowerCase().replace(/\s+/g, '-')).trim();
          const sku = (r.sku || '').trim() || null;
          const price = Number(r.price || 0);
          const currency = r.currency || 'USD';
          const short_description = r.short_description || r.description || '';
          const category_slug = (r.category_slug || '').trim();

          // normalize trade_type from CSV row
          const import_trade_type_raw = r.trade_type ?? null;
          const import_trade_type = normalizeTradeTypeInput(import_trade_type_raw);
          if (import_trade_type_raw != null && import_trade_type === null) {
            results.errors.push({ row: i + 1, reason: 'invalid_trade_type' });
            continue;
          }

          if (!title && !sku && !slug) {
            results.errors.push({ row: i + 1, reason: 'missing title/sku/slug' });
            continue;
          }

          let category_id = null;
          if (category_slug) {
            const cr = await client.query('SELECT id FROM categories WHERE slug=$1 LIMIT 1', [category_slug]);
            if (cr.rows[0]) category_id = cr.rows[0].id;
          }

          let existing = null;
          if (sku) {
            const er = await client.query('SELECT * FROM products WHERE sku=$1 LIMIT 1', [sku]);
            if (er.rows[0]) existing = er.rows[0];
          }

          if (!existing) {
            const er2 = await client.query('SELECT * FROM products WHERE slug=$1 LIMIT 1', [slug]);
            if (er2.rows[0]) existing = er2.rows[0];
          }

          if (existing) {
            await client.query(`
              UPDATE products SET
                title=$1, short_description=$2, description=$3,
                price=$4, currency=$5, category_id=$6, trade_type=$7, updated_at=NOW()
              WHERE id=$8
            `, [
              title || existing.title,
              short_description || existing.short_description,
              r.description || existing.description,
              price,
              currency,
              category_id,
              import_trade_type || existing.trade_type || null,
              existing.id
            ]);
            results.updated++;
          } else {
            await client.query(`
              INSERT INTO products
                (id, sku, title, slug, description, short_description, price, currency, category_id, trade_type, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
            `, [
              uuidv4(),
              sku,
              title,
              slug,
              r.description || null,
              short_description || null,
              price,
              currency,
              category_id,
              import_trade_type || null
            ]);
            results.created++;
          }
        } catch (rowErr) {
          results.errors.push({ row: i + 1, reason: rowErr.message });
        }
      }
    });

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[products.import-csv] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error', detail: err.message });
  }
});

module.exports = router;
