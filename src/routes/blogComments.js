// src/routes/blogComments.js

const express = require("express");
const router = express.Router();

/* ----------------------- Helpers ----------------------- */
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
function sendOK(res, d = {}) {
  return res.json({ ok: true, ...d });
}
function sendError(res, code = 400, msg = "error") {
  return res.status(code).json({ ok: false, error: msg });
}

/* ----------------------- POST comment ----------------------- */
router.post("/:id/comments", async (req, res) => {
  const db = req.db;
  const blogId = req.params.id;
  const { name, email, rating, body } = req.body || {};

  if (!body) return sendError(res, 400, "body_required");
  if (rating && (rating < 1 || rating > 5)) return sendError(res, 400, "rating_invalid");

  try {
    const q = await db.query(
      `
      INSERT INTO blog_comments (blog_id, name, email, rating, body, is_published, created_at)
      VALUES ($1,$2,$3,$4,$5,false,now())
      RETURNING *
    `,
      [blogId, name || null, email || null, rating || null, body]
    );

    return res.status(201).json({ ok: true, comment: q.rows[0] });
  } catch (err) {
    console.error("[blog-comments.POST] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- GET comments ----------------------- */
router.get("/:id/comments", async (req, res) => {
  const db = req.db;
  const blogId = req.params.id;
  const all = req.query.all === "true";

  try {
    let sql = `
      SELECT id, blog_id, name, email, rating, body, is_published,
             created_at, updated_at
      FROM blog_comments
      WHERE blog_id=$1
    `;

    const params = [blogId];

    if (!all) sql += " AND is_published = true";

    sql += " ORDER BY created_at DESC";

    const q = await db.query(sql, params);
    return sendOK(res, { comments: q.rows });
  } catch (err) {
    console.error("[blog-comments.GET] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- UPDATE comment ----------------------- */
router.put("/comments/:commentId", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const id = req.params.commentId;
  const { body, rating, name, email, is_published } = req.body || {};

  try {
    const sets = [];
    const params = [];
    let idx = 1;

    if (body !== undefined) {
      sets.push(`body=$${idx++}`);
      params.push(body);
    }
    if (rating !== undefined) {
      if (rating < 1 || rating > 5) return sendError(res, 400, "rating_invalid");
      sets.push(`rating=$${idx++}`);
      params.push(rating);
    }
    if (name !== undefined) {
      sets.push(`name=$${idx++}`);
      params.push(name);
    }
    if (email !== undefined) {
      sets.push(`email=$${idx++}`);
      params.push(email);
    }
    if (is_published !== undefined) {
      sets.push(`is_published=$${idx++}`);
      params.push(is_published);
    }

    if (!sets.length) return sendError(res, 400, "no_update_fields");

    params.push(id);

    const updated = await db.query(
      `
      UPDATE blog_comments
      SET ${sets.join(", ")}, updated_at = now()
      WHERE id=$${idx}
      RETURNING *
    `,
      params
    );

    if (!updated.rows[0]) return sendError(res, 404, "not_found");

    return sendOK(res, { comment: updated.rows[0] });
  } catch (err) {
    console.error("[blog-comments.PUT] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- DELETE comment ----------------------- */
router.delete("/comments/:commentId", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const id = req.params.commentId;

  try {
    const d = await db.query(`DELETE FROM blog_comments WHERE id=$1 RETURNING id`, [id]);
    if (!d.rows[0]) return sendError(res, 404, "not_found");
    return sendOK(res);
  } catch (err) {
    console.error("[blog-comments.DELETE] error:", err);
    return sendError(res, 500, "server_error");
  }
});

module.exports = router;
