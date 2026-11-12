'use strict';

/**
 * Public estimate share page (Phase 1b): GET /s/:token renders the
 * estimate as a read-only document — the same markup/classes the app
 * preview uses, so a client opening the link sees the same estimate
 * the owner sees (and the PDF prints). No login. The page records
 * views, and the client can approve (typing their name, optionally
 * ticking optional line items) or decline right on the page.
 *
 * The stored document totals are NEVER recomputed here: the optional
 * items a client ticks are recorded with the approval
 * (approved_optionals) and shown to the owner, nothing more.
 */

const db = require('./db');

/* Report design themes (mirror routes.js REPORT_TEMPLATES): the share
   page renders the same .report.tpl-* classes as the app preview. */
const SHARE_TEMPLATES = ['corporate', 'minimal', 'clean', 'editorial', 'dark'];

/* --- helpers (mirror app.js so the page matches the preview) ------- */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function moneyC(n) {
  return `$${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function lineTotal(it) {
  return round2(Number(it.qty || 0) * Number(it.unit_price || 0));
}

function estimateTotals(items, report) {
  const list = items || [];
  const subtotal = round2(list.filter((i) => !i.optional).reduce((s, i) => s + lineTotal(i), 0));
  const optionalSubtotal = round2(
    list.filter((i) => i.optional).reduce((s, i) => s + lineTotal(i), 0)
  );
  const dv = Number(report.discount_value || 0);
  const discount = round2(
    report.discount_type === 'amt' ? Math.min(dv, subtotal) : (subtotal * dv) / 100
  );
  const taxable = round2(subtotal - discount);
  const taxRate = Number(report.tax_rate || 0);
  const tax = round2((taxable * taxRate) / 100);
  const total = round2(taxable + tax);
  const depositPct = Number(report.deposit_pct || 0);
  const deposit = round2((total * depositPct) / 100);
  return { subtotal, optionalSubtotal, discount, taxable, taxRate, tax, total, depositPct, deposit };
}

function estimateSections(items) {
  const order = [];
  const map = new Map();
  for (const it of items || []) {
    const name = it.section || '';
    if (!map.has(name)) {
      map.set(name, []);
      order.push(name);
    }
    map.get(name).push(it);
  }
  return order.map((name) => ({ name, items: map.get(name) }));
}

/* Mirrors app.js estimateValidUntil. */
function estimateValidUntil(report) {
  const days = Number(report.valid_days || 0);
  if (!days) return null;
  const base = report.inspection_date
    ? new Date(`${String(report.inspection_date).slice(0, 10)}T12:00:00`)
    : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

const KIND_LABEL = { labor: 'Labor', material: 'Material', item: 'Item' };

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shapeItem(row) {
  return {
    ...row,
    qty: Number(row.qty || 0),
    unit_price: Number(row.unit_price || 0),
    optional: Boolean(row.optional),
  };
}

function parseOptionals(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch (_) {
    return [];
  }
}

/* --- data ------------------------------------------------------------ */

async function loadShare(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await db.query('SELECT * FROM reports WHERE share_token = $1', [token]);
  const report = rows[0];
  if (!report || !report.share_enabled) return null;
  const [itemRows, fieldRows, userRows] = await Promise.all([
    db.query('SELECT * FROM estimate_items WHERE report_id = $1 ORDER BY sort_order, id', [
      report.id,
    ]),
    db.query('SELECT * FROM custom_fields WHERE report_id = $1 ORDER BY sort_order, id', [
      report.id,
    ]),
    db.query(
      'SELECT email, full_name, company_name, phone, company_address FROM users WHERE id = $1',
      [report.user_id]
    ),
  ]);
  const u = userRows.rows[0] || {};
  return {
    report,
    items: itemRows.rows.map(shapeItem),
    customFields: fieldRows.rows,
    profile: {
      email: u.email || '',
      fullName: u.full_name || '',
      companyName: u.company_name || '',
      phone: u.phone || '',
      companyAddress: u.company_address || '',
    },
  };
}

/* Count a view: bump the counter, stamp the first view, and move a
   Sent estimate to Viewed. The owner's own visits (signed-in session
   for the same account) don't count. */
async function recordView(req, report) {
  if (req.user && req.user.id === report.user_id) return;
  await db.query(
    `UPDATE reports
        SET view_count = view_count + 1,
            viewed_at = COALESCE(viewed_at, now()),
            estimate_status = CASE WHEN estimate_status = 'sent' THEN 'viewed' ELSE estimate_status END
      WHERE id = $1`,
    [report.id]
  );
}

/* --- rendering --------------------------------------------------------- */

function companyBlockHtml(report, profile) {
  const coName = profile.companyName || report.inspector_name || profile.fullName || '';
  const coLine = [profile.companyAddress, profile.phone, profile.email]
    .filter((v) => v && String(v).trim())
    .join(' · ');
  if (!coName && !coLine) return '';
  return `<div class="report-company">${coName ? `<p class="rc-name">${esc(coName)}</p>` : ''}${coLine ? `<p class="rc-line">${esc(coLine)}</p>` : ''}</div>`;
}

/* Tiny "Powered by" credit at the very bottom of the public page: the
   page carries the PRO's own branding, so our mark is only this small
   footer line (icon + text) linked to the landing page — the big logo
   that used to sit at the top was removed on the founder's call
   (2026-11-05). */
function footerCreditHtml() {
  return `<p class="share-credit"><a href="https://inspect-report.com/" target="_blank" rel="noopener"><img src="/assets/logo-icon.png" alt="" />Powered by InspectReport AI</a></p>`;
}

/* Approved banner: page chrome at the very top of the main content,
   shown only once the client has approved — the approval line down in
   the document's signature area is easy to miss, so the founder asked
   for an unmistakable band above the document too (2026-11-05). The
   document itself is unchanged. */
function approvedBannerHtml(report) {
  return `
  <div class="approved-banner">
    <p class="approved-banner-title"><span class="approved-banner-check">✓</span> Approved</p>
    <p class="approved-banner-sub">Approved by ${esc(report.approved_name || '')} · ${esc(fmtDate(report.approved_at))}</p>
  </div>`;
}

function notFoundPage(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Link not available — InspectReport AI</title>
<link rel="stylesheet" href="/styles.css" />
<link rel="icon" type="image/png" href="/assets/favicon.png" />
</head>
<body>
<main class="share-wrap">
  <div class="card share-missing">
    <h1>This link isn't available</h1>
    <p class="muted">The estimate link may have been turned off, or the address is incomplete. Please contact the sender for a fresh link.</p>
  </div>
  ${footerCreditHtml()}
</main>
</body>
</html>`);
}

