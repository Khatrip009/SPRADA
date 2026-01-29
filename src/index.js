'use strict';

/**
 * FINAL PRODUCTION index.js
 * - DB pool attached
 * - JWT works
 * - Supabase image uploads supported
 * - Product & Blog images routes fixed
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');


// ✅ DB POOL
const { pool } = require('./db');

const PORT = parseInt(process.env.PORT || '4200', 10);
const ENV = process.env.NODE_ENV || 'development';

const app = express();
app.set('trust proxy', true);

/* ---------------- SECURITY ---------------- */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());

/* ---------------- BODY PARSERS ---------------- */
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

/* ---------------- FILE UPLOAD (REQUIRED FOR SUPABASE) ---------------- */
app.use(
  fileUpload({
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    abortOnLimit: true,
    createParentPath: false
  })
);

/* ---------------- LOGGING ---------------- */
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));

/* =========================================================
   🔥 DB ATTACH MIDDLEWARE (CRITICAL)
   ========================================================= */
app.use((req, res, next) => {
  req.db = pool;
  req.app.locals.db = pool;
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
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true, uptime: process.uptime() });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

/* ---------------- JWT ---------------- */
const { jwtAuthMiddleware } = require('./middleware/jwt');

app.use('/api', (req, res, next) => {
  // Public routes
  if (req.path.startsWith('/auth')) return next();
  if (req.path.startsWith('/visitors')) return next();
  if (req.path.startsWith('/metrics')) return next();
  if (req.path === '/leads' && req.method === 'POST') return next();

  return jwtAuthMiddleware(req, res, next);
});

/* ---------------- ROUTES ---------------- */
const routesBase = path.join(__dirname, 'routes');

function mount(route, url) {
  try {
    app.use(url, require(path.join(routesBase, route)));
    console.log(`✅ Mounted ${url}`);
  } catch (e) {
    console.warn(`⚠️ Skipped ${route}:`, e.message);
  }
}

mount('auth', '/api/auth');
mount('products', '/api/products');
mount('product-images', '/api/product-images');
mount('categories', '/api/categories');
mount('blogs', '/api/blogs');
mount('blog-images', '/api/blog-images');
mount('users', '/api/users');
mount('reviews', '/api/reviews');
mount('events', '/api/events');
mount('leads', '/api/leads');
mount('visitors', '/api/visitors');
mount('metrics', '/api/metrics');

/* ---------------- 404 ---------------- */
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

/* ---------------- ERROR HANDLER ---------------- */
app.use((err, req, res, next) => {
  console.error('❌ SERVER ERROR:', err);
  res.status(500).json({
    ok: false,
    error: 'server_error',
    detail: err.message
  });
});

/* ---------------- START SERVER ---------------- */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sprada backend running on port ${PORT}`);
});

/* ---------------- GRACEFUL SHUTDOWN ---------------- */
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down...');
  await pool.end();
  server.close(() => process.exit(0));
});
