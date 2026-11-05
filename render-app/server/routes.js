'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const auth = require('./auth');
const ai = require('./ai');
const access = require('./access');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = MIME_TO_EXT[file.mimetype] || '.img';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    if (MIME_TO_EXT[file.mimetype]) return cb(null, true);
    return cb(new Error('Only image files (JPEG, PNG, WebP, GIF) can be uploaded.'));
  },
});


/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function shapeFinding(row) {
  return { ...row, cost: Number(row.cost || 0), photos: [] };
}

function shapeEstimateItem(row) {
  return {
    ...row,
    qty: Number(row.qty || 0),
    unit_price: Number(row.unit_price || 0),
    optional: Boolean(row.optional),
  };
}

const ITEM_KINDS = ['labor', 'material', 'item'];

function cleanKind(v) {
  return ITEM_KINDS.includes(v) ? v : 'item';
}

/**
 * Fetch a row by id. Used instead of `RETURNING *` on writes: some
 * embedded Postgres emulators mishandle RETURNING * on FK-referenced
 * tables, while RETURNING id + SELECT works everywhere (incl. real PG).
 */
async function byId(table, id) {
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  return rows[0];
}

function shapePhoto(row) {
  return { ...row, url: `/api/photos/${row.id}/file` };
}

/** Fetch a report only if it belongs to the signed-in user. */
async function ownReport(userId, reportId) {
  const { rows } = await db.query('SELECT * FROM reports WHERE id = $1 AND user_id = $2', [
    reportId,
    userId,
  ]);
  return rows[0] || null;
}

async function fullReport(userId, reportId) {
  const report = await ownReport(userId, reportId);
  if (!report) return null;
  const [fields, findingRows, photoRows, itemRows] = await Promise.all([
    db.query('SELECT * FROM custom_fields WHERE report_id = $1 ORDER BY sort_order, id', [reportId]),
    db.query('SELECT * FROM findings WHERE report_id = $1 ORDER BY sort_order, id', [reportId]),
    db.query('SELECT * FROM photos WHERE report_id = $1 ORDER BY id', [reportId]),
    db.query('SELECT * FROM estimate_items WHERE report_id = $1 ORDER BY sort_order, id', [reportId]),
  ]);
  const estimateItems = itemRows.rows.map(shapeEstimateItem);
  const findings = findingRows.rows.map(shapeFinding);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const photos = photoRows.rows.map(shapePhoto);
  for (const photo of photos) {
    const f = photo.finding_id != null ? byId.get(photo.finding_id) : null;
    if (f) f.photos.push(photo);
  }
  // The house photo (report cover), if one is set and still exists.
  const cover = report.cover_photo_id ? photos.find((p) => p.id === report.cover_photo_id) : null;
  report.cover_url = cover ? cover.url : null;
  // Numeric estimate fields come back as strings from pg — normalize.
  report.deposit_pct = Number(report.deposit_pct || 0);
  report.discount_value = Number(report.discount_value || 0);
  report.tax_rate = Number(report.tax_rate || 0);
  report.valid_days = Number(report.valid_days || 30);
  // Phase 1b sharing fields: same treatment.
  report.share_enabled = Boolean(report.share_enabled);
  report.view_count = Number(report.view_count || 0);
  try {
    const parsed = JSON.parse(report.approved_optionals || '[]');
    report.approved_optionals = Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch (_) {
    report.approved_optionals = [];
  }
  return { report, customFields: fields.rows, findings, photos, estimateItems };
}

async function touchReport(reportId) {
  await db.query('UPDATE reports SET updated_at = now() WHERE id = $1', [reportId]);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

router.post(
  '/auth/signup',
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
    }
    const hash = await auth.hashPassword(password);
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    const token = await auth.createSession(rows[0].id);
    auth.setSessionCookie(res, token);
    return res.status(201).json({ user: rows[0] });
  })
);

router.post(
  '/auth/login',
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await auth.verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const token = await auth.createSession(user.id);
    auth.setSessionCookie(res, token);
    return res.json({ user: { id: user.id, email: user.email } });
  })
);

router.post('/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  return res.json({ user: req.user });
});

/* ------------------------------------------------------------------ */
/* User profile (User Profile page: full name, company name, phone)    */
/* ------------------------------------------------------------------ */

function profileJson(u) {
  return {
    email: u.email,
    fullName: u.full_name || '',
    companyName: u.company_name || '',
    phone: u.phone || '',
    companyAddress: u.company_address || '',
    estTerms: u.est_terms || '',
    estExclusions: u.est_exclusions || '',
    estValidDays: Number(u.est_valid_days ?? 30),
    estDepositPct: Number(u.est_deposit_pct || 0),
  };
}

const PROFILE_COLS =
  'email, full_name, company_name, phone, company_address, est_terms, est_exclusions, est_valid_days, est_deposit_pct';

router.get(
  '/profile',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(`SELECT ${PROFILE_COLS} FROM users WHERE id = $1`, [
      req.user.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ profile: profileJson(rows[0]) });
  })
);

router.put(
  '/profile',
  auth.requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    /* Only keys actually present in the body are updated, so the
       profile form and the estimate-defaults form can save separately
       without wiping each other's fields. */
    const defs = [
      ['fullName', 'full_name', (v) => String(v ?? '').trim().slice(0, 120)],
      ['companyName', 'company_name', (v) => String(v ?? '').trim().slice(0, 120)],
      ['phone', 'phone', (v) => String(v ?? '').trim().slice(0, 40)],
      ['companyAddress', 'company_address', (v) => String(v ?? '').trim().slice(0, 200)],
      ['estTerms', 'est_terms', (v) => String(v ?? '').slice(0, 4000)],
      ['estExclusions', 'est_exclusions', (v) => String(v ?? '').slice(0, 4000)],
      ['estValidDays', 'est_valid_days', (v) => Math.max(0, Math.min(365, Math.round(Number(v) || 0)))],
      ['estDepositPct', 'est_deposit_pct', (v) => Math.max(0, Math.min(100, Number(v) || 0))],
    ];
    const sets = [];
    const values = [];
    for (const [key, col, clean] of defs) {
      if (body[key] !== undefined) {
        values.push(clean(body[key]));
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (sets.length) {
      values.push(req.user.id);
      await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    }
    const { rows } = await db.query(`SELECT ${PROFILE_COLS} FROM users WHERE id = $1`, [
      req.user.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ profile: profileJson(rows[0]) });
  })
);

/* Change password from the User Profile page: the current password must
   check out against the stored hash before the new one is saved. */
