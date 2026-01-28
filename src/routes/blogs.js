// src/routes/blogs.js
// FULLY JWT-SECURED BLOG ROUTER
// Requires: req.db, req.txRun, req.user (from jwtAuthMiddleware)

const express = require('express');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { buildImageUrl } = require('../lib/buildUrl');

const router = express.Router();

/* ----------------------
   Helpers (same pattern as categories.js)
   ---------------------- */
function slugify(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function requireAuth(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  return null;
}
function requireEditorOrAdmin(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  const role = Number(req.user.role);
  if (role === 1 || role === 2) return null;
  return res.status(403).json({ ok: false, error: "forbidden" });
}
function requireAdmin(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  const role = Number(req.user.role);
  if (role === 1) return null;
  return res.status(403).json({ ok: false, error: "forbidden" });
}

function getUserIdFromReq(req) {
  if (req.user && req.user.id) return req.user.id;
  if (req.headers && req.headers['x-user-id']) return req.headers['x-user-id'];
  return null;
}

async function setAppUser(db, userId) {
  if (!userId || !db) return;
  try {
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId.toString()]);
  } catch (e) { /* ignore if not available */ }
}

/* ----------------------
   Uploads (editor single file) - local disk
   ---------------------- */
async function ensureUploadFolder() {
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'blogs');
  try { await stat(uploadDir); } catch (err) { await mkdir(uploadDir, { recursive: true }); }
  return uploadDir;
}
function uniqueFilename(originalName) {
  const safe = (originalName || 'file').replace(/[^a-z0-9.\-_]/gi, '_');
  return `${Date.now()}_${Math.floor(Math.random()*1e6)}_${safe}`;
}
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try { const d = await ensureUploadFolder(); cb(null, d); } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

/* ----------------------
   Utilities
   ---------------------- */
function sendOK(res, data = {}) { return res.json({ ok: true, ...data }); }
function sendError(res, code = 400, message = 'error') { return res.status(code).json({ ok: false, error: message }); }

/* ----------------------
   LIST / SEARCH
   GET /api/blogs? q, page, limit, published (true/false)
   ---------------------- */
router.get('/', async (req, res) => {
  const db = req.db;
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, parseInt(req.query.limit || '12', 10));
  const offset = (page - 1) * limit;
  const published = req.query.published;

  try {
    if (!db) throw new Error('database pool unavailable');

    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(title ILIKE $${params.length} OR excerpt ILIKE $${params.length})`);
    }
    if (published === 'true') where.push(`is_published = true`);
    else if (published === 'false') where.push(`(is_published IS NULL OR is_published = false)`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await db.query(`SELECT count(*)::int as total FROM blogs ${whereSql}`, params);
    const total = countRes.rows[0].total;

    params.push(limit, offset);
    const listSql = `
      SELECT b.id, b.title, b.slug, b.excerpt, b.meta_title, b.meta_description, b.canonical_url,
             b.og_image as image, b.author_id, b.is_published, b.published_at, b.created_at, b.updated_at
      FROM blogs b
      ${whereSql}
      ORDER BY (is_published IS NOT TRUE) ASC, published_at DESC NULLS LAST, created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const rows = (await db.query(listSql, params)).rows;

    // normalize og_image -> image_url
    const blogs = rows.map(r => ({
      ...r,
      image: buildImageUrl(r.image)
    }));

    return sendOK(res, { blogs, total, page, limit });
  } catch (err) {
    console.error('[blogs.GET /] error:', err);
    return sendError(res, 500, 'server_error');
  }
});

/* ----------------------
   GET BY ID or SLUG
   GET /api/blogs/:idOrSlug
   ---------------------- */
router.get('/:idOrSlug', async (req, res) => {
  const db = req.db;
  const idOrSlug = req.params.idOrSlug;
  try {
    if (!db) throw new Error('database pool unavailable');

    const q = await db.query(
      `SELECT b.*, b.content as content_json FROM blogs b WHERE b.id::text = $1 OR b.slug = $1 LIMIT 1`, [idOrSlug]
    );
    if (!q.rows.length) return sendError(res, 404, 'not_found');
    const blog = q.rows[0];

    const imgs = (await db.query(`SELECT id, url, caption, created_at FROM blog_images WHERE blog_id = $1 ORDER BY created_at ASC`, [blog.id])).rows;
    const normalizedImgs = imgs.map(i => ({ ...i, url: buildImageUrl(i.url) }));

    // normalize blog og_image too
    const normalizedBlog = { ...blog, og_image: buildImageUrl(blog.og_image) };

    return sendOK(res, { blog: { ...normalizedBlog, images: normalizedImgs } });
  } catch (err) {
    console.error('[blogs.GET /:idOrSlug] error:', err);
    return sendError(res, 500, 'server_error');
  }
});

/* ----------------------
   CREATE (admin/editor allowed by your original policy; here admin/editor)
   POST /api/blogs
   Body: { title, excerpt, content, author_id?, meta_title?, meta_description?, canonical_url?, og_image? }
   ---------------------- */
