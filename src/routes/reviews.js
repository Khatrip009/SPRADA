// src/routes/reviews.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Helper: validate UUID strings
const isValidUUID = (v) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);

/**
 * GET /api/reviews?about_type=&about_id=&limit=&page=
 * Returns:
 * {
 *   reviews: [...],
 *   total: number,
 *   page: number,
 *   limit: number,
 *   total_pages: number
 * }
 */
router.get('/', async (req, res) => {
  const db = req.db || req.app?.locals?.db || pool;

  try {
    // Sanitize pagination
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    // Raw inputs
    let about_type = req.query.about_type;
    let about_id = req.query.about_id;

    // Build filtering
    const where = [];
    const params = [];

    // Clean about_type
    if (
      about_type &&
      about_type !== "" &&
      about_type !== "undefined" &&
      about_type !== "null"
    ) {
      params.push(about_type);
      where.push(`about_type = $${params.length}`);
    }

    // Clean about_id (only accept valid UUID)
    if (
      about_id &&
      about_id !== "" &&
      about_id !== "undefined" &&
      about_id !== "null" &&
      isValidUUID(about_id)
    ) {
      params.push(about_id);
      where.push(`about_id = $${params.length}`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Count rows
    const countQ = `SELECT COUNT(*)::int AS total FROM reviews ${whereSQL}`;
    const { rows: countRows } = await db.query(countQ, params);
    const total = countRows[0].total || 0;

    // Fetch reviews
    params.push(limit, offset);

    const q = `
      SELECT 
        id, author_name, author_email, rating, title, body,
        about_type, about_id, created_at
      FROM reviews
      ${whereSQL}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length};
    `;

    const { rows } = await db.query(q, params);

    return res.json({
      reviews: rows,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit)
    });

  } catch (err) {
    console.error("[reviews.GET] error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});


/**
 * POST /api/reviews
 */
router.post('/', async (req, res) => {
  const { about_type, about_id, author_name, author_email, rating, title, body } = req.body || {};

  if (!about_type || !about_id || !rating)
    return res.status(400).json({ error: 'about_type, about_id and rating required' });

  try {
    const id = uuidv4();
    await pool.query(
      `
      INSERT INTO reviews 
      (id, about_type, about_id, author_name, author_email, rating, title, body, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
      `,
      [id, about_type, about_id, author_name || null, author_email || null, rating, title || null, body || null]
    );

    return res.status(201).json({ id });

  } catch (err) {
    console.error('[reviews.POST] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});


/**
 * GET /api/reviews/stats
 */
router.get('/stats', async (req, res) => {
  const db = req.db || req.app?.locals?.db || pool;

  try {
    // Summary
    const summaryQ = `
      SELECT COUNT(*)::int AS total,
             ROUND(AVG(rating)::numeric, 2) AS avg_rating
      FROM reviews
    `;
    const { rows: summaryRows } = await db.query(summaryQ);

    const total = summaryRows[0]?.total || 0;
    const avg_rating = summaryRows[0]?.avg_rating || null;

    // Count per rating
    const countsQ = `
      SELECT rating::int AS rating, COUNT(*)::int AS cnt
      FROM reviews
      WHERE rating IS NOT NULL
      GROUP BY rating
    `;
    const { rows: countsRows } = await db.query(countsQ);

    const counts = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const r of countsRows) {
      counts[String(r.rating)] = r.cnt;
    }

    return res.json({ total, avg_rating, counts });

  } catch (err) {
    console.error('[reviews.GET /stats] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});


module.exports = router;
