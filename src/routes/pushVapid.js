// src/routes/pushVapid.js
const express = require('express');
const router = express.Router();

/**
 * GET /api/push/vapid
 * Returns the VAPID public key for the client to call pushManager.subscribe().
 * Safer than baking into frontend build. Requires VAPID_PUBLIC env var (base64 url-safe).
 */
router.get('/vapid', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC || '';
  if (!publicKey) {
    return res.status(503).json({ ok: false, error: 'vapid_not_configured' });
  }
  res.json({ ok: true, publicKey });
});

module.exports = router;
