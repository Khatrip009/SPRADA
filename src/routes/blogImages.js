// src/routes/blogImages.js
// Blog images router — follows project style (jwt based auth helpers)

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fsPromises = require('fs/promises');
const fsSync = require('fs');

const { buildImageUrl } = require('../lib/buildUrl');

const router = express.Router();

const UPLOAD_ROOT = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), 'public', 'uploads');
const BLOG_DIR = path.join(UPLOAD_ROOT, 'blogs');

(async () => {
  try { await fsPromises.mkdir(BLOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
})();

const storage = multer.diskStorage({
  destination(req, file, cb) { cb(null, BLOG_DIR); },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) return cb(new Error('invalid_file_type'));
    cb(null, true);
  }
});

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

function sendOK(res, data = {}) { return res.json({ ok: true, ...data }); }
function sendError(res, code = 400, message = 'error') { return res.status(code).json({ ok: false, error: message }); }

/* GET images by blog_id (requires blog_id query param) */
router.get('/', async (req, res) => {
  const db = req.db;
  const blogId = req.query.blog_id;
  if (!blogId) return sendError(res, 400, 'blog_id_required');

  try {
    const { rows } = await db.query(`SELECT id, blog_id, url, caption, created_at FROM blog_images WHERE blog_id = $1 ORDER BY created_at DESC`, [blogId]);

    // normalize URLs to canonical full URL
    const images = rows.map(r => ({
      ...r,
      url: buildImageUrl(r.url)
    }));

    return sendOK(res, { images });
  } catch (err) {
    console.error('[blog-images.GET] error:', err);
    return sendError(res, 500, 'server_error');
  }
});

/* Upload (editor/admin) - multipart */
router.post('/', (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  return upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('[blog-images.POST] multer error:', err);
      return sendError(res, 400, err.message || 'upload_error');
    }
    const db = req.db;
    try {
      const { blog_id, caption = null } = req.body || {};
      if (!blog_id) return sendError(res, 400, 'blog_id_required');
      if (!req.file) return sendError(res, 400, 'file_required');

      // build canonical public URL using buildImageUrl helper
      const relPath = `/uploads/blogs/${encodeURIComponent(req.file.filename)}`;
      const publicUrl = buildImageUrl(relPath);

      const id = uuidv4();
      const insertQ = `INSERT INTO blog_images (id, blog_id, url, caption, created_at) VALUES ($1,$2,$3,$4, now()) RETURNING *`;
      const { rows } = await db.query(insertQ, [id, blog_id, publicUrl, caption]);
      // ensure returned url is canonical (buildImageUrl is idempotent for full URLs)
      const image = { ...rows[0], url: buildImageUrl(rows[0].url) };
      return res.status(201).json({ ok: true, image });
    } catch (err2) {
      console.error('[blog-images.POST] error:', err2);
      return sendError(res, 500, 'server_error');
    }
  });
});

/* JSON mode (editor/admin) - add image by URL */
router.post('/by-url', (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  (async () => {
    const db = req.db;
    const { blog_id, url, caption = null } = req.body || {};
    if (!blog_id) return sendError(res, 400, 'blog_id_required');
    if (!url) return sendError(res, 400, 'url_required');

    try {
      const canonicalUrl = buildImageUrl(url);
      const id = uuidv4();
      const insertQ = `INSERT INTO blog_images (id, blog_id, url, caption, created_at) VALUES ($1,$2,$3,$4, now()) RETURNING *`;
      const { rows } = await db.query(insertQ, [id, blog_id, canonicalUrl, caption]);
      const image = { ...rows[0], url: buildImageUrl(rows[0].url) };
      return res.status(201).json({ ok: true, image });
    } catch (err) {
      console.error('[blog-images.POST-json] error:', err);
      return sendError(res, 500, 'server_error');
    }
  })();
});

/* DELETE image (admin only) */
router.delete('/:id', (req, res) => {
  if (requireAdmin(req, res)) return;
  (async () => {
    const db = req.db;
    const id = req.params.id;
    try {
      const { rows } = await db.query('SELECT url FROM blog_images WHERE id = $1 LIMIT 1', [id]);
      if (!rows[0]) return sendError(res, 404, 'not_found');
      const url = rows[0].url;
      await db.query('DELETE FROM blog_images WHERE id = $1', [id]);

      // attempt to unlink local file if present
      try {
        if (typeof url === 'string' && url.includes('/uploads/blogs/')) {
          const filename = decodeURIComponent(url.split('/').pop());
          const filePath = path.join(BLOG_DIR, filename);
          if (fsSync.existsSync(filePath)) await fsPromises.unlink(filePath);
        }
      } catch (e) {
        console.warn('[blog-images.DELETE] unlink warning:', e?.message || e);
      }

      return sendOK(res, {});
    } catch (err) {
      console.error('[blog-images.DELETE] error:', err);
      return sendError(res, 500, 'server_error');
    }
  })();
});

module.exports = router;
