'use strict';

/**
 * Express server entry with robust CORS, OPTIONS handling, DB attach,
 * static uploads serving, and an uploads "mirror" that serves local files
 * or proxies to an upstream API host when missing.
 *
 * Ready-to-paste. Restart server after replacing.
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);

let fetchFunc = global.fetch;
if (!fetchFunc) {
  try {
    // Prefer undici when available (works well in Node >= 14+)
    // eslint-disable-next-line node/no-extraneous-require
    const undici = require('undici');
    if (undici && undici.fetch) {
      fetchFunc = undici.fetch;
      console.log('[startup] using undici.fetch as fetch polyfill');
    }
  } catch (e) {
    // undici not present, try node-fetch (may be ESM in v3; this will work only for v2)
    try {
      // eslint-disable-next-line node/no-extraneous-require
      let nf = require('node-fetch');
      // node-fetch v3 uses ESM and exports default; handle both shapes
      if (nf && nf.default) nf = nf.default;
      fetchFunc = nf;
      console.log('[startup] using node-fetch as fetch polyfill');
    } catch (e2) {
      console.warn('[startup] no global fetch and no fetch polyfill found; upstream proxying will not work if needed.');
      fetchFunc = null;
    }
  }
}

const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '4200', 10);
const ENV = process.env.NODE_ENV || 'development';

const app = express();

// If behind a reverse proxy (Caddy/Nginx) set trust proxy to allow correct client IPs & secure cookies
app.set('trust proxy', true);

/* ----------------------
   Security & middleware
   ---------------------- */
/*
  Note: helmet by default may add Cross-Origin-Resource-Policy which
  can block cross-origin embedding of images. Disable automatic CORP here
  and set it explicitly for uploads responses below.
*/
app.use(helmet({ crossOriginResourcePolicy: false }));

app.use(compression());
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));

/* ----------------------
   Simple response logger
   ---------------------- */
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      console.error(`[RESP] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    } else if (res.statusCode >= 400) {
      console.warn(`[RESP] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    }
  });
  next();
});

/* ----------------------
   Allowed origins list
   ---------------------- */
/*
  Keep this list in sync with your Caddy echoing rules.
  Add or remove origins here as your trusted clients change.
*/
const allowedOrigins = [
  'https://sprada2global.exotech.co.in',
  'https://sprada2globalexim.com',
  'https://admin.sprada2globalexim.com',
  'https://sprada.exotech.co.in',
  'https://apisprada.exotech.co.in',
  'https://adminsprada.exotech.co.in',
  'https://exotech.co.in',
  'https://khatrip009.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  'http://localhost:3000'
];

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  // allow subpath origins like https://khatrip009.github.io/<repo>
  if (typeof origin === 'string' && origin.startsWith('https://khatrip009.github.io')) return true;
  return false;
}

/* ----------------------
   Global CORS for API routes
   ---------------------- */
const corsOptionsForApi = {
  origin: (origin, callback) => {
    // allow non-browser tools (curl/postman) which often omit Origin
    if (!origin) return callback(null, true);
    if (isOriginAllowed(origin)) return callback(null, true);
    console.warn('CORS blocked for origin (API):', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Cache-Control']
};

app.use((req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    return cors(corsOptionsForApi)(req, res, next);
  }
  return next();
});

/* ----------------------
   Global OPTIONS preflight (catch-all)
   ---------------------- */
app.options('*', (req, res) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // when origin absent or not allowed, echo origin or fallback to wildcard
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization, Cache-Control, X-Requested-With, Accept, Origin');
  return res.sendStatus(204);
});

/* ----------------------
   Serve uploads (static) root
   ---------------------- */
const UPLOAD_ROOT = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
console.log('[server] UPLOAD_ROOT =', UPLOAD_ROOT);

// Upstream API host to proxy to when file missing locally.
// Set via env: API_UPLOADS_HOST=https://apisprada.exotech.co.in
const API_UPLOADS_HOST = process.env.API_UPLOADS_HOST || 'https://apisprada.exotech.co.in';