router.post('/', (req, res) => {
  // Use admin-only if you want stricter control; categories used editor+admin — use requireEditorOrAdmin
  if (requireEditorOrAdmin(req, res)) return;
  (async () => {
    const db = req.db;
    const userId = getUserIdFromReq(req);
    await setAppUser(db, userId);

    const { title, excerpt, content, author_id, meta_title, meta_description, canonical_url, og_image } = req.body || {};
    if (!title || !content) return sendError(res, 400, 'title_and_content_required');

    const slugBase = slugify(title);
    try {
      // transaction if available
      if (req.txRun) {
        const inserted = await req.txRun(async client => {
          let slug = slugBase;
          let count = 0;
          while (true) {
            const check = await client.query('SELECT 1 FROM blogs WHERE slug = $1 LIMIT 1', [slug]);
            if (!check.rows.length) break;
            count++; slug = `${slugBase}-${count}`;
          }
          const authorToUse = author_id || userId || null;
          const insertSql = `
            INSERT INTO blogs (id, title, slug, excerpt, content, author_id, meta_title, meta_description, canonical_url, og_image, is_published, published_at, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,NULL, now(), now())
            RETURNING id, title, slug, excerpt, author_id, is_published, created_at, og_image
          `;
          const id = uuidv4();
          // store og_image as provided (frontend may submit relative /uploads path); normalize on response
          const r = await client.query(insertSql, [id, title, slug, excerpt || null, JSON.stringify(content), authorToUse, meta_title || null, meta_description || null, canonical_url || null, og_image || null]);
          return r.rows[0];
        });
        // Normalize returned og_image
        const insertedNormalized = { ...inserted, og_image: buildImageUrl(inserted.og_image) };
        return res.status(201).json({ ok: true, blog: insertedNormalized });
      }

      // fallback
      let slug = slugBase;
      let count = 0;
      while (true) {
        const check = await db.query('SELECT 1 FROM blogs WHERE slug = $1 LIMIT 1', [slug]);
        if (!check.rows.length) break;
        count++; slug = `${slugBase}-${count}`;
      }
      const authorToUse = author_id || userId || null;
      const insertSql = `
        INSERT INTO blogs (title, slug, excerpt, content, author_id, meta_title, meta_description, canonical_url, og_image, is_published, published_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,false,NULL, now(), now())
        RETURNING id, title, slug, excerpt, author_id, is_published, created_at, og_image
      `;
      const inserted = await db.query(insertSql, [title, slug, excerpt || null, JSON.stringify(content), authorToUse, meta_title || null, meta_description || null, canonical_url || null, og_image || null]);
      const insertedRow = inserted.rows[0];
      insertedRow.og_image = buildImageUrl(insertedRow.og_image);
      return res.status(201).json({ ok: true, blog: insertedRow });
    } catch (err) {
      console.error('[blogs.POST] error:', err);
      return sendError(res, 500, 'server_error');
    }
  })();
});

/* ----------------------
   UPDATE (admin/editor)
   PUT /api/blogs/:id
   ---------------------- */
