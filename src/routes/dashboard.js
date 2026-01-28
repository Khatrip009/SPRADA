// src/routes/dashboard.js
const express = require("express");
const router = express.Router();
const { createClient, removeClient, broadcast, clientCount } = require("../lib/sse-bus");

// In-memory stores (replace with DB)
const visitors = []; // each: { id, ip, ua, path, startedAt, lastSeen, userId? }
const reviewsStats = { positive: 42, neutral: 8, negative: 5 }; // demo
const pushSubscriptions = []; // array of subscription objects
const products = [
  { id: 1, name: "BioGas 55TPD", sales: 14 },
  { id: 2, name: "Dewatering Screw Press", sales: 7 },
  { id: 3, name: "Balloon Storage kit", sales: 19 },
];

// Utility: fill visitors with demo data if empty
function seedVisitors() {
  if (visitors.length) return;
  const now = Date.now();
  for (let i = 6; i >= 0; i--) {
    // simulate a day of visitors
    const count = Math.floor(Math.random()*50) + 10;
    visitors.push({
      id: `demo-${i}`,
      ip: `192.168.0.${i+10}`,
      ua: "Mozilla/5.0 (demo)",
      path: "/",
      startedAt: new Date(now - i * 24*3600*1000).toISOString(),
      lastSeen: new Date(now - i * 24*3600*1000 + 3600000).toISOString(),
      dayOffset: i,
      sessionsThatDay: Math.floor(Math.random()*120)+20
    });
  }
}
seedVisitors();

/**
 * GET /api/visitors/list
 * returns array of sessions (replace with DB)
 */
router.get("/visitors/list", (req, res) => {
  // If you have pagination, support query params here
  res.json(visitors);
});

/**
 * GET /api/metrics/visitors/summary
 */
router.get("/metrics/visitors/summary", (req, res) => {
  const total = visitors.reduce((s, v) => s + (v.sessionsThatDay || 1), 0);
  res.json({ totalVisitors: total, activeSSEClients: clientCount() });
});

/**
 * GET /api/metrics/visitors/trend?days=7
 * returns { labels: [], data: [] } for charts
 */
router.get("/metrics/visitors/trend", (req, res) => {
  const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 7));
  // generate demo trend (replace with DB aggregation)
  const now = new Date();
  const labels = [];
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    labels.push(d.toISOString().slice(0,10));
    data.push(Math.floor(Math.random() * 150) + 10);
  }
  res.json(labels.map((label, idx) => ({ label, value: data[idx] })));
});

/**
 * GET /api/reviews/stats
 */
router.get("/reviews/stats", (req, res) => {
  res.json(reviewsStats);
});

/**
 * GET /api/products?limit=20
 */
router.get("/products", (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
  res.json(products.slice(0, limit));
});

/**
 * GET /api/push/list and /api/push/subscriptions
 */
router.get("/push/list", (req, res) => {
  res.json(pushSubscriptions);
});
router.get("/push/subscriptions", (req, res) => {
  res.json(pushSubscriptions);
});

/**
 * SSE endpoint: GET /api/events/sse
 * Keeps connection alive and pushes simple heartbeat + demo events.
 */
router.get("/events/sse", (req, res) => {
  // required headers for SSE + CORS preflight is handled globally
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  const client = createClient(res);

  // Send a welcome event with current stats
  res.write(`event: welcome\n`);
  res.write(`data: ${JSON.stringify({ message: "connected", clients: clientCount() })}\n\n`);

  // Send an initial snapshot event
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify({ visitors: visitors.slice(0,10), reviewsStats })}\n\n`);

  // keep socket alive with periodic pings if necessary
  const ping = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${JSON.stringify({ ts: Date.now(), clients: clientCount() })}\n\n`);
  }, 25000); // 25s

  // Clean up when the connection closes
  req.on("close", () => {
    clearInterval(ping);
    removeClient(client);
  });
});

/**
 * POST /api/push/register  (optional helper)
 * store push subscription object in memory
 */
router.post("/push/register", express.json(), (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid subscription" });
  // avoid duplicates by endpoint
  const exists = pushSubscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) pushSubscriptions.push({ ...sub, createdAt: new Date().toISOString() });
  return res.json({ ok: true, count: pushSubscriptions.length });
});

/**
 * POST /api/events/emit (dev-only)
 * Accepts { event, data } to broadcast to SSE clients (for testing)
 */
router.post("/events/emit", express.json(), (req, res) => {
  const { event = "message", data = {} } = req.body || {};
  broadcast(event, data);
  res.json({ ok: true });
});

module.exports = router;