function renderSharePage(data, opts = {}) {
  const { report, items, customFields, profile } = data;
  const token = report.share_token;
  const t = estimateTotals(items, report);
  const validUntil = estimateValidUntil(report);
  const approved = Boolean(report.approved_at);
  const selectedIds = parseOptionals(report.approved_optionals);
  const selectedSet = new Set(selectedIds);
  const rows = [
    ['Client', report.client_name || '—'],
    ['Date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
    ['Prepared by', report.inspector_name || '—'],
    ['Client email', report.client_email || '—'],
    ['Client phone', report.client_phone || '—'],
    ...(report.estimate_number ? [['Estimate #', report.estimate_number]] : []),
    ...(validUntil ? [['Valid until', validUntil]] : []),
    ...customFields.map((f) => [f.name || 'Field', f.value || '—']),
  ];
  const itemRow = (it, pickable) => `
            <div class="r-item">
              ${
                pickable
                  ? `<label class="opt-pick" title="Include this optional item"><input type="checkbox" name="opt" value="${it.id}" /></label>`
                  : ''
              }
              <div class="r-main">
                <div class="r-line"><b>${esc(it.description || 'Line item')}</b>${
                  approved && it.optional && selectedSet.has(it.id)
                    ? '<span class="pill pill-good">✓ Included</span>'
                    : ''
                }<span class="est-amt">${moneyC(lineTotal(it))}</span></div>
                <p class="r-detail">${esc(KIND_LABEL[it.kind] || 'Item')} · ${Number(it.qty || 0)}${it.unit ? ` ${esc(it.unit)}` : ''} × ${moneyC(it.unit_price)}</p>
              </div>
            </div>`;
  const sections = estimateSections(items);
  const billableSections = sections
    .map((sec) => ({ name: sec.name, items: sec.items.filter((i) => !i.optional) }))
    .filter((sec) => sec.items.length);
  const optionalItems = items.filter((i) => i.optional);

  const bodySections = billableSections.length
    ? billableSections
        .map(
          (sec) => `
        ${sec.name ? `<h3>${esc(sec.name)}</h3>` : ''}
        ${sec.items.map((it) => itemRow(it, false)).join('')}`
        )
        .join('')
    : '<p class="r-empty">No line items yet.</p>';

  const optionalBlock = optionalItems.length
    ? `
        <h3>Optional — not included in total${approved ? '' : ' (tick the ones you want, then approve below)'}</h3>
        ${optionalItems.map((it) => itemRow(it, !approved)).join('')}
        <p class="est-opt-total">Optional subtotal: ${moneyC(t.optionalSubtotal)}</p>`
    : '';

  const totalsBlock = `
        <div class="est-totals">
          <div><span>Subtotal</span><b>${moneyC(t.subtotal)}</b></div>
          ${t.discount ? `<div><span>Discount</span><b>−${moneyC(t.discount)}</b></div>` : ''}
          ${t.tax ? `<div><span>Tax (${t.taxRate}%)</span><b>${moneyC(t.tax)}</b></div>` : ''}
          <div class="est-grand"><span>Total</span><b>${moneyC(t.total)}</b></div>
          ${t.deposit ? `<div><span>Deposit due to schedule (${t.depositPct}%)</span><b>${moneyC(t.deposit)}</b></div>` : ''}
        </div>`;

  const textsBlock = `
        ${report.scope_text ? `<h3>Scope of work</h3><p class="est-text">${esc(report.scope_text)}</p>` : ''}
        ${report.exclusions_text ? `<h3>Exclusions</h3><p class="est-text">${esc(report.exclusions_text)}</p>` : ''}
        ${report.terms_text ? `<h3>Terms</h3><p class="est-text">${esc(report.terms_text)}</p>` : ''}`;

  let approvalBlock;
  if (approved) {
    const chosen = optionalItems.filter((it) => selectedSet.has(it.id));
    approvalBlock = `
        <div class="approve-done">
          <p class="approve-line">✓ Approved by <b>${esc(report.approved_name || '')}</b> on ${esc(fmtDate(report.approved_at))}</p>
          ${
            chosen.length
              ? `<p class="approve-opts">Optional items included: ${chosen
                  .map((it) => esc(it.description || 'Line item'))
                  .join(', ')}</p>`
              : ''
          }
        </div>`;
  } else {
    approvalBlock = `
        <div class="approve-box">
          <h3>Approve this estimate</h3>
          ${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
          ${
            report.estimate_status === 'declined'
              ? '<p class="muted">You declined this estimate earlier — if that was a mistake, you can still approve it here.</p>'
              : ''
          }
          <label class="field"><span>Your full name</span>
            <input type="text" name="customer_name" required maxlength="120" placeholder="e.g. Jordan Miller" autocomplete="name" /></label>
          <button type="submit" class="btn btn-amber btn-big btn-block">Approve this estimate</button>
          <p class="muted small">Approving means you agree to the scope, exclusions and terms above. Optional items are only included if you ticked them.</p>
        </div>`;
  }

  const actionableBody = approved
    ? `${optionalBlock}${totalsBlock}${textsBlock}${approvalBlock}`
    : `<form method="POST" action="/s/${esc(token)}/approve">${optionalBlock}${totalsBlock}${textsBlock}${approvalBlock}</form>`;

  const declineBlock = approved
    ? ''
    : `
      <form class="decline-form" method="POST" action="/s/${esc(token)}/decline">
        <span class="muted small">Not going ahead?</span>
        <input type="text" name="reason" maxlength="500" placeholder="Reason (optional)" />
        <button type="submit" class="btn btn-ghost btn-sm">Decline this estimate</button>
      </form>`;

  const companyName = profile.companyName || report.inspector_name || 'InspectReport AI';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<meta name="color-scheme" content="light" />
<title>Estimate ${esc(report.estimate_number || '')} — ${esc(companyName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css" />
<link rel="icon" type="image/png" href="/assets/favicon.png" />
</head>
<body>
<main class="share-wrap">${approved ? approvedBannerHtml(report) : ''}
  <article class="report tpl-${esc(SHARE_TEMPLATES.includes(report.template) ? report.template : 'corporate')}">
    <div class="report-head">
      <span class="badge">${esc(String(report.badge_text || '').trim() || 'ESTIMATE')}</span>
      <h1>${esc(report.address || 'Estimate')}</h1>
    </div>
    <div class="report-body">
      <dl class="meta">
        ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
      ${companyBlockHtml(report, profile)}
      ${bodySections}
      ${actionableBody}
    </div>
  </article>
  ${declineBlock}
  <p class="share-foot muted small">This page is a private link — please don't forward it.</p>
  ${footerCreditHtml()}
</main>
</body>
</html>`;
}

/* --- handlers ------------------------------------------------------------ */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const page = wrap(async (req, res) => {
  const data = await loadShare(req.params.token);
  if (!data) return notFoundPage(res);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  await recordView(req, data.report);
  return res.send(renderSharePage(data));
});

const approve = wrap(async (req, res) => {
  const data = await loadShare(req.params.token);
  if (!data) return notFoundPage(res);
  const { report, items } = data;
  if (report.approved_at) return res.redirect(303, `/s/${report.share_token}`);
  const name = String((req.body && req.body.customer_name) || '').trim().slice(0, 120);
  if (!name) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res
      .status(400)
      .send(renderSharePage(data, { error: 'Please type your full name to approve.' }));
  }
  const optionalIds = new Set(items.filter((i) => i.optional).map((i) => i.id));
  let chosen = (req.body && req.body.opt) || [];
  if (!Array.isArray(chosen)) chosen = [chosen];
  const selected = [
    ...new Set(chosen.map((v) => Number(v)).filter((id) => optionalIds.has(id))),
  ];
  await db.query(
    `UPDATE reports
        SET approved_name = $1, approved_at = now(), approved_optionals = $2,
            estimate_status = 'approved'
      WHERE id = $3`,
    [name, JSON.stringify(selected), report.id]
  );
  return res.redirect(303, `/s/${report.share_token}`);
});

const decline = wrap(async (req, res) => {
  const data = await loadShare(req.params.token);
  if (!data) return notFoundPage(res);
  const { report } = data;
  if (report.approved_at) return res.redirect(303, `/s/${report.share_token}`);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  await db.query(
    `UPDATE reports
        SET estimate_status = 'declined', declined_at = now(), declined_reason = $1
      WHERE id = $2`,
    [reason || null, report.id]
  );
  return res.redirect(303, `/s/${report.share_token}`);
});

module.exports = { page, approve, decline, loadShare, renderSharePage };
