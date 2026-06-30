const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const db = require('../database/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Supabase Storage client (képfeltöltéshez)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const BUCKET = 'job-photos';

// Multer memóriában tartja a fájlokat (nem írja lemezre)
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Csak képfájl tölthető fel'));
  }
});

// Munkák listája
router.get('/', authenticate, async (req, res) => {
  try {
    const { partner_id, year, month, day, invoiced, technician } = req.query;
    let sql = `
      SELECT j.*, p.name as partner_name, u.name as creator_name
      FROM jobs j
      JOIN partners p ON p.id = j.partner_id
      LEFT JOIN users u ON u.id = j.created_by
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (partner_id) { sql += ` AND j.partner_id = $${idx++}`; params.push(partner_id); }
    if (year)       { sql += ` AND SUBSTR(j.job_date, 1, 4) = $${idx++}`; params.push(String(year)); }
    if (month)      { sql += ` AND SUBSTR(j.job_date, 6, 2) = $${idx++}`; params.push(String(month).padStart(2, '0')); }
    if (day)        { sql += ` AND SUBSTR(j.job_date, 9, 2) = $${idx++}`; params.push(String(day).padStart(2, '0')); }
    if (invoiced !== undefined && invoiced !== '') {
      sql += ` AND j.invoiced = $${idx++}`;
      params.push(invoiced === '1' || invoiced === 'true' ? 1 : 0);
    }
    if (technician) { sql += ` AND j.technicians LIKE $${idx++}`; params.push(`%${technician}%`); }

    sql += ' ORDER BY j.job_date DESC, j.id DESC';

    const { pool } = db;
    const result = await pool.query(sql, params);
    const jobs = result.rows;

    // Képszámok
    for (const j of jobs) {
      const r = await pool.query('SELECT COUNT(*) as c FROM job_photos WHERE job_id = $1', [j.id]);
      j.photo_count = parseInt(r.rows[0].c);
    }

    res.json(jobs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Egy munka részletei + képek
router.get('/:id', authenticate, async (req, res) => {
  try {
    const job = await db.prepare(`
      SELECT j.*, p.name as partner_name, p.address as partner_address,
             p.phone as partner_phone, u.name as creator_name
      FROM jobs j
      JOIN partners p ON p.id = j.partner_id
      LEFT JOIN users u ON u.id = j.created_by
      WHERE j.id = ?
    `).get(req.params.id);

    if (!job) return res.status(404).json({ error: 'Munka nem található' });

    job.photos = await db.prepare(
      'SELECT * FROM job_photos WHERE job_id = ? ORDER BY uploaded_at'
    ).all(req.params.id);

    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Új munka
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      partner_id, job_date, arrived_at, left_at,
      description, materials_installed, technicians
    } = req.body;

    if (!partner_id || !job_date) {
      return res.status(400).json({ error: 'Partner és dátum kötelező' });
    }

    const result = await db.prepare(`
      INSERT INTO jobs (partner_id, job_date, arrived_at, left_at,
                        description, materials_installed, technicians, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      partner_id, job_date, arrived_at || null, left_at || null,
      description || null, materials_installed || null,
      technicians || null, req.user.id
    );

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Munka módosítása
router.put('/:id', authenticate, async (req, res) => {
  try {
    const {
      partner_id, job_date, arrived_at, left_at,
      description, materials_installed, technicians,
      invoiced, invoice_number, invoice_amount
    } = req.body;

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Munka nem található' });

    const isAdmin = req.user.role === 'admin';

    await db.prepare(`
      UPDATE jobs
      SET partner_id = ?, job_date = ?, arrived_at = ?, left_at = ?,
          description = ?, materials_installed = ?, technicians = ?,
          invoiced = ?, invoice_number = ?, invoice_amount = ?,
          updated_at = NOW()
      WHERE id = ?
    `).run(
      partner_id ?? job.partner_id,
      job_date ?? job.job_date,
      arrived_at ?? job.arrived_at,
      left_at ?? job.left_at,
      description ?? job.description,
      materials_installed ?? job.materials_installed,
      technicians ?? job.technicians,
      isAdmin ? (invoiced ? 1 : 0) : job.invoiced,
      isAdmin ? (invoice_number ?? job.invoice_number) : job.invoice_number,
      isAdmin ? (invoice_amount ?? job.invoice_amount) : job.invoice_amount,
      req.params.id
    );

    const updated = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Munka törlése (csak admin)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Csak admin törölhet' });
    }

    // Képek törlése Supabase Storage-ból
    const photos = await db.prepare(
      'SELECT storage_path FROM job_photos WHERE job_id = ?'
    ).all(req.params.id);

    const paths = photos.map(p => p.storage_path).filter(Boolean);
    if (paths.length > 0) {
      await supabase.storage.from(BUCKET).remove(paths);
    }

    await db.prepare('DELETE FROM job_photos WHERE job_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Képfeltöltés Supabase Storage-ba
router.post('/:id/photos', authenticate, upload.array('photos', 20), async (req, res) => {
  try {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Munka nem található' });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nincs feltöltött fájl' });
    }

    const inserted = [];
    for (const file of req.files) {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname).toLowerCase();
      const storagePath = `job-${req.params.id}/job-${unique}${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) throw new Error('Storage hiba: ' + uploadError.message);

      const { data: { publicUrl } } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(storagePath);

      const result = await db.prepare(`
        INSERT INTO job_photos (job_id, filename, original_name, storage_path, public_url, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.params.id, path.basename(storagePath), file.originalname,
             storagePath, publicUrl, req.user.id);

      inserted.push({
        id: result.lastInsertRowid,
        filename: path.basename(storagePath),
        original_name: file.originalname,
        url: publicUrl
      });
    }

    res.status(201).json({ photos: inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kép törlése
router.delete('/:jobId/photos/:photoId', authenticate, async (req, res) => {
  try {
    const photo = await db.prepare(
      'SELECT * FROM job_photos WHERE id = ? AND job_id = ?'
    ).get(req.params.photoId, req.params.jobId);

    if (!photo) return res.status(404).json({ error: 'Kép nem található' });

    if (photo.storage_path) {
      await supabase.storage.from(BUCKET).remove([photo.storage_path]);
    }

    await db.prepare('DELETE FROM job_photos WHERE id = ?').run(req.params.photoId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Képek listázása egy munkához
router.get('/:id/photos', authenticate, async (req, res) => {
  try {
    const photos = await db.prepare(
      'SELECT * FROM job_photos WHERE job_id = ? ORDER BY uploaded_at'
    ).all(req.params.id);
    res.json(photos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
