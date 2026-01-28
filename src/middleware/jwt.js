// src/middleware/jwt.js
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';

/**
 * If Authorization header not present -> continue as anonymous (no req.user).
 * If Authorization present but token invalid/expired -> return 401 (clearer feedback).
 * If token ok -> attach req.user = { id, role, raw } and next().
 */
async function jwtAuthMiddleware(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
      // no token -> proceed as anonymous
      return next();
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      console.warn('[jwtAuth] token invalid or expired:', err.message);
      // token exists but invalid -> explicit 401 so client can know
      return res.status(401).json({ success: false, error: 'invalid_token' });
    }

    req.user = {
      id: payload.sub || payload.user_id || payload.id,
      role: payload.role,
      raw: payload
    };
    return next();
  } catch (err) {
    console.error('[jwtAuth] unexpected error', err);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
}

module.exports = { jwtAuthMiddleware };
