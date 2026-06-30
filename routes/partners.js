const express = require('express');
const db = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const partners = await db.prepare('SELECT * FROM partners ORDER BY name').all();
    res.json(partners);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const partner = await db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
    if (!partner) return res.status(404).json({ error: 'Partner nem található' });
    res.json(partner);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, address, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'A név kötelező' });

    const result = await db.prepare(`
      INSERT INTO partners (name, address, phone, email, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, address || null, phone || null, email || null, notes || null);

    const partner = await db.prepare('SELECT * FROM partners WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(partner);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, address, phone, email, notes } = req.body;
    await db.prepare(`
      UPDATE partners
      SET name = ?, address = ?, phone = ?, email = ?, notes = ?
      WHERE id = ?
    `).run(name, address || null, phone || null, email || null, notes || null, req.params.id);

    const partner = await db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
    res.json(partner);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const row = await db.prepare('SELECT COUNT(*) as c FROM jobs WHERE partner_id = ?').get(req.params.id);
    if (row.c > 0) {
      return res.status(400).json({ error: 'A partnerhez vannak munkák, először azokat kell törölni' });
    }
    await db.prepare('DELETE FROM partners WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
