// src/routes/events.js
// Simple server-side SSE broadcaster with a /publish test endpoint.
// Mount this at /api/events

const express = require('express');
const router = express.Router();

// In-memory client list (small-scale). For multi-process, use redis/pubsub.
const clients = new Map(); // id -> { res, lastSeen }

function setSseHeaders(res, origin) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform'); // allowed by preflight after you add Cache-Control
  res.setHeader('Connection', 'keep-alive');
  // allow credentials if your frontend uses them
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  // Expose any headers your frontend requires
  res.setHeader('Access-Control-Expose-Headers', 'Cache-Control');
}

function sendEvent(res, eventName, data, id = null) {
  // SSE format:
  // id: <id>\nevent: <eventName>\ndata: <json>\n\n
  try {
    if (id !== null) res.write(`id: ${id}\n`);
    if (eventName) res.write(`event: ${eventName}\n`);
    const payload = (typeof data === 'string') ? data : JSON.stringify(data || {});
    // split long payload lines per SSE spec
    payload.split(/\n/).forEach(line => res.write(`data: ${line}\n`));
    res.write('\n');
  } catch (e) {
    // writing to a closed socket throws — caller will remove client on error/close
  }
}

function broadcast(eventName, data) {
  const id = Date.now();
  for (const [key, client] of clients.entries()) {
    try {
      sendEvent(client.res, eventName, data, id);
      client.lastSeen = Date.now();
    } catch (e) {
      // ignore, close will be handled by 'close' handler
    }
  }
}

// OPTIONS preflight for /sse (some browsers do preflight for EventSource)
router.options('/sse', (req, res) => {
  // echo origin if present so EventSource can connect
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // allow the Cache-Control header (some clients include this)
  res.setHeader('Access-Control-Allow-Headers',
    (req.headers['access-control-request-headers'] || 'Content-Type, Authorization, Cache-Control, X-Requested-With, Accept, Origin'));
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return res.sendStatus(204);
});

/**
 * GET /api/events/sse
 * Keeps an SSE connection open. Add ?topic=foo to filter in future (here we broadcast to all).
 */
router.get('/sse', (req, res) => {
  const origin = req.headers.origin || req.get('origin') || '*';

  // enable CORS for this route specifically (safe because we control allowed origins globally)
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // SSE headers
  setSseHeaders(res, origin);

  // prevent nginx / proxies from buffering small chunks:
  // (Depends on proxy setup; recommended but may not be necessary)
  res.flushHeaders && res.flushHeaders();

  // create a client id
  const clientId = `sse-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  // initial comment to force some browsers to start streaming
  res.write(':ok\n\n');

  // send a welcome event
  sendEvent(res, 'connected', { clientId, ts: new Date().toISOString() }, clientId);

  clients.set(clientId, { res, lastSeen: Date.now() });

  // keepalive ping every 20s (prevents proxies/idle timeouts)
  const pingInterval = setInterval(() => {
    try {
      sendEvent(res, 'ping', { ts: new Date().toISOString() }, null);
    } catch (e) { /* ignore */ }
  }, 20 * 1000);

  // When client disconnects
  const cleanup = () => {
    clearInterval(pingInterval);
    clients.delete(clientId);
    try { res.end(); } catch (e) { /* ignore */ }
  };

  // handle close
  req.on('close', () => {
    cleanup();
  });

  // catch errors
  req.on('error', () => {
    cleanup();
  });
});

/**
 * POST /api/events/publish
 * body: { event: string, data: object }
 * This endpoint allows other backend modules or an admin UI to publish events.
 */
router.post('/publish', express.json(), (req, res) => {
  const { event = 'message', data = {} } = req.body || {};

  // optional: validate event and data
  try {
    broadcast(event, data);
    return res.json({ ok: true, clients: clients.size });
  } catch (err) {
    console.error('[events.publish] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'publish_failed' });
  }
});

/**
 * GET /api/events/list-clients  (debug)
 * Returns a small list of connected clients
 */
router.get('/list-clients', (req, res) => {
  const out = [];
  for (const [id, cl] of clients.entries()) {
    out.push({ id, lastSeen: cl.lastSeen });
  }
  res.json({ ok: true, clients: out });
});

module.exports = router;
