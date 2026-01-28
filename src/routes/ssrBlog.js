// src/routes/ssrBlog.js
const express = require('express');
const router = express.Router();

// Mounts two equivalent routes so clients can call either /ssr/blog/:slug or /blog/:slug
// (This avoids confusion when frontend or bots use one or the other.)
const ROUTE_PATHS = ['/ssr/blog/:slug', '/blog/:slug'];

/**
 * Helper: escape meta strings (title / description / canonical)
 */
function escapeHtml(s) {
  if (!s && s !== 0) return '';
  return String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

/**
 * Helper: try to derive article HTML from various stored shapes:
 * - content can be a string of HTML
 * - content can be JSON ({ html: '...' } or { blocks: [...] })
 * - fallback to excerpt
 */
function deriveBodyHtml(row) {
  if (!row) return '';
  const c = row.content;
  if (!c) return row.excerpt || '';
  try {
    if (typeof c === 'string') return c;
    // if DB returns JSON object already parsed
    if (c && typeof c === 'object') {
      if (c.html && typeof c.html === 'string') return c.html;
      if (Array.isArray(c.blocks)) {
        // join string blocks or pick html property
        return c.blocks.map(b => (typeof b === 'string' ? b : (b.html || ''))).join('\n');
      }
    }
  } catch (e) {
    // noop -> fallback
  }
  return row.excerpt || '';
}

/**
 * Create route for each path in ROUTE_PATHS
 */
ROUTE_PATHS.forEach((path) => {
  router.get(path, async (req, res) => {
    const db = req.db || req.app?.locals?.db || null;
    const slug = req.params.slug;
    if (!db || typeof db.query !== 'function') {
      console.error('[ssr] db not configured');
      return res.status(500).send('Server misconfiguration: database not available.');
    }
    if (!slug) return res.status(400).send('Bad request');

    try {
      const q = `
        SELECT id, title, slug, excerpt, content, meta_title, meta_description, og_image, published_at
        FROM blogs
        WHERE slug = $1 AND is_published = TRUE
        LIMIT 1
      `;
      const { rows } = await db.query(q, [slug]);
      if (!rows || !rows[0]) {
        // not found
        return res.status(404).send('Not found');
      }

      const b = rows[0];
      const title = b.meta_title || b.title || '';
      const desc = b.meta_description || b.excerpt || '';
      const og = b.og_image || '';
      const bodyHtml = deriveBodyHtml(b) || '';

      // build canonical from APP_DOMAIN or request host (robust for proxied deployments)
      const domain = (process.env.APP_DOMAIN || '').replace(/\/$/, '');
      const host = req.get('x-forwarded-host') || req.get('host') || '';
      const domainBase = domain || (host ? `${req.protocol}://${host}` : '');
      const canonical = domainBase ? `${domainBase}/blog/${encodeURIComponent(b.slug)}` : `/blog/${encodeURIComponent(b.slug)}`;

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  ${og ? `<meta property="og:image" content="${escapeHtml(og)}" />` : ''}
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <style>
    /* small readable reset for SSR pages */
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; color: #213; line-height:1.6; padding:24px; background:#fff; }
    main { max-width: 900px; margin: 0 auto; }
    h1 { color:#33504F; font-size:28px; margin-bottom:8px; }
    p.lead { color:#666; margin-top:0; }
    article img { max-width:100%; height:auto; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(b.title || '')}</h1>
    <p class="lead">${escapeHtml(b.excerpt || '')}</p>
    <article>${bodyHtml}</article>
  </main>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (err) {
      console.error('[ssr.blog] error', err && (err.stack || err.message) ? (err.stack || err.message) : err);
      return res.status(500).send('Server error');
    }
  });
});

module.exports = router;
