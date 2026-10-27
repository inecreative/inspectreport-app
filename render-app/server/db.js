'use strict';

/**
 * Database layer.
 *
 * Production: a real PostgreSQL database via the DATABASE_URL env var
 * (Render Postgres). Tables are created automatically on boot with
 * idempotent CREATE TABLE IF NOT EXISTS statements.
 *
 * Local smoke test: when DATABASE_URL is NOT set we fall back to pg-mem,
 * an in-memory Postgres-compatible database behind the exact same
 * `query()` interface. Data in this mode is throwaway (lost on restart)
 * and exists only so the app can be run/tested without a Postgres install.
 * For real local development, point DATABASE_URL at a real Postgres.
 */

const { Pool } = require('pg');

let pool = null;
let memoryMode = false;

function createPool() {
  const url = process.env.DATABASE_URL;
  if (url) {
    let ssl;
    try {
      const host = new URL(url).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') {
        // Render Postgres requires SSL; its certs are not in the default CA
        // chain used here, so accept them without strict verification.
        ssl = { rejectUnauthorized: false };
      }
    } catch (_) {
      /* unparsable URL: let pg report the error */
    }
    return new Pool({ connectionString: url, ssl });
  }

  memoryMode = true;
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  return new MemPool();
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     email TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reports (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     address TEXT NOT NULL DEFAULT '',
     client_name TEXT NOT NULL DEFAULT '',
     client_email TEXT NOT NULL DEFAULT '',
     client_phone TEXT NOT NULL DEFAULT '',
     inspection_date DATE,
     inspector_name TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS custom_fields (
     id SERIAL PRIMARY KEY,
     report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '',
     value TEXT NOT NULL DEFAULT '',
     sort_order INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS field_templates (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '',
     value TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS findings (
     id SERIAL PRIMARY KEY,
     report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
     area TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL DEFAULT '',
     detail TEXT NOT NULL DEFAULT '',
     severity TEXT NOT NULL DEFAULT 'Monitor',
     cost NUMERIC(10,2) NOT NULL DEFAULT 0,
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS photos (
     id SERIAL PRIMARY KEY,
     report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
     finding_id INTEGER REFERENCES findings(id) ON DELETE SET NULL,
     filename TEXT NOT NULL,
     original_name TEXT NOT NULL DEFAULT '',
     mime TEXT NOT NULL DEFAULT '',
     size INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function init() {
  pool = createPool();
  for (const stmt of SCHEMA) {
    // Sequential on purpose: keeps boot logs readable and order deterministic.
    // eslint-disable-next-line no-await-in-loop
    await pool.query(stmt);
  }
  if (memoryMode) {
    console.warn(
      '[db] DATABASE_URL is not set — running on an in-memory pg-mem database. ' +
        'Data will NOT persist across restarts. Set DATABASE_URL for real use.'
    );
  } else {
    console.log('[db] Connected to PostgreSQL and ensured schema.');
  }
}

function query(text, params) {
  if (!pool) throw new Error('Database not initialised — call init() first.');
  return pool.query(text, params);
}

module.exports = { init, query, isMemoryMode: () => memoryMode };
