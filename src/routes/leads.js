// src/routes/leads.js
// Leads CRUD + Notes (Admin/Editor protected except POST)

const express = require("express");
const { v4: uuidv4 } = require("uuid");
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

function sendOK(res, data = {}) {
  return res.json({ ok: true, ...data });
}
function sendError(res, code = 400, message = "error") {
  return res.status(code).json({ ok: false, error: message });
}

/* ----------------------- LIST ----------------------- */
router.get("/", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const q = (req.query.q || "").trim();
  const status = req.query.status;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const offset = (page - 1) * limit;

  try {
    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where.push(`(name ILIKE $${params.length - 1} OR email ILIKE $${params.length})`);
    }

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM leads ${whereSql}`,
      params
    );

    const total = countRes.rows[0].total;

    params.push(limit, offset);

    const rows = (
      await db.query(
        `
      SELECT id, name, email, phone, company, country, product_interest,
             status, created_at, updated_at
      FROM leads
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
        params
      )
    ).rows;

    return sendOK(res, { leads: rows, total, page, limit });
  } catch (err) {
    console.error("[leads.GET] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- CREATE (public) ----------------------- */
router.post("/", async (req, res) => {
  const db = req.db;
  const b = req.body || {};

  try {
    const name = (b.name || "").trim();
    const email = (b.email || "").trim();

    if (!name || !email) return sendError(res, 400, "name_and_email_required");

    const id = uuidv4();
    const insert = await db.query(
      `
      INSERT INTO leads (id, name, email, phone, company, country, product_interest, message, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new')
      RETURNING *
    `,
      [
        id,
        name,
        email,
        b.phone || null,
        b.company || null,
        b.country || null,
        b.product_interest || null,
        b.message || null,
      ]
    );

    return res.status(201).json({ ok: true, lead: insert.rows[0] });
  } catch (err) {
    console.error("[leads.POST] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- DETAIL ----------------------- */
router.get("/:id", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const id = req.params.id;

  try {
    const q = await db.query(`SELECT * FROM leads WHERE id=$1`, [id]);
    if (!q.rows[0]) return sendError(res, 404, "not_found");
    return sendOK(res, { lead: q.rows[0] });
  } catch (err) {
    console.error("[leads.GET/:id] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- UPDATE ----------------------- */
router.put("/:id", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  const db = req.db;
  const id = req.params.id;
  const body = req.body || {};

  try {
    const allowed = [
      "name",
      "email",
      "phone",
      "company",
      "country",
      "product_interest",
      "message",
      "status",
    ];

    const sets = [];
    const params = [];
    let idx = 1;

    for (const k of allowed) {
      if (body[k] !== undefined) {
        sets.push(`${k}=$${idx++}`);
        params.push(body[k]);
      }
    }

    if (!sets.length) return sendError(res, 400, "no_update_fields");

    params.push(id);

    const sql = `
      UPDATE leads
      SET ${sets.join(", ")}, updated_at = now()
      WHERE id=$${idx}
      RETURNING *
    `;

    const updated = await db.query(sql, params);
    if (!updated.rows[0]) return sendError(res, 404, "not_found");

    return sendOK(res, { lead: updated.rows[0] });
  } catch (err) {
    console.error("[leads.PUT] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- DELETE ----------------------- */
router.delete("/:id", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;
  const db = req.db;
  const id = req.params.id;

  try {
    const r = await db.query(`DELETE FROM leads WHERE id=$1 RETURNING id`, [id]);
    if (!r.rows[0]) return sendError(res, 404, "not_found");

    return sendOK(res, { message: "deleted" });
  } catch (err) {
    console.error("[leads.DELETE] error:", err);
    return sendError(res, 500, "server_error");
  }
});

/* ----------------------- NOTES ----------------------- */
router.get("/:id/notes", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const leadId = req.params.id;

  try {
    const notes = await db.query(
      `SELECT * FROM lead_notes WHERE lead_id=$1 ORDER BY created_at DESC`,
      [leadId]
    );
    return sendOK(res, { notes: notes.rows });
  } catch (err) {
    console.error("[lead-notes.GET] error:", err);
    return sendError(res, 500, "server_error");
  }
});

router.post("/:id/notes", async (req, res) => {
  if (requireEditorOrAdmin(req, res)) return;

  const db = req.db;
  const leadId = req.params.id;
  const note = (req.body.note || "").trim();

  if (!note) return sendError(res, 400, "note_required");

  try {
    const id = uuidv4();
    const inserted = await db.query(
      `INSERT INTO lead_notes (id, lead_id, note) VALUES ($1,$2,$3) RETURNING *`,
      [id, leadId, note]
    );
    return res.status(201).json({ ok: true, note: inserted.rows[0] });
  } catch (err) {
    console.error("[lead-notes.POST] error:", err);
    return sendError(res, 500, "server_error");
  }
});

module.exports = router;
