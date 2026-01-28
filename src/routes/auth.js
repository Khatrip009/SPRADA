/* ===================== src/routes/auth.js ===================== */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES || '30d';

// Simple login - expects email + password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });

  try {
    const { rows } = await pool.query('SELECT id, password_hash, role_id, full_name FROM users WHERE email = $1', [email]);
    if (!rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = jwt.sign({ sub: user.id, role: user.role_id }, JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
    const refreshToken = jwt.sign({ sub: user.id, role: user.role_id }, JWT_SECRET, { expiresIn: REFRESH_EXPIRES });

    res.json({ accessToken, refreshToken, user: { id: user.id, full_name: user.full_name, role: user.role_id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/auth/refresh
 * body: { refreshToken }
 * Verifies refresh token, rotates it and issues a fresh access token.
 * Returns { accessToken, refreshToken, user } on success.
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

    let payload;
    try {
      payload = jwt.verify(refreshToken, JWT_SECRET);
    } catch (err) {
      // invalid or expired
      return res.status(401).json({ error: 'invalid_refresh' });
    }

    const userId = payload.sub;
    // Fetch user details from DB to return consistent user shape
    const { rows } = await pool.query('SELECT id, full_name, role_id FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return res.status(401).json({ error: 'invalid_user' });
    const user = rows[0];

    // Issue new tokens (rotate refresh token)
    const newAccess = jwt.sign({ sub: user.id, role: user.role_id }, JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
    const newRefresh = jwt.sign({ sub: user.id, role: user.role_id }, JWT_SECRET, { expiresIn: REFRESH_EXPIRES });

    return res.json({
      accessToken: newAccess,
      refreshToken: newRefresh,
      user: { id: user.id, full_name: user.full_name, role: user.role_id }
    });
  } catch (err) {
    console.error('[auth.refresh] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
