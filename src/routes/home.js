// src/routes/home.js
const express = require('express');
const router = express.Router();
const { buildImageUrl } = require('../lib/buildUrl');

/**
 * /api/home
 * Homepage payload:
 * {
 *   ok: true,
 *   hero,
 *   categories: [...],
 *   featured: [...],
 *   blogs: [...],
 *   testimonials: [...]   // optional
 * }
 */

router.get('/', async (req, res) => {
  const db = req.db || req.app?.locals?.db || null;

  try {
    if (!db || typeof db.query !== 'function')
      throw new Error('db pool missing');

    /* ------------------------------------
     * HERO SECTION (Static / Editable)
     * ------------------------------------ */
    // send null so frontend falls back to the local asset
    const hero = {
      title: 'SPRADA2GLOBAL',
      subtitle: 'Rich Quality, Reach to the World',
      image: null,
      tagline: 'Premium Agricultural Exports',
      description: 'Quality products, global shipping — trusted suppliers from India.',
    };

    /* ------------------------------------
     * CATEGORIES WITH THUMBNAILS (RLS Safe)
     * ------------------------------------ */
    const catQ = `
      SELECT
        c.id,
        c.slug,
        c.name,
        c.description,
        c.sort_order,
        COALESCE(pc.count, 0) AS count,
        pi.url AS thumb
      FROM categories c
      LEFT JOIN (
        SELECT category_id, COUNT(*) AS count
        FROM products
        WHERE is_published = TRUE
        GROUP BY category_id
      ) pc ON pc.category_id = c.id
      LEFT JOIN LATERAL (
        SELECT pi2.url
        FROM product_images pi2
        JOIN products p2 ON p2.id = pi2.product_id
        WHERE p2.category_id = c.id
          AND p2.is_published = TRUE  -- RLS SAFE CONDITION
        ORDER BY pi2.is_primary DESC NULLS LAST, pi2.created_at DESC
        LIMIT 1
      ) pi ON TRUE
      ORDER BY c.sort_order NULLS LAST, c.name
      LIMIT 12;
    `;
    const { rows: categories } = await db.query(catQ);

    /* ------------------------------------
     * FEATURED PRODUCTS (PRIMARY IMAGE SAFE)
     * ------------------------------------ */
    const featuredQ = `
      SELECT
        p.id, p.sku, p.title, p.slug, p.short_description,
        p.price, p.currency, p.moq,
        p.available_qty, p.is_published, p.metadata,
        p.created_at, p.og_image,
        jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name) AS category,
        pi.url AS primary_image
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT url 
        FROM product_images 
        WHERE product_id = p.id 
          AND (is_primary = TRUE OR is_primary IS NULL)
        ORDER BY is_primary DESC NULLS LAST, created_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE p.is_published = TRUE
      ORDER BY ((p.metadata->>'featured') = 'true') DESC NULLS LAST, p.created_at DESC
      LIMIT 8;
    `;
    const { rows: featuredRows } = await db.query(featuredQ);

    /* ------------------------------------
     * BLOGS (If table exists)
     * ------------------------------------ */
    let blogs = [];
    try {
      const blogQ = `
        SELECT
          b.id,
          b.title,
          b.slug,
          b.excerpt,
          b.published_at,
          b.og_image,
          (
            SELECT url
            FROM blog_images bi
            WHERE bi.blog_id = b.id
            ORDER BY bi.created_at DESC
            LIMIT 1
          ) AS image
        FROM blogs b
        WHERE b.is_published = TRUE
        ORDER BY b.published_at DESC NULLS LAST
        LIMIT 3;
      `;
      const { rows: blogRows } = await db.query(blogQ);

      blogs = blogRows.map(b => ({
        id: b.id,
        title: b.title,
        slug: b.slug,
        excerpt: b.excerpt,
        image: buildImageUrl(b.image || b.og_image || null),
        published_at: b.published_at,
      }));
    } catch (err) {
      blogs = []; // No blogs table or error → safe fallback
    }

    /* ------------------------------------
     * REVIEWS / TESTIMONIALS (If table exists)
     * NOTE: do NOT reference is_published (may not exist). Keep query minimal.
     * ------------------------------------ */
    let testimonials = [];
    try {
      const reviewsQ = `
        SELECT
          r.id,
          r.title,
          r.rating,
          r.body::text AS content,
          r.author_name,
          r.author_email,
          NULL::text AS author_title,
          NULL::text AS author_photo,
          r.created_at
        FROM reviews r
        ORDER BY r.created_at DESC
        LIMIT 10;
      `;
      const { rows: reviewRows } = await db.query(reviewsQ);

      testimonials = reviewRows.map(r => ({
        id: r.id,
        customerName: r.author_name || null,
        author_email: r.author_email || null,
        customerTitle: r.author_title || null,
        rating: r.rating == null ? 5 : Number(r.rating),
        content: r.content || null,
        customerPhoto: buildImageUrl(r.author_photo || null),
        created_at: r.created_at
      }));
    } catch (err) {
      // If reviews table doesn't exist or query fails, just continue silently
      testimonials = [];
    }

    /* ------------------------------------
     * FINAL RESPONSE
     * ------------------------------------ */
    return res.json({
      ok: true,
      hero,

      categories: categories.map(c => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        count: Number(c.count || 0),
        thumb: buildImageUrl(c.thumb || null),
      })),

      featured: featuredRows.map(p => {
        const primary =
          p.primary_image ||
          (p.metadata && p.metadata.og_image) ||
          p.og_image ||
          null;

        return {
          id: p.id,
          sku: p.sku,
          title: p.title,
          slug: p.slug,
          short_description: p.short_description || null,
          price: p.price,
          currency: p.currency,
          moq: p.moq,
          available_qty: p.available_qty == null ? null : Number(p.available_qty),
          is_published: !!p.is_published,
          metadata: p.metadata || {},
          category: p.category || null,
          primary_image: buildImageUrl(primary),
          created_at: p.created_at
        };
      }),

      blogs,
      testimonials
    });

  } catch (err) {
    console.error('[home.GET /api/home] error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