// Normalize upstream host (remove trailing slash)
const API_UPLOADS_HOST_NORMALIZED = (API_UPLOADS_HOST || '').replace(/\/+$/, '');

// allowed origins for uploads responses (fine-grained)
const uploadsAllowedOrigins = [
  'https://admin.sprada2globalexim.com',
  'https://sprada2globalexim.com',
  'https://sprada2global.exotech.co.in',
  'https://adminsprada.exotech.co.in',
  'https://sprada.exotech.co.in',
  'https://apisprada.exotech.co.in',
  'https://exotech.co.in',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4200',
  'http://127.0.0.1:4200'
];

function isUploadsOriginAllowed(origin) {
  if (!origin) return false;
  if (uploadsAllowedOrigins.includes(origin)) return true;
  if (typeof origin === 'string' && origin.startsWith('https://khatrip009.github.io')) return true;
  return false;
}

/* ----------------------
   (debug) log blocked origins for easier troubleshooting - remove in prod if noisy
   ---------------------- */
app.use((req, res, next) => {
  try {
    const origin = req.headers.origin;
    // Only log when origin exists and is not allowed by either list and request targets api/uploads or /api
    if (origin && !isOriginAllowed(origin) && !isUploadsOriginAllowed(origin)) {
      console.warn('[CORS] blocked origin:', origin, 'path:', req.path);
    }
  } catch (e) {
    // ignore
  }
  next();
});

/* ----------------------
   Helper: set CORS/CORP headers for uploads
   ---------------------- */
