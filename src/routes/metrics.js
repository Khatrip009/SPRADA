// src/routes/metrics.js
const express = require('express');
const router = express.Router();

/**
 * GET /api/metrics/visitors/summary
 * Returns:
 * {
 *   total_visitors: number,
 *   visitors_today: number | null,
 *   new_visitors_today: number | null
 * }
 *
 * This attempts to use materialized views if present (mv_daily_visitors, mv_unique_visitors_per_day),
 * and falls back to simple counts on visitors table if not.
 */
router.get('/visitors/summary', async (req, res) => {
  const db = req.db || req.app?.locals?.db || req.app?.locals?.pool;
  try {
    if (!db || typeof db.query !== 'function') throw new Error('db pool missing');

    // 1) total visitors (from visitors table)
    const totQ = 'SELECT COUNT(*)::int AS total FROM public.visitors';
    const { rows: totRows } = await db.query(totQ);
    const total_visitors = (totRows && totRows[0] && Number(totRows[0].total)) || 0;

    // 2) try to get visitors_today from mv_daily_visitors materialized view (if exists)
    let visitors_today = null;
    try {
      const todayQ = `SELECT COALESCE(page_views, 0)::int AS page_views FROM public.mv_daily_visitors WHERE day = current_date LIMIT 1`;
      const { rows } = await db.query(todayQ);
      if (rows && rows[0]) visitors_today = Number(rows[0].page_views);
    } catch (e) {
      // view may not exist; fallback below
    }

    // 3) try to get new_visitors_today from mv_unique_visitors_per_day materialized view
    let new_visitors_today = null;
    try {
      const newQ = `SELECT COALESCE(new_visitors, 0)::int AS new_visitors FROM public.mv_unique_visitors_per_day WHERE day = current_date LIMIT 1`;
      const { rows } = await db.query(newQ);
      if (rows && rows[0]) new_visitors_today = Number(rows[0].new_visitors);
    } catch (e) {
      // view may not exist; fallback below
    }

    // Fallbacks if materialized views not present
    if (visitors_today === null) {
      try {
        const vQ = `
          SELECT COUNT(DISTINCT v.session_id)::int AS visitors_today
          FROM public.visitors v
          LEFT JOIN public.analytics_events ev ON ev.visitor_id = v.id AND ev.created_at::date = current_date
          WHERE ev.id IS NOT NULL
        `;
        const { rows } = await db.query(vQ);
        if (rows && rows[0]) visitors_today = Number(rows[0].visitors_today || 0);
      } catch (e) {
        visitors_today = null;
      }
    }

    if (new_visitors_today === null) {
      try {
        const nvQ = `SELECT COUNT(*)::int AS new_visitors_today FROM public.visitors WHERE first_seen::date = current_date`;
        const { rows } = await db.query(nvQ);
        if (rows && rows[0]) new_visitors_today = Number(rows[0].new_visitors_today || 0);
      } catch (e) {
        new_visitors_today = null;
      }
    }

    return res.json({
      total_visitors,
      visitors_today,
      new_visitors_today
    });
  } catch (err) {
    console.error('[metrics.GET /api/metrics/visitors/summary] error:', err && err.stack ? err.stack : err);
    const payload = { error: 'server_error' };
    if (process.env.NODE_ENV !== 'production') payload.detail = (err && err.message) || String(err);
    return res.status(500).json(payload);
  }
});

module.exports = router;
