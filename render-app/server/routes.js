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
  const [fields, findingRows, photoRows] = await Promise.all([
    db.query('SELECT * FROM custom_fields WHERE report_id = $1 ORDER BY sort_order, id', [reportId]),
    db.query('SELECT * FROM findings WHERE report_id = $1 ORDER BY sort_order, id', [reportId]),
    db.query('SELECT * FROM photos WHERE report_id = $1 ORDER BY id', [reportId]),
  ]);
  const findings = findingRows.rows.map(shapeFinding);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const photos = photoRows.rows.map(shapePhoto);
  for (const photo of photos) {
    const f = photo.finding_id != null ? byId.get(photo.finding_id) : null;
    if (f) f.photos.push(photo);
  }
  return { report, customFields: fields.rows, findings, photos };
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
/* Billing                                                             */
/* ------------------------------------------------------------------ */

router.get(
  '/billing',
  wrap(async (req, res) => {
    let subscribed = false;
    let subscribedVia = null;
    let isAdmin = false;
    if (req.user) {
      const row = await access.userById(req.user.id);
      ({ subscribed, subscribedVia } = access.subscriptionState(row || req.user));
      isAdmin = access.isAdminEmail(req.user.email);
    }
    res.json({
      planName: 'InspectReport AI',
      priceMonthly: 49,
      paymentLinkUrl: process.env.PAYMENT_LINK_URL || null,
      aiEnabled: ai.aiConfigured(),
      subscribed,
      subscribedVia,
      isAdmin,
    });
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
  const email = emailFromEventObject(obj);
  if (!email) {
    // Subscription objects carry a customer id, not an email, and without
    // a Stripe API key we cannot resolve it — log and move on.
    console.warn(
      `[stripe] ${eventType}: no customer email on event object (customer=${(obj && obj.customer) || 'n/a'}); no user updated.`
    );
    return;
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
  } else if (eventType === 'customer.subscription.deleted') {
    subscribed = false;
  }
  if (subscribed === null) return;
  const existing = await access.userByEmail(email);
  if (!existing) {
    console.warn(`[stripe] ${eventType}: no InspectReport account for ${email}; event acknowledged only.`);
    return;
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
    }
    res.json({
      reports: reports.map((r) => ({
        ...r,
        ...(stats.get(r.id) || { finding_count: 0, urgent_count: 0, total_cost: 0 }),
      })),
    });
  })
);

router.post(
  '/reports',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      'INSERT INTO reports (user_id) VALUES ($1) RETURNING id',
      [req.user.id]
    );
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
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_fields WHERE report_id = $1',
      [report.id]
    );
    const { rows } = await db.query(
      'INSERT INTO custom_fields (report_id, name, value, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [report.id, String(req.body.name || ''), String(req.body.value || ''), maxRows[0].m + 1]
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
  '/templates',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM field_templates WHERE user_id = $1 ORDER BY id',
      [req.user.id]
    );
    res.json({ templates: rows });
  })
);

router.post(
  '/templates',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rows } = await db.query(
      'INSERT INTO field_templates (user_id, name, value) VALUES ($1, $2, $3) RETURNING id',
      [req.user.id, String(req.body.name || ''), String(req.body.value || '')]
    );
    res.status(201).json({ template: await byId('field_templates', rows[0].id) });
  })
);

router.put(
  '/templates/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rowCount } = await db.query(
      'UPDATE field_templates SET name = $1, value = $2 WHERE id = $3 AND user_id = $4',
      [String(req.body.name || ''), String(req.body.value || ''), req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Template not found.' });
    return res.json({ template: await byId('field_templates', Number(req.params.id)) });
  })
);

router.delete(
  '/templates/:id',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { rowCount } = await db.query(
      'DELETE FROM field_templates WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Template not found.' });
    return res.json({ ok: true });
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