function setUploadsResponseHeaders(req, res, { allowCredentials = true } = {}) {
  const origin = (req.headers && req.headers.origin) || '';
  if (origin && isUploadsOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (allowCredentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    // If origin not allowed or missing, use wildcard (no credentials)
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Cache-Control, Content-Type');
  // allow embedding cross-origin
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

/* ----------------------
   Uploads mirror middleware
   - Serves local file if present
   - Else attempts to proxy (stream) from API_UPLOADS_HOST
   - Ensures correct headers for CORS & CORP
   ---------------------- */
app.use(async (req, res, next) => {
  try {
    // Only GET/HEAD for static assets
    if (!['GET', 'HEAD'].includes(req.method)) return next();

    // only handle /uploads/* and /src/uploads/*
    if (!req.path.startsWith('/uploads/') && !req.path.startsWith('/src/uploads/')) {
      return next();
    }

    // Map request to a filesystem path under UPLOAD_ROOT (safe: normalize & prevent traversal)
    const relPathRaw = req.path.replace(/^\/src\/uploads\//, '').replace(/^\/uploads\//, '').replace(/^\/+/, '');
    // use posix normalize to avoid backslash surprises across platforms
    const relPath = path.posix.normalize('/' + relPathRaw).replace(/^\/+/, '');
    const fsPath = path.join(UPLOAD_ROOT, relPath);

    // Security: ensure resolved fsPath is under UPLOAD_ROOT
    const resolvedUploadRoot = path.resolve(UPLOAD_ROOT);
    const resolvedFsPath = path.resolve(fsPath);
    if (!(resolvedFsPath === resolvedUploadRoot || resolvedFsPath.startsWith(resolvedUploadRoot + path.sep))) {
      console.warn('[uploads-mirror] path traversal attempt:', req.path, fsPath);
      return res.status(400).send('Bad Request');
    }

    // If file exists locally, serve it
    if (fs.existsSync(resolvedFsPath) && fs.statSync(resolvedFsPath).isFile()) {
      setUploadsResponseHeaders(req, res, { allowCredentials: true });
      return res.sendFile(resolvedFsPath, (err) => {
        if (err) {
          console.warn('[uploads-mirror] sendFile error for', resolvedFsPath, err && err.message);
          return next();
        }
      });
    }

    // File not found locally -> try to proxy from API_UPLOADS_HOST
    if (!fetchFunc) {
      console.warn('[uploads-mirror] fetch not available; cannot proxy upstream:', API_UPLOADS_HOST_NORMALIZED + req.path);
      return next();
    }

    const upstreamUrl = `${API_UPLOADS_HOST_NORMALIZED}${req.path}`;
    let upstreamResp;
    try {
      upstreamResp = await fetchFunc(upstreamUrl, { method: 'GET', redirect: 'follow' });
    } catch (err) {
      console.warn('[uploads-mirror] error fetching upstream', upstreamUrl, err && err.message);
      return next();
    }

    if (!upstreamResp) return next();

    if (upstreamResp.status === 404) {
      // upstream not found -> reply 404
      res.status(404).send('Not Found');
      return;
    }

    if (!upstreamResp.ok) {
      // upstream returned error -> let next handle or forward minimal info
      console.warn(`[uploads-mirror] upstream ${upstreamUrl} returned ${upstreamResp.status}`);
      try {
        const ct = upstreamResp.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const body = await upstreamResp.text();
          res.status(upstreamResp.status).type('application/json').send(body);
          return;
        }
      } catch (_) {}
      return next();
    }

    // ok -> stream the response to client, copying useful headers
    const contentType = upstreamResp.headers.get('content-type');
    const contentLength = upstreamResp.headers.get('content-length');
    const cacheControl = upstreamResp.headers.get('cache-control');
    const contentDisposition = upstreamResp.headers.get('content-disposition');
    const etag = upstreamResp.headers.get('etag');
    const lastModified = upstreamResp.headers.get('last-modified');

    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    if (etag) res.setHeader('ETag', etag);
    if (lastModified) res.setHeader('Last-Modified', lastModified);

    // For proxied responses we avoid allowing credentials by default (echoing origin would require it).
    // Set permissive CORP for embedding.
    setUploadsResponseHeaders(req, res, { allowCredentials: false });

    // Stream upstream body to client
    const body = upstreamResp.body;
    if (!body) return next();
    await streamPipeline(body, res);
    return;
  } catch (err) {
    console.error('[uploads-mirror] unexpected error:', err && (err.stack || err));
    return next();
  }
});

/* ----------------------
   Static fallback serving (if a request reaches here)
   - This will serve files from UPLOAD_ROOT with setHeaders for CORS & caching
   ---------------------- */
const staticOpts = {
  maxAge: '7d',
  fallthrough: true,
  setHeaders: (res, filePath) => {
    try {
      if (filePath.match(/\.(jpg|jpeg|png|gif|webp|avif|svg)$/i)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }

      const reqOrigin = (res.req && res.req.headers && res.req.headers.origin) || '';

      if (isUploadsOriginAllowed(reqOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', reqOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }

      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Cache-Control, Content-Type');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } catch (e) {
      console.warn('[static.setHeaders] non-fatal error:', e && e.message);
    }
  }
};

// Mount static routes for uploads (legacy path included)
app.use('/uploads', (req, res, next) => {
  // CORS middleware for uploads route (echo origin only if allowed)
  const corsOpts = {
    origin: (o, cb) => {
      if (!o) return cb(null, true);
      if (isUploadsOriginAllowed(o)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Cache-Control']
  };
  return cors(corsOpts)(req, res, next);
}, express.static(UPLOAD_ROOT, staticOpts));

app.use('/src/uploads', (req, res, next) => {
  const corsOpts = {
    origin: (o, cb) => {
      if (!o) return cb(null, true);
      if (isUploadsOriginAllowed(o)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Cache-Control']
  };
  return cors(corsOpts)(req, res, next);
}, express.static(UPLOAD_ROOT, staticOpts));

/* ----------------------
   Healthcheck
   ---------------------- */
async function probeDb() {
  try {
    const dbPaths = [
      path.join(__dirname, 'lib', 'db'),
      path.join(__dirname, 'db'),
      path.join(__dirname, '..', 'lib', 'db'),
      path.join(__dirname, '..', 'db')
    ];
    for (const p of dbPaths) {
      try {
        const db = require(p);
        if (!db) continue;
        if (typeof db.ping === 'function') {
          const r = await db.ping();
          return { ok: true, result: r };
        }
        const pool = db.pool || db.client || db;
        if (pool && typeof pool.query === 'function') {
          try { const r = await pool.query('SELECT 1'); return { ok: true, result: r }; } catch {}
        }
        if (db.ok) return { ok: !!db.ok, result: db };
      } catch {}
    }
  } catch {}
  return { ok: null, result: null };
}

app.get('/health', async (req, res) => {
  const uptime = process.uptime();
  const timestamp = new Date().toISOString();
  let dbProbe = { ok: null, result: null };
  try {
    dbProbe = await probeDb();
  } catch (e) {
    dbProbe = { ok: false, result: String(e) };
  }
  res.json({ ok: true, uptime, timestamp, env: ENV, user: null, db: dbProbe });
});

/* ----------------------
   Attach DB helper (optional)
   ---------------------- */
(function attachDbIfPresent() {
  const tryPaths = [ path.join(__dirname, 'db'), path.join(__dirname, '..', 'db') ];
  let db = null;
  for (const p of tryPaths) {
    try {
      const mod = require(p);
      if (mod) {
        db = mod;
        console.log(`Loaded DB helper from ${p}`);
        break;
      }
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') {
        console.warn(`Error requiring DB helper ${p}:`, e && e.message);
      }
    }
  }
  if (!db) return;
  const pool = db.pool || db.client || db;
  if (pool && typeof pool.query === 'function') {
    app.locals.db = pool;
    app.use((req, res, next) => { req.db = app.locals.db; next(); });

    if (typeof pool.connect === 'function') {
      app.use((req, res, next) => {
        req.txRun = async (fn, ctx = {}) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            if (ctx.settings) {
              for (const s of ctx.settings) {
                await client.query(s.sql, s.params || []);
              }
            }
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
          } catch (err) {
            try { await client.query('ROLLBACK'); } catch {}
            throw err;
          } finally {
            client.release();
          }
        };
        next();
      });
    }
  }
})();

/* ----------------------
   JWT AUTH MIDDLEWARE (unchanged)
   ---------------------- */
let jwtAuthMiddleware = null;
try {
  jwtAuthMiddleware = require('./middleware/jwt').jwtAuthMiddleware;
} catch (e) {
  console.warn('[index] jwt middleware not found:', e && e.message);
  jwtAuthMiddleware = (req, res, next) => next();
}

app.use('/api', (req, res, next) => {
  if (req.path === '/auth' || req.path.startsWith('/auth/')) {
    return next();
  }
 // Allow public POST to /api/leads (contact form) without JWT
  // NOTE: keep this minimal — only add truly public endpoints here.
  if (req.path === '/leads' && req.method === 'POST') {
    return next();
  }
  return jwtAuthMiddleware(req, res, next);
});

/* ----------------------
   Helper: require route & route mounting (unchanged)
   ---------------------- */
function tryRequireRoute(relPath) {
  try {
    const r = require(relPath);
    if (!r) {
      console.warn(`Require succeeded for ${relPath} but module.exports is falsy`);
      return null;
    }
    return r;
  } catch (e) {
    console.warn(`Failed to require ${relPath}:`, e && e.message);
    return null;
  }
}

const routesBase = path.join(__dirname, 'routes');

function mountRouteModule(mod, mountPoint, name) {
  if (!mod) {
    console.warn(`Route module for ${name} not found; skipping mount at ${mountPoint}`);
    return false;
  }
  try {
    const isRouter = typeof mod === 'function' || (mod && (mod.stack || mod.handle));
    if (isRouter) {
      app.use(mountPoint, mod);
      console.log(`Mounted ${name} at ${mountPoint}`);
      return true;
    }
    if (typeof mod === 'object') {
      let mountedAny = false;
      for (const key of Object.keys(mod)) {
        const candidate = mod[key];
        if (!candidate) continue;
        const candidateIsRouter = typeof candidate === 'function' || (candidate && (candidate.stack || candidate.handle));
        if (candidateIsRouter) {
          app.use(mountPoint, candidate);
          console.log(`Mounted ${name}.${key} at ${mountPoint}`);
          mountedAny = true;
        }
      }
      if (!mountedAny) {
        console.warn(`Module ${name} did not contain any router exports; skipping mount at ${mountPoint}`);
        return false;
      }
      return true;
    }
    app.use(mountPoint, mod);
    console.log(`Mounted ${name} at ${mountPoint} (fallback)`);
    return true;
  } catch (e) {
    console.error(`Failed to mount ${name} at ${mountPoint}:`, e && e.message);
    return false;
  }
}

/* ----------------------
   MOUNT ROUTES
   ---------------------- */
mountRouteModule(tryRequireRoute(path.join(routesBase, 'auth')), '/api/auth', 'auth');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'uploads-local')), '/api/uploads', 'uploads-local');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'uploads')), '/api/uploads', 'uploads-s3');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'users')), '/api/users', 'users');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'blog-images')), '/api/blog-images', 'blog-images');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'blogs')), '/api/blogs', 'blogs');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'blogLikes')), '/api/blogs', 'blog-likes');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'blogComments')), '/api/blogs', 'blog-comments');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'categories')), '/api/categories', 'categories');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'home')), '/api/home', 'home');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'metrics')), '/api/metrics', 'metrics');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'products')), '/api/products', 'products');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'productImages')), '/api/product-images', 'product-images');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'events')), '/api/events', 'events');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'reviews')), '/api/reviews', 'reviews');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'visitors')), '/api/visitors', 'visitors');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'push')), '/api/push', 'push');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'leads')), '/api/leads', 'leads');
mountRouteModule(tryRequireRoute(path.join(routesBase, 'leadsStats')), '/api/leads-stats', 'leads-stats');
mountRouteModule(  tryRequireRoute(path.join(routesBase, 'featured')),  '/api/featured',  'featured');

/* ----------------------
   404 JSON for /api/*
   ---------------------- */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/api') {
    return res.status(404).json({ error: 'not_found', path: req.path });
  }
  next();
});

/* ----------------------
   Error handler
   ---------------------- */
app.use((err, req, res, next) => {
  try {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      // fallback origin; keep something sane to avoid browser CORS errors while still logging
      res.setHeader('Access-Control-Allow-Origin', origin || 'https://khatrip009.github.io');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  } catch {}

  const status = err.status || 500;
  const body = {
    ok: false,
    error: err.message || 'internal_error',
    details: ENV !== 'production' ? (err.stack || err) : undefined
  };

  console.error('Unhandled error:', err && err.message);
  res.status(status).json(body);
});

/* ----------------------
   Start server
   ---------------------- */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Exotech Sprada Backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Node ENV: ${ENV}`);
  console.log(`API_UPLOADS_HOST = ${API_UPLOADS_HOST_NORMALIZED}`);
});

/* ----------------------
   Graceful shutdown handlers
   ---------------------- */
async function shutdown(signal) {
  try {
    console.info(`[shutdown] received ${signal}, closing server...`);
    // stop accepting new connections
    server.close(async (err) => {
      if (err) console.error('[shutdown] server close error:', err && err.message);
      // Try to close DB pools if present
      try {
        const pool = app.locals.db;
        if (pool) {
          if (typeof pool.end === 'function') {
            console.info('[shutdown] closing DB pool (end)');
            await pool.end();
          } else if (typeof pool.close === 'function') {
            console.info('[shutdown] closing DB pool (close)');
            await pool.close();
          }
        }
      } catch (dbErr) {
        console.warn('[shutdown] error closing DB pool:', dbErr && dbErr.message);
      } finally {
        process.exit(0);
      }
    });

    // Force exit if not closed after timeout
    setTimeout(() => {
      console.error('[shutdown] force exit after timeout');
      process.exit(1);
    }, 10000).unref();
  } catch (e) {
    console.error('[shutdown] unexpected during shutdown:', e && e.stack);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err));
  // allow the process to restart cleanly
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && (reason.stack || reason));
});
