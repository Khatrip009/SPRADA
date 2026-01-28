// src/lib/sse-bus.js
const clients = new Set();

function createClient(res) {
  const client = { id: Date.now() + Math.random(), res };
  clients.add(client);
  return client;
}

function removeClient(client) {
  clients.delete(client);
}

function sendEvent(client, event, data) {
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${payload}\n\n`);
  } catch (err) {
    console.error("[SSE] sendEvent error:", err);
  }
}

function broadcast(event, data) {
  for (const c of clients) {
    sendEvent(c, event, data);
  }
}

function clientCount() { return clients.size; }

module.exports = { createClient, removeClient, sendEvent, broadcast, clientCount };
