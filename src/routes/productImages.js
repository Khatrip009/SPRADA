'use strict';

const express = require('express');
const router = express.Router();
const { validate: isUuid } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

/* =========================
   Supabase Client (SERVER)
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'sprada_storage';

/* =========================
   Helpers
========================= */
function badRequest(res, msg) {
  return res.status(400).json({ ok: false, error: msg });
}

function publicUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

function requireAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

/* =========================
   GET images by product
   /api/product-images?product_id=
========================= */
router.get('/', async (req, res) => {
  const db = req.db;
  const { product_id } = req.query;

  if (!isUuid(product_id)) {
    return badRequest(res, 'invalid_product_id');
  }

  try {
    const { rows } = await db.query(`
      SELECT id, product_id, storage_path, is_primary, created_at
      FROM product_images
      WHERE product_id = $1
      ORDER BY is_primary DESC, created_at ASC
    `, [product_id]);

    const images = rows.map(img => ({
      id: img.id,
      product_id: img.product_id,
      is_primary: img.is_primary,
      url: publicUrl(img.storage_path),
      created_at: img.created_at
    }));

    return res.json({ ok: true, product_id, items: images });
  } catch (err) {
    console.error('[product-images.GET]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* =========================
   POST upload image
   multipart/form-data
========================= */
router.post('/', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const db = req.db;
  const { product_id, is_primary } = req.body;

  if (!isUuid(product_id)) {
    return badRequest(res, 'invalid_product_id');
  }

  if (!req.files || !req.files.file) {
    return badRequest(res, 'file_required');
  }

  const file = req.files.file;
  const ext = file.name.split('.').pop();
  const storagePath = `products/${product_id}/${Date.now()}.${ext}`;

  try {
    /* Upload to Supabase */
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.data, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) throw uploadError;

    /* DB insert */
    if (is_primary === 'true') {
      await db.query(
        'UPDATE product_images SET is_primary=false WHERE product_id=$1',
        [product_id]
      );
    }

    const { rows } = await db.query(`
      INSERT INTO product_images (product_id, storage_path, is_primary, created_at)
      VALUES ($1,$2,$3,NOW())
      RETURNING *
    `, [product_id, storagePath, is_primary === 'true']);

    const image = rows[0];

    return res.status(201).json({
      ok: true,
      image: {
        id: image.id,
        product_id,
        is_primary: image.is_primary,
        url: publicUrl(image.storage_path),
        created_at: image.created_at
      }
    });
  } catch (err) {
    console.error('[product-images.POST]', err);
    return res.status(500).json({ ok: false, error: 'upload_failed' });
  }
});

/* =========================
   DELETE image
========================= */
router.delete('/:id', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const db = req.db;
  const { id } = req.params;

  if (!isUuid(id)) return badRequest(res, 'invalid_id');

  try {
    const { rows } = await db.query(
      'SELECT storage_path FROM product_images WHERE id=$1',
      [id]
    );

    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const path = rows[0].storage_path;

    /* delete from storage */
    await supabase.storage.from(BUCKET).remove([path]);

    /* delete from db */
    await db.query('DELETE FROM product_images WHERE id=$1', [id]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[product-images.DELETE]', err);
    return res.status(500).json({ ok: false, error: 'delete_failed' });
  }
});

module.exports = router;
