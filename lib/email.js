// Email küldő modul - nodemailer alapú SMTP
const nodemailer = require('nodemailer');

let transporter = null;
let lastError = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isConfigured()) return null;

  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    return transporter;
  } catch (e) {
    lastError = e.message;
    return null;
  }
}

function getFromAddress() {
  const name = process.env.SMTP_FROM_NAME || 'JadeWell';
  const email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  return `"${name}" <${email}>`;
}

async function sendEmail({ to, cc, bcc, subject, text, html, attachments }) {
  if (!isConfigured()) {
    throw new Error('Email küldés nincs beállítva. Töltsd ki a .env fájlban a SMTP_HOST, SMTP_USER, SMTP_PASS mezőket.');
  }
  const tr = getTransporter();
  if (!tr) {
    throw new Error('Email küldő nem elérhető: ' + (lastError || 'ismeretlen hiba'));
  }

  const info = await tr.sendMail({
    from: getFromAddress(),
    to, cc, bcc, subject, text, html, attachments
  });

  return info;
}

async function verifyConnection() {
  if (!isConfigured()) return { ok: false, configured: false };
  const tr = getTransporter();
  if (!tr) return { ok: false, configured: true, error: lastError };
  try {
    await tr.verify();
    return { ok: true, configured: true };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

module.exports = { sendEmail, isConfigured, verifyConnection, getFromAddress };