router.put('/:id', (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  (async () => {
    const db = req.db;
    const id = req.params.id;
    const { title, excerpt, content, meta_title, meta_description, canonical_url, og_image } = req.body || {};
    if (!title && !excerpt && !content && !meta_title && !meta_description && !canonical_url && !og_image) {
      return sendError(res, 400, 'no_update_fields');
    }

    try {
      if (req.txRun) {
        const updated = await req.txRun(async client => {
          const existing = await client.query('SELECT * FROM blogs WHERE id = $1 LIMIT 1', [id]);
          if (!existing.rows.length) throw Object.assign(new Error('not_found'), { status: 404 });

          const updates = [];
          const params = [];
          let idx = 1;
          if (title) { updates.push(`title = $${idx++}`); params.push(title); }
          if (excerpt !== undefined) { updates.push(`excerpt = $${idx++}`); params.push(excerpt); }
          if (content !== undefined) { updates.push(`content = $${idx++}::jsonb`); params.push(JSON.stringify(content)); }
          if (meta_title !== undefined) { updates.push(`meta_title = $${idx++}`); params.push(meta_title); }
          if (meta_description !== undefined) { updates.push(`meta_description = $${idx++}`); params.push(meta_description); }
          if (canonical_url !== undefined) { updates.push(`canonical_url = $${idx++}`); params.push(canonical_url); }
          if (og_image !== undefined) { updates.push(`og_image = $${idx++}`); params.push(og_image); }

          if (title) {
            const newSlugBase = slugify(title);
            let slug = newSlugBase; let count = 0;
            while (true) {
              const check = await client.query('SELECT 1 FROM blogs WHERE slug = $1 AND id != $2 LIMIT 1', [slug, id]);
              if (!check.rows.length) break;
              count++; slug = `${newSlugBase}-${count}`;
            }
            updates.push(`slug = $${idx++}`); params.push(slug);
          }

          params.push(id);
          const updateSql = `UPDATE blogs SET ${updates.join(',')}, updated_at = now() WHERE id = $${idx} RETURNING id, title, slug, og_image`;
          const updated = await client.query(updateSql, params);
          return updated.rows[0];
        });
        // Normalize og_image in response
        const updatedNormalized = { ...updated, og_image: buildImageUrl(updated.og_image) };
        return sendOK(res, { blog: updatedNormalized });
      }

      // fallback
      const existing = await db.query('SELECT * FROM blogs WHERE id = $1 LIMIT 1', [id]);
      if (!existing.rows.length) return sendError(res, 404, 'not_found');

      const updates = [];
      const params = [];
      let idx = 1;
      if (title) { updates.push(`title = $${idx++}`); params.push(title); }
      if (excerpt !== undefined) { updates.push(`excerpt = $${idx++}`); params.push(excerpt); }
      if (content !== undefined) { updates.push(`content = $${idx++}::jsonb`); params.push(JSON.stringify(content)); }
      if (meta_title !== undefined) { updates.push(`meta_title = $${idx++}`); params.push(meta_title); }
      if (meta_description !== undefined) { updates.push(`meta_description = $${idx++}`); params.push(meta_description); }
      if (canonical_url !== undefined) { updates.push(`canonical_url = $${idx++}`); params.push(canonical_url); }
      if (og_image !== undefined) { updates.push(`og_image = $${idx++}`); params.push(og_image); }

      if (title) {
        const newSlugBase = slugify(title);
        let slug = newSlugBase; let count = 0;
        while (true) {
          const check = await db.query('SELECT 1 FROM blogs WHERE slug = $1 AND id != $2 LIMIT 1', [slug, id]);
          if (!check.rows.length) break;
          count++; slug = `${newSlugBase}-${count}`;
        }
        updates.push(`slug = $${idx++}`); params.push(slug);
      }

      params.push(id);
      const updateSql = `UPDATE blogs SET ${updates.join(',')}, updated_at = now() WHERE id = $${idx} RETURNING id, title, slug, og_image`;
      const updated = await db.query(updateSql, params);
      const updatedRow = updated.rows[0];
      updatedRow.og_image = buildImageUrl(updatedRow.og_image);
      return sendOK(res, { blog: updatedRow });
    } catch (err) {
      console.error('[blogs.PUT] error:', err);
      if (err.status === 404) return sendError(res, 404, 'not_found');
      return sendError(res, 500, 'server_error');
    }
  })();
});

/* ----------------------
   DELETE (admin/editor)
   DELETE /api/blogs/:id
   ---------------------- */
router.delete('/:id', (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  (async () => {
    const db = req.db;
    const id = req.params.id;
    try {
      if (req.txRun) {
        await req.txRun(async client => {
          const r = await client.query('DELETE FROM blogs WHERE id=$1 RETURNING id', [id]);
          if (!r.rows[0]) throw Object.assign(new Error('not_found'), { status: 404 });
          return true;
        });
        return sendOK(res, {});
      }
      const r = await db.query('DELETE FROM blogs WHERE id=$1 RETURNING id', [id]);
      if (!r.rows[0]) return sendError(res, 404, 'not_found');
      return sendOK(res, {});
    } catch (err) {
      console.error('[blogs.DELETE] error:', err);
      if (err.status === 404) return sendError(res, 404, 'not_found');
      return sendError(res, 500, 'server_error');
    }
  })();
});

/* ----------------------
   PUBLISH / UNPUBLISH (admin/editor)
   POST /api/blogs/:id/publish  { publish: true/false, published_at? }
   ---------------------- */
router.post('/:id/publish', (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  (async () => {
    const db = req.db;
    const id = req.params.id;
    const publish = req.body.publish === true || req.body.publish === 'true';
    const published_at = req.body.published_at ? new Date(req.body.published_at) : (publish ? new Date() : null);
    try {
      const upd = await db.query('UPDATE blogs SET is_published=$1, published_at=$2, updated_at=now() WHERE id=$3 RETURNING id, is_published, published_at', [publish, published_at, id]);
      if (!upd.rows.length) return sendError(res, 404, 'not_found');
      return sendOK(res, { data: upd.rows[0] });
    } catch (err) {
      console.error('[blogs.POST publish] error:', err);
      return sendError(res, 500, 'server_error');
    }
  })();
});

/* ----------------------
   Editor single file upload (admin/editor)
   POST /api/blogs/upload (multipart form-data, field 'file')
   ---------------------- */
router.post('/upload', upload.single('file'), (req, res) => {
  // Only editor/admin allowed to upload images
  if (requireEditorOrAdmin(req, res)) return;
  (async () => {
    try {
      if (!req.file) return sendError(res, 400, 'no_file');
      const relPath = `/uploads/blogs/${path.basename(req.file.path)}`;
      // return canonical full URL
      const url = buildImageUrl(relPath);
      return res.status(201).json({ ok: true, url });
    } catch (err) {
      console.error('[blogs.upload] error:', err);
      return sendError(res, 500, 'server_error');
    }
  })();
});

module.exports = router;
