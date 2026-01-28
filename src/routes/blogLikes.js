// src/routes/blogLikes.js
// Likes router using same simple auth helpers pattern

const express = require('express');
const router = express.Router();

function requireAuth(req, res) {
  if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });
  return null;
}

function getUserIdFromReq(req) {
  if (req.user && req.user.id) return req.user.id;
  if (req.body && req.body.user_id) return req.body.user_id;
  if (req.headers && req.headers['x-user-id']) return req.headers['x-user-id'];
  return null;
}

function sendOK(res, data = {}) { return res.json({ ok: true, ...data }); }
function sendError(res, code = 400, message = 'error') { return res.status(code).json({ ok: false, error: message }); }

/* POST /api/blogs/:id/like  - toggle like. requires auth */
router.post('/:id/like', (req, res) => {
  if (requireAuth(req, res)) return;
  (async () => {
    const db = req.db;
    const blogId = req.params.id;
    const userId = getUserIdFromReq(req);
    if (!userId) return sendError(res, 400, 'user_id_required');

    try {
      const exists = await db.query('SELECT id FROM blog_likes WHERE blog_id = $1 AND user_id = $2 LIMIT 1', [blogId, userId]);
      if (exists.rows.length) {
        await db.query('DELETE FROM blog_likes WHERE id = $1', [exists.rows[0].id]);
        const countRes = await db.query('SELECT count(*)::int as cnt FROM blog_likes WHERE blog_id = $1', [blogId]);
        return sendOK(res, { message: 'unliked', likes_count: countRes.rows[0].cnt });
      } else {
        await db.query('INSERT INTO blog_likes (blog_id, user_id, created_at) VALUES ($1,$2, now())', [blogId, userId]);
        const countRes = await db.query('SELECT count(*)::int as cnt FROM blog_likes WHERE blog_id = $1', [blogId]);
        return sendOK(res, { message: 'liked', likes_count: countRes.rows[0].cnt });
      }
    } catch (err) {
      console.error('[blog-likes.POST] error:', err);
      return sendError(res, 500, 'server_error');
    }
  })();
});

/* GET /api/blogs/:id/count - likes count (public) */
router.get('/:id/count', async (req, res) => {
  const db = req.db;
  const blogId = req.params.id;
  try {
    const q = await db.query('SELECT count(*)::int AS cnt FROM blog_likes WHERE blog_id = $1', [blogId]);
    return sendOK(res, { likes_count: q.rows[0].cnt });
  } catch (err) {
    console.error('[blog-likes.GET count] error:', err);
    return sendError(res, 500, 'server_error');
  }
});

module.exports = router;
