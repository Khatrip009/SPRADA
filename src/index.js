'use strict';

/**
 * FINAL FIXED index.js
 * - DB pool is properly attached
 * - req.db works everywhere
 * - healthcheck works
 * - products route fixed
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

// ✅ IMPORT DB POOL (THIS WAS MISSING)
const { pool } = require('./db');

let fetchFunc = global.fetch;
if (!fetchFunc) {
  try {
    const undici = require('undici');
    if (undici?.fetch) fetchFunc = undici.fetch;
  } catch {
    try {
      let nf = require('node-fetch');
      if (nf?.default) nf = nf.default;
      fetchFunc = nf;
    } catch {
      fetchFunc = null;
    }
  }
}

const PORT = parseInt(process.env.PORT || '4200', 10);
const ENV = process.env.NODE_ENV || 'development';

const app = express();
app.set('trust proxy', true);

/* ---------------- SECURITY ---------------- */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));

/* =========================================================
   🔥 DB ATTACH MIDDLEWARE (CRITICAL FIX)
   ========================================================= */
app.use((req, res, next) => {
  req.db = pool;
  req.app.locals.db = pool;
  next();
});

/* ---------------- RESPONSE LOGGER ---------------- */
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      console.error(`[RESP] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    }
  });
  next();
});

/* ---------------- CORS ---------------- */
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
  'http://localhost:4200'
];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  credentials: true
};

app.use('/api', cors(corsOptions));

/* ---------------- HEALTH ---------------- */
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1');
    res.json({ ok: true, db: true, uptime: process.uptime() });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

/* ---------------- JWT ---------------- */
let jwtAuthMiddleware = require('./middleware/jwt').jwtAuthMiddleware;

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  if (req.path === '/leads' && req.method === 'POST') return next();
  return jwtAuthMiddleware(req, res, next);
});

/* ---------------- ROUTES ---------------- */
const routesBase = path.join(__dirname, 'routes');

function mount(route, pathName) {
  try {
    app.use(pathName, require(path.join(routesBase, route)));
    console.log(`Mounted ${route}`);
  } catch (e) {
    console.warn(`Skipped ${route}:`, e.message);
  }
}

mount('auth', '/api/auth');
mount('products', '/api/products');
mount('categories', '/api/categories');
mount('blogs', '/api/blogs');
mount('users', '/api/users');
mount('reviews', '/api/reviews');
mount('events', '/api/events');
mount('leads', '/api/leads');
mount('visitors', '/api/visitors');
mount('metrics', '/api/metrics');


/* ---------------- 404 ---------------- */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found' });
});

/* ---------------- ERROR ---------------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    ok: false,
    error: 'server_error',
    detail: err.message
  });
});

/* ---------------- START ---------------- */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sprada backend running on ${PORT}`);
});

/* ---------------- SHUTDOWN ---------------- */
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  server.close(() => process.exit(0));
});
