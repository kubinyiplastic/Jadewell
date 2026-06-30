const express = require('express');
const db = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

const VALID_STATUSES = ['new', 'survey_scheduled', 'quoted', 'won', 'lost', 'on_hold'];

router.get('/', async (req, res) => {
  try {
    const { status, due, search } = req.query;
    let sql = `
      SELECT l.*, p.name as converted_partner_name, u.name as creator_name
      FROM leads l
      LEFT JOIN partners p ON p.id = l.converted_partner_id
      LEFT JOIN users u ON u.id = l.created_by
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (status) {
      if (status === 'active') {
        sql += ` AND l.status NOT IN ('won', 'lost')`;
      } else {
        sql += ` AND l.status = $${idx++}`; params.push(status);
      }
    }

    if (due === 'today') {
      sql += ` AND (l.survey_date = CURRENT_DATE::text OR l.follow_up_date = CURRENT_DATE::text)`;
    } else if (due === 'overdue') {
      sql += ` AND ((l.survey_date < CURRENT_DATE::text AND l.survey_date IS NOT NULL) OR (l.follow_up_date < CURRENT_DATE::text AND l.follow_up_date IS NOT NULL))`;
      sql += ` AND l.status NOT IN ('won', 'lost')`;
    } else if (due === 'week') {
      sql += ` AND ((l.survey_date BETWEEN CURRENT_DATE::text AND (CURRENT_DATE + INTERVAL '7 days')::text) OR (l.follow_up_date BETWEEN CURRENT_DATE::text AND (CURRENT_DATE + INTERVAL '7 days')::text))`;
      sql += ` AND l.status NOT IN ('won', 'lost')`;
    }

    if (search) {
      sql += ` AND (l.name ILIKE $${idx} OR l.phone ILIKE $${idx} OR l.address ILIKE $${idx})`;
      params.push(`%${search}%`); idx++;
    }

    sql += ` ORDER BY CASE l.status WHEN 'new' THEN 1 WHEN 'survey_scheduled' THEN 2 WHEN 'quoted' THEN 3 WHEN 'on_hold' THEN 4 WHEN 'won' THEN 5 WHEN 'lost' THEN 6 END, l.created_at DESC`;

    const { pool } = db;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats/summary', async (req, res) => {
  try {
    const { pool } = db;
    const [total, newCount, overdue, thisWeek, totalValue] = await Promise.all([
      pool.query(`SELECT COUNT(*) as c FROM leads WHERE status NOT IN ('won', 'lost')`),
      pool.query(`SELECT COUNT(*) as c FROM leads WHERE status = 'new'`),
      pool.query(`SELECT COUNT(*) as c FROM leads WHERE status NOT IN ('won', 'lost') AND ((survey_date < CURRENT_DATE::text AND survey_date IS NOT NULL) OR (follow_up_date < CURRENT_DATE::text AND follow_up_date IS NOT NULL))`),
      pool.query(`SELECT COUNT(*) as c FROM leads WHERE status NOT IN ('won', 'lost') AND ((survey_date BETWEEN CURRENT_DATE::text AND (CURRENT_DATE + INTERVAL '7 days')::text) OR (follow_up_date BETWEEN CURRENT_DATE::text AND (CURRENT_DATE + INTERVAL '7 days')::text))`),
      pool.query(`SELECT COALESCE(SUM(estimated_value), 0) as v FROM leads WHERE status NOT IN ('won', 'lost') AND estimated_value IS NOT NULL`)
    ]);

    res.json({
      active: parseInt(total.rows[0].c),
      new: parseInt(newCount.rows[0].c),
      overdue: parseInt(overdue.rows[0].c),
      this_week: parseInt(thisWeek.rows[0].c),
      pipeline_value: parseFloat(totalValue.rows[0].v)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const lead = await db.prepare(`
      SELECT l.*, p.name as converted_partner_name, u.name as creator_name
      FROM leads l
      LEFT JOIN partners p ON p.id = l.converted_partner_id
      LEFT JOIN users u ON u.id = l.created_by
      WHERE l.id = ?
    `).get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Érdeklődés nem található' });
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const {
      name, phone, email, address,
      project_type, description, estimated_value,
      status, survey_date, follow_up_date, notes
    } = req.body;

    if (!name) return res.status(400).json({ error: 'A név kötelező' });
    const finalStatus = VALID_STATUSES.includes(status) ? status : 'new';

    const result = await db.prepare(`
      INSERT INTO leads (name, phone, email, address, project_type, description,
                         estimated_value, status, survey_date, follow_up_date, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, phone || null, email || null, address || null,
      project_type || null, description || null,
      estimated_value ? Number(estimated_value) : null,
      finalStatus, survey_date || null, follow_up_date || null,
      notes || null, req.user.id
    );

    const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Érdeklődés nem található' });

    const {
      name, phone, email, address,
      project_type, description, estimated_value,
      status, survey_date, follow_up_date, notes
    } = req.body;

    const finalStatus = status && VALID_STATUSES.includes(status) ? status : lead.status;

    await db.prepare(`
      UPDATE leads
      SET name = ?, phone = ?, email = ?, address = ?,
          project_type = ?, description = ?, estimated_value = ?,
          status = ?, survey_date = ?, follow_up_date = ?, notes = ?,
          updated_at = NOW()
      WHERE id = ?
    `).run(
      name ?? lead.name,
      phone ?? lead.phone,
      email ?? lead.email,
      address ?? lead.address,
      project_type ?? lead.project_type,
      description ?? lead.description,
      estimated_value !== undefined ? (estimated_value ? Number(estimated_value) : null) : lead.estimated_value,
      finalStatus,
      survey_date !== undefined ? (survey_date || null) : lead.survey_date,
      follow_up_date !== undefined ? (follow_up_date || null) : lead.follow_up_date,
      notes ?? lead.notes,
      req.params.id
    );

    const updated = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/convert', async (req, res) => {
  try {
    const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Érdeklődés nem található' });
    if (lead.converted_partner_id) {
      return res.status(400).json({ error: 'Már konvertálva van: partner ID ' + lead.converted_partner_id });
    }

    const partnerNotes = [
      lead.notes ? `Megjegyzés: ${lead.notes}` : null,
      lead.description ? `Eredeti érdeklődés: ${lead.description}` : null,
      lead.estimated_value ? `Becsült érték: ${Number(lead.estimated_value).toLocaleString('hu-HU')} Ft` : null
    ].filter(Boolean).join('\n\n');

    const partnerResult = await db.prepare(`
      INSERT INTO partners (name, address, phone, email, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      lead.name, lead.address || null, lead.phone || null,
      lead.email || null, partnerNotes || null
    );

    await db.prepare(`
      UPDATE leads SET status = 'won', converted_partner_id = ?, updated_at = NOW()
      WHERE id = ?
    `).run(partnerResult.lastInsertRowid, req.params.id);

    res.json({
      ok: true,
      partner_id: partnerResult.lastInsertRowid,
      message: 'Sikeres konvertálás partnerré!'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
