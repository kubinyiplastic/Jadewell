const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../database/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sendEmail, isConfigured, verifyConnection } = require('../lib/email');
const { registerFonts, drawHeader, drawFooter } = require('../lib/pdfHelper');

const router = express.Router();
router.use(authenticate, requireAdmin);

// Következő ajánlati szám generálása (async)
async function nextQuoteNumber() {
  const year = new Date().getFullYear();
  const last = await db.prepare(
    "SELECT quote_number FROM quotes WHERE quote_number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`AJ-${year}-%`);

  if (!last) return `AJ-${year}-001`;
  const num = parseInt(last.quote_number.split('-')[2]) + 1;
  return `AJ-${year}-${String(num).padStart(3, '0')}`;
}

// Összes ajánlat
router.get('/', async (req, res) => {
  try {
    const { lead_id, partner_id, status } = req.query;
    let sql = 'SELECT * FROM quotes WHERE 1=1';
    const params = [];
    let idx = 1;
    if (lead_id)    { sql += ` AND lead_id = $${idx++}`;    params.push(lead_id); }
    if (partner_id) { sql += ` AND partner_id = $${idx++}`; params.push(partner_id); }
    if (status)     { sql += ` AND status = $${idx++}`;     params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const { pool } = db;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Egy ajánlat részletei + tételek
router.get('/:id', async (req, res) => {
  try {
    const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Ajánlat nem található' });
    quote.items = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id').all(quote.id);
    res.json(quote);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Új ajánlat
router.post('/', async (req, res) => {
  try {
    const {
      lead_id, partner_id,
      customer_name, customer_address, customer_email, customer_phone, customer_tax_number,
      issue_date, valid_until, intro_text, notes, payment_terms, warranty, vat_rate,
      items
    } = req.body;

    if (!customer_name) return res.status(400).json({ error: 'Ügyfél név kötelező' });

    const quoteNumber = await nextQuoteNumber();
    const today = new Date().toISOString().split('T')[0];
    const validDate = valid_until || (() => {
      const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0];
    })();
    const vatRate = vat_rate !== undefined ? Number(vat_rate) : 27;

    const result = await db.prepare(`
      INSERT INTO quotes (quote_number, lead_id, partner_id,
        customer_name, customer_address, customer_email, customer_phone, customer_tax_number,
        issue_date, valid_until, intro_text, notes, payment_terms, warranty, vat_rate,
        status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      quoteNumber, lead_id || null, partner_id || null,
      customer_name, customer_address || null, customer_email || null,
      customer_phone || null, customer_tax_number || null,
      issue_date || today, validDate,
      intro_text || null, notes || null,
      payment_terms || 'Átutalás, 8 napon belül',
      warranty || null, vatRate,
      req.user.id
    );

    const quoteId = result.lastInsertRowid;

    if (items && Array.isArray(items)) {
      await saveItems(quoteId, items);
    }
    await recalcTotals(quoteId);

    const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    quote.items = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id').all(quoteId);

    if (lead_id) {
      const lead = await db.prepare('SELECT status FROM leads WHERE id = ?').get(lead_id);
      if (lead && lead.status !== 'won' && lead.status !== 'lost') {
        await db.prepare("UPDATE leads SET status = 'quoted', updated_at = NOW() WHERE id = ?").run(lead_id);
      }
    }

    res.status(201).json(quote);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ajánlat módosítása
router.put('/:id', async (req, res) => {
  try {
    const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Ajánlat nem található' });

    const {
      customer_name, customer_address, customer_email, customer_phone, customer_tax_number,
      issue_date, valid_until, intro_text, notes, payment_terms, warranty, vat_rate,
      status, items
    } = req.body;

    const validStatuses = ['draft', 'sent', 'accepted', 'rejected'];

    await db.prepare(`
      UPDATE quotes SET
        customer_name = ?, customer_address = ?, customer_email = ?,
        customer_phone = ?, customer_tax_number = ?,
        issue_date = ?, valid_until = ?, intro_text = ?, notes = ?,
        payment_terms = ?, warranty = ?, vat_rate = ?,
        status = ?, updated_at = NOW()
      WHERE id = ?
    `).run(
      customer_name ?? quote.customer_name,
      customer_address ?? quote.customer_address,
      customer_email ?? quote.customer_email,
      customer_phone ?? quote.customer_phone,
      customer_tax_number ?? quote.customer_tax_number,
      issue_date ?? quote.issue_date,
      valid_until ?? quote.valid_until,
      intro_text ?? quote.intro_text,
      notes ?? quote.notes,
      payment_terms ?? quote.payment_terms,
      warranty ?? quote.warranty,
      vat_rate !== undefined ? Number(vat_rate) : quote.vat_rate,
      (status && validStatuses.includes(status)) ? status : quote.status,
      req.params.id
    );

    if (status === 'sent' && !quote.sent_at) {
      await db.prepare("UPDATE quotes SET sent_at = NOW() WHERE id = ?").run(req.params.id);
    }
    if (status === 'accepted' && !quote.accepted_at) {
      await db.prepare("UPDATE quotes SET accepted_at = NOW() WHERE id = ?").run(req.params.id);
    }
    if (status === 'rejected' && !quote.rejected_at) {
      await db.prepare("UPDATE quotes SET rejected_at = NOW() WHERE id = ?").run(req.params.id);
    }

    if (items && Array.isArray(items)) {
      await db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(req.params.id);
      await saveItems(req.params.id, items);
    }

    await recalcTotals(req.params.id);

    const updated = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    updated.items = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id').all(req.params.id);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ajánlat törlése
router.delete('/:id', async (req, res) => {
  try {
    await db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF generálás
function generateQuotePdfBuffer(quote, items) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    registerFonts(doc);
    let y = drawHeader(doc, { rightTitle: 'Árajánlat', rightSubtitle: quote.quote_number });

    doc.font('SansBold').fontSize(11).fillColor('#1a4d4a').text('Megrendelő:', 50, y);
    y += 18;
    doc.font('SansBold').fontSize(11).fillColor('#000').text(quote.customer_name, 50, y);
    y += 16;
    doc.font('Sans').fontSize(9).fillColor('#444');
    if (quote.customer_address) { doc.text(quote.customer_address, 50, y); y += 13; }
    if (quote.customer_phone)   { doc.text(`Tel: ${quote.customer_phone}`, 50, y); y += 13; }
    if (quote.customer_email)   { doc.text(`Email: ${quote.customer_email}`, 50, y); y += 13; }
    if (quote.customer_tax_number) { doc.text(`Adószám: ${quote.customer_tax_number}`, 50, y); y += 13; }

    doc.font('Sans').fontSize(9).fillColor('#666')
      .text(`Kiállítás: ${formatDateHu(quote.issue_date)}`, 350, 158, { width: 195, align: 'right' })
      .text(`Érvényes: ${formatDateHu(quote.valid_until)}`, 350, 173, { width: 195, align: 'right' });

    y = Math.max(y, 218) + 10;
    if (quote.intro_text) {
      doc.font('Sans').fontSize(10).fillColor('#333').text(quote.intro_text, 50, y, { width: 495 });
      y = doc.y + 16;
    }

    const colX = { num: 50, name: 70, qty: 310, unit: 345, price: 385, total: 465 };
    const colW = { name: 235, qty: 35, unit: 38, price: 78, total: 78 };
    doc.rect(50, y, 495, 22).fillColor('#1a4d4a').fill();
    doc.font('SansBold').fontSize(9).fillColor('#fff')
      .text('#', colX.num + 4, y + 7)
      .text('Megnevezés', colX.name + 4, y + 7)
      .text('Menny.', colX.qty, y + 7, { width: colW.qty, align: 'right' })
      .text('Egys.', colX.unit, y + 7, { width: colW.unit, align: 'center' })
      .text('Egységár', colX.price, y + 7, { width: colW.price, align: 'right' })
      .text('Összeg', colX.total, y + 7, { width: colW.total, align: 'right' });
    y += 22;

    items.forEach((item, idx) => {
      if (y > 700) { doc.addPage(); y = 50; }
      const rowH = item.description ? 32 : 22;
      const bgColor = idx % 2 === 0 ? '#f9f9f8' : '#ffffff';
      doc.rect(50, y, 495, rowH).fillColor(bgColor).fill();
      doc.font('Sans').fontSize(9).fillColor('#333')
        .text(String(idx + 1), colX.num + 4, y + 6)
        .text(item.name, colX.name + 4, y + 6, { width: colW.name });
      if (item.description) {
        doc.font('Sans').fontSize(8).fillColor('#888')
          .text(item.description, colX.name + 4, y + 19, { width: colW.name });
      }
      doc.font('Sans').fontSize(9).fillColor('#333')
        .text(formatNum(item.quantity), colX.qty, y + 6, { width: colW.qty, align: 'right' })
        .text(item.unit || 'db', colX.unit, y + 6, { width: colW.unit, align: 'center' })
        .text(formatMoney(item.unit_price), colX.price, y + 6, { width: colW.price, align: 'right' })
        .text(formatMoney(item.total), colX.total, y + 6, { width: colW.total, align: 'right' });
      y += rowH;
    });

    doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').lineWidth(0.5).stroke();
    y += 10;
    if (y > 680) { doc.addPage(); y = 50; }

    const labelX = 320, labelW = 115, valueX = 435, valueW = 110;
    doc.font('Sans').fontSize(10).fillColor('#555')
      .text('Nettó összesen:', labelX, y, { width: labelW, align: 'right' })
      .text(formatMoney(quote.subtotal) + ' Ft', valueX, y, { width: valueW, align: 'right' });
    y += 18;
    doc.text(`ÁFA (${quote.vat_rate}%):`, labelX, y, { width: labelW, align: 'right' })
      .text(formatMoney(quote.vat_amount) + ' Ft', valueX, y, { width: valueW, align: 'right' });
    y += 4;
    doc.moveTo(labelX, y + 10).lineTo(545, y + 10).strokeColor('#1a4d4a').lineWidth(1.5).stroke();
    y += 16;
    doc.font('SansBold').fontSize(14).fillColor('#1a4d4a')
      .text('Összesen:', labelX, y, { width: labelW, align: 'right' })
      .text(formatMoney(quote.total) + ' Ft', valueX, y, { width: valueW, align: 'right' });
    y += 32;

    if (y > 700) { doc.addPage(); y = 50; }
    if (quote.payment_terms) {
      doc.font('SansBold').fontSize(10).fillColor('#1a4d4a').text('Fizetési feltételek:', 50, y); y += 15;
      doc.font('Sans').fontSize(9).fillColor('#444').text(quote.payment_terms, 50, y, { width: 495 });
      y = doc.y + 12;
    }
    if (quote.warranty) {
      doc.font('SansBold').fontSize(10).fillColor('#1a4d4a').text('Garancia:', 50, y); y += 15;
      doc.font('Sans').fontSize(9).fillColor('#444').text(quote.warranty, 50, y, { width: 495 });
      y = doc.y + 12;
    }
    if (quote.notes) {
      doc.font('SansBold').fontSize(10).fillColor('#1a4d4a').text('Megjegyzés:', 50, y); y += 15;
      doc.font('Sans').fontSize(9).fillColor('#444').text(quote.notes, 50, y, { width: 495 });
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (i > range.start) drawFooter(doc);
    }
    drawFooter(doc);
    doc.end();
  });
}

router.get('/:id/pdf', async (req, res) => {
  try {
    const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Ajánlat nem található' });
    const items = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id').all(quote.id);
    const buffer = await generateQuotePdfBuffer(quote, items);
    const filename = `JadeWell_ajanlat_${quote.quote_number.replace(/\//g, '-')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: 'PDF generálás sikertelen: ' + e.message }); }
});

router.get('/email/check', async (req, res) => {
  const result = await verifyConnection();
  res.json(result);
});

router.get('/:id/email-template', async (req, res) => {
  try {
    const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Ajánlat nem található' });
    const subject = `Árajánlat ${quote.quote_number} - JadeWell`;
    const validUntil = formatDateHu(quote.valid_until);
    const total = formatMoney(quote.total);
    const body = `Tisztelt ${quote.customer_name}!\n\nKöszönjük érdeklődését! Mellékelten küldjük árajánlatunkat (${quote.quote_number}), melyet a megbeszélésünk alapján állítottunk össze.\n\nAz ajánlat teljes összege: ${total} Ft (bruttó)\nAz ajánlat érvényes: ${validUntil}-ig\n\nAz ajánlat részletei a csatolt PDF dokumentumban találhatóak. Ha bármilyen kérdése merül fel, kérjük keressen telefonon a +36 20 240 6463 számon vagy válaszoljon erre az emailre.\n\nVárjuk visszajelzését!\n\nÜdvözlettel,\nJadeWell csapata\n+36 20 240 6463\ninfo@jadewell.hu\njadewell.hu`;
    res.json({ to: quote.customer_email || '', subject, body });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/send-email', async (req, res) => {
  try {
    const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Ajánlat nem található' });

    if (!isConfigured()) {
      return res.status(400).json({ error: 'Email küldés nincs beállítva.' });
    }

    const { to, cc, bcc, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Címzett, tárgy és üzenet kötelező' });
    }

    const items = await db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id').all(quote.id);
    const pdfBuffer = await generateQuotePdfBuffer(quote, items);
    const filename = `JadeWell_ajanlat_${quote.quote_number.replace(/\//g, '-')}.pdf`;

    await sendEmail({
      to, cc: cc || undefined, bcc: bcc || undefined,
      subject, text: body,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }]
    });

    await db.prepare(`
      UPDATE quotes
      SET sent_at = NOW(), sent_to_email = ?,
          sent_count = sent_count + 1,
          status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
          updated_at = NOW()
      WHERE id = ?
    `).run(to, req.params.id);

    res.json({ ok: true, message: 'Email sikeresen elküldve!' });
  } catch (e) {
    console.error('Email küldési hiba:', e);
    res.status(500).json({ error: 'Email küldés sikertelen: ' + e.message });
  }
});

// === HELPER FUNCTIONS ===
async function saveItems(quoteId, items) {
  for (const [idx, item] of items.entries()) {
    const qty = Number(item.quantity) || 1;
    const price = Number(item.unit_price) || 0;
    await db.prepare(`
      INSERT INTO quote_items (quote_id, sort_order, name, description, quantity, unit, unit_price, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(quoteId, item.sort_order ?? idx, item.name, item.description || null,
           qty, item.unit || 'db', price, qty * price);
  }
}

async function recalcTotals(quoteId) {
  const quote = await db.prepare('SELECT vat_rate FROM quotes WHERE id = ?').get(quoteId);
  const items = await db.prepare('SELECT total FROM quote_items WHERE quote_id = ?').all(quoteId);
  const subtotal = items.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
  const vatRate = quote ? (quote.vat_rate || 27) : 27;
  const vatAmount = Math.round(subtotal * vatRate / 100);
  const total = subtotal + vatAmount;
  await db.prepare('UPDATE quotes SET subtotal = ?, vat_amount = ?, total = ? WHERE id = ?')
    .run(subtotal, vatAmount, total, quoteId);
}

function formatDateHu(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}.`;
}
function formatMoney(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('hu-HU');
}
function formatNum(n) {
  if (n == null) return '1';
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

module.exports = router;
