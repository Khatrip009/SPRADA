// src/routes/leadsStats.js

const express = require("express");
const router = express.Router();

/**
 * GET /api/leads-stats/stats
 */
router.get("/stats", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: "unauthorized" });

    const db = req.db;

    const sql = `
      SELECT
        SUM((created_at::date = current_date)::int) AS today,
        SUM((created_at::date = current_date - INTERVAL '1 day')::int) AS yesterday,
        SUM(CASE WHEN created_at >= now() - INTERVAL '24 hours' THEN 1 ELSE 0 END) AS last_24h,
        SUM(CASE WHEN created_at >= date_trunc('week', now()) THEN 1 ELSE 0 END) AS this_week,
        COUNT(*) AS total
      FROM leads
    `;

    const { rows } = await db.query(sql);
    const r = rows[0] || {};

    const today = Number(r.today || 0);
    const yesterday = Number(r.yesterday || 0);

    return res.json({
      ok: true,
      stats: {
        today,
        yesterday,
        last_24h: Number(r.last_24h || 0),
        this_week: Number(r.this_week || 0),
        total: Number(r.total || 0),
        delta: today - yesterday,
      },
    });
  } catch (err) {
    console.error("[leadsStats.GET] error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
