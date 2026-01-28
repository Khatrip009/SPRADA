// src/routes/uploads.js
/**
 * Uses AWS SDK v3 (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner)
 * Produces presigned PUT URLs (v4), sanitizes filename to avoid path injection,
 * uses explicit credentials/region from environment variables.
 *
 * Also exposes a simple image proxy GET /api/uploads/proxy?src=...
 * to work around remote-host 403s (whitelisted hosts only).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const stream = require('stream');

const {
  S3Client,
  PutObjectCommand
} = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

/* ===================== S3 CONFIG ===================== */

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION;
const ACCESS_KEY = process.env.S3_ACCESS_KEY;
const SECRET_KEY = process.env.S3_SECRET_KEY;

if (!BUCKET || !REGION) {
  console.warn('uploads.js: S3_BUCKET or S3_REGION not set. Presign endpoint will fail until configured.');
}

// Create S3 client (v3)
const s3Client = new S3Client({
  region: REGION || undefined,
  credentials: (ACCESS_KEY && SECRET_KEY) ? {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY
  } : undefined
});

/* ===================== HELPERS ===================== */

function sanitizeFileName(filename = '') {
  const base = path.basename(String(filename || 'file'));
  const cleaned = base.replace(/[^a-zA-Z0-9.\-_]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `${Date.now()}`;
}

/* ===================== PRESIGNED UPLOAD URL ===================== */

router.post('/presign', express.json(), async (req, res) => {
  const { fileName, fileType } = req.body || {};
  if (!fileName || !fileType) return res.status(400).json({ ok: false, error: 'fileName and fileType required' });
  if (!BUCKET || !REGION) return res.status(500).json({ ok: false, error: 's3_not_configured' });

  try {
    const safeName = sanitizeFileName(String(fileName));
    const key = `products/${Date.now()}-${uuidv4()}-${safeName}`;

    const putParams = {
      Bucket: BUCKET,
      Key: key,
      ContentType: fileType,
      ACL: 'public-read'
    };

    const command = new PutObjectCommand(putParams);
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });

    const publicBase = process.env.S3_PUBLIC_URL || (() => {
      if (REGION === 'us-east-1') return `https://${BUCKET}.s3.amazonaws.com`;
      return `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
    })();

    const publicUrl = `${publicBase.replace(/\/$/, '')}/${encodeURIComponent(key)}`;

    return res.json({ ok: true, uploadUrl, publicUrl, key });
  } catch (err) {
    console.error('[uploads.presign] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server_error', detail: (err && err.message) || String(err) });
  }
});

/* ================================================================
   IMAGE PROXY (Fix Wix 403 for blog images)
   GET /api/uploads/proxy?src=<encoded URL>
   Allowed hosts are intentionally restrictive.
   ================================================================ */

const ALLOWED_HOSTNAMES = [
  "static.wixstatic.com",
  "images.wixstatic.com",
  "media.wix.com",
  "i.imgur.com",
  "res.cloudinary.com"
];

function hostnameAllowed(src) {
  try {
    const u = new URL(src);
    return ALLOWED_HOSTNAMES.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

router.get('/proxy', async (req, res) => {
  const src = String(req.query.src || '').trim();
  if (!src) return res.status(400).json({ ok: false, error: 'src query param required' });

  if (!/^https?:\/\//i.test(src)) return res.status(400).json({ ok: false, error: 'invalid_url' });

  if (!hostnameAllowed(src)) return res.status(403).json({ ok: false, error: 'host_not_allowed' });

  try {
    // Use node-fetch-like global fetch if available (node 18+) else fallback to http/https
    if (typeof fetch === 'function') {
      const upstream = await fetch(src, { headers: { 'User-Agent': 'Sprada-ImageProxy/1.0' }, redirect: 'follow' });
      if (!upstream.ok) {
        console.warn('[uploads.proxy] upstream error', upstream.status, src);
        return res.status(502).json({ ok: false, error: 'upstream_error', status: upstream.status });
      }

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=3600';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      const readable = upstream.body;
      if (!readable) {
        const buf = await upstream.arrayBuffer();
        return res.send(Buffer.from(buf));
      }
      const pass = new stream.PassThrough();
      // readable is a WHATWG ReadableStream; pipe via stream conversion
      readable.pipeTo(pass).catch(() => res.end());
      pass.pipe(res);
      return;
    }

    // Fallback: raw http/https client
    let parsed;
    try { parsed = new URL(src); } catch (e) { return res.status(400).json({ ok: false, error: 'invalid_url' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ ok: false, error: 'unsupported_protocol' });

    const client = parsed.protocol === 'https:' ? https : http;
    const opts = { method: 'GET', headers: { Accept: 'image/*,*/*;q=0.8', 'User-Agent': req.get('User-Agent') || 'SpradaProxy/1.0' } };

    const proxyReq = client.request(parsed, opts, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        // follow one redirect
        try {
          const redirectUrl = new URL(proxyRes.headers.location, parsed).toString();
          const nextClient = redirectUrl.startsWith('https:') ? https : http;
          return nextClient.get(redirectUrl, (r2) => {
            res.setHeader('Content-Type', r2.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');
            r2.pipe(res);
          }).on('error', (err) => {
            console.warn('[uploads.proxy] redirect fetch error', err && err.message);
            res.status(502).json({ ok: false, error: 'upstream_error' });
          });
        } catch (e) {
          return res.status(502).json({ ok: false, error: 'bad_redirect' });
        }
      }

      if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');

      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[uploads.proxy] request error', err && err.message ? err.message : err);
      return res.status(502).json({ ok: false, error: 'upstream_error' });
    });

    proxyReq.end();
  } catch (err) {
    console.error('[uploads.proxy] unexpected', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
