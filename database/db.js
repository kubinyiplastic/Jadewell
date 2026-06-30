// database/db.js  –  Supabase (PostgreSQL) verzió
// Cseréli az eredeti node:sqlite alapú modult.
// A felületi API azonos: db.prepare(sql).get/all/run

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ------------------------------------------------------------
// Kompatibilitási réteg: szinkron-szerű API az eredeti
// better-sqlite3 / node:sqlite stílushoz közelítve.
// A route-ok db.prepare(sql).get/all/run() hívásokat használnak,
// de mi ezeket aszinkronná alakítjuk belül és a route-okban
// await-tel hívjuk majd.
// FONTOS: Az összes route-ban az async/await mintára váltunk.
// ------------------------------------------------------------

// Segédfüggvény: SQLite ? placeholder → PostgreSQL $1 $2 ...
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Segédfüggvény: SQLite date() és datetime() → PostgreSQL
function convertDateFunctions(sql) {
  // date('now') → CURRENT_DATE
  sql = sql.replace(/date\('now'\)/gi, 'CURRENT_DATE');
  // date('now', '+7 days') → CURRENT_DATE + INTERVAL '7 days'
  sql = sql.replace(/date\('now',\s*'\+(\d+)\s+days?'\)/gi, (_, n) => `CURRENT_DATE + INTERVAL '${n} days'`);
  // CURRENT_TIMESTAMP → NOW() (kompatibilis, de jelezzük)
  // substr(col, start, len) → SUBSTR kompatibilis PostgreSQL-ben is
  return sql;
}

function prepare(sql) {
  const pgSql = convertDateFunctions(convertPlaceholders(sql));

  return {
    // SELECT egyetlen sor
    async get(...params) {
      const res = await pool.query(pgSql, params);
      return res.rows[0] || null;
    },
    // SELECT több sor
    async all(...params) {
      const res = await pool.query(pgSql, params);
      return res.rows;
    },
    // INSERT / UPDATE / DELETE
    // Visszaad: { lastInsertRowid, changes }
    async run(...params) {
      // INSERT esetén RETURNING id-vel szerzünk lastInsertRowid-t
      let execSql = pgSql;
      let isInsert = /^\s*INSERT/i.test(pgSql);
      if (isInsert && !/RETURNING/i.test(pgSql)) {
        execSql = pgSql + ' RETURNING id';
      }
      const res = await pool.query(execSql, params);
      return {
        lastInsertRowid: isInsert && res.rows[0] ? res.rows[0].id : null,
        changes: res.rowCount
      };
    }
  };
}

// exec: DDL futtatása (CREATE TABLE, stb.) – csak indításkor kell
async function exec(sql) {
  await pool.query(sql);
}

// Tranzakció segédfüggvény
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Közvetlen query az összetettebb esetekhez
async function query(sql, params = []) {
  const pgSql = convertDateFunctions(convertPlaceholders(sql));
  const res = await pool.query(pgSql, params);
  return res.rows;
}

module.exports = { prepare, exec, transaction, query, pool };