router.put(
  '/profile/password',
  auth.requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    if (next.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    if (next === current) {
      return res.status(400).json({ error: 'New password must be different from the current one.' });
    }
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    if (!(await auth.verifyPassword(current, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const hash = await auth.hashPassword(next);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Billing                                                             */
/* ------------------------------------------------------------------ */

router.get(
  '/billing',
  wrap(async (req, res) => {
    let state = {
      subscribed: false,
      subscribedVia: null,
      hasPdfAccess: false,
      accessVia: null,
      inTrial: false,
      trialEndsAt: null,
      trialDaysLeft: 0,
    };
    let isAdmin = false;
    let userRow = null;
    if (req.user) {
      userRow = await access.userById(req.user.id);
      state = access.pdfAccessState(userRow || req.user);
      isAdmin = access.isAdminEmail(req.user.email);
    }
    res.json({
      planName: 'InspectReport AI',
      priceMonthly: 49,
      paymentLinkUrl: process.env.PAYMENT_LINK_URL || null,
      aiEnabled: ai.aiConfigured(),
      subscribed: state.subscribed,
      subscribedVia: state.subscribedVia,
      pdfAccess: state.hasPdfAccess,
      accessVia: state.accessVia,
      inTrial: state.inTrial,
      trialEndsAt: state.trialEndsAt,
      trialDaysLeft: state.trialDaysLeft,
      cancelRequestedAt: userRow && userRow.cancel_requested_at ? userRow.cancel_requested_at : null,
      cancelAtPeriodEnd: Boolean(userRow && userRow.cancel_at_period_end),
      isAdmin,
    });
  })
);

/* Cancel the signed-in user's subscription from the User Profile page.
   - Stripe subscribers: when STRIPE_SECRET_KEY is configured and we know
     the subscription id (captured by the webhook at checkout), the
     cancellation is sent to Stripe as cancel-at-period-end, so access
     runs to the end of the paid period and the subscription.deleted
     webhook then removes it. Without a key, the request is recorded
     (cancel_requested_at) for the founder to process in Stripe — it
     surfaces in the admin stats — and access stays active meanwhile.
   - Manually granted access: revoked immediately (nothing is billed).
   - Comp accounts have no paid subscription to cancel. */
router.post(
  '/billing/cancel',
  auth.requireAuth,
  wrap(async (req, res) => {
    const row = await access.userById(req.user.id);
    const stateNow = access.subscriptionState(row || req.user);
    if (!stateNow.subscribed) {
      return res.status(400).json({ error: 'No active subscription to cancel.' });
    }
    if (stateNow.subscribedVia === 'comp') {
      return res
        .status(400)
        .json({ error: 'This account has complimentary access — there is no paid subscription to cancel.' });
    }
    if (stateNow.subscribedVia !== 'stripe') {
      await access.setSubscribedByEmail(req.user.email, false, 'manual');
      return res.json({ ok: true, mode: 'immediate' });
    }
    const key = process.env.STRIPE_SECRET_KEY;
    const subId = row && row.stripe_subscription_id;
    if (key && subId) {
      const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ cancel_at_period_end: 'true' }).toString(),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        console.error('[stripe] cancel-at-period-end failed:', resp.status, detail.slice(0, 200));
        return res
          .status(502)
          .json({ error: 'Stripe could not process the cancellation. Please try again, or email us and we will cancel it for you.' });
      }
      const sub = await resp.json().catch(() => ({}));
      await db.query(
        'UPDATE users SET cancel_at_period_end = true, cancel_requested_at = NULL WHERE id = $1',
        [req.user.id]
      );
      return res.json({
        ok: true,
        mode: 'period_end',
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
      });
    }
    await db.query('UPDATE users SET cancel_requested_at = now() WHERE id = $1', [req.user.id]);
    return res.json({ ok: true, mode: 'requested' });
  })
);

/* Undo a pending cancellation (profile page "Keep my subscription"). */
router.post(
  '/billing/cancel/undo',
  auth.requireAuth,
  wrap(async (req, res) => {
    const row = await access.userById(req.user.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    const key = process.env.STRIPE_SECRET_KEY;
    if (row.cancel_at_period_end && key && row.stripe_subscription_id) {
      const resp = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ cancel_at_period_end: 'false' }).toString(),
        }
      );
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        console.error('[stripe] undo cancel failed:', resp.status, detail.slice(0, 200));
        return res.status(502).json({ error: 'Stripe could not undo the cancellation. Please try again.' });
      }
    }
    await db.query(
      'UPDATE users SET cancel_at_period_end = false, cancel_requested_at = NULL WHERE id = $1',
      [req.user.id]
    );
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Admin: grant / revoke subscription access by email (comp admins)    */
/* ------------------------------------------------------------------ */

router.post(
  '/admin/access',
  auth.requireAuth,
  wrap(async (req, res) => {
    if (!access.isAdminEmail(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const email = access.normalizeEmail(req.body && req.body.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const grant = Boolean(req.body && req.body.grant);
    const target = await access.userByEmail(email);
    if (!target) {
      return res.status(404).json({ error: 'No account with that email address.' });
    }
    const updated = await access.setSubscribedByEmail(email, grant, 'manual');
    const stateNow = access.subscriptionState(updated || target);
    return res.json({
      ok: true,
      email,
      subscribed: stateNow.subscribed,
      subscribedVia: stateNow.subscribedVia,
    });
  })
);

/* Admin: site stats for the founder (signup counts and activity).
   Same comp-admin guard as /admin/access. Read-only. */
router.get(
  '/admin/stats',
  auth.requireAuth,
  wrap(async (req, res) => {
    if (!access.isAdminEmail(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const count = async (sql) => {
      const { rows } = await db.query(sql);
      return Number(rows[0].n || 0);
    };
    // "Today" boundary computed in JS (date_trunc is not portable to the
    // in-memory fallback database).
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const { rows: todayRows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE created_at >= $1',
      [startOfToday.toISOString()]
    );
    const newToday = Number(todayRows[0].n || 0);
    const [
      totalUsers,
      new7d,
      new30d,
      subscribed,
      inTrial,
      totalReports,
      reports7d,
    ] = await Promise.all([
      count('SELECT COUNT(*)::int AS n FROM users'),
      count(`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= now() - interval '7 days'`),
      count(`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= now() - interval '30 days'`),
      count('SELECT COUNT(*)::int AS n FROM users WHERE subscribed = true'),
      // Trial-active: inside the 3-day free-trial window, not subscribed.
      count(
        `SELECT COUNT(*)::int AS n FROM users
          WHERE subscribed = false AND created_at >= now() - interval '3 days'`
      ),
      count('SELECT COUNT(*)::int AS n FROM reports'),
      count(`SELECT COUNT(*)::int AS n FROM reports WHERE created_at >= now() - interval '7 days'`),
    ]);
    const { rows: recent } = await db.query(
      'SELECT email, created_at, subscribed, subscribed_via FROM users ORDER BY created_at DESC LIMIT 10'
    );
    /* Pending cancellation requests (profile page) the founder still has
       to process in Stripe — only relevant until a Stripe secret key is
       configured on the server and cancellations become automatic. */
    const { rows: cancelRows } = await db.query(
      'SELECT email, cancel_requested_at FROM users WHERE cancel_requested_at IS NOT NULL ORDER BY cancel_requested_at ASC'
    );
    return res.json({
      totalUsers,
      newToday,
      new7d,
      new30d,
      subscribed,
      inTrial,
      totalReports,
      reports7d,
      recent,
      cancelRequests: cancelRows.map((r) => ({ email: r.email, requestedAt: r.cancel_requested_at })),
    });
  })
);

/* ------------------------------------------------------------------ */
/* Stripe webhook — automatic subscription enforcement.              */
/*                                                                     */
/* Manual mode: when STRIPE_WEBHOOK_SECRET is unset the endpoint     */
/* answers 503 and the rest of the app works normally; access is     */
/* then managed by admin grants and the comp list only.              */
/* ------------------------------------------------------------------ */

const WEBHOOK_TOLERANCE_SEC = 5 * 60;

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of String(signatureHeader).split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || !signatures.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

/** Best-effort email extraction from a Stripe event object. */
function emailFromEventObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.customer_email,
    obj.customer_details && obj.customer_details.email,
    obj.customerDetails && obj.customerDetails.email,
    obj.receipt_email,
    obj.billing_details && obj.billing_details.email,
    obj.metadata && obj.metadata.email,
    obj.metadata && obj.metadata.user_email,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.includes('@')) return c.trim().toLowerCase();
  }
  return null;
}

/** Subscription statuses that mean the customer should NOT have access. */
const DEAD_SUBSCRIPTION_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

async function applyStripeSubscriptionState(eventType, obj) {
  let email = emailFromEventObject(obj);
  let existing = email ? await access.userByEmail(email) : null;
  if (!existing && obj && obj.customer) {
    // Subscription objects carry a customer id, not an email. Resolve the
    // account through the customer id the checkout event stored for it.
    const { rows } = await db.query('SELECT * FROM users WHERE stripe_customer_id = $1', [
      String(obj.customer),
    ]);
    existing = rows[0] || null;
    if (existing) email = existing.email;
  }
  if (!existing) {
    console.warn(
      `[stripe] ${eventType}: no InspectReport account matched (email=${email || 'n/a'}, customer=${(obj && obj.customer) || 'n/a'}); event acknowledged only.`
    );
    return;
  }
  // Remember the Stripe linkage so later subscription events (and the
  // profile page's cancel button) can find this subscription again.
  const customerId = obj.customer ? String(obj.customer) : null;
  let subscriptionId = null;
  if (eventType === 'checkout.session.completed') {
    subscriptionId = obj.subscription ? String(obj.subscription) : null;
  } else if (obj.id) {
    subscriptionId = String(obj.id);
  }
  if (customerId || subscriptionId) {
    await db.query(
      `UPDATE users
          SET stripe_customer_id = COALESCE($1, stripe_customer_id),
              stripe_subscription_id = COALESCE($2, stripe_subscription_id)
        WHERE id = $3`,
      [customerId, subscriptionId, existing.id]
    );
  }
  let subscribed = null;
  if (eventType === 'checkout.session.completed') {
    if (obj.mode && obj.mode !== 'subscription') return;
    subscribed = true;
  } else if (
    eventType === 'customer.subscription.created' ||
    eventType === 'customer.subscription.updated'
  ) {
    subscribed = !DEAD_SUBSCRIPTION_STATUSES.has(String(obj.status || ''));
    // Mirror Stripe's scheduled cancellation so the profile page shows
    // the same state Stripe does.
    if (obj.cancel_at_period_end !== undefined) {
      await db.query('UPDATE users SET cancel_at_period_end = $1 WHERE id = $2', [
        Boolean(obj.cancel_at_period_end),
        existing.id,
      ]);
    }
  } else if (eventType === 'customer.subscription.deleted') {
    subscribed = false;
  }
  if (subscribed === null) return;
  if (subscribed) {
    // A (re)subscription clears any stale cancellation bookkeeping.
    await db.query(
      'UPDATE users SET cancel_requested_at = NULL, cancel_at_period_end = false WHERE id = $1',
      [existing.id]
    );
  }
  await access.setSubscribedByEmail(email, subscribed, 'stripe');
  console.log(`[stripe] ${eventType}: ${email} -> subscribed=${subscribed} (via stripe)`);
}

router.post('/stripe/webhook', (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Stripe webhook is not configured.' });
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'Invalid signature.' });
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }
  const obj = (event.data && event.data.object) || {};
  // Acknowledge every well-formed signed event, even unmatched ones.
  res.json({ received: true });
  const handled = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ];
  if (handled.includes(event.type)) {
    applyStripeSubscriptionState(event.type, obj).catch((err) => {
      console.error('[stripe] webhook handler error:', err);
    });
  }
  return undefined;
});

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

