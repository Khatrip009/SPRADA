// src/lib/sitemapService.js
const fs = require("fs");
const path = require("path");

// ------------------------------
// Safely fetch rows from DB
// ------------------------------
async function fetchRows(db, sql, params = []) {
  if (!db || typeof db.query !== "function") return [];
  const { rows } = await db.query(sql, params);
  return rows || [];
}

// ------------------------------
// URL Entry for XML sitemap
// ------------------------------
function urlEntry(url, opts = {}) {
  const lastmod = opts.lastmod ? `<lastmod>${opts.lastmod.toISOString()}</lastmod>` : "";
  const changefreq = opts.changefreq ? `<changefreq>${opts.changefreq}</changefreq>` : "";
  const priority =
    typeof opts.priority === "number"
      ? `<priority>${opts.priority.toFixed(1)}</priority>`
      : "";

  return `<url><loc>${url}</loc>${lastmod}${changefreq}${priority}</url>`;
}

// ------------------------------
// Build XML Sitemap
// ------------------------------
async function buildXml(db, baseUrl) {
  baseUrl =
    (baseUrl || process.env.APP_DOMAIN || "https://localhost:4200").replace(
      /\/$/,
      ""
    );

  const urls = [];

  // homepage
  urls.push(urlEntry(`${baseUrl}/`, { changefreq: "daily", priority: 1.0 }));

  // categories
  const categories = await fetchRows(
    db,
    `SELECT slug, updated_at FROM categories ORDER BY sort_order NULLS LAST, name`
  );
  categories.forEach((c) =>
    urls.push(
      urlEntry(`${baseUrl}/category/${encodeURIComponent(c.slug)}`, {
        lastmod: c.updated_at || null,
        changefreq: "weekly",
        priority: 0.8,
      })
    )
  );

  // products
  const products = await fetchRows(
    db,
    `SELECT slug, updated_at FROM products
     WHERE is_published = TRUE ORDER BY updated_at DESC LIMIT 50000`
  );
  products.forEach((p) =>
    urls.push(
      urlEntry(`${baseUrl}/product/${encodeURIComponent(p.slug)}`, {
        lastmod: p.updated_at || null,
        changefreq: "weekly",
        priority: 0.9,
      })
    )
  );

  // blogs
  const blogs = await fetchRows(
    db,
    `SELECT slug, published_at, updated_at FROM blogs
     WHERE is_published = TRUE ORDER BY published_at DESC LIMIT 50000`
  );
  blogs.forEach((b) => {
    const last = b.published_at || b.updated_at || null;
    urls.push(
      urlEntry(`${baseUrl}/blog/${encodeURIComponent(b.slug)}`, {
        lastmod: last,
        changefreq: "monthly",
        priority: 0.7,
      })
    );
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join(
    "\n"
  )}\n</urlset>`;

  return xml;
}

// ------------------------------
// Write Sitemap to public folder
// ------------------------------
async function writeStatic(xml) {
  const outDir = path.resolve(process.cwd(), "public");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "sitemap.xml");
  fs.writeFileSync(outPath, xml, "utf8");
  return outPath;
}

module.exports = {
  // ------------------------------
  // REBUILD SITEMAP
  // ------------------------------
  async rebuild(db, baseUrl) {
    if (!db || typeof db.query !== "function") {
      console.warn("sitemapService.rebuild: DB missing → SKIPPED");
      return { ok: false, skipped: true };
    }

    const xml = await buildXml(db, baseUrl);
    const outPath = await writeStatic(xml);
    return { ok: true, path: outPath };
  },

  // ------------------------------
  // INVALIDATE + silently fallback
  // ------------------------------
  async invalidate(providedDb = null, baseUrl) {
    let db = providedDb;

    // auto-detect DB if not provided
    if (!db) {
      try {
        const local = require("../db");
        db = local.pool || local.client || local;
      } catch {
        db = null;
      }
    }

    // no db = skip sitemap generation (do NOT error)
    if (!db || typeof db.query !== "function") {
      console.warn("sitemapService.invalidate: No DB → Sitemap SKIPPED");
      return { ok: false, skipped: true };
    }

    try {
      return await this.rebuild(db, baseUrl);
    } catch (err) {
      console.error("sitemapService.invalidate failed:", err);
      return { ok: false, error: err.message };
    }
  },
};
