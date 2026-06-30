const express = require('express');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const db = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { registerFonts, drawHeader, drawFooter } = require('../lib/pdfHelper');

const router = express.Router();
router.use(authenticate, requireAdmin);

// Naptár események
router.get('/calendar', async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Év és hónap kötelező' });

    const yyyy = String(year);
    const mm = String(month).padStart(2, '0');
    const monthPrefix = `${yyyy}-${mm}`;
    const events = [];

    const jobs = await db.prepare(`
      SELECT j.id, j.job_date, j.arrived_at, j.left_at, j.description, j.invoiced,
             j.technicians, p.name as partner_name
      FROM jobs j JOIN partners p ON p.id = j.partner_id
      WHERE SUBSTR(j.job_date, 1, 7) = ?
      ORDER BY j.job_date, j.arrived_at
    `).all(monthPrefix);

    jobs.forEach(j => events.push({
      type: 'job', id: j.id, date: j.job_date, time: j.arrived_at,
      title: j.partner_name,
      subtitle: j.description ? j.description.substring(0, 60) : 'Szerviz',
      meta: j.technicians, invoiced: !!j.invoiced
    }));

    const surveys = await db.prepare(`
      SELECT id, name, phone, project_type, survey_date, status
      FROM leads WHERE SUBSTR(survey_date, 1, 7) = ? ORDER BY survey_date
    `).all(monthPrefix);

    surveys.forEach(l => events.push({
      type: 'survey', id: l.id, date: l.survey_date, title: l.name,
      subtitle: 'Felmérés: ' + (l.project_type || 'megtekintés'),
      meta: l.phone, status: l.status
    }));

    const followups = await db.prepare(`
      SELECT id, name, phone, project_type, follow_up_date, status
      FROM leads WHERE SUBSTR(follow_up_date, 1, 7) = ? ORDER BY follow_up_date
    `).all(monthPrefix);

    followups.forEach(l => events.push({
      type: 'followup', id: l.id, date: l.follow_up_date, title: l.name,
      subtitle: 'Visszahívás' + (l.project_type ? ' - ' + l.project_type : ''),
      meta: l.phone, status: l.status
    }));

    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Felhasználók listája
router.get('/users', async (req, res) => {
  try {
    const users = await db.prepare(`
      SELECT id, name, username, role, active, created_at
      FROM users ORDER BY name
    `).all();
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Új felhasználó
router.post('/users', async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Név, felhasználónév és jelszó kötelező' });
    }
    const exists = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(400).json({ error: 'A felhasználónév foglalt' });

    const hashed = bcrypt.hashSync(password, 10);
    const result = await db.prepare(`
      INSERT INTO users (name, username, password, role) VALUES (?, ?, ?, ?)
    `).run(name, username, hashed, role === 'admin' ? 'admin' : 'technician');

    res.status(201).json({ id: result.lastInsertRowid, name, username, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Felhasználó módosítása
router.put('/users/:id', async (req, res) => {
  try {
    const { name, password, role, active } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Felhasználó nem található' });

    const newPassword = password ? bcrypt.hashSync(password, 10) : user.password;
    await db.prepare(`
      UPDATE users SET name = ?, password = ?, role = ?, active = ? WHERE id = ?
    `).run(
      name ?? user.name, newPassword,
      role ?? user.role,
      active !== undefined ? (active ? 1 : 0) : user.active,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Felhasználó törlése
router.delete('/users/:id', async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Saját magadat nem törölheted' });
    }
    await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF munkariport egy partnerhez
router.get('/report/partner/:id/pdf', async (req, res) => {
  try {
    const { year, month, invoiced } = req.query;

    const partner = await db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
    if (!partner) return res.status(404).json({ error: 'Partner nem található' });

    let sql = `
      SELECT j.*, u.name as creator_name
      FROM jobs j
      LEFT JOIN users u ON u.id = j.created_by
      WHERE j.partner_id = ?
    `;
    const params = [req.params.id];
    let idx = 2;

    if (year)  { sql += ` AND SUBSTR(j.job_date, 1, 4) = $${idx++}`; params.push(String(year)); }
    if (month) { sql += ` AND SUBSTR(j.job_date, 6, 2) = $${idx++}`; params.push(String(month).padStart(2,'0')); }
    if (invoiced !== undefined && invoiced !== '') {
      sql += ` AND j.invoiced = $${idx++}`;
      params.push(invoiced === '1' ? 1 : 0);
    }
    sql += ' ORDER BY j.job_date ASC';

    const { pool } = db;
    // Fix: first param is already positional via prepare, use pool.query directly
    const pgSql = sql.replace('?', '$1');
    const jobsResult = await pool.query(pgSql, params);
    const jobs = jobsResult.rows;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="JadeWell_riport_${partner.name.replace(/\s+/g,'-')}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    doc.pipe(res);
    registerFonts(doc);

    let y = drawHeader(doc, {
      rightTitle: 'Munkavégzési riport',
      rightSubtitle: partner.name
    });

    doc.font('SansBold').fontSize(11).fillColor('#1a4d4a').text('Partner:', 50, y);
    doc.font('SansBold').fontSize(11).fillColor('#000').text(partner.name, 110, y);
    y += 18;
    doc.font('Sans').fontSize(9);
    if (partner.address) { doc.fillColor('#666').text('Cím:', 50, y); doc.fillColor('#000').text(partner.address, 110, y); y += 13; }
    if (partner.phone)   { doc.fillColor('#666').text('Telefon:', 50, y); doc.fillColor('#000').text(partner.phone, 110, y); y += 13; }
    if (partner.email)   { doc.fillColor('#666').text('Email:', 50, y); doc.fillColor('#000').text(partner.email, 110, y); y += 13; }

    y += 10;
    const filters = [];
    if (year) filters.push(`Év: ${year}`);
    if (month) filters.push(`Hónap: ${month}`);
    if (invoiced === '1') filters.push('Csak számlázott');
    if (invoiced === '0') filters.push('Csak nem számlázott');
    if (filters.length > 0) {
      doc.font('Sans').fontSize(9).fillColor('#888').text(`Szűrők: ${filters.join(' · ')}`, 50, y);
      y += 14;
    }
    doc.font('Sans').fontSize(9).fillColor('#888').text(`Készült: ${new Date().toLocaleString('hu-HU')}`, 50, y);
    y += 22;

    doc.font('SansBold').fontSize(14).fillColor('#1a4d4a').text(`Munkák (${jobs.length} db)`, 50, y);
    y += 25;

    if (jobs.length === 0) {
      doc.font('Sans').fontSize(11).fillColor('#888').text('Nincs munka a megadott szűrőkkel.', 50, y);
    } else {
      let totalAmount = 0, invoicedCount = 0;

      jobs.forEach((job, idx) => {
        if (y > 700) { doc.addPage(); y = 50; }
        doc.rect(50, y, 495, 4).fillColor(job.invoiced ? '#10b981' : '#f59e0b').fill();
        y += 12;
        doc.font('SansBold').fontSize(11).fillColor('#000').text(`${idx + 1}. ${job.job_date}`, 50, y);
        const statusText = job.invoiced ? 'Számlázva' : 'Nincs számlázva';
        doc.font('Sans').fontSize(9).fillColor(job.invoiced ? '#10b981' : '#f59e0b')
          .text(statusText, 450, y + 2, { width: 95, align: 'right' });
        y += 18;
        doc.font('Sans').fontSize(9).fillColor('#666');
        if (job.arrived_at || job.left_at) { doc.text(`Idő: ${job.arrived_at || '—'} – ${job.left_at || '—'}`, 60, y); y += 13; }
        if (job.technicians) { doc.text(`Szerelők: ${job.technicians}`, 60, y); y += 13; }
        if (job.description) {
          doc.font('SansBold').fontSize(10).fillColor('#000').text('Elvégzett munka:', 60, y); y += 13;
          doc.font('Sans').fontSize(9).fillColor('#333').text(job.description, 70, y, { width: 470 });
          y = doc.y + 5;
        }
        if (job.materials_installed) {
          doc.font('SansBold').fontSize(10).fillColor('#000').text('Beépített anyagok:', 60, y); y += 13;
          doc.font('Sans').fontSize(9).fillColor('#333').text(job.materials_installed, 70, y, { width: 470 });
          y = doc.y + 5;
        }
        if (job.invoice_amount) {
          doc.font('Sans').fontSize(10).fillColor('#000')
            .text(`Összeg: ${Number(job.invoice_amount).toLocaleString('hu-HU')} Ft` + (job.invoice_number ? ` (számla: ${job.invoice_number})` : ''), 60, y);
          y += 14;
          totalAmount += Number(job.invoice_amount);
          if (job.invoiced) invoicedCount++;
        }
        y += 10;
        doc.moveTo(50, y).lineTo(545, y).strokeColor('#e5e5e5').lineWidth(0.5).stroke();
        y += 10;
      });

      if (y > 680) { doc.addPage(); y = 50; }
      y += 10;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#1a4d4a').lineWidth(1.5).stroke();
      y += 10;
      doc.font('SansBold').fontSize(11).fillColor('#000').text('Összesítés', 50, y); y += 18;
      doc.font('Sans').fontSize(10).fillColor('#333').text(`Munkák száma: ${jobs.length} db`, 60, y); y += 14;
      doc.text(`Számlázott munkák: ${invoicedCount} db`, 60, y); y += 14;
      doc.text(`Nem számlázott: ${jobs.length - invoicedCount} db`, 60, y); y += 14;
      if (totalAmount > 0) {
        doc.font('SansBold').fontSize(11).fillColor('#1a4d4a')
          .text(`Összeg (rögzített): ${totalAmount.toLocaleString('hu-HU')} Ft`, 60, y);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc);
    }
    doc.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Statisztikák a dashboardhoz
router.get('/stats', async (req, res) => {
  try {
    const { pool } = db;
    const [totalJobs, totalPartners, notInvoiced, thisMonth, notInvoicedAmount, activeLeads, overdueLeads, pipelineValue] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM jobs'),
      pool.query('SELECT COUNT(*) as c FROM partners'),
      pool.query('SELECT COUNT(*) as c FROM jobs WHERE invoiced = 0'),
      pool.query("SELECT COUNT(*) as c FROM jobs WHERE SUBSTR(job_date, 1, 7) = TO_CHAR(NOW(), 'YYYY-MM')"),
      pool.query('SELECT COALESCE(SUM(invoice_amount), 0) as total FROM jobs WHERE invoiced = 0 AND invoice_amount IS NOT NULL'),
      pool.query("SELECT COUNT(*) as c FROM leads WHERE status NOT IN ('won', 'lost')"),
      pool.query("SELECT COUNT(*) as c FROM leads WHERE status NOT IN ('won', 'lost') AND ((survey_date < CURRENT_DATE::text AND survey_date IS NOT NULL) OR (follow_up_date < CURRENT_DATE::text AND follow_up_date IS NOT NULL))"),
      pool.query("SELECT COALESCE(SUM(estimated_value), 0) as v FROM leads WHERE status NOT IN ('won', 'lost') AND estimated_value IS NOT NULL")
    ]);

    res.json({
      total_jobs: parseInt(totalJobs.rows[0].c),
      total_partners: parseInt(totalPartners.rows[0].c),
      not_invoiced: parseInt(notInvoiced.rows[0].c),
      this_month: parseInt(thisMonth.rows[0].c),
      not_invoiced_amount: parseFloat(notInvoicedAmount.rows[0].total),
      active_leads: parseInt(activeLeads.rows[0].c),
      overdue_leads: parseInt(overdueLeads.rows[0].c),
      pipeline_value: parseFloat(pipelineValue.rows[0].v)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
