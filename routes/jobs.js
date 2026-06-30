const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const db = require('../database/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'job-photos';

// Multer – memóriában tartja a fájlokat
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

// Supabase Storage feltöltés natív fetch-el (Node 18 kompatibilis)
async function uploadToStorage(buffer, storagePath, mimeType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType,
      'x-upsert': 'false'
    },
    body: buffer
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Storage feltöltési hiba: ' + err);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

async function deleteFromStorage(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
}

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
    job.photos = await db.prepare('SELECT * FROM job_photos WHERE job_id = ? ORDER BY uploaded_at').all(req.params.id);
    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Új munka
router.post('/', authenticate, async (req, res) => {
  try {
    const { partner_id, job_date, arrived_at, left_at, description, materials_installed, technicians } = req.body;
    if (!partner_id || !job_date) return res.status(400).json({ error: 'Partner és dátum kötelező' });

    const result = await db.prepare(`
      INSERT INTO jobs (partner_id, job_date, arrived_at, left_at,
                        description, materials_installed, technicians, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(partner_id, job_date, arrived_at || null, left_at || null,
           description || null, materials_installed || null, technicians || null, req.user.id);

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Munka módosítása
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { partner_id, job_date, arrived_at, left_at, description, materials_installed,
            technicians, invoiced, invoice_number, invoice_amount } = req.body;

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Munka nem található' });

    const isAdmin = req.user.role === 'admin';
    await db.prepare(`
      UPDATE jobs SET partner_id = ?, job_date = ?, arrived_at = ?, left_at = ?,
          description = ?, materials_installed = ?, technicians = ?,
          invoiced = ?, invoice_number = ?, invoice_amount = ?, updated_at = NOW()
      WHERE id = ?
    `).run(
      partner_id ?? job.partner_id, job_date ?? job.job_date,
      arrived_at ?? job.arrived_at, left_at ?? job.left_at,
      description ?? job.description, materials_installed ?? job.materials_installed,
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

// Munka törlése
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Csak admin törölhet' });

    const photos = await db.prepare('SELECT storage_path FROM job_photos WHERE job_id = ?').all(req.params.id);
    for (const p of photos) {
      if (p.storage_path) await deleteFromStorage(p.storage_path);
    }

    await db.prepare('DELETE FROM job_photos WHERE job_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Képfeltöltés
router.post('/:id/photos', authenticate, upload.array('photos', 20), async (req, res) => {
  try {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Munka nem található' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nincs feltöltött fájl' });

    const inserted = [];
    for (const file of req.files) {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname).toLowerCase();
      const storagePath = `job-${req.params.id}/job-${unique}${ext}`;

      const publicUrl = await uploadToStorage(file.buffer, storagePath, file.mimetype);

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
    if (photo.storage_path) await deleteFromStorage(photo.storage_path);
    await db.prepare('DELETE FROM job_photos WHERE id = ?').run(req.params.photoId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Képek listázása
router.get('/:id/photos', authenticate, async (req, res) => {
  try {
    const photos = await db.prepare(
      'SELECT * FROM job_photos WHERE job_id = ? ORDER BY uploaded_at'
    ).all(req.params.id);
    res.json(photos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
