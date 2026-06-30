/**
 * Első indításkor futtasd: node scripts/init-users.js
 * Létrehozza az admin felhasználót és szervizes felhasználókat.
 * SUPABASE/PostgreSQL verzió
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const readline = require('readline');
const db = require('../database/db');  // az új pg-alapú db.js

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function question(q) { return new Promise(resolve => rl.question(q, resolve)); }

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   JadeWell – kezdeti beállítás           ║');
  console.log('║   (Supabase/PostgreSQL verzió)           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  const adminExists = await db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get();
  if (adminExists) {
    console.log('Admin felhasználó már létezik.');
    const overwrite = await question('Új admin létrehozása? (i/N): ');
    if (overwrite.toLowerCase() === 'i') await createAdmin();
    else console.log('Kihagyva.');
  } else {
    console.log('Admin felhasználó létrehozása');
    console.log('-----------------------------');
    await createAdmin();
  }

  console.log('');
  const addTech = await question('Szervizes felhasználót szeretnél most felvenni? (i/N): ');
  if (addTech.toLowerCase() === 'i') {
    let more = true;
    while (more) {
      await createTechnician();
      const again = await question('Még egy szervizes? (i/N): ');
      more = again.toLowerCase() === 'i';
    }
  }

  console.log('');
  console.log('Beállítás kész! Most indítsd el a szervert:');
  console.log('  npm start');
  console.log('');
  rl.close();
  process.exit(0);
}

async function createAdmin() {
  const name = await question('  Neved: ');
  const username = await question('  Felhasználónév (pl. andras): ');
  const password = await question('  Jelszó (legalább 6 karakter): ');
  if (!name || !username || password.length < 6) { console.log('  Hibás adat, kihagyva.'); return; }
  const hashed = bcrypt.hashSync(password, 10);
  try {
    await db.prepare(`INSERT INTO users (name, username, password, role) VALUES (?, ?, ?, 'admin')`).run(name, username, hashed);
    console.log(`  Admin létrehozva: ${username}`);
  } catch (e) { console.log(`  Hiba: ${e.message}`); }
}

async function createTechnician() {
  console.log('');
  console.log('Szervizes felvétele');
  console.log('--------------------');
  const name = await question('  Neve: ');
  const username = await question('  Felhasználónév: ');
  const password = await question('  Jelszó: ');
  if (!name || !username || password.length < 4) { console.log('  Hibás adat, kihagyva.'); return; }
  const hashed = bcrypt.hashSync(password, 10);
  try {
    await db.prepare(`INSERT INTO users (name, username, password, role) VALUES (?, ?, ?, 'technician')`).run(name, username, hashed);
    console.log(`  Szervizes felvéve: ${name} (${username})`);
  } catch (e) { console.log(`  Hiba: ${e.message}`); }
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });
