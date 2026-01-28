/* ===================== src/routes/notifications.js ===================== */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');


// POST /api/notifications/schedule { title, body, data, target_query, scheduled_at }
router.post('/schedule', async (req, res) => {
const { title, body, data = {}, target_query = {}, scheduled_at = null } = req.body;
if (!title) return res.status(400).json({ error: 'title required' });
try {
const { rows } = await pool.query('INSERT INTO notifications (title, body, data, target_query, scheduled_at) VALUES ($1,$2,$3,$4,$5) RETURNING *', [title, body, data, target_query, scheduled_at]);
res.status(201).json(rows[0]);
} catch (err) {
console.error(err);
res.status(500).json({ error: 'server_error' });
}
});


module.exports = router;