// src/routes/cookieConsents.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

/* POST /api/cookie-consent
   Body: { visitor_id: string, consent: { analytics: true, marketing: false, personalization: true } }
*/
router.post('/', async (req, res) => {
  const db = req.db || req.app?.locals?.db || null;
  const { visitor_id, consent } = req.body;

  if (!db || typeof db.query !== 'function') return res.status(500).json({ error: 'db_missing' });
  if (!visitor_id || typeof consent !== 'object') return res.status(400).json({ error: 'visitor_id_and_consent_required' });

  try {
    const id = uuidv4();
    await db.query(
      'INSERT INTO cookie_consents (id, visitor_id, consent) VALUES ($1,$2,$3)',
      [id, visitor_id, consent]
    );
    // optional: update visitors.metadata with consent
    try {
      await db.query('UPDATE visitors SET metadata = COALESCE(metadata, \'{}\'::jsonb) || $2 WHERE id = $1', [visitor_id, JSON.stringify({ cookie_consent: consent })]);
    } catch (e) { /* ignore optional */ }

    return res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('[cookie-consent.POST] error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