router.get(
  '/reports',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows: reports } = await db.query(
      'SELECT * FROM reports WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.user.id]
    );
    // Aggregate findings in JS: keeps the SQL plain and portable across
    // Postgres implementations, and the data volume per user is small.
    const stats = new Map();
    if (reports.length) {
      const { rows: frows } = await db.query(
        `SELECT report_id, severity, cost FROM findings
          WHERE report_id IN (SELECT id FROM reports WHERE user_id = $1)`,
        [req.user.id]
      );
      for (const f of frows) {
        const s = stats.get(f.report_id) || { finding_count: 0, urgent_count: 0, total_cost: 0 };
        s.finding_count += 1;
        if (f.severity === 'Urgent') s.urgent_count += 1;
        s.total_cost += Number(f.cost || 0);
        stats.set(f.report_id, s);
      }
      const { rows: irows } = await db.query(
        `SELECT report_id, qty, unit_price, optional FROM estimate_items
          WHERE report_id IN (SELECT id FROM reports WHERE user_id = $1)`,
        [req.user.id]
      );
      for (const it of irows) {
        const s = stats.get(it.report_id) || { finding_count: 0, urgent_count: 0, total_cost: 0 };
        s.item_count = (s.item_count || 0) + 1;
        if (!it.optional) {
          s.item_total = (s.item_total || 0) + Number(it.qty || 0) * Number(it.unit_price || 0);
        }
        stats.set(it.report_id, s);
      }
    }
    res.json({
      reports: reports.map((r) => ({
        ...r,
        ...(stats.get(r.id) || { finding_count: 0, urgent_count: 0, total_cost: 0 }),
        item_count: (stats.get(r.id) || {}).item_count || 0,
        item_total: (stats.get(r.id) || {}).item_total || 0,
      })),
    });
  })
);

router.post(
  '/reports',
  auth.requireAuth,
  wrap(async (req, res) => {
    // New reports start with the inspector name from the user's profile,
    // so they don't retype it on every job (still editable per report).
    // Estimate fields are prefilled from the profile's estimate defaults
    // the same way, so switching a report to an Estimate keeps the
    // user's own terms / exclusions / validity / deposit.
    const { rows: urows } = await db.query(
      'SELECT full_name, est_terms, est_exclusions, est_valid_days, est_deposit_pct FROM users WHERE id = $1',
      [req.user.id]
    );
    const u = urows[0] || {};
    const inspectorName = u.full_name || '';
    const { rows } = await db.query(
      `INSERT INTO reports (user_id, inspector_name, terms_text, exclusions_text, valid_days, deposit_pct)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        req.user.id,
        inspectorName,
        u.est_terms || '',
        u.est_exclusions || '',
        Number(u.est_valid_days ?? 30),
        Number(u.est_deposit_pct || 0),
      ]
    );
    const estimateNumber = `EST-${String(rows[0].id).padStart(4, '0')}`;
    await db.query('UPDATE reports SET estimate_number = $1 WHERE id = $2', [
      estimateNumber,
      rows[0].id,
    ]);
    res.status(201).json({ report: await byId('reports', rows[0].id) });
  })
);

router.get(
  '/reports/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const data = await fullReport(req.user.id, req.params.id);
    if (!data) return res.status(404).json({ error: 'Report not found.' });
    return res.json(data);
  })
);

router.put(
  '/reports/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const allowed = ['address', 'client_name', 'client_email', 'client_phone', 'inspector_name', 'summary'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        values.push(String(req.body[key] ?? ''));
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (req.body.inspection_date !== undefined) {
      values.push(req.body.inspection_date || null);
      sets.push(`inspection_date = $${values.length}`);
    }
    if (req.body.doc_type !== undefined) {
      const docType = String(req.body.doc_type);
      if (docType !== 'inspection' && docType !== 'job' && docType !== 'estimate') {
        return res.status(400).json({ error: 'Invalid document type.' });
      }
      values.push(docType);
      sets.push(`doc_type = $${values.length}`);
    }
    // Estimate-only document fields (long texts + simple numbers).
    for (const key of ['scope_text', 'exclusions_text', 'terms_text']) {
      if (req.body[key] !== undefined) {
        values.push(String(req.body[key] ?? '').slice(0, 8000));
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (req.body.valid_days !== undefined) {
      values.push(Math.max(0, Math.min(365, Math.round(Number(req.body.valid_days) || 0))));
      sets.push(`valid_days = $${values.length}`);
    }
    if (req.body.deposit_pct !== undefined) {
      values.push(Math.max(0, Math.min(100, Number(req.body.deposit_pct) || 0)));
      sets.push(`deposit_pct = $${values.length}`);
    }
    if (req.body.discount_value !== undefined) {
      values.push(Math.max(0, Number(req.body.discount_value) || 0));
      sets.push(`discount_value = $${values.length}`);
    }
    if (req.body.discount_type !== undefined) {
      values.push(req.body.discount_type === 'amt' ? 'amt' : 'pct');
      sets.push(`discount_type = $${values.length}`);
    }
    if (req.body.tax_rate !== undefined) {
      values.push(Math.max(0, Math.min(100, Number(req.body.tax_rate) || 0)));
      sets.push(`tax_rate = $${values.length}`);
    }
    if (req.body.cover_photo_id !== undefined) {
      let coverId = req.body.cover_photo_id;
      if (coverId !== null) {
        coverId = Number(coverId);
        // The cover must be one of this report's own photos.
        const { rows: coverRows } = await db.query(
          'SELECT id FROM photos WHERE id = $1 AND report_id = $2',
          [coverId, report.id]
        );
        if (!coverRows.length) return res.status(400).json({ error: 'Cover photo not found for this report.' });
      }
      values.push(coverId);
      sets.push(`cover_photo_id = $${values.length}`);
    }
    if (sets.length) {
      sets.push('updated_at = now()');
      values.push(report.id);
      await db.query(`UPDATE reports SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    }
    const data = await fullReport(req.user.id, report.id);
    return res.json(data);
  })
);

router.delete(
  '/reports/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: photoRows } = await db.query('SELECT filename FROM photos WHERE report_id = $1', [report.id]);
    await db.query('DELETE FROM reports WHERE id = $1', [report.id]);
    for (const p of photoRows) {
      fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(p.filename))).catch(() => {});
    }
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Custom fields (per report) and saved templates (per user)           */
/* ------------------------------------------------------------------ */

router.post(
  '/reports/:id/fields',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    let sortOrder;
    const afterId = req.body.afterId ? Number(req.body.afterId) : null;
    if (afterId) {
      const { rows: arows } = await db.query(
        'SELECT sort_order FROM custom_fields WHERE id = $1 AND report_id = $2',
        [afterId, report.id]
      );
      if (arows.length) {
        sortOrder = arows[0].sort_order + 1;
        await db.query(
          'UPDATE custom_fields SET sort_order = sort_order + 1 WHERE report_id = $1 AND sort_order >= $2',
          [report.id, sortOrder]
        );
      }
    }
    if (sortOrder === undefined) {
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_fields WHERE report_id = $1',
        [report.id]
      );
      sortOrder = maxRows[0].m + 1;
    }
    const { rows } = await db.query(
      'INSERT INTO custom_fields (report_id, name, value, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [report.id, String(req.body.name || ''), String(req.body.value || ''), sortOrder]
    );
    await touchReport(report.id);
    return res.status(201).json({ field: await byId('custom_fields', rows[0].id) });
  })
);

router.put(
  '/fields/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT cf.* FROM custom_fields cf
         JOIN reports r ON r.id = cf.report_id
        WHERE cf.id = $1 AND r.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Field not found.' });
    await db.query('UPDATE custom_fields SET name = $1, value = $2 WHERE id = $3', [
      String(req.body.name ?? rows[0].name),
      String(req.body.value ?? rows[0].value),
      rows[0].id,
    ]);
    const updated = await byId('custom_fields', rows[0].id);
    await touchReport(rows[0].report_id);
    return res.json({ field: updated });
  })
);

router.delete(
  '/fields/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT cf.id, cf.report_id FROM custom_fields cf
         JOIN reports r ON r.id = cf.report_id
        WHERE cf.id = $1 AND r.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Field not found.' });
    await db.query('DELETE FROM custom_fields WHERE id = $1', [rows[0].id]);
    await touchReport(rows[0].report_id);
    return res.json({ ok: true });
  })
);

router.get(
  '/report-templates',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows: templates } = await db.query(
      'SELECT * FROM report_templates WHERE user_id = $1 ORDER BY id',
      [req.user.id]
    );
    const out = [];
    for (const t of templates) {
      const { rows: fields } = await db.query(
        'SELECT * FROM report_template_fields WHERE template_id = $1 ORDER BY sort_order, id',
        [t.id]
      );
      out.push({ ...t, fields, fieldCount: fields.length });
    }
    return res.json({ templates: out });
  })
);

/* Create a report template. Two ways in:
   - from scratch (Templates page): body carries fields: [{name, value}]
   - from a report (legacy): body carries reportId and the report's
     current custom fields are copied. Name only either way. */
router.post(
  '/report-templates',
  auth.requireAuth,
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the template a name.' });
    if (Array.isArray(req.body.fields)) {
      const fields = req.body.fields.map((f) => ({
        name: String((f && f.name) || ''),
        value: String((f && f.value) || ''),
      }));
      if (!fields.length) {
        return res.status(400).json({ error: 'Add at least one field first.' });
      }
      const { rows } = await db.query(
        'INSERT INTO report_templates (user_id, name) VALUES ($1, $2) RETURNING id',
        [req.user.id, name]
      );
      const templateId = rows[0].id;
      for (let i = 0; i < fields.length; i += 1) {
        await db.query(
          'INSERT INTO report_template_fields (template_id, name, value, sort_order) VALUES ($1, $2, $3, $4)',
          [templateId, fields[i].name, fields[i].value, i]
        );
      }
      return res
        .status(201)
        .json({ template: { id: templateId, name, fieldCount: fields.length } });
    }
    const report = await ownReport(req.user.id, req.body.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: fields } = await db.query(
      'SELECT * FROM custom_fields WHERE report_id = $1 ORDER BY sort_order, id',
      [report.id]
    );
    if (!fields.length) {
      return res.status(400).json({ error: 'Add at least one custom field first.' });
    }
    const { rows } = await db.query(
      'INSERT INTO report_templates (user_id, name) VALUES ($1, $2) RETURNING id',
      [req.user.id, name]
    );
    const templateId = rows[0].id;
    for (let i = 0; i < fields.length; i += 1) {
      await db.query(
        'INSERT INTO report_template_fields (template_id, name, value, sort_order) VALUES ($1, $2, $3, $4)',
        [templateId, fields[i].name, fields[i].value, i]
      );
    }
    return res.status(201).json({ template: { id: templateId, name, fieldCount: fields.length } });
  })
);

router.post(
  '/reports/:id/apply-template',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: trows } = await db.query(
      'SELECT * FROM report_templates WHERE id = $1 AND user_id = $2',
      [Number(req.body.templateId), req.user.id]
    );
    if (!trows.length) return res.status(404).json({ error: 'Template not found.' });
    const { rows: tfields } = await db.query(
      'SELECT * FROM report_template_fields WHERE template_id = $1 ORDER BY sort_order, id',
      [trows[0].id]
    );
    const { rows: existing } = await db.query(
      'SELECT name FROM custom_fields WHERE report_id = $1',
      [report.id]
    );
    const have = new Set(existing.map((f) => f.name.trim().toLowerCase()));
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_fields WHERE report_id = $1',
      [report.id]
    );
    let sort = maxRows[0].m + 1;
    let added = 0;
    for (const f of tfields) {
      if (have.has(f.name.trim().toLowerCase())) continue;
      await db.query(
        'INSERT INTO custom_fields (report_id, name, value, sort_order) VALUES ($1, $2, $3, $4)',
        [report.id, f.name, f.value, sort]
      );
      sort += 1;
      added += 1;
    }
    if (added) await touchReport(report.id);
    return res.json({ ok: true, added });
  })
);

/* Update a report template from the Templates page: rename and/or
   replace its field rows wholesale. */
router.put(
  '/report-templates/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows: trows } = await db.query(
      'SELECT * FROM report_templates WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!trows.length) return res.status(404).json({ error: 'Template not found.' });
    const tpl = trows[0];
    const name = String(req.body.name ?? tpl.name).trim();
    if (!name) return res.status(400).json({ error: 'Give the template a name.' });
    let fields = null;
    if (Array.isArray(req.body.fields)) {
      fields = req.body.fields.map((f) => ({
        name: String((f && f.name) || ''),
        value: String((f && f.value) || ''),
      }));
      if (!fields.length) {
        return res.status(400).json({ error: 'Add at least one field first.' });
      }
    }
    await db.query('UPDATE report_templates SET name = $1 WHERE id = $2', [name, tpl.id]);
    if (fields) {
      await db.query('DELETE FROM report_template_fields WHERE template_id = $1', [tpl.id]);
      for (let i = 0; i < fields.length; i += 1) {
        await db.query(
          'INSERT INTO report_template_fields (template_id, name, value, sort_order) VALUES ($1, $2, $3, $4)',
          [tpl.id, fields[i].name, fields[i].value, i]
        );
      }
    }
    const { rows: saved } = await db.query(
      'SELECT * FROM report_template_fields WHERE template_id = $1 ORDER BY sort_order, id',
      [tpl.id]
    );
    return res.json({
      template: { id: tpl.id, name, fields: saved, fieldCount: saved.length },
    });
  })
);

router.delete(
  '/report-templates/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rowCount } = await db.query(
      'DELETE FROM report_templates WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Template not found.' });
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Estimate items (line items on estimate documents)                   */
/* ------------------------------------------------------------------ */

router.post(
  '/reports/:id/items',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM estimate_items WHERE report_id = $1',
      [report.id]
    );
    const b = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO estimate_items (report_id, section, description, kind, qty, unit, unit_price, optional, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        report.id,
        String(b.section || ''),
        String(b.description || ''),
        cleanKind(b.kind),
        Number(b.qty) || 0,
        String(b.unit || ''),
        Number(b.unit_price) || 0,
        Boolean(b.optional),
        maxRows[0].m + 1,
      ]
    );
    await touchReport(report.id);
    return res
      .status(201)
      .json({ item: shapeEstimateItem(await byId('estimate_items', rows[0].id)) });
  })
);

async function ownItem(userId, itemId) {
  const { rows } = await db.query(
    `SELECT i.* FROM estimate_items i
       JOIN reports r ON r.id = i.report_id
      WHERE i.id = $1 AND r.user_id = $2`,
    [itemId, userId]
  );
  return rows[0] || null;
}

router.put(
  '/items/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const item = await ownItem(req.user.id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const b = req.body || {};
    await db.query(
      `UPDATE estimate_items
          SET section = $1, description = $2, kind = $3, qty = $4, unit = $5,
              unit_price = $6, optional = $7
        WHERE id = $8`,
      [
        String(b.section ?? item.section),
        String(b.description ?? item.description),
        cleanKind(b.kind ?? item.kind),
        b.qty !== undefined ? Number(b.qty) || 0 : Number(item.qty),
        String(b.unit ?? item.unit),
        b.unit_price !== undefined ? Number(b.unit_price) || 0 : Number(item.unit_price),
        b.optional !== undefined ? Boolean(b.optional) : Boolean(item.optional),
        item.id,
      ]
    );
    await touchReport(item.report_id);
    return res.json({ item: shapeEstimateItem(await byId('estimate_items', item.id)) });
  })
);

router.delete(
  '/items/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const item = await ownItem(req.user.id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    await db.query('DELETE FROM estimate_items WHERE id = $1', [item.id]);
    await touchReport(item.report_id);
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Price book (the user's own saved line items)                        */
/* ------------------------------------------------------------------ */

router.get(
  '/price-book',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM price_book WHERE user_id = $1 ORDER BY id', [
      req.user.id,
    ]);
    return res.json({
      entries: rows.map((r) => ({ ...r, unit_price: Number(r.unit_price || 0) })),
    });
  })
);

router.post(
  '/price-book',
  auth.requireAuth,
  wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the price book item a name.' });
    const { rows } = await db.query(
      `INSERT INTO price_book (user_id, name, kind, unit, unit_price)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.id, name, cleanKind(b.kind), String(b.unit || ''), Number(b.unit_price) || 0]
    );
    const entry = await byId('price_book', rows[0].id);
    return res
      .status(201)
      .json({ entry: { ...entry, unit_price: Number(entry.unit_price || 0) } });
  })
);

router.delete(
  '/price-book/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rowCount } = await db.query('DELETE FROM price_book WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: 'Price book item not found.' });
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Estimate templates (name only — same shape as report templates)     */
/* ------------------------------------------------------------------ */

router.get(
  '/estimate-templates',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows: templates } = await db.query(
      'SELECT * FROM estimate_templates WHERE user_id = $1 ORDER BY id',
      [req.user.id]
    );
    const out = [];
    for (const t of templates) {
      const { rows: items } = await db.query(
        'SELECT * FROM estimate_template_items WHERE template_id = $1 ORDER BY sort_order, id',
        [t.id]
      );
      out.push({ ...t, items: items.map(shapeEstimateItem), itemCount: items.length });
    }
    return res.json({ templates: out });
  })
);

/* Normalize a client-supplied template line item (Templates page). */
function cleanTemplateItem(it) {
  const b = it || {};
  return {
    section: String(b.section || ''),
    description: String(b.description || ''),
    kind: cleanKind(b.kind),
    qty: Number(b.qty) || 0,
    unit: String(b.unit || ''),
    unit_price: Number(b.unit_price) || 0,
    optional: Boolean(b.optional),
  };
}

async function insertTemplateItems(templateId, items) {
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    await db.query(
      `INSERT INTO estimate_template_items
         (template_id, section, description, kind, qty, unit, unit_price, optional, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        templateId,
        it.section,
        it.description,
        it.kind,
        it.qty,
        it.unit,
        it.unit_price,
        it.optional,
        i,
      ]
    );
  }
}

/* Create an estimate template. Two ways in:
   - from scratch (Templates page): body carries items + the three texts
   - from an estimate (legacy): body carries reportId and the estimate's
     items + texts are copied. */
router.post(
  '/estimate-templates',
  auth.requireAuth,
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the template a name.' });
    if (Array.isArray(req.body.items)) {
      const items = req.body.items.map(cleanTemplateItem);
      if (!items.length) {
        return res.status(400).json({ error: 'Add at least one line item first.' });
      }
      const { rows } = await db.query(
        `INSERT INTO estimate_templates (user_id, name, scope_text, exclusions_text, terms_text)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          req.user.id,
          name,
          String(req.body.scopeText ?? req.body.scope_text ?? ''),
          String(req.body.exclusionsText ?? req.body.exclusions_text ?? ''),
          String(req.body.termsText ?? req.body.terms_text ?? ''),
        ]
      );
      const templateId = rows[0].id;
      await insertTemplateItems(templateId, items);
      return res
        .status(201)
        .json({ template: { id: templateId, name, itemCount: items.length } });
    }
    const report = await ownReport(req.user.id, req.body.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: items } = await db.query(
      'SELECT * FROM estimate_items WHERE report_id = $1 ORDER BY sort_order, id',
      [report.id]
    );
    if (!items.length) {
      return res.status(400).json({ error: 'Add at least one line item first.' });
    }
    const { rows } = await db.query(
      `INSERT INTO estimate_templates (user_id, name, scope_text, exclusions_text, terms_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.id, name, report.scope_text || '', report.exclusions_text || '', report.terms_text || '']
    );
    const templateId = rows[0].id;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      await db.query(
        `INSERT INTO estimate_template_items
           (template_id, section, description, kind, qty, unit, unit_price, optional, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          templateId,
          it.section,
          it.description,
          it.kind,
          Number(it.qty || 0),
          it.unit,
          Number(it.unit_price || 0),
          Boolean(it.optional),
          i,
        ]
      );
    }
    return res.status(201).json({ template: { id: templateId, name, itemCount: items.length } });
  })
);

/* Apply appends the template's items; the saved texts fill in only
   where the target estimate's own texts are still empty. */
router.post(
  '/reports/:id/apply-estimate-template',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: trows } = await db.query(
      'SELECT * FROM estimate_templates WHERE id = $1 AND user_id = $2',
      [Number(req.body.templateId), req.user.id]
    );
    if (!trows.length) return res.status(404).json({ error: 'Template not found.' });
    const tpl = trows[0];
    const { rows: titems } = await db.query(
      'SELECT * FROM estimate_template_items WHERE template_id = $1 ORDER BY sort_order, id',
      [tpl.id]
    );
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM estimate_items WHERE report_id = $1',
      [report.id]
    );
    let sort = maxRows[0].m + 1;
    for (const it of titems) {
      await db.query(
        `INSERT INTO estimate_items (report_id, section, description, kind, qty, unit, unit_price, optional, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          report.id,
          it.section,
          it.description,
          it.kind,
          Number(it.qty || 0),
          it.unit,
          Number(it.unit_price || 0),
          Boolean(it.optional),
          sort,
        ]
      );
      sort += 1;
    }
    const sets = [];
    const vals = [];
    for (const col of ['scope_text', 'exclusions_text', 'terms_text']) {
      if (!String(report[col] || '').trim() && String(tpl[col] || '').trim()) {
        vals.push(tpl[col]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (sets.length) {
      vals.push(report.id);
      await db.query(`UPDATE reports SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    if (titems.length || sets.length) await touchReport(report.id);
    return res.json({ ok: true, added: titems.length });
  })
);

/* Update an estimate template from the Templates page: rename, edit
   the three texts, and/or replace its item rows wholesale. */
router.put(
  '/estimate-templates/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows: trows } = await db.query(
      'SELECT * FROM estimate_templates WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!trows.length) return res.status(404).json({ error: 'Template not found.' });
    const tpl = trows[0];
    const name = String(req.body.name ?? tpl.name).trim();
    if (!name) return res.status(400).json({ error: 'Give the template a name.' });
    let items = null;
    if (Array.isArray(req.body.items)) {
      items = req.body.items.map(cleanTemplateItem);
      if (!items.length) {
        return res.status(400).json({ error: 'Add at least one line item first.' });
      }
    }
    await db.query(
      `UPDATE estimate_templates
          SET name = $1, scope_text = $2, exclusions_text = $3, terms_text = $4
        WHERE id = $5`,
      [
        name,
        String(req.body.scopeText ?? req.body.scope_text ?? tpl.scope_text),
        String(req.body.exclusionsText ?? req.body.exclusions_text ?? tpl.exclusions_text),
        String(req.body.termsText ?? req.body.terms_text ?? tpl.terms_text),
        tpl.id,
      ]
    );
    if (items) {
      await db.query('DELETE FROM estimate_template_items WHERE template_id = $1', [tpl.id]);
      await insertTemplateItems(tpl.id, items);
    }
    const { rows: saved } = await db.query(
      'SELECT * FROM estimate_template_items WHERE template_id = $1 ORDER BY sort_order, id',
      [tpl.id]
    );
    const { rows: updated } = await db.query('SELECT * FROM estimate_templates WHERE id = $1', [
      tpl.id,
    ]);
    return res.json({
      template: {
        ...updated[0],
        items: saved.map(shapeEstimateItem),
        itemCount: saved.length,
      },
    });
  })
);

router.delete(
  '/estimate-templates/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rowCount } = await db.query(
      'DELETE FROM estimate_templates WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Template not found.' });
    return res.json({ ok: true });
  })
);

/* Convert an estimate into a NEW Job Report: same client/property,
   each non-optional line item becomes a finding priced at its line
   total. The estimate itself is left untouched. */
router.post(
  '/reports/:id/convert-to-job',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (report.doc_type !== 'estimate') {
      return res.status(400).json({ error: 'Only an estimate can be converted to a job report.' });
    }
    const { rows: items } = await db.query(
      'SELECT * FROM estimate_items WHERE report_id = $1 ORDER BY sort_order, id',
      [report.id]
    );
    const billable = items.filter((it) => !it.optional);
    if (!billable.length) {
      return res.status(400).json({ error: 'Add at least one line item first.' });
    }
    const { rows } = await db.query(
      `INSERT INTO reports (user_id, address, client_name, client_email, client_phone,
                            inspection_date, inspector_name, doc_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'job') RETURNING id`,
      [
        req.user.id,
        report.address,
        report.client_name,
        report.client_email,
        report.client_phone,
        report.inspection_date,
        report.inspector_name,
      ]
    );
    const newId = rows[0].id;
    await db.query('UPDATE reports SET estimate_number = $1 WHERE id = $2', [
      `EST-${String(newId).padStart(4, '0')}`,
      newId,
    ]);
    const { rows: fields } = await db.query(
      'SELECT * FROM custom_fields WHERE report_id = $1 ORDER BY sort_order, id',
      [report.id]
    );
    for (let i = 0; i < fields.length; i += 1) {
      await db.query(
        'INSERT INTO custom_fields (report_id, name, value, sort_order) VALUES ($1, $2, $3, $4)',
        [newId, fields[i].name, fields[i].value, i]
      );
    }
    for (let i = 0; i < billable.length; i += 1) {
      const it = billable[i];
      await db.query(
        `INSERT INTO findings (report_id, area, title, detail, severity, cost, sort_order)
         VALUES ($1, $2, $3, $4, 'Monitor', $5, $6)`,
        [
          newId,
          it.section || 'General',
          it.description || 'Line item',
          '',
          Number(it.qty || 0) * Number(it.unit_price || 0),
          i,
        ]
      );
    }
    const data = await fullReport(req.user.id, newId);
    return res.status(201).json(data);
  })
);

/* ------------------------------------------------------------------ */
/* Estimate sharing (Phase 1b): owner side. The public page itself     */
/* lives in server/share.js (GET /s/:token).                           */
/* ------------------------------------------------------------------ */

/* Turn the public share link on/off. The token is generated lazily on
   first enable and then stays stable, so a link the owner already sent
   keeps working across off/on toggles. */
router.post(
  '/reports/:id/share',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const enabled = Boolean(req.body && req.body.enabled);
    let token = report.share_token || null;
    if (enabled && !token) {
      token = crypto.randomBytes(24).toString('base64url');
    }
    await db.query('UPDATE reports SET share_enabled = $1, share_token = $2 WHERE id = $3', [
      enabled,
      token,
      report.id,
    ]);
    await touchReport(report.id);
    return res.json({
      share_token: token,
      share_enabled: enabled,
      share_path: token ? `/s/${token}` : null,
    });
  })
);

/* Owner marks the estimate as sent (they deliver the link themselves,
   by text or email). Only draft/declined move to 'sent' — a viewed or
   approved estimate keeps its further-along status. */
router.post(
  '/reports/:id/mark-sent',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (['draft', 'declined'].includes(report.estimate_status || 'draft')) {
      await db.query("UPDATE reports SET estimate_status = 'sent' WHERE id = $1", [report.id]);
      await touchReport(report.id);
    }
    const data = await fullReport(req.user.id, report.id);
    return res.json(data);
  })
);

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

router.post(
  '/reports/:id/findings',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM findings WHERE report_id = $1',
      [report.id]
    );
    const b = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO findings (report_id, area, title, detail, severity, cost, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        report.id,
        String(b.area || 'General'),
        String(b.title || 'New finding'),
        String(b.detail || ''),
        ai.SEVERITIES.includes(b.severity) ? b.severity : 'Monitor',
        Number(b.cost) || 0,
        maxRows[0].m + 1,
      ]
    );
    await touchReport(report.id);
    return res.status(201).json({ finding: shapeFinding(await byId('findings', rows[0].id)) });
  })
);

async function ownFinding(userId, findingId) {
  const { rows } = await db.query(
    `SELECT f.* FROM findings f
       JOIN reports r ON r.id = f.report_id
      WHERE f.id = $1 AND r.user_id = $2`,
    [findingId, userId]
  );
  return rows[0] || null;
}

router.put(
  '/findings/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const finding = await ownFinding(req.user.id, req.params.id);
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    const b = req.body || {};
    await db.query(
      `UPDATE findings SET area = $1, title = $2, detail = $3, severity = $4, cost = $5
        WHERE id = $6`,
      [
        String(b.area ?? finding.area),
        String(b.title ?? finding.title),
        String(b.detail ?? finding.detail),
        ai.SEVERITIES.includes(b.severity) ? b.severity : finding.severity,
        b.cost !== undefined ? Number(b.cost) || 0 : Number(finding.cost),
        finding.id,
      ]
    );
    await touchReport(finding.report_id);
    return res.json({ finding: shapeFinding(await byId('findings', finding.id)) });
  })
);

router.delete(
  '/findings/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const finding = await ownFinding(req.user.id, req.params.id);
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    await db.query('DELETE FROM findings WHERE id = $1', [finding.id]);
    await touchReport(finding.report_id);
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* AI actions                                                          */
/* ------------------------------------------------------------------ */

router.post(
  '/reports/:id/structure',
  auth.requireAuth,
  wrap(async (req, res) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const notes = String(req.body.notes || '').trim();
    if (!notes) return res.status(400).json({ error: 'Write some field notes first.' });
    const drafts = await ai.structureNotes(notes);
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM findings WHERE report_id = $1',
      [report.id]
    );
    let order = maxRows[0].m;
    const created = [];
    for (const draft of drafts) {
      order += 1;
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await db.query(
        `INSERT INTO findings (report_id, area, title, detail, severity, cost, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [report.id, draft.area, draft.title, draft.detail, draft.severity, draft.cost, order]
      );
      // eslint-disable-next-line no-await-in-loop
      created.push(shapeFinding(await byId('findings', rows[0].id)));
    }
    await touchReport(report.id);
    return res.status(201).json({ findings: created, aiUsed: ai.aiConfigured() });
  })
);

router.post(
  '/findings/:id/polish',
  auth.requireAuth,
  wrap(async (req, res) => {
    const finding = await ownFinding(req.user.id, req.params.id);
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    const polished = await ai.polishFinding({
      title: String(req.body.title ?? finding.title),
      detail: String(req.body.detail ?? finding.detail),
    });
    await db.query('UPDATE findings SET title = $1, detail = $2 WHERE id = $3', [
      polished.title,
      polished.detail,
      finding.id,
    ]);
    await touchReport(finding.report_id);
    return res.json({
      finding: shapeFinding(await byId('findings', finding.id)),
      aiUsed: ai.aiConfigured(),
    });
  })
);

router.post(
  '/reports/:id/summarize',
  auth.requireAuth,
  wrap(async (req, res) => {
    const data = await fullReport(req.user.id, req.params.id);
    if (!data) return res.status(404).json({ error: 'Report not found.' });
    const summary = await ai.summarizeReport(data.report, data.findings);
    await db.query('UPDATE reports SET summary = $1, updated_at = now() WHERE id = $2', [
      summary,
      data.report.id,
    ]);
    return res.json({ summary, aiUsed: ai.aiConfigured() });
  })
);

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

router.post(
  '/reports/:id/photos',
  auth.requireAuth,
  wrap(async (req, res, next) => {
    const report = await ownReport(req.user.id, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    req.reportForUpload = report;
    return next();
  }),
  upload.array('photos', 20),
  wrap(async (req, res) => {
    const report = req.reportForUpload;
    let findingId = req.body.findingId ? Number(req.body.findingId) : null;
    if (findingId) {
      const f = await ownFinding(req.user.id, findingId);
      if (!f || f.report_id !== report.id) findingId = null;
    }
    const saved = [];
    for (const file of req.files || []) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await db.query(
        `INSERT INTO photos (report_id, finding_id, filename, original_name, mime, size)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [report.id, findingId, file.filename, file.originalname || '', file.mimetype, file.size]
      );
      // eslint-disable-next-line no-await-in-loop
      saved.push(shapePhoto(await byId('photos', rows[0].id)));
    }
    await touchReport(report.id);
    return res.status(201).json({ photos: saved });
  })
);

router.get(
  '/photos/:id/file',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.* FROM photos p
         JOIN reports r ON r.id = p.report_id
        WHERE p.id = $1 AND r.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Photo not found.' });
    const filePath = path.join(UPLOAD_DIR, path.basename(rows[0].filename));
    return res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Photo file is missing.' });
    });
  })
);

router.delete(
  '/photos/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.id, p.filename, p.report_id FROM photos p
         JOIN reports r ON r.id = p.report_id
        WHERE p.id = $1 AND r.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Photo not found.' });
    await db.query('DELETE FROM photos WHERE id = $1', [rows[0].id]);
    // If the deleted photo was the report's cover, clear the cover.
    await db.query('UPDATE reports SET cover_photo_id = NULL WHERE cover_photo_id = $1', [rows[0].id]);
    await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(rows[0].filename))).catch(() => {});
    await touchReport(rows[0].report_id);
    return res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Sample job                                                          */
/* ------------------------------------------------------------------ */

const SAMPLE = {
  address: '123 Maple St, Austin, TX 78701',
  client_name: 'Jordan Miller',
  client_email: 'jordan.miller@example.com',
  client_phone: '(512) 555-0147',
  inspector_name: 'Alex Carter, Licensed Inspector',
  summary:
    'A home inspection was completed at 123 Maple St, Austin, TX 78701. 4 findings were documented, ' +
    'including 2 urgent items that should be addressed promptly: an active leak under the kitchen sink ' +
    'and damaged roof shingles on the north slope. The total estimated cost of recommended repairs is ' +
    '$1,590. See the findings below for details, severity ratings, and photos for each item.',
  customFields: [
    { name: 'Gate code', value: '4821' },
    { name: 'HOA', value: 'Maple Grove HOA' },
  ],
  findings: [
    {
      area: 'Kitchen',
      title: 'Active leak under kitchen sink',
      detail:
        'Active water leak observed at the P-trap under the kitchen sink. The cabinet base shows moisture ' +
        'damage and staining. Recommend repair by a licensed plumber and drying the cabinet to prevent mold growth.',
      severity: 'Urgent',
      cost: 450,
    },
    {
      area: 'Roof',
      title: 'Damaged asphalt shingles on north slope',
      detail:
        'Multiple asphalt shingles on the north slope are cracked and lifting, exposing the underlayment. ' +
        'Recommend repair by a roofing contractor to prevent water intrusion.',
      severity: 'Urgent',
      cost: 780,
    },
    {
      area: 'Electrical',
      title: 'Double-tapped breaker in main panel',
      detail:
        'One breaker in the main electrical panel is double-tapped (two conductors on a single lug), which ' +
        'is not permitted for this panel. Recommend correction by a licensed electrician.',
      severity: 'Repair',
      cost: 260,
    },
    {
      area: 'HVAC',
      title: 'Furnace filter overdue for replacement',
      detail:
        'The furnace filter is heavily loaded with dust and overdue for replacement. No other defects were ' +
        'observed with the heating system. Recommend replacing the filter and monitoring airflow.',
      severity: 'Monitor',
      cost: 100,
    },
  ],
};

router.post(
  '/reports/sample',
  auth.requireAuth,
  wrap(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `INSERT INTO reports (user_id, address, client_name, client_email, client_phone, inspection_date, inspector_name, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        req.user.id,
        SAMPLE.address,
        SAMPLE.client_name,
        SAMPLE.client_email,
        SAMPLE.client_phone,
        today,
        SAMPLE.inspector_name,
        SAMPLE.summary,
      ]
    );
    const report = await byId('reports', rows[0].id);
    for (let i = 0; i < SAMPLE.customFields.length; i += 1) {
      const f = SAMPLE.customFields[i];
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        'INSERT INTO custom_fields (report_id, name, value, sort_order) VALUES ($1, $2, $3, $4)',
        [report.id, f.name, f.value, i]
      );
    }
    for (let i = 0; i < SAMPLE.findings.length; i += 1) {
      const f = SAMPLE.findings[i];
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `INSERT INTO findings (report_id, area, title, detail, severity, cost, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [report.id, f.area, f.title, f.detail, f.severity, f.cost, i]
      );
    }
    const data = await fullReport(req.user.id, report.id);
    return res.status(201).json(data);
  })
);

module.exports = router;
