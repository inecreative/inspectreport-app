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
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     subscribed BOOLEAN NOT NULL DEFAULT false,
     subscribed_via TEXT
   )`,
  /* Subscription columns for databases created before the paywall:
     idempotent, so existing production data upgrades safely on boot and
     existing users default to unsubscribed. */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscribed BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscribed_via TEXT`,
  /* Profile fields shown/edited on the User Profile page (full name,
     company, phone). Idempotent like the subscription columns above. */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_address TEXT NOT NULL DEFAULT ''`,
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
  `CREATE TABLE IF NOT EXISTS report_templates (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS report_template_fields (
     id SERIAL PRIMARY KEY,
     template_id INTEGER NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '',
     value TEXT NOT NULL DEFAULT '',
     sort_order INTEGER NOT NULL DEFAULT 0
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
  /* Commercial pack (Phase 2): when a finding's work is expected to be
     needed — 'immediate' | '1-3' | '3-5' | '5-10', NULL when unset (the
     residential flow never touches it). Drives the auto CAPEX summary
     in the preview/PDF. Must run AFTER the findings table exists. */
  `ALTER TABLE findings ADD COLUMN IF NOT EXISTS horizon TEXT`,
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
  /* Report cover ("house photo"): the id of a photos row shown at the
     top of the report preview and the PDF. Plain INTEGER (no FK) so the
     migration stays trivially idempotent; routes validate ownership.
     Must run AFTER the reports table exists (production DBs created
     before this column upgrade on boot, like the users columns above). */
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS cover_photo_id INTEGER`,
  /* Per-report document type: 'inspection' (default — every existing
     report keeps the current wording) or 'job', for trades users who
     send customers a "Job Report" instead of an inspection report.
     Must run AFTER the reports table exists. */
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'inspection'`,
  /* Report design theme (5 selectable templates): 'corporate' is the
     original look and the default, so existing reports never change.
     badge_text is the user's optional replacement for the orange badge
     wording ('' = the per-doc-type default). Must run AFTER the
     reports table exists. */
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS template TEXT NOT NULL DEFAULT 'corporate'`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS badge_text TEXT NOT NULL DEFAULT ''`,
  /* Stripe linkage + cancellation bookkeeping behind the User Profile
     page's subscribe / cancel controls. The customer/subscription ids
     are captured from webhook events; cancel_requested_at records a
     cancellation the founder still has to process in Stripe when no
     Stripe secret key is configured on the server. */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false`,
  /* Estimate document type (Phase 1a): per-report estimate fields.
     Real columns (not custom fields) so totals/validity math is exact.
     Must run AFTER the reports table exists. estimate_number is filled
     in by the create route as EST-<zero-padded report id>. */
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS estimate_number TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS valid_days INTEGER NOT NULL DEFAULT 30`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS scope_text TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS exclusions_text TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS terms_text TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS deposit_pct NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS discount_value NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'pct'`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_rate NUMERIC NOT NULL DEFAULT 0`,
  /* Line items for estimate documents, grouped by a free-text section
     name. Optional items are quoted separately and never counted in
     the estimate total. */
  `CREATE TABLE IF NOT EXISTS estimate_items (
     id SERIAL PRIMARY KEY,
     report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
     section TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'item',
     qty NUMERIC NOT NULL DEFAULT 1,
     unit TEXT NOT NULL DEFAULT '',
     unit_price NUMERIC NOT NULL DEFAULT 0,
     optional BOOLEAN NOT NULL DEFAULT false,
     sort_order INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  /* The user's own saved line items ("my price book"), reused across
     estimates. Managed as a simple list on the User Profile page. */
  `CREATE TABLE IF NOT EXISTS price_book (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'item',
     unit TEXT NOT NULL DEFAULT '',
     unit_price NUMERIC NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  /* Estimate templates, same philosophy as report templates v2: save
     by NAME only (the current estimate's items + texts are copied),
     apply appends, delete removes. No template editor. */
  `CREATE TABLE IF NOT EXISTS estimate_templates (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '',
     scope_text TEXT NOT NULL DEFAULT '',
     exclusions_text TEXT NOT NULL DEFAULT '',
     terms_text TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS estimate_template_items (
     id SERIAL PRIMARY KEY,
     template_id INTEGER NOT NULL REFERENCES estimate_templates(id) ON DELETE CASCADE,
     section TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'item',
     qty NUMERIC NOT NULL DEFAULT 1,
     unit TEXT NOT NULL DEFAULT '',
     unit_price NUMERIC NOT NULL DEFAULT 0,
     optional BOOLEAN NOT NULL DEFAULT false,
     sort_order INTEGER NOT NULL DEFAULT 0
   )`,
  /* Estimate defaults on the profile: new estimates start prefilled
     with the user's own terms / exclusions / validity / deposit. */
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS est_terms TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS est_exclusions TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS est_valid_days INTEGER NOT NULL DEFAULT 30`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS est_deposit_pct NUMERIC NOT NULL DEFAULT 0`,
  /* Estimate sharing (Phase 1b): a public, unguessable share link per
     report with view tracking and customer approval. share_token is
     generated lazily the first time the owner turns the link on.
     estimate_status: 'draft' | 'sent' | 'viewed' | 'approved' |
     'declined' (estimate documents only). approved_optionals holds a
     JSON array of the estimate_items ids the customer chose to include
     when approving. Must run AFTER the reports table exists. */
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS share_token TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS estimate_status TEXT NOT NULL DEFAULT 'draft'`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS approved_name TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS approved_optionals TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS declined_reason TEXT`,
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
