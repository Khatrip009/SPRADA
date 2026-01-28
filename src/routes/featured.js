// src/routes/featured.js
const express = require("express");
const router = express.Router();
const { buildImageUrl } = require("../lib/buildUrl");

router.get("/", async (req, res) => {
  const db = req.db;

  try {
    if (!db) throw new Error("DB missing");

    const q = `
      SELECT
        p.id, p.sku, p.title, p.slug, p.short_description,
        p.price, p.currency, p.moq, p.available_qty,
        p.is_published, p.metadata, p.created_at, p.og_image,
        jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name) AS category,
        pi.url AS primary_image
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT url
        FROM product_images
        WHERE product_id = p.id AND is_primary = TRUE
        ORDER BY created_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE p.is_published = TRUE
      ORDER BY p.created_at DESC
      LIMIT 8;
    `;

    const { rows } = await db.query(q);

    return res.json({
      ok: true,
      featured: rows.map((p) => ({
        ...p,
        primary_image: buildImageUrl(p.primary_image || p.og_image)
      }))
    });
  } catch (err) {
    console.error("[featured.GET] error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
