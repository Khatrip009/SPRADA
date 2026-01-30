'use strict';

const express = require('express');
const { validate: isUuid } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

/* =====================================================
   SUPABASE SERVER CLIENT
===================================================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'sprada_storage';

/* =====================================================
   HELPERS
===================================================== */
function sendOK(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function sendError(res, code = 400, message = 'error') {
  return res.status(code).json({ ok: false, error: message });
}

function requireEditorOrAdmin(req, res) {
  if (!req.user) {
    sendError(res, 401, 'unauthorized');
    return false;
  }
  const role = Number(req.user.role_id || req.user.role);
  if (role === 1 || role === 2) return true;
  sendError(res, 403, 'forbidden');
  return false;
}

function requireAdmin(req, res) {
  if (!req.user) {
    sendError(res, 401, 'unauthorized');
    return false;
  }
  const role = Number(req.user.role_id || req.user.role);
  if (role === 1) return true;
  sendError(res, 403, 'forbidden');
  return false;
}

function publicUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

/* =====================================================
   GET BLOG IMAGES
   GET /api/blog-images?blog_id=UUID
===================================================== */
router.get('/', async (req, res) => {
  const db = req.app.locals.db;
  const { blog_id } = req.query;

  if (!isUuid(blog_id)) {
    return sendError(res, 400, 'invalid_blog_id');
  }

  try {
    const { rows } = await db.query(
      `
      SELECT id, blog_id, url, caption, created_at
      FROM blog_images
      WHERE blog_id = $1
      ORDER BY created_at DESC
      `,
      [blog_id]
    );

    const images = rows.map(img => ({
      id: img.id,
      blog_id: img.blog_id,
      caption: img.caption,
      created_at: img.created_at,
      url: publicUrl(img.url)
    }));

    return sendOK(res, { images });
  } catch (err) {
    console.error('[blog-images.GET]', err);
    return sendError(res, 500, 'server_error');
  }
});

/* =====================================================
   UPLOAD BLOG IMAGE (EDITOR / ADMIN)
   POST /api/blog-images
   multipart/form-data
===================================================== */
router.post('/', async (req, res) => {
  if (!requireEditorOrAdmin(req, res)) return;

  const db = req.app.locals.db;
  const { blog_id, caption = null } = req.body;

  if (!isUuid(blog_id)) {
    return sendError(res, 400, 'invalid_blog_id');
  }

  if (!req.files || !req.files.file) {
    return sendError(res, 400, 'file_required');
  }

  const file = req.files.file;
  const ext = file.name.split('.').pop();
  const storagePath = `blogs/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;

  try {
    /* Upload to Supabase Storage */
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.data, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) throw uploadError;

    /* Insert into DB */
    const { rows } = await db.query(
      `
      INSERT INTO blog_images (blog_id, url, caption, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id, blog_id, url, caption, created_at
      `,
      [blog_id, storagePath, caption]
    );

    const image = rows[0];

    return res.status(201).json({
      ok: true,
      image: {
        id: image.id,
        blog_id: image.blog_id,
        caption: image.caption,
        created_at: image.created_at,
        url: publicUrl(image.url)
      }
    });
  } catch (err) {
    console.error('[blog-images.POST]', err);
    return sendError(res, 500, 'upload_failed');
  }
});

/* =====================================================
   ADD BLOG IMAGE BY URL (JSON)
   POST /api/blog-images/by-url
===================================================== */
router.post('/by-url', async (req, res) => {
  if (!requireEditorOrAdmin(req, res)) return;

  const db = req.app.locals.db;
  const { blog_id, url, caption = null } = req.body;

  if (!isUuid(blog_id)) {
    return sendError(res, 400, 'invalid_blog_id');
  }

  if (!url || typeof url !== 'string') {
    return sendError(res, 400, 'url_required');
  }

  try {
    const { rows } = await db.query(
      `
      INSERT INTO blog_images (blog_id, url, caption, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id, blog_id, url, caption, created_at
      `,
      [blog_id, url, caption]
    );

    const image = rows[0];

    return res.status(201).json({
      ok: true,
      image: {
        id: image.id,
        blog_id: image.blog_id,
        caption: image.caption,
        created_at: image.created_at,
        url: publicUrl(image.url)
      }
    });
  } catch (err) {
    console.error('[blog-images.POST-by-url]', err);
    return sendError(res, 500, 'server_error');
  }
});

/* =====================================================
   DELETE BLOG IMAGE (ADMIN)
   DELETE /api/blog-images/:id
===================================================== */
router.delete('/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const db = req.app.locals.db;
  const { id } = req.params;

  if (!isUuid(id)) {
    return sendError(res, 400, 'invalid_id');
  }

  try {
    const { rows } = await db.query(
      'SELECT url FROM blog_images WHERE id=$1',
      [id]
    );

    if (!rows.length) {
      return sendError(res, 404, 'not_found');
    }

    const path = rows[0].url;

    /* Remove from storage */
    await supabase.storage.from(BUCKET).remove([path]);

    /* Remove from DB */
    await db.query('DELETE FROM blog_images WHERE id=$1', [id]);

    return sendOK(res);
  } catch (err) {
    console.error('[blog-images.DELETE]', err);
    return sendError(res, 500, 'delete_failed');
  }
});

module.exports = router;
