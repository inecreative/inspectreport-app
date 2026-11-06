'use strict';

/* InspectReport AI — single-page frontend (vanilla JS). */

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  billing: null,
  profile: null,
  templates: [],
  estTemplates: [],
  priceBook: [],
  current: null, // { report, customFields, findings, photos, estimateItems }
  authMode: 'login', // or 'signup'
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/* Estimates are priced to the cent (labor rates, materials), unlike
   finding costs which round to whole dollars. */
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

/* Canonical estimate math — pdf.js duplicates this exactly so the
   printed estimate always matches the preview. Optional items are
   quoted separately and NEVER counted in the total. */
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

/* Group line items by section name, in first-appearance order. */
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

const KIND_LABEL = { labor: 'Labor', material: 'Material', item: 'Item' };

/* Commercial pack (Phase 2): findings can carry a cost horizon; when at
   least one finding has a horizon AND a cost, the report gains a CAPEX
   summary bucketing those costs by horizon. pdf.js duplicates this
   math exactly (pdfCapexSummary) so the PDF matches the preview. */
const CAPEX_BUCKETS = [
  { key: 'immediate', label: 'Immediate' },
  { key: '1-3', label: '1–3 years' },
  { key: '3-5', label: '3–5 years' },
  { key: '5-10', label: '5–10 years' },
];

function capexSummary(findings) {
  const sums = { immediate: 0, '1-3': 0, '3-5': 0, '5-10': 0 };
  let any = false;
  for (const f of findings || []) {
    const cost = Number(f.cost || 0);
    if (f.horizon && sums[f.horizon] !== undefined && cost > 0) {
      sums[f.horizon] += cost;
      any = true;
    }
  }
  if (!any) return null;
  const rows = CAPEX_BUCKETS.filter((b) => sums[b.key] > 0).map((b) => ({
    key: b.key,
    label: b.label,
    amount: round2(sums[b.key]),
  }));
  return { rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) };
}

/* --- Autosave status -----------------------------------------------
   There is no Save button anywhere in the editor — every field saves on
   change. The indicator in the editor header reflects REAL request
   state: it flips to "Saving…" while any mutating request is in flight,
   to "✓ Saved <time>" when the last one succeeds, and to a warning when
   one fails. The photo uploads (raw fetch, below) report through the
   same counters. */
let savePending = 0;

function paintSaveStatus(kind, text) {
  const el = $('#saveStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-saving', kind === 'saving');
  el.classList.toggle('is-saved', kind === 'saved');
  el.classList.toggle('is-error', kind === 'error');
}

function noteSaveStart() {
  savePending += 1;
  paintSaveStatus('saving', 'Saving…');
}

function noteSaveDone() {
  savePending = Math.max(0, savePending - 1);
  if (savePending > 0) return;
  const t = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  paintSaveStatus('saved', `✓ All changes saved · ${t}`);
}

function noteSaveError() {
  savePending = Math.max(0, savePending - 1);
  if (savePending > 0) return;
  paintSaveStatus('error', '⚠ Could not save — check your connection');
}

function resetSaveStatus() {
  savePending = 0;
  paintSaveStatus('', 'All changes save automatically');
}

async function api(path, options = {}) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
    String(options.method || 'GET').toUpperCase()
  );
  if (mutating) noteSaveStart();
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* no body */
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    if (mutating) noteSaveDone();
    return data;
  } catch (err) {
    if (mutating) noteSaveError();
    throw err;
  }
}

/* ---------------------------------------------------------------- */
/* Auth                                                              */
/* ---------------------------------------------------------------- */

function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#userArea').classList.add('hidden');
  updatePdfButton();
}

function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userArea').classList.remove('hidden');
  $('#userEmail').textContent = state.user.email;
}

async function initAuth() {
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    showApp();
    await loadBilling();
    await fetchProfile();
    await loadReports();
    await loadEstTemplates();
    await loadPriceBook();
  } catch (_) {
    showAuth();
    // Landing page CTAs link here with ?mode=signup to start on the
    // create-account form instead of sign-in.
    if (new URLSearchParams(window.location.search).get('mode') === 'signup') {
      setAuthMode('signup');
    }
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('#authTitle').textContent = signup ? 'Create your account' : 'Sign in';
  $('#authSubmit').textContent = signup ? 'Create account' : 'Sign in';
  $('#authSwitchText').textContent = signup ? 'Already have an account?' : 'New here?';
  $('#authSwitch').textContent = signup ? 'Sign in' : 'Create an account';
  $('#authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('#authError').classList.add('hidden');
}

$('#authSwitch').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(state.authMode === 'login' ? 'signup' : 'login');
});

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const errBox = $('#authError');
  errBox.classList.add('hidden');
  try {
    const path = state.authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const { user } = await api(path, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    state.user = user;
    showApp();
    await loadBilling();
    await fetchProfile();
    await loadReports();
    await loadEstTemplates();
    await loadPriceBook();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.current = null;
  state.profile = null;
  $('#profileView').classList.add('hidden');
  $('#templatesView').classList.add('hidden');
  $('#editorView').classList.add('hidden');
  $('#listView').classList.remove('hidden');
  showAuth();
});

/* ---------------------------------------------------------------- */
/* Billing                                                           */
/* ---------------------------------------------------------------- */

async function loadBilling() {
  try {
    state.billing = await api('/api/billing');
  } catch (_) {
    state.billing = {
      priceMonthly: 9,
      paymentLinkUrl: null,
      subscribed: false,
      pdfAccess: false,
      inTrial: false,
      trialEndsAt: null,
      trialDaysLeft: 0,
      isAdmin: false,
    };
  }
  renderBilling();
  updatePdfButton();
}

function isSubscribed() {
  return Boolean(state.billing && state.billing.subscribed);
}

/* PDF export is unlocked by a subscription, a comp grant, or the free
   7-day trial every new account starts with. */
function hasPdfAccess() {
  const b = state.billing;
  if (!b) return false;
  if (typeof b.pdfAccess === 'boolean') return b.pdfAccess;
  return Boolean(b.subscribed || b.inTrial);
}

/* One-shot message shown at the top of the billing card after a
   subscribe/cancel action re-renders it. */
let billingFlash = '';

function billingHtml() {
  const b = state.billing || { priceMonthly: 9, paymentLinkUrl: null };
  const flash = billingFlash ? `<p class="small"><b>${esc(billingFlash)}</b></p>` : '';
  if (b.subscribed) {
    const viaNote =
      b.subscribedVia === 'comp'
        ? 'Complimentary access. All features unlocked, including PDF export.'
        : b.subscribedVia === 'stripe'
          ? 'Paid via Stripe. All features unlocked, including PDF export.'
          : 'Access granted. All features unlocked, including PDF export.';
    const cancelBlock =
      b.subscribedVia === 'comp'
        ? ''
        : b.cancelAtPeriodEnd
          ? `<p class="muted small">Cancellation scheduled — your plan stays active until the end of the current billing period, then PDF export turns off.</p>
             <div class="row-gap"><button class="btn btn-amber btn-sm" id="undoCancelBtn">Keep my subscription</button></div>
             <p class="small billing-status" aria-live="polite"></p>`
          : b.cancelRequestedAt
            ? `<p class="muted small">Cancellation requested on ${esc(String(b.cancelRequestedAt).slice(0, 10))} — we're processing it, and your access stays active until it completes.</p>
               <div class="row-gap"><button class="btn btn-amber btn-sm" id="undoCancelBtn">Keep my subscription</button></div>
               <p class="small billing-status" aria-live="polite"></p>`
            : `<div class="row-gap"><button class="btn btn-ghost btn-sm" id="cancelSubBtn">Cancel subscription</button></div>
               <p class="small billing-status" aria-live="polite"></p>`;
    return `
    <h2>Billing</h2>
    ${flash}
    <div class="billing-inner">
      <div>
        <div class="billing-price">Plan: Active <small>✓</small></div>
        <p class="muted">${viaNote}</p>
      </div>
      <div><span class="pill pill-good">Subscribed</span></div>
    </div>${cancelBlock}${adminBoxHtml(b)}`;
  }
  const button = b.paymentLinkUrl
    ? `<a class="btn btn-amber btn-big" href="${esc(b.paymentLinkUrl)}" target="_blank" rel="noopener">Subscribe — $${b.priceMonthly}/mo</a>`
    : `<button class="btn btn-amber btn-big" disabled>Subscribe — $${b.priceMonthly}/mo</button>
       <p class="muted small">Payments are not live yet — the Subscribe button activates once the payment link is configured.</p>`;
  const trialNote = b.inTrial
    ? `<p class="muted"><b>Free trial — ${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? '' : 's'} left.</b> Your trial includes full PDF export. After that, $${b.priceMonthly}/mo keeps PDF export.</p>`
    : '';
  return `
    <h2>Billing</h2>
    ${flash}
    <div class="billing-inner">
      <div>
        <div class="billing-price">$${b.priceMonthly}<small>/mo flat per account</small></div>
        ${trialNote}
        <p class="muted">Unlimited reports. No per-inspector fees, no promo pricing that doubles later.</p>
        <p class="muted small">Reports and the live preview are free — the plan unlocks PDF export.</p>
      </div>
      <div>${button}</div>
    </div>${adminBoxHtml(b)}`;
}

/* Admin-only: site stats + grant/revoke subscription access by email.
   Rendered solely when /api/billing says the signed-in user is an admin. */
function adminBoxHtml(b) {
  if (!b.isAdmin) return '';
  return `
    <div class="admin-box">
      <h3 class="admin-title">Site stats <small>(admin)</small></h3>
      <div class="admin-stats-body"><p class="muted small">Loading stats…</p></div>
      <h3 class="admin-title">Manage access <small>(admin)</small></h3>
      <p class="muted small">Grant or revoke subscription access by the email on the account.</p>
      <div class="row-gap">
        <input type="email" class="inline-input admin-email" placeholder="tester@example.com" />
        <button class="btn btn-amber btn-sm admin-grant">Grant access</button>
        <button class="btn btn-ghost btn-sm admin-revoke">Revoke</button>
      </div>
      <p class="small admin-status" aria-live="polite"></p>
    </div>`;
}

async function loadAdminStats(card) {
  const body = card.querySelector('.admin-stats-body');
  if (!body) return;
  try {
    const s = await api('/api/admin/stats');
    const recent = (s.recent || [])
      .slice(0, 5)
      .map((u) => `${esc(u.email)} (${String(u.created_at).slice(0, 10)})`)
      .join(' · ');
    body.innerHTML = `
      <div class="stats-row">
        <div class="stat"><div class="stat-num">${s.totalUsers}</div><div class="stat-label">Total signups</div></div>
        <div class="stat"><div class="stat-num">${s.new7d}</div><div class="stat-label">New · last 7 days</div></div>
        <div class="stat"><div class="stat-num">${s.subscribed}</div><div class="stat-label">Subscribed</div></div>
        <div class="stat"><div class="stat-num">${s.inTrial}</div><div class="stat-label">In free trial</div></div>
        <div class="stat"><div class="stat-num">${s.totalReports}</div><div class="stat-label">Reports created</div></div>
      </div>
      ${recent ? `<p class="muted small">Newest signups: ${recent}</p>` : ''}
      ${
        s.cancelRequests && s.cancelRequests.length
          ? `<p class="muted small"><b>Cancellation requests to process in Stripe:</b> ${s.cancelRequests
              .map((r) => `${esc(r.email)} (${esc(String(r.requestedAt).slice(0, 10))})`)
              .join(' · ')}</p>`
          : ''
      }`;
  } catch (err) {
    body.innerHTML = '<p class="muted small">Stats unavailable right now.</p>';
  }
}

async function adminAccess(card, grant) {
  const email = card.querySelector('.admin-email').value.trim();
  const status = card.querySelector('.admin-status');
  if (!email) {
    status.textContent = 'Enter the account email first.';
    return;
  }
  status.textContent = grant ? 'Granting…' : 'Revoking…';
  try {
    const out = await api('/api/admin/access', {
      method: 'POST',
      body: JSON.stringify({ email, grant }),
    });
    status.textContent = out.subscribed
      ? `✓ ${out.email} now has subscription access (${out.subscribedVia || 'manual'}). It takes effect on their next page load.`
      : `${out.email} no longer has subscription access.`;
    // If the admin changed their own record, refresh our own gate state.
    if (state.user && out.email.toLowerCase() === state.user.email.toLowerCase()) {
      await loadBilling();
    }
  } catch (err) {
    status.textContent = err.message;
  }
}

async function cancelSubscription(card) {
  const status = card.querySelector('.billing-status');
  if (
    !window.confirm(
      'Cancel your subscription? Paid plans stay active until the end of the current billing period; after that, PDF export turns off (reports and the preview stay free).'
    )
  ) {
    return;
  }
  if (status) status.textContent = 'Processing…';
  try {
    const out = await api('/api/billing/cancel', { method: 'POST', body: '{}' });
    billingFlash =
      out.mode === 'period_end'
        ? '✓ Cancellation scheduled with Stripe — access continues until the end of this billing period.'
        : out.mode === 'requested'
          ? '✓ Cancellation requested — we will process it shortly and email you when it is done.'
          : '✓ Subscription cancelled.';
    await loadBilling();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

async function undoCancellation(card) {
  const status = card.querySelector('.billing-status');
  if (status) status.textContent = 'Processing…';
  try {
    await api('/api/billing/cancel/undo', { method: 'POST', body: '{}' });
    billingFlash = '✓ Cancellation undone — your subscription continues as before.';
    await loadBilling();
  } catch (err) {
    if (status) status.textContent = err.message;
  }
}

function renderBilling() {
  const b = state.billing || {};
  for (const id of ['#billingCardProfile']) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = billingHtml();
    const grantBtn = el.querySelector('.admin-grant');
    const revokeBtn = el.querySelector('.admin-revoke');
    if (grantBtn) grantBtn.addEventListener('click', () => adminAccess(el, true));
    if (revokeBtn) revokeBtn.addEventListener('click', () => adminAccess(el, false));
    const cancelBtn = el.querySelector('#cancelSubBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelSubscription(el));
    const undoBtn = el.querySelector('#undoCancelBtn');
    if (undoBtn) undoBtn.addEventListener('click', () => undoCancellation(el));
    if (b.isAdmin) loadAdminStats(el);
  }
  billingFlash = '';
}

/* ---------------------------------------------------------------- */
/* User profile (details form + the billing plan live on this page)  */
/* ---------------------------------------------------------------- */

async function fetchProfile() {
  try {
    const { profile } = await api('/api/profile');
    state.profile = profile;
  } catch (_) {
    /* profile is optional everywhere it is used */
  }
}

async function loadProfile() {
  await fetchProfile();
  const p = state.profile || {};
  $('#p_full_name').value = p.fullName || '';
  $('#p_company_name').value = p.companyName || '';
  $('#p_phone').value = p.phone || '';
  $('#p_company_address').value = p.companyAddress || '';
  $('#p_email').value = p.email || (state.user && state.user.email) || '';
  $('#profileMsg').textContent = '';
  $('#p_est_terms').value = p.estTerms || '';
  $('#p_est_exclusions').value = p.estExclusions || '';
  $('#p_est_valid_days').value = p.estValidDays ?? 30;
  $('#p_est_deposit_pct').value = p.estDepositPct ?? 0;
  renderPriceBook();
}

function showProfile() {
  $('#listView').classList.add('hidden');
  $('#editorView').classList.add('hidden');
  $('#templatesView').classList.add('hidden');
  $('#profileView').classList.remove('hidden');
  loadProfile();
  loadPriceBook();
  renderBilling();
}

$('#profileBtn').addEventListener('click', showProfile);

$('#profileBackBtn').addEventListener('click', async () => {
  $('#profileView').classList.add('hidden');
  if (state.current) {
    $('#editorView').classList.remove('hidden');
  } else {
    $('#listView').classList.remove('hidden');
    await loadReports();
  }
  updatePdfButton();
});

/* --- Templates page (create + manage templates live here, not in
       the editors — the editors only apply them) --- */
function showTemplates() {
  $('#listView').classList.add('hidden');
  $('#editorView').classList.add('hidden');
  $('#profileView').classList.add('hidden');
  $('#templatesView').classList.remove('hidden');
  closeRtEditor();
  closeEtEditor();
  loadTemplates();
  loadEstTemplates();
}

$('#templatesBtn').addEventListener('click', showTemplates);

$('#templatesBackBtn').addEventListener('click', async () => {
  $('#templatesView').classList.add('hidden');
  if (state.current) {
    $('#editorView').classList.remove('hidden');
  } else {
    $('#listView').classList.remove('hidden');
    await loadReports();
  }
  updatePdfButton();
});

$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#profileMsg');
  msg.textContent = 'Saving…';
  try {
    const { profile } = await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        fullName: $('#p_full_name').value,
        companyName: $('#p_company_name').value,
        phone: $('#p_phone').value,
        companyAddress: $('#p_company_address').value,
      }),
    });
    state.profile = profile;
    msg.textContent = '✓ Profile saved.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#estDefaultsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#estDefaultsMsg');
  msg.textContent = 'Saving…';
  try {
    const { profile } = await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        estTerms: $('#p_est_terms').value,
        estExclusions: $('#p_est_exclusions').value,
        estValidDays: Number($('#p_est_valid_days').value) || 0,
        estDepositPct: Number($('#p_est_deposit_pct').value) || 0,
      }),
    });
    state.profile = profile;
    msg.textContent = '✓ Estimate defaults saved.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* --- Price book (profile page list; also feeds the estimate editor) --- */
async function loadPriceBook() {
  try {
    const { entries } = await api('/api/price-book');
    state.priceBook = entries;
  } catch (_) {
    state.priceBook = [];
  }
  renderPriceBook();
  if (state.current && state.current.report.doc_type === 'estimate') renderEstimate();
}

function renderPriceBook() {
  const wrap = $('#priceBookList');
  if (!wrap) return;
  wrap.innerHTML = state.priceBook.length
    ? state.priceBook
        .map(
          (e) => `
      <div class="tpl-row">
        <span class="tpl-title">${esc(e.name)}</span>
        <span class="muted small">${esc(KIND_LABEL[e.kind] || 'Item')}${e.unit ? ` · ${esc(e.unit)}` : ''} · ${moneyC(e.unit_price)}</span>
        <button class="btn btn-danger-ghost btn-sm" data-del-pb="${e.id}">Delete</button>
      </div>`
        )
        .join('')
    : '<p class="muted small">No price book items yet — add your first one below.</p>';
  wrap.querySelectorAll('[data-del-pb]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/price-book/${btn.dataset.delPb}`, { method: 'DELETE' });
      await loadPriceBook();
    });
  });
}

$('#pbAddBtn').addEventListener('click', async () => {
  const msg = $('#priceBookMsg');
  const name = $('#pb_name').value.trim();
  if (!name) {
    $('#pb_name').focus();
    return;
  }
  try {
    await api('/api/price-book', {
      method: 'POST',
      body: JSON.stringify({
        name,
        kind: $('#pb_kind').value,
        unit: $('#pb_unit').value.trim(),
        unit_price: Number($('#pb_price').value) || 0,
      }),
    });
    $('#pb_name').value = '';
    $('#pb_unit').value = '';
    $('#pb_price').value = '';
    msg.textContent = '✓ Added to your price book.';
    await loadPriceBook();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#passwordMsg');
  const current = $('#pw_current').value;
  const next = $('#pw_new').value;
  const confirm = $('#pw_confirm').value;
  if (next.length < 8) {
    msg.textContent = 'New password must be at least 8 characters.';
    return;
  }
  if (next !== confirm) {
    msg.textContent = 'New passwords do not match.';
    return;
  }
  msg.textContent = 'Updating…';
  try {
    await api('/api/profile/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    e.target.reset();
    msg.textContent = '✓ Password changed. Use the new password next time you sign in.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* ---------------------------------------------------------------- */
/* Reports list                                                      */
/* ---------------------------------------------------------------- */

async function loadReports() {
  const { reports } = await api('/api/reports');
  const list = $('#reportList');
  $('#listEmpty').classList.toggle('hidden', reports.length > 0);
  list.innerHTML = reports
    .map(
      (r) => `
      <div class="report-card" data-open="${r.id}">
        <div>
          <div class="rc-addr">${esc(r.address || 'Untitled property')}</div>
          <div class="rc-meta">${esc(r.client_name || 'No client yet')}${
            r.inspection_date ? ` · ${esc(String(r.inspection_date).slice(0, 10))}` : ''
          }</div>
        </div>
        <div class="rc-stats">
          ${
            r.doc_type === 'estimate'
              ? `${r.item_count || 0} line items<br />${moneyC(r.item_total || 0)} estimate`
              : `${r.finding_count} findings · ${r.urgent_count} urgent<br />${money(r.total_cost)} est. repairs`
          }
        </div>
      </div>`
    )
    .join('');
  list.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openReport(Number(el.dataset.open)));
  });
}

$('#newReportBtn').addEventListener('click', async () => {
  const { report } = await api('/api/reports', { method: 'POST', body: '{}' });
  await openReport(report.id);
});

$('#sampleBtn').addEventListener('click', async () => {
  const data = await api('/api/reports/sample', { method: 'POST', body: '{}' });
  state.current = data;
  await loadTemplates();
  await loadEstTemplates();
  showEditor();
});

/* ---------------------------------------------------------------- */
/* Editor                                                            */
/* ---------------------------------------------------------------- */

async function openReport(id) {
  state.current = await api(`/api/reports/${id}`);
  await loadTemplates();
  await loadEstTemplates();
  showEditor();
}

function showEditor() {
  $('#listView').classList.add('hidden');
  $('#profileView').classList.add('hidden');
  $('#templatesView').classList.add('hidden');
  $('#editorView').classList.remove('hidden');
  updatePdfButton();
  const r = state.current.report;
  resetSaveStatus();
  paintDocTypeButtons(['job', 'estimate'].includes(r.doc_type) ? r.doc_type : 'inspection');
  updateDocTypeLabels();
  $('#f_address').value = r.address || '';
  $('#f_client_name').value = r.client_name || '';
  $('#f_client_email').value = r.client_email || '';
  $('#f_client_phone').value = r.client_phone || '';
  $('#f_inspector_name').value = r.inspector_name || '';
  $('#f_inspection_date').value = r.inspection_date ? String(r.inspection_date).slice(0, 10) : '';
  $('#summaryBox').value = r.summary || '';
  $('#e_number').value = r.estimate_number || '';
  $('#e_valid_days').value = r.valid_days ?? 30;
  $('#e_discount_value').value = r.discount_value ?? 0;
  $('#e_discount_type').value = r.discount_type === 'amt' ? 'amt' : 'pct';
  $('#e_tax_rate').value = r.tax_rate ?? 0;
  $('#e_deposit_pct').value = r.deposit_pct ?? 0;
  $('#e_scope').value = r.scope_text || '';
  $('#e_exclusions').value = r.exclusions_text || '';
  $('#e_terms').value = r.terms_text || '';
  $('#notesBox').value = '';
  $('#structureMsg').textContent = '';
  renderEditor();
}

$('#backBtn').addEventListener('click', async () => {
  state.current = null;
  $('#editorView').classList.add('hidden');
  $('#profileView').classList.add('hidden');
  $('#templatesView').classList.add('hidden');
  $('#listView').classList.remove('hidden');
  updatePdfButton();
  await loadReports();
});

$('#deleteReportBtn').addEventListener('click', async () => {
  if (!state.current) return;
  if (!window.confirm('Delete this report and all its findings and photos?')) return;
  await api(`/api/reports/${state.current.report.id}`, { method: 'DELETE' });
  state.current = null;
  $('#editorView').classList.add('hidden');
  $('#profileView').classList.add('hidden');
  $('#templatesView').classList.add('hidden');
  $('#listView').classList.remove('hidden');
  updatePdfButton();
  await loadReports();
});

async function refreshCurrent() {
  if (!state.current) return;
  state.current = await api(`/api/reports/${state.current.report.id}`);
  renderEditor();
}

function renderEditor() {
  renderStats();
  renderCustomFields();
  renderTemplates();
  renderPhotos();
  renderFindings();
  renderEstimate();
  renderShare();
  renderPreview();
}

/* --- Document type (per report): Inspection Report vs Job Report vs
   Estimate — picked with the big buttons above the form. Job Report is
   the trades-facing document: same layout, but the badge, the preparer
   label and the signature line drop the inspector wording. The preview
   and the PDF read the same doc_type, so they never drift. */
function currentDocType() {
  const active = document.querySelector('.doctype-btn.is-active');
  return active ? active.dataset.doctype : 'inspection';
}

function paintDocTypeButtons(type) {
  document.querySelectorAll('.doctype-btn').forEach((btn) => {
    const on = btn.dataset.doctype === type;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function updateDocTypeLabels() {
  const type = currentDocType();
  const isJob = type === 'job';
  const isEstimate = type === 'estimate';
  $('#f_inspector_name_label').textContent = isJob || isEstimate ? 'Prepared by' : 'Inspector name';
  $('#f_inspection_date_label').textContent = isJob
    ? 'Job date'
    : isEstimate
      ? 'Estimate date'
      : 'Inspection date';
  $('#f_inspector_name').placeholder =
    isJob || isEstimate
      ? 'Alex Carter, Carter Plumbing Co.'
      : 'Alex Carter, Licensed Inspector';
  // Estimate documents use the line-item editor instead of the
  // findings composer and the summary box.
  $('#findingsCard').classList.toggle('hidden', isEstimate);
  $('#summaryCard').classList.toggle('hidden', isEstimate);
  $('#estimateCard').classList.toggle('hidden', !isEstimate);
}

document.querySelectorAll('.doctype-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.doctype;
    paintDocTypeButtons(type);
    updateDocTypeLabels();
    if (!state.current) return;
    if (state.current.report.doc_type === type) return;
    state.current = await api(`/api/reports/${state.current.report.id}`, {
      method: 'PUT',
      body: JSON.stringify({ doc_type: type }),
    });
    renderEditor();
  });
});

/* --- Property & client main fields: save on change --- */
for (const key of ['address', 'client_name', 'client_email', 'client_phone', 'inspector_name', 'inspection_date']) {
  const el = $(`#f_${key}`);
  el.addEventListener('change', async () => {
    if (!state.current) return;
    const body = {};
    body[key] = el.value;
    state.current = await api(`/api/reports/${state.current.report.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    renderStats();
    renderPreview();
  });
}

/* --- Stats + completeness --- */
function reportStats() {
  const { report, findings } = state.current;
  const total = findings.reduce((s, f) => s + Number(f.cost || 0), 0);
  const urgent = findings.filter((f) => f.severity === 'Urgent').length;
  const hasProperty = Boolean((report.address || '').trim() && (report.client_name || '').trim());
  let completeness = 0;
  if (hasProperty) completeness += 34;
  if (findings.length) completeness += 33;
  if ((report.summary || '').trim()) completeness += 33;
  return { total, urgent, count: findings.length, completeness };
}

function renderStats() {
  if (state.current.report.doc_type === 'estimate') {
    const items = state.current.estimateItems || [];
    const t = estimateTotals(items, state.current.report);
    const r = state.current.report;
    let completeness = 0;
    if ((r.address || '').trim() && (r.client_name || '').trim()) completeness += 50;
    if (items.length) completeness += 50;
    $('#statsRow').innerHTML = `
    <div class="stat"><div class="stat-num">${items.length}</div><div class="stat-label">Line items</div></div>
    <div class="stat"><div class="stat-num">${items.filter((i) => i.optional).length}</div><div class="stat-label">Optional</div></div>
    <div class="stat"><div class="stat-num">${moneyC(t.total)}</div><div class="stat-label">Estimate total</div></div>
    <div class="stat"><div class="stat-num">${completeness}%</div><div class="stat-label">Estimate complete</div>
      <div class="completeness"><div style="width:${completeness}%"></div></div></div>`;
    return;
  }
  const s = reportStats();
  $('#statsRow').innerHTML = `
    <div class="stat"><div class="stat-num">${s.count}</div><div class="stat-label">Findings</div></div>
    <div class="stat"><div class="stat-num">${s.urgent}</div><div class="stat-label">Urgent</div></div>
    <div class="stat"><div class="stat-num">${money(s.total)}</div><div class="stat-label">Est. repair cost</div></div>
    <div class="stat"><div class="stat-num">${s.completeness}%</div><div class="stat-label">Report complete</div>
      <div class="completeness"><div style="width:${s.completeness}%"></div></div></div>`;
}

/* --- Custom fields --- */
function renderCustomFields() {
  const wrap = $('#customFieldList');
  wrap.innerHTML = state.current.customFields
    .map(
      (f) => `
      <div class="cf-row" data-field="${f.id}">
        <input class="cf-name" value="${esc(f.name)}" placeholder="Field name" />
        <input class="cf-value" value="${esc(f.value)}" placeholder="Value" />
        <button class="btn btn-white btn-sm" data-add-below="${f.id}">+ Add</button>
        <button class="btn btn-danger-ghost btn-sm" data-del-field="${f.id}">Delete</button>
      </div>`
    )
    .join('');
  wrap.querySelectorAll('[data-field]').forEach((row) => {
    const id = Number(row.dataset.field);
    const save = async () => {
      await api(`/api/fields/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: row.querySelector('.cf-name').value,
          value: row.querySelector('.cf-value').value,
        }),
      });
      await refreshCurrent();
    };
    row.querySelector('.cf-name').addEventListener('change', save);
    row.querySelector('.cf-value').addEventListener('change', save);
  });
  wrap.querySelectorAll('[data-del-field]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/fields/${btn.dataset.delField}`, { method: 'DELETE' });
      await refreshCurrent();
    });
  });
  wrap.querySelectorAll('[data-add-below]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.current) return;
      const { field } = await api(`/api/reports/${state.current.report.id}/fields`, {
        method: 'POST',
        body: JSON.stringify({ name: '', value: '', afterId: Number(btn.dataset.addBelow) }),
      });
      await refreshCurrent();
      if (field) {
        const input = document.querySelector(`#customFieldList [data-field="${field.id}"] .cf-name`);
        if (input) {
          input.scrollIntoView({ block: 'nearest' });
          input.focus();
        }
      }
    });
  });
}

$('#addFieldBtn').addEventListener('click', async () => {
  if (!state.current) return;
  await api(`/api/reports/${state.current.report.id}/fields`, {
    method: 'POST',
    body: JSON.stringify({ name: '', value: '' }),
  });
  await refreshCurrent();
});

/* --- Report templates: created/managed on the Templates page; the
       report editor only applies one (select + Apply). --- */
async function loadTemplates() {
  const { templates } = await api('/api/report-templates');
  state.templates = templates;
  renderTemplates();
}

function renderTemplates() {
  // Editor: compact apply control (select of names + Apply button).
  const sel = $('#rtApplySelect');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">Choose a template…</option>' +
      state.templates
        .map(
          (t) =>
            `<option value="${t.id}">${esc(t.name)} (${t.fieldCount} field${t.fieldCount === 1 ? '' : 's'})</option>`
        )
        .join('');
    if (state.templates.some((t) => String(t.id) === cur)) sel.value = cur;
  }
  renderRtPageList();
}

$('#applyTemplateBtn').addEventListener('click', async () => {
  if (!state.current) return;
  // Value is a numeric id for user templates, or the built-in
  // template's string id — pass it through as-is; the server branches.
  const templateId = $('#rtApplySelect').value;
  if (!templateId) {
    $('#rtApplySelect').focus();
    return;
  }
  await api(`/api/reports/${state.current.report.id}/apply-template`, {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  });
  await refreshCurrent();
});

/* Templates page — report template list + from-scratch editor. */
let rtEditId = null;
/* True while the editor holds a built-in opened as a working copy:
   Save then creates a user-owned template ("Save as my template")
   instead of updating anything. */
let rtFromBuiltin = false;

/* Two-pane selection state: which template the right-hand editor pane
   is showing. kind is 'rt' or 'et'; key is String(template.id) —
   numeric for user templates, the string id for built-ins — or null
   while a blank "new" editor is open. */
let tplSel = null;

function setTplSelection(kind, key) {
  tplSel = kind ? { kind, key } : null;
  syncTplPane();
  markTplSelection();
}

/* The right pane shows the empty-state hint until an editor is open,
   then the editor card instead. */
function syncTplPane() {
  const rtEd = $('#rtEditor');
  const etEd = $('#etEditor');
  if (!rtEd || !etEd) return;
  const anyOpen =
    !rtEd.classList.contains('hidden') || !etEd.classList.contains('hidden');
  const hint = $('#tplEmptyHint');
  if (hint) hint.classList.toggle('hidden', anyOpen);
  const card = $('#tplEditorCard');
  if (card) card.classList.toggle('hidden', !anyOpen);
}

/* Re-apply the selected-row highlight after every list render (the
   rows are rebuilt from scratch on each load). */
function markTplSelection() {
  document
    .querySelectorAll('#rtPageList .tpl-row, #etPageList .tpl-row')
    .forEach((row) => {
      const selected = Boolean(
        tplSel &&
          tplSel.key !== null &&
          row.dataset.tplKind === tplSel.kind &&
          row.dataset.tplKey === tplSel.key
      );
      row.classList.toggle('is-selected', selected);
    });
}

function renderRtPageList() {
  const wrap = $('#rtPageList');
  if (!wrap) return;
  wrap.innerHTML = state.templates.length
    ? state.templates
        .map(
          (t) => `
      <div class="tpl-row" data-tpl-kind="rt" data-tpl-key="${t.id}">
        <span class="tpl-title">${esc(t.name)}</span>
        <span class="muted small">${t.fieldCount} field${t.fieldCount === 1 ? '' : 's'}</span>
        ${
          t.builtin
            ? `<span class="muted small">Built-in</span>`
            : `<button class="btn btn-white btn-sm" data-edit-rt="${t.id}">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" data-del-rt="${t.id}">Delete</button>`
        }
      </div>`
        )
        .join('')
    : '<p class="muted small">No report templates yet — create your first one below.</p>';
  wrap.querySelectorAll('[data-edit-rt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = state.templates.find((t) => t.id === Number(btn.dataset.editRt));
      if (tpl) openRtEditor(tpl);
    });
  });
  wrap.querySelectorAll('[data-del-rt]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/report-templates/${btn.dataset.delRt}`, { method: 'DELETE' });
      if (rtEditId === Number(btn.dataset.delRt)) closeRtEditor();
      await loadTemplates();
    });
  });
  /* The name itself is the open action — built-ins have no button.
     stopPropagation keeps the row handler below from firing a second
     open for the same click. */
  wrap.querySelectorAll('.tpl-row .tpl-title').forEach((title) => {
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = title.closest('.tpl-row');
      const tpl = state.templates.find((t) => String(t.id) === row.dataset.tplKey);
      if (tpl) openRtEditor(tpl);
    });
  });
  /* Clicking anywhere else on a row opens it in the right pane too. */
  wrap.querySelectorAll('.tpl-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const tpl = state.templates.find((t) => String(t.id) === row.dataset.tplKey);
      if (tpl) openRtEditor(tpl);
    });
  });
  markTplSelection();
}

function renderRtEditRows(fields) {
  const wrap = $('#rtEditFields');
  wrap.innerHTML = fields
    .map(
      (f) => `
      <div class="cf-row">
        <input class="cf-name" value="${esc(f.name)}" placeholder="Field name — e.g. Unit #" />
        <input class="cf-value" value="${esc(f.value)}" placeholder="Value (can be left blank)" />
        <button type="button" class="btn btn-white btn-sm" data-rt-add-below>+ Add</button>
        <button type="button" class="btn btn-danger-ghost btn-sm" data-rt-del-row>Delete</button>
      </div>`
    )
    .join('');
  wrap.querySelectorAll('[data-rt-add-below]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rows = collectRtFields();
      const idx = [...wrap.querySelectorAll('.cf-row')].indexOf(btn.closest('.cf-row'));
      rows.splice(idx + 1, 0, { name: '', value: '' });
      renderRtEditRows(rows);
      const input = wrap.querySelectorAll('.cf-row')[idx + 1]?.querySelector('.cf-name');
      if (input) input.focus();
    });
  });
  wrap.querySelectorAll('[data-rt-del-row]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rows = collectRtFields();
      const idx = [...wrap.querySelectorAll('.cf-row')].indexOf(btn.closest('.cf-row'));
      rows.splice(idx, 1);
      renderRtEditRows(rows);
    });
  });
}

function collectRtFields() {
  return [...document.querySelectorAll('#rtEditFields .cf-row')].map((row) => ({
    name: row.querySelector('.cf-name').value,
    value: row.querySelector('.cf-value').value,
  }));
}

function openRtEditor(tpl) {
  /* One editor at a time in the right pane. */
  closeEtEditor();
  const fromBuiltin = Boolean(tpl && tpl.builtin);
  rtFromBuiltin = fromBuiltin;
  /* A built-in opens as a working copy: rtEditId stays null so Save
     takes the create path and the built-in itself is never touched. */
  rtEditId = tpl && !fromBuiltin ? tpl.id : null;
  $('#rtEditorTitle').textContent = tpl
    ? fromBuiltin
      ? `Built-in template — ${tpl.name}`
      : `Edit template — ${tpl.name}`
    : 'New report template';
  $('#rtEditSaveBtn').textContent = fromBuiltin ? 'Save as my template' : 'Save template';
  $('#rtEditName').value = tpl ? tpl.name : '';
  $('#rtEditMsg').textContent = '';
  renderRtEditRows(tpl ? tpl.fields.map((f) => ({ name: f.name, value: f.value })) : [{ name: '', value: '' }]);
  $('#rtEditor').classList.remove('hidden');
  setTplSelection('rt', tpl ? String(tpl.id) : null);
  $('#rtEditName').focus();
}

function closeRtEditor() {
  rtEditId = null;
  rtFromBuiltin = false;
  const ed = $('#rtEditor');
  if (ed) ed.classList.add('hidden');
  if (tplSel && tplSel.kind === 'rt') tplSel = null;
  syncTplPane();
  markTplSelection();
}

$('#rtNewBtn').addEventListener('click', () => openRtEditor(null));
$('#rtAddRowBtn').addEventListener('click', () => {
  const rows = collectRtFields();
  rows.push({ name: '', value: '' });
  renderRtEditRows(rows);
  const list = document.querySelectorAll('#rtEditFields .cf-row');
  const input = list[list.length - 1]?.querySelector('.cf-name');
  if (input) input.focus();
});
$('#rtEditCancelBtn').addEventListener('click', closeRtEditor);
$('#rtEditSaveBtn').addEventListener('click', async () => {
  const msg = $('#rtEditMsg');
  const name = $('#rtEditName').value.trim();
  if (!name) {
    $('#rtEditName').focus();
    return;
  }
  const fields = collectRtFields();
  if (!fields.length) {
    msg.textContent = 'Add at least one field first.';
    return;
  }
  msg.textContent = 'Saving…';
  try {
    let createdId = null;
    if (rtEditId) {
      await api(`/api/report-templates/${rtEditId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, fields }),
      });
    } else {
      const res = await api('/api/report-templates', {
        method: 'POST',
        body: JSON.stringify({ name, fields }),
      });
      createdId = res && res.template ? res.template.id : null;
    }
    if (rtFromBuiltin && createdId) {
      /* Saved a copy of a built-in: land on the new user template in
         the editor so it is obvious the copy is theirs and editable. */
      await loadTemplates();
      const mine = state.templates.find((t) => t.id === createdId);
      if (mine) {
        openRtEditor(mine);
        $('#rtEditMsg').textContent = 'Saved — this copy is yours now.';
        return;
      }
    }
    closeRtEditor();
    await loadTemplates();
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* --- Photos --- */
function renderPhotos() {
  const grid = $('#photoGrid');
  const photos = state.current.photos;
  grid.innerHTML = photos.length
    ? photos
        .map(
          (p) => `
        <div class="photo-cell">
          <img src="${esc(p.url)}" alt="${esc(p.original_name || 'Inspection photo')}" />
          <div class="photo-meta">
            <span>${esc(p.original_name || 'photo')}${p.finding_id ? ' · attached' : ''}</span>
            <button class="photo-del" data-del-photo="${p.id}" title="Delete photo">✕</button>
          </div>
        </div>`
        )
        .join('')
    : '<p class="muted">No photos yet. Upload job-site photos above.</p>';
  grid.querySelectorAll('[data-del-photo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/photos/${btn.dataset.delPhoto}`, { method: 'DELETE' });
      await refreshCurrent();
    });
  });
  const sel = $('#photoFindingSelect');
  sel.innerHTML =
    '<option value="">Report (general)</option>' +
    state.current.findings
      .map((f) => `<option value="${f.id}">${esc(f.area)} — ${esc(f.title)}</option>`)
      .join('');
  renderCover();
}

/* --- House photo (report cover) --- */
function renderCover() {
  const url = state.current && state.current.report.cover_url;
  const thumb = $('#coverThumb');
  const removeBtn = $('#coverRemoveBtn');
  if (!thumb || !removeBtn) return;
  thumb.classList.toggle('hidden', !url);
  removeBtn.classList.toggle('hidden', !url);
  if (url) thumb.src = url;
  $('#coverBtnText').textContent = url ? 'Change house photo' : 'Upload house photo';
}

$('#coverInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file || !state.current) return;
  const errBox = $('#coverError');
  errBox.classList.add('hidden');
  try {
    noteSaveStart();
    const form = new FormData();
    form.append('photos', file);
    const res = await fetch(`/api/reports/${state.current.report.id}/photos`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Upload failed.');
    const photo = data && data.photos && data.photos[0];
    if (!photo) throw new Error('Upload failed.');
    await api(`/api/reports/${state.current.report.id}`, {
      method: 'PUT',
      body: JSON.stringify({ cover_photo_id: photo.id }),
    });
    await refreshCurrent();
    noteSaveDone();
  } catch (err) {
    noteSaveError();
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    e.target.value = '';
  }
});

$('#coverRemoveBtn').addEventListener('click', async () => {
  if (!state.current) return;
  await api(`/api/reports/${state.current.report.id}`, {
    method: 'PUT',
    body: JSON.stringify({ cover_photo_id: null }),
  });
  await refreshCurrent();
});

$('#photoInput').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files.length || !state.current) return;
  const errBox = $('#photoError');
  errBox.classList.add('hidden');
  const form = new FormData();
  for (const file of files) form.append('photos', file);
  const findingId = $('#photoFindingSelect').value;
  if (findingId) form.append('findingId', findingId);
  try {
    noteSaveStart();
    const res = await fetch(`/api/reports/${state.current.report.id}/photos`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Upload failed.');
    await refreshCurrent();
    noteSaveDone();
  } catch (err) {
    noteSaveError();
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    e.target.value = '';
  }
});

/* --- Findings --- */
const SEVERITIES = ['Good', 'Monitor', 'Repair', 'Urgent'];
/* Cost horizon (Phase 2 commercial pack): one compact select per
   finding; empty = unset, and unset findings never show anywhere new. */
const HORIZON_OPTIONS = [
  { v: '', label: '—' },
  { v: 'immediate', label: 'Immediate' },
  { v: '1-3', label: '1–3 yrs' },
  { v: '3-5', label: '3–5 yrs' },
  { v: '5-10', label: '5–10 yrs' },
];
// Findings that already auto-opened a successor card (once per finding per session).
const autoSpawnedFor = new Set();

function renderFindings() {
  const wrap = $('#findingList');
  const findings = state.current.findings;
  if (!findings.length) {
    wrap.innerHTML = '<p class="muted">No findings yet. Paste field notes above and hit “AI Structure notes”, or add one manually — photos can go in with your notes, before any finding exists.</p>';
    return;
  }
  wrap.innerHTML = findings
    .map(
      (f) => `
      <div class="finding" data-finding="${f.id}">
        <div class="finding-head">
          <input class="f-area" value="${esc(f.area)}" placeholder="Area" />
          <input class="f-title" value="${esc(f.title)}" placeholder="Finding title" />
          <span class="badge badge-${esc(f.severity)}">${esc(f.severity)}</span>
        </div>
        <textarea class="f-detail" rows="3" placeholder="Details for the client…">${esc(f.detail)}</textarea>
        <div class="finding-foot">
          <label class="field-inline"><span>Severity</span>
            <select class="f-severity sev-${esc(f.severity)}">
              ${SEVERITIES.map((s) => `<option ${s === f.severity ? 'selected' : ''}>${s}</option>`).join('')}
            </select></label>
          <label class="field-inline"><span>Est. cost $</span>
            <input class="f-cost" type="number" min="0" step="1" value="${Number(f.cost || 0)}" /></label>
          <label class="field-inline"><span>Horizon</span>
            <select class="f-horizon">
              ${HORIZON_OPTIONS.map((h) => `<option value="${h.v}" ${h.v === (f.horizon || '') ? 'selected' : ''}>${h.label}</option>`).join('')}
            </select></label>
          <button class="btn btn-amber btn-sm" data-polish="${f.id}">✨ Polish</button>
          <button class="btn btn-danger-ghost btn-sm" data-del-finding="${f.id}">Delete</button>
        </div>
        <div class="finding-photos">
          ${(f.photos || [])
            .map(
              (p) => `<span class="f-photo"><img src="${esc(p.url)}" alt="${esc(p.original_name || 'Finding photo')}" /><button class="f-photo-del" data-del-finding-photo="${p.id}" title="Remove photo">✕</button></span>`
            )
            .join('')}
          <label class="f-photo-add">＋ Photo
            <input type="file" data-finding-photo-input="${f.id}" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden />
          </label>
        </div>
      </div>`
    )
    .join('');

  wrap.querySelectorAll('[data-finding]').forEach((card) => {
    const id = Number(card.dataset.finding);
    const payload = () => ({
      area: card.querySelector('.f-area').value,
      title: card.querySelector('.f-title').value,
      detail: card.querySelector('.f-detail').value,
      severity: card.querySelector('.f-severity').value,
      cost: Number(card.querySelector('.f-cost').value) || 0,
      horizon: card.querySelector('.f-horizon').value || null,
    });
    const save = async () => {
      const p = payload();
      await api(`/api/findings/${id}`, { method: 'PUT', body: JSON.stringify(p) });
      // Auto-add: once the LAST finding has both a title and a description,
      // open the next blank finding card right away (once per finding).
      const findings = state.current.findings;
      const isLast = findings.length > 0 && findings[findings.length - 1].id === id;
      let spawned = false;
      if (isLast && p.title.trim() && p.detail.trim() && !autoSpawnedFor.has(id)) {
        autoSpawnedFor.add(id);
        await api(`/api/reports/${state.current.report.id}/findings`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        spawned = true;
      }
      await refreshCurrent();
      if (spawned) {
        const cards = document.querySelectorAll('#findingList .finding');
        const lastCard = cards[cards.length - 1];
        if (lastCard) {
          lastCard.scrollIntoView({ block: 'nearest' });
          const titleInput = lastCard.querySelector('.f-title');
          if (titleInput) titleInput.focus();
        }
      }
    };
    card.querySelectorAll('.f-area,.f-title,.f-detail,.f-severity,.f-cost,.f-horizon').forEach((el) => {
      el.addEventListener('change', save);
    });
    card.querySelector('[data-polish]').addEventListener('click', async () => {
      await api(`/api/findings/${id}/polish`, { method: 'POST', body: JSON.stringify(payload()) });
      await refreshCurrent();
    });
  });
  wrap.querySelectorAll('[data-del-finding]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/findings/${btn.dataset.delFinding}`, { method: 'DELETE' });
      await refreshCurrent();
    });
  });
  // Per-finding photo upload: posts straight to this finding.
  wrap.querySelectorAll('[data-finding-photo-input]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files.length || !state.current) return;
      const form = new FormData();
      for (const file of files) form.append('photos', file);
      form.append('findingId', input.dataset.findingPhotoInput);
      try {
        noteSaveStart();
        const res = await fetch(`/api/reports/${state.current.report.id}/photos`, {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        });
        if (!res.ok) throw new Error('Upload failed.');
        await refreshCurrent();
        noteSaveDone();
      } catch (err) {
        noteSaveError();
        window.alert(err.message);
      } finally {
        e.target.value = '';
      }
    });
  });
  wrap.querySelectorAll('[data-del-finding-photo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/photos/${btn.dataset.delFindingPhoto}`, { method: 'DELETE' });
      await refreshCurrent();
    });
  });
}

/* --- Findings composer: stage photos here, they attach when the finding is added --- */
let stagedPhotos = [];

function renderStaged() {
  const wrap = $('#stageThumbs');
  wrap.innerHTML = stagedPhotos
    .map(
      (s, i) =>
        `<span class="f-photo"><img src="${s.url}" alt="Staged photo" /><button class="f-photo-del" data-unstage="${i}" title="Remove photo">✕</button></span>`
    )
    .join('');
  wrap.querySelectorAll('[data-unstage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [gone] = stagedPhotos.splice(Number(btn.dataset.unstage), 1);
      if (gone) URL.revokeObjectURL(gone.url);
      renderStaged();
    });
  });
}

function clearStaged() {
  stagedPhotos.forEach((s) => URL.revokeObjectURL(s.url));
  stagedPhotos = [];
  renderStaged();
}

$('#stagePhotoInput').addEventListener('change', (e) => {
  for (const file of e.target.files) {
    stagedPhotos.push({ file, url: URL.createObjectURL(file) });
  }
  e.target.value = '';
  renderStaged();
});

async function uploadStagedTo(findingId) {
  if (!stagedPhotos.length) return;
  const form = new FormData();
  for (const s of stagedPhotos) form.append('photos', s.file);
  form.append('findingId', String(findingId));
  noteSaveStart();
  const res = await fetch(`/api/reports/${state.current.report.id}/photos`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    noteSaveError();
    throw new Error((data && data.error) || 'Photo upload failed.');
  }
  noteSaveDone();
  clearStaged();
}

$('#addFindingBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const errBox = $('#stageError');
  errBox.classList.add('hidden');
  const photoCount = stagedPhotos.length;
  try {
    // Manual add stays a blank finding — the notes box is never consumed here.
    // Photos staged with the notes attach to the new finding.
    const { finding } = await api(`/api/reports/${state.current.report.id}/findings`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (photoCount) await uploadStagedTo(finding.id);
    $('#structureMsg').textContent = photoCount
      ? `Finding added below with your ${photoCount} photo${photoCount === 1 ? '' : 's'} attached — fill in its details.`
      : '';
    await refreshCurrent();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

$('#structureBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const notes = $('#notesBox').value.trim();
  const msg = $('#structureMsg');
  if (!notes) {
    msg.textContent = stagedPhotos.length
      ? 'No notes to structure — or press “+ Add finding manually” to create a finding for the staged photos.'
      : 'Write some field notes first.';
    return;
  }
  $('#structureBtn').disabled = true;
  msg.textContent = 'Structuring…';
  try {
    const { findings, aiUsed } = await api(`/api/reports/${state.current.report.id}/structure`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
    });
    $('#notesBox').value = '';
    let photoNote = '';
    if (stagedPhotos.length && findings.length) {
      const count = stagedPhotos.length;
      try {
        await uploadStagedTo(findings[0].id);
        photoNote = ` ${count} photo${count === 1 ? '' : 's'} attached to the first finding.`;
      } catch (err) {
        photoNote = ' Photo upload failed — your photos are still staged above.';
      }
    }
    msg.textContent = `Added ${findings.length} finding${findings.length === 1 ? '' : 's'}${
      aiUsed ? ' using AI' : ' using the built-in structurer (no AI key configured)'
    }. Review and adjust severity and costs below.${photoNote}`;
    await refreshCurrent();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    $('#structureBtn').disabled = false;
  }
});

/* --- Summary --- */
$('#summaryBox').addEventListener('change', async () => {
  if (!state.current) return;
  state.current = await api(`/api/reports/${state.current.report.id}`, {
    method: 'PUT',
    body: JSON.stringify({ summary: $('#summaryBox').value }),
  });
  renderStats();
  renderPreview();
});

$('#summarizeBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const { summary } = await api(`/api/reports/${state.current.report.id}/summarize`, {
    method: 'POST',
    body: '{}',
  });
  $('#summaryBox').value = summary;
  await refreshCurrent();
  $('#summaryBox').value = summary;
});

/* ---------------------------------------------------------------- */
/* Estimate documents: line items, sections, totals                  */
/* ---------------------------------------------------------------- */

function renderEstimate() {
  const wrap = $('#estimateItems');
  if (!wrap || !state.current) return;
  const items = state.current.estimateItems || [];
  const sections = estimateSections(items);
  const pbOptions = state.priceBook
    .map(
      (e) =>
        `<option value="${e.id}">${esc(e.name)} — ${moneyC(e.unit_price)}${e.unit ? ` / ${esc(e.unit)}` : ''}</option>`
    )
    .join('');
  wrap.innerHTML = items.length
    ? sections
        .map((sec) => {
          const secTotal = round2(
            sec.items.filter((i) => !i.optional).reduce((s, i) => s + lineTotal(i), 0)
          );
          return `
      <div class="est-section">
        <div class="est-section-head">
          <input class="es-name" value="${esc(sec.name)}" placeholder="Section name — e.g. Plumbing" />
          <span class="muted small">${moneyC(secTotal)}</span>
        </div>
        ${sec.items
          .map(
            (it) => `
        <div class="est-item" data-item="${it.id}">
          <input class="ei-desc" value="${esc(it.description)}" placeholder="Description — e.g. Replace leaking trap and supply lines" />
          <select class="ei-kind">
            ${['item', 'labor', 'material'].map((k) => `<option value="${k}" ${k === it.kind ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}
          </select>
          <input class="ei-qty" type="number" min="0" step="0.25" value="${Number(it.qty || 0)}" title="Quantity" />
          <input class="ei-unit" value="${esc(it.unit)}" placeholder="unit" title="Unit (hr, ea, sq ft…)" />
          <input class="ei-price" type="number" min="0" step="0.01" value="${Number(it.unit_price || 0)}" title="Unit price $" />
          <span class="ei-total">${moneyC(lineTotal(it))}</span>
          <label class="ei-opt"><input type="checkbox" class="ei-optional" ${it.optional ? 'checked' : ''} /> Optional</label>
          <button class="btn btn-white btn-sm" data-save-pb="${it.id}" title="Save this line to your price book">Save to price book</button>
          <button class="btn btn-danger-ghost btn-sm" data-del-item="${it.id}">Delete</button>
        </div>`
          )
          .join('')}
        <div class="est-section-foot">
          <button class="btn btn-navy btn-sm" data-add-item="${esc(sec.name)}">+ Add item</button>
          ${
            state.priceBook.length
              ? `<select class="pb-pick" data-pb-section="${esc(sec.name)}"><option value="">+ Add from my price book…</option>${pbOptions}</select>`
              : ''
          }
        </div>
      </div>`;
        })
        .join('')
    : '<p class="muted">No line items yet — add a section below to start (e.g. “Plumbing”), then add items to it.</p>';

  const t = estimateTotals(items, state.current.report);
  $('#estimateTotals').innerHTML = `
    <div><span>Subtotal</span><b>${moneyC(t.subtotal)}</b></div>
    ${t.discount ? `<div><span>Discount</span><b>−${moneyC(t.discount)}</b></div>` : ''}
    ${t.tax ? `<div><span>Tax (${t.taxRate}%)</span><b>${moneyC(t.tax)}</b></div>` : ''}
    <div class="est-grand"><span>Estimate total</span><b>${moneyC(t.total)}</b></div>
    ${t.optionalSubtotal ? `<div><span>Optional items (not included in total)</span><b>${moneyC(t.optionalSubtotal)}</b></div>` : ''}
    ${t.deposit ? `<div><span>Deposit due to schedule (${t.depositPct}%)</span><b>${moneyC(t.deposit)}</b></div>` : ''}`;

  // Section rename: applies to every item in the section.
  wrap.querySelectorAll('.est-section').forEach((secEl, idx) => {
    const sec = sections[idx];
    if (!sec) return;
    const nameInput = secEl.querySelector('.es-name');
    nameInput.addEventListener('change', async () => {
      const name = nameInput.value.trim();
      if (name === sec.name) return;
      for (const it of sec.items) {
        await api(`/api/items/${it.id}`, {
          method: 'PUT',
          body: JSON.stringify({ section: name }),
        });
      }
      await refreshCurrent();
    });
  });

  wrap.querySelectorAll('[data-item]').forEach((row) => {
    const id = Number(row.dataset.item);
    const payload = () => ({
      description: row.querySelector('.ei-desc').value,
      kind: row.querySelector('.ei-kind').value,
      qty: Number(row.querySelector('.ei-qty').value) || 0,
      unit: row.querySelector('.ei-unit').value,
      unit_price: Number(row.querySelector('.ei-price').value) || 0,
      optional: row.querySelector('.ei-optional').checked,
    });
    row
      .querySelectorAll('.ei-desc,.ei-kind,.ei-qty,.ei-unit,.ei-price,.ei-optional')
      .forEach((el) => {
        el.addEventListener('change', async () => {
          await api(`/api/items/${id}`, { method: 'PUT', body: JSON.stringify(payload()) });
          await refreshCurrent();
        });
      });
    row.querySelector('[data-save-pb]').addEventListener('click', async () => {
      const p = payload();
      if (!p.description.trim()) {
        row.querySelector('.ei-desc').focus();
        return;
      }
      await api('/api/price-book', {
        method: 'POST',
        body: JSON.stringify({
          name: p.description.trim(),
          kind: p.kind,
          unit: p.unit,
          unit_price: p.unit_price,
        }),
      });
      await loadPriceBook();
    });
  });
  wrap.querySelectorAll('[data-del-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/items/${btn.dataset.delItem}`, { method: 'DELETE' });
      await refreshCurrent();
    });
  });
  wrap.querySelectorAll('[data-add-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.current) return;
      const { item } = await api(`/api/reports/${state.current.report.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ section: btn.dataset.addItem }),
      });
      await refreshCurrent();
      if (item) {
        const input = document.querySelector(`#estimateItems [data-item="${item.id}"] .ei-desc`);
        if (input) {
          input.scrollIntoView({ block: 'nearest' });
          input.focus();
        }
      }
    });
  });
  wrap.querySelectorAll('.pb-pick').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const entry = state.priceBook.find((e) => e.id === Number(sel.value));
      if (!entry || !state.current) return;
      await api(`/api/reports/${state.current.report.id}/items`, {
        method: 'POST',
        body: JSON.stringify({
          section: sel.dataset.pbSection,
          description: entry.name,
          kind: entry.kind,
          qty: 1,
          unit: entry.unit,
          unit_price: entry.unit_price,
        }),
      });
      await refreshCurrent();
    });
  });
  renderEstTemplates();
}

/* Estimate detail fields (validity, discount, tax, deposit, texts):
   save on change, same as the other report fields. */
const EST_FIELD_MAP = {
  e_valid_days: ['valid_days', true],
  e_discount_value: ['discount_value', true],
  e_discount_type: ['discount_type', false],
  e_tax_rate: ['tax_rate', true],
  e_deposit_pct: ['deposit_pct', true],
  e_scope: ['scope_text', false],
  e_exclusions: ['exclusions_text', false],
  e_terms: ['terms_text', false],
};
for (const [id, [key, numeric]] of Object.entries(EST_FIELD_MAP)) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('change', async () => {
    if (!state.current) return;
    const body = {};
    body[key] = numeric ? Number(el.value) || 0 : el.value;
    state.current = await api(`/api/reports/${state.current.report.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    renderStats();
    renderEstimate();
    renderPreview();
  });
}

/* ✨ Polish for the estimate's writing areas (Scope / Exclusions /
   Terms) — the same AI polish the finding cards have. On success the
   textarea content is replaced and saved through the field's normal
   change flow above (which also re-renders the preview); on failure
   the user's text is left exactly as it was. */
document.querySelectorAll('[data-polish-text]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!state.current) return;
    const ta = document.getElementById(btn.dataset.polishText);
    const mapping = EST_FIELD_MAP[btn.dataset.polishText];
    if (!ta || !mapping) return;
    const errBox = $('#estPolishError');
    errBox.classList.add('hidden');
    if (!ta.value.trim()) {
      ta.focus();
      return;
    }
    btn.disabled = true;
    try {
      const { text } = await api(`/api/reports/${state.current.report.id}/polish-text`, {
        method: 'POST',
        body: JSON.stringify({ field: mapping[0], text: ta.value }),
      });
      ta.value = text;
      ta.dispatchEvent(new Event('change'));
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
});

$('#addSectionBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const input = $('#newSectionName');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const { item } = await api(`/api/reports/${state.current.report.id}/items`, {
    method: 'POST',
    body: JSON.stringify({ section: name }),
  });
  input.value = '';
  await refreshCurrent();
  if (item) {
    const desc = document.querySelector(`#estimateItems [data-item="${item.id}"] .ei-desc`);
    if (desc) {
      desc.scrollIntoView({ block: 'nearest' });
      desc.focus();
    }
  }
});

/* --- Estimate templates: created/managed on the Templates page; the
       estimate editor only applies one (select + Apply). --- */
async function loadEstTemplates() {
  try {
    const { templates } = await api('/api/estimate-templates');
    state.estTemplates = templates;
  } catch (_) {
    state.estTemplates = [];
  }
  renderEstTemplates();
}

function renderEstTemplates() {
  // Editor: compact apply control (select of names + Apply button).
  const sel = $('#etApplySelect');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">Choose a template…</option>' +
      state.estTemplates
        .map(
          (t) =>
            `<option value="${t.id}">${esc(t.name)} (${t.itemCount} item${t.itemCount === 1 ? '' : 's'})</option>`
        )
        .join('');
    if (state.estTemplates.some((t) => String(t.id) === cur)) sel.value = cur;
  }
  renderEtPageList();
}

$('#applyEstTemplateBtn').addEventListener('click', async () => {
  if (!state.current) return;
  // Value is a numeric id for user templates, or a built-in
  // template's string id — pass it through as-is; the server branches.
  const templateId = $('#etApplySelect').value;
  if (!templateId) {
    $('#etApplySelect').focus();
    return;
  }
  await api(`/api/reports/${state.current.report.id}/apply-estimate-template`, {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  });
  await refreshCurrent();
  // Apply may have filled the estimate's texts from the template —
  // refreshCurrent re-renders items/preview but not these inputs.
  const r = state.current.report;
  $('#e_scope').value = r.scope_text || '';
  $('#e_exclusions').value = r.exclusions_text || '';
  $('#e_terms').value = r.terms_text || '';
});

/* Templates page — estimate template list + from-scratch editor. */
let etEditId = null;
/* True while the editor holds a built-in opened as a working copy:
   Save then creates a user-owned template ("Save as my template")
   instead of updating anything. */
let etFromBuiltin = false;

function renderEtPageList() {
  const wrap = $('#etPageList');
  if (!wrap) return;
  wrap.innerHTML = state.estTemplates.length
    ? state.estTemplates
        .map(
          (t) => `
      <div class="tpl-row" data-tpl-kind="et" data-tpl-key="${t.id}">
        <span class="tpl-title">${esc(t.name)}</span>
        <span class="muted small">${t.itemCount} item${t.itemCount === 1 ? '' : 's'}</span>
        ${
          t.builtin
            ? `<span class="muted small">Built-in</span>`
            : `<button class="btn btn-white btn-sm" data-edit-et="${t.id}">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" data-del-et="${t.id}">Delete</button>`
        }
      </div>`
        )
        .join('')
    : '<p class="muted small">No estimate templates yet — create your first one below.</p>';
  wrap.querySelectorAll('[data-edit-et]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = state.estTemplates.find((t) => t.id === Number(btn.dataset.editEt));
      if (tpl) openEtEditor(tpl);
    });
  });
  wrap.querySelectorAll('[data-del-et]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/estimate-templates/${btn.dataset.delEt}`, { method: 'DELETE' });
      if (etEditId === Number(btn.dataset.delEt)) closeEtEditor();
      await loadEstTemplates();
    });
  });
  /* The name itself is the open action — built-ins have no button.
     stopPropagation keeps the row handler below from firing a second
     open for the same click. */
  wrap.querySelectorAll('.tpl-row .tpl-title').forEach((title) => {
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = title.closest('.tpl-row');
      const tpl = state.estTemplates.find((t) => String(t.id) === row.dataset.tplKey);
      if (tpl) openEtEditor(tpl);
    });
  });
  /* Clicking anywhere else on a row opens it in the right pane too. */
  wrap.querySelectorAll('.tpl-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const tpl = state.estTemplates.find((t) => String(t.id) === row.dataset.tplKey);
      if (tpl) openEtEditor(tpl);
    });
  });
  markTplSelection();
}

const ET_BLANK_ITEM = { section: '', description: '', kind: 'item', qty: 1, unit: '', unit_price: 0, optional: false };

function renderEtEditRows(items) {
  const wrap = $('#etEditItems');
  wrap.innerHTML = items
    .map(
      (it) => `
      <div class="est-item">
        <input class="eti-section" value="${esc(it.section)}" placeholder="Section — e.g. Plumbing" />
        <input class="ei-desc" value="${esc(it.description)}" placeholder="Description — e.g. Replace leaking trap" />
        <select class="ei-kind">
          ${['item', 'labor', 'material'].map((k) => `<option value="${k}" ${k === it.kind ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}
        </select>
        <input class="ei-qty" type="number" min="0" step="0.25" value="${Number(it.qty || 0)}" title="Quantity" />
        <input class="ei-unit" value="${esc(it.unit)}" placeholder="unit" title="Unit (hr, ea, sq ft…)" />
        <input class="ei-price" type="number" min="0" step="0.01" value="${Number(it.unit_price || 0)}" title="Unit price $" />
        <label class="ei-opt"><input type="checkbox" class="ei-optional" ${it.optional ? 'checked' : ''} /> Optional</label>
        <button type="button" class="btn btn-white btn-sm" data-et-add-below>+ Add</button>
        <button type="button" class="btn btn-danger-ghost btn-sm" data-et-del-row>Delete</button>
      </div>`
    )
    .join('');
  const rows = () => [...wrap.querySelectorAll('.est-item')];
  wrap.querySelectorAll('[data-et-add-below]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemsNow = collectEtItems();
      const idx = rows().indexOf(btn.closest('.est-item'));
      itemsNow.splice(idx + 1, 0, { ...ET_BLANK_ITEM });
      renderEtEditRows(itemsNow);
      const input = rows()[idx + 1]?.querySelector('.eti-section');
      if (input) input.focus();
    });
  });
  wrap.querySelectorAll('[data-et-del-row]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemsNow = collectEtItems();
      const idx = rows().indexOf(btn.closest('.est-item'));
      itemsNow.splice(idx, 1);
      renderEtEditRows(itemsNow);
    });
  });
}

function collectEtItems() {
  return [...document.querySelectorAll('#etEditItems .est-item')].map((row) => ({
    section: row.querySelector('.eti-section').value,
    description: row.querySelector('.ei-desc').value,
    kind: row.querySelector('.ei-kind').value,
    qty: Number(row.querySelector('.ei-qty').value) || 0,
    unit: row.querySelector('.ei-unit').value,
    unit_price: Number(row.querySelector('.ei-price').value) || 0,
    optional: row.querySelector('.ei-optional').checked,
  }));
}

function openEtEditor(tpl) {
  /* One editor at a time in the right pane. */
  closeRtEditor();
  const fromBuiltin = Boolean(tpl && tpl.builtin);
  etFromBuiltin = fromBuiltin;
  /* A built-in opens as a working copy: etEditId stays null so Save
     takes the create path and the built-in itself is never touched. */
  etEditId = tpl && !fromBuiltin ? tpl.id : null;
  $('#etEditorTitle').textContent = tpl
    ? fromBuiltin
      ? `Built-in template — ${tpl.name}`
      : `Edit template — ${tpl.name}`
    : 'New estimate template';
  $('#etEditSaveBtn').textContent = fromBuiltin ? 'Save as my template' : 'Save template';
  $('#etEditName').value = tpl ? tpl.name : '';
  $('#etEditScope').value = tpl ? tpl.scope_text || '' : '';
  $('#etEditExclusions').value = tpl ? tpl.exclusions_text || '' : '';
  $('#etEditTerms').value = tpl ? tpl.terms_text || '' : '';
  $('#etEditMsg').textContent = '';
  renderEtEditRows(
    tpl
      ? tpl.items.map((it) => ({
          section: it.section,
          description: it.description,
          kind: it.kind,
          qty: it.qty,
          unit: it.unit,
          unit_price: it.unit_price,
          optional: it.optional,
        }))
      : [{ ...ET_BLANK_ITEM }]
  );
  $('#etEditor').classList.remove('hidden');
  setTplSelection('et', tpl ? String(tpl.id) : null);
  $('#etEditName').focus();
}

function closeEtEditor() {
  etEditId = null;
  etFromBuiltin = false;
  const ed = $('#etEditor');
  if (ed) ed.classList.add('hidden');
  if (tplSel && tplSel.kind === 'et') tplSel = null;
  syncTplPane();
  markTplSelection();
}

$('#etNewBtn').addEventListener('click', () => openEtEditor(null));
$('#etAddRowBtn').addEventListener('click', () => {
  const items = collectEtItems();
  items.push({ ...ET_BLANK_ITEM });
  renderEtEditRows(items);
  const list = document.querySelectorAll('#etEditItems .est-item');
  const input = list[list.length - 1]?.querySelector('.eti-section');
  if (input) input.focus();
});
$('#etEditCancelBtn').addEventListener('click', closeEtEditor);
$('#etEditSaveBtn').addEventListener('click', async () => {
  const msg = $('#etEditMsg');
  const name = $('#etEditName').value.trim();
  if (!name) {
    $('#etEditName').focus();
    return;
  }
  const items = collectEtItems();
  if (!items.length) {
    msg.textContent = 'Add at least one line item first.';
    return;
  }
  msg.textContent = 'Saving…';
  try {
    const body = JSON.stringify({
      name,
      items,
      scopeText: $('#etEditScope').value,
      exclusionsText: $('#etEditExclusions').value,
      termsText: $('#etEditTerms').value,
    });
    let createdId = null;
    if (etEditId) {
      await api(`/api/estimate-templates/${etEditId}`, { method: 'PUT', body });
    } else {
      const res = await api('/api/estimate-templates', { method: 'POST', body });
      createdId = res && res.template ? res.template.id : null;
    }
    if (etFromBuiltin && createdId) {
      /* Saved a copy of a built-in: land on the new user template in
         the editor so it is obvious the copy is theirs and editable. */
      await loadEstTemplates();
      const mine = state.estTemplates.find((t) => t.id === createdId);
      if (mine) {
        openEtEditor(mine);
        $('#etEditMsg').textContent = 'Saved — this copy is yours now.';
        return;
      }
    }
    closeEtEditor();
    await loadEstTemplates();
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* Convert this estimate into a new Job Report (no confirm dialog —
   the estimate itself is left untouched, so there is nothing to lose). */
$('#convertJobBtn').addEventListener('click', async () => {
  if (!state.current) return;
  try {
    const data = await api(`/api/reports/${state.current.report.id}/convert-to-job`, {
      method: 'POST',
      body: '{}',
    });
    state.current = data;
    showEditor();
    paintSaveStatus('saved', '✓ Converted — this is the new Job Report');
  } catch (err) {
    window.alert(err.message);
  }
});

/* --- Estimate sharing (Phase 1b): public link, view tracking,
       approval — one compact block in the estimate editor. --- */
const EST_STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  approved: 'Approved',
  declined: 'Declined',
};

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  );
}

function renderShare() {
  const pill = $('#shareStatusPill');
  if (!pill || !state.current) return;
  const r = state.current.report;
  if (r.doc_type !== 'estimate') return;
  const status = r.estimate_status || 'draft';
  pill.textContent = EST_STATUS_LABEL[status] || 'Draft';
  pill.className = `status-pill st-${status}`;
  const toggle = $('#shareEnabledToggle');
  toggle.checked = Boolean(r.share_enabled);
  const urlInput = $('#shareUrl');
  if (r.share_enabled && r.share_token) {
    urlInput.value = `${location.origin}/s/${r.share_token}`;
    urlInput.placeholder = '';
  } else {
    urlInput.value = '';
    urlInput.placeholder = r.share_token
      ? 'Link is off — turn it on to share'
      : 'Turn the link on to get a shareable URL';
  }
  $('#shareCopyBtn').disabled = !(r.share_enabled && r.share_token);
  $('#markSentBtn').disabled = status === 'approved' || status === 'viewed';
  $('#shareViewInfo').textContent = r.viewed_at
    ? `Viewed ${fmtDateTime(r.viewed_at)} · ${r.view_count || 0} view${Number(r.view_count) === 1 ? '' : 's'}`
    : 'Not viewed yet';
  const info = $('#shareApprovalInfo');
  if (r.approved_at) {
    const chosen = (state.current.estimateItems || []).filter((it) =>
      (r.approved_optionals || []).includes(it.id)
    );
    info.textContent =
      `✓ Approved by ${r.approved_name || ''} on ${fmtDateTime(r.approved_at)}` +
      (chosen.length
        ? ` · Optional included: ${chosen.map((it) => it.description || 'Line item').join(', ')}`
        : '');
  } else if (status === 'declined') {
    info.textContent =
      `Declined${r.declined_at ? ` on ${fmtDateTime(r.declined_at)}` : ''}` +
      (r.declined_reason ? ` — “${r.declined_reason}”` : '');
  } else {
    info.textContent = '';
  }
}

$('#shareEnabledToggle').addEventListener('change', async (e) => {
  if (!state.current) return;
  await api(`/api/reports/${state.current.report.id}/share`, {
    method: 'POST',
    body: JSON.stringify({ enabled: e.target.checked }),
  });
  await refreshCurrent();
});

$('#shareCopyBtn').addEventListener('click', async () => {
  const input = $('#shareUrl');
  if (!input.value) return;
  const msg = $('#shareMsg');
  try {
    await navigator.clipboard.writeText(input.value);
    msg.textContent = '✓ Link copied';
  } catch (_) {
    input.select();
    msg.textContent = 'Link selected — copy it with Ctrl/Cmd+C';
  }
  setTimeout(() => {
    msg.textContent = '';
  }, 3000);
});

$('#markSentBtn').addEventListener('click', async () => {
  if (!state.current) return;
  state.current = await api(`/api/reports/${state.current.report.id}/mark-sent`, {
    method: 'POST',
    body: '{}',
  });
  renderEditor();
});

/* Valid-until date = estimate date + valid_days (estimate date falls
   back to today when the date field is empty). pdf.js duplicates this. */
function estimateValidUntil(report) {
  const days = Number(report.valid_days || 0);
  if (!days) return null;
  const base = report.inspection_date
    ? new Date(`${String(report.inspection_date).slice(0, 10)}T12:00:00`)
    : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

/* --- Estimate preview (mirrors the PDF 1:1) --- */
function renderEstimatePreview() {
  const { report, customFields, estimateItems } = state.current;
  const items = estimateItems || [];
  const t = estimateTotals(items, report);
  const validUntil = estimateValidUntil(report);
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
  const itemRow = (it) => `
            <div class="r-item">
              <div class="r-main">
                <div class="r-line"><b>${esc(it.description || 'Line item')}</b><span class="est-amt">${moneyC(lineTotal(it))}</span></div>
                <p class="r-detail">${esc(KIND_LABEL[it.kind] || 'Item')} · ${Number(it.qty || 0)}${it.unit ? ` ${esc(it.unit)}` : ''} × ${moneyC(it.unit_price)}</p>
              </div>
            </div>`;
  const sections = estimateSections(items);
  const billableSections = sections
    .map((sec) => ({ name: sec.name, items: sec.items.filter((i) => !i.optional) }))
    .filter((sec) => sec.items.length);
  const optionalItems = items.filter((i) => i.optional);
  $('#preview').innerHTML = `
    <article class="report">
      ${report.cover_url ? `<img class="report-cover" src="${esc(report.cover_url)}" alt="Property photo" />` : ''}
      <div class="report-head">
        <span class="badge">ESTIMATE</span>
        <h1>${esc(report.address || 'Add a property address to start your estimate')}</h1>
      </div>
      <div class="report-body">
        <dl class="meta">
          ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        ${
          billableSections.length
            ? billableSections
                .map(
                  (sec) => `
        ${sec.name ? `<h3>${esc(sec.name)}</h3>` : ''}
        ${sec.items.map(itemRow).join('')}`
                )
                .join('')
            : '<p class="r-empty">No line items yet — add sections and items on the left, and they will appear here grouped by section.</p>'
        }
        ${
          optionalItems.length
            ? `
        <h3>Optional — not included in total</h3>
        ${optionalItems.map(itemRow).join('')}
        <p class="est-opt-total">Optional subtotal: ${moneyC(t.optionalSubtotal)}</p>`
            : ''
        }
        <div class="est-totals">
          <div><span>Subtotal</span><b>${moneyC(t.subtotal)}</b></div>
          ${t.discount ? `<div><span>Discount</span><b>−${moneyC(t.discount)}</b></div>` : ''}
          ${t.tax ? `<div><span>Tax (${t.taxRate}%)</span><b>${moneyC(t.tax)}</b></div>` : ''}
          <div class="est-grand"><span>Total</span><b>${moneyC(t.total)}</b></div>
          ${t.deposit ? `<div><span>Deposit due to schedule (${t.depositPct}%)</span><b>${moneyC(t.deposit)}</b></div>` : ''}
        </div>
        ${report.scope_text ? `<h3>Scope of work</h3><p class="est-text">${esc(report.scope_text)}</p>` : ''}
        ${report.exclusions_text ? `<h3>Exclusions</h3><p class="est-text">${esc(report.exclusions_text)}</p>` : ''}
        ${report.terms_text ? `<h3>Terms</h3><p class="est-text">${esc(report.terms_text)}</p>` : ''}
        <div class="total-row">
          ${
            report.approved_name
              ? `<span>✓ Approved by ${esc(report.approved_name)} · ${esc(fmtDateTime(report.approved_at))}</span><span></span>`
              : `<span>Customer approval: ___________________</span>
          <span>Date: ____________</span>`
          }
        </div>
        ${companyBlockHtml(report)}
      </div>
    </article>`;
}

/* Company footer at the bottom of the report (replaces the old
   disclaimer): the preparer's company name, address, phone and email
   from their User Profile. Renders nothing when all are empty. */
function companyBlockHtml(report) {
  const prof = state.profile || {};
  const coName = prof.companyName || report.inspector_name || prof.fullName || '';
  const coLine = [prof.companyAddress, prof.phone, prof.email]
    .filter((v) => v && String(v).trim())
    .join(' · ');
  if (!coName && !coLine) return '';
  return `<div class="report-company">${coName ? `<p class="rc-name">${esc(coName)}</p>` : ''}${coLine ? `<p class="rc-line">${esc(coLine)}</p>` : ''}</div>`;
}

/* --- Preview (mirrors the approved report document look) --- */
function renderPreview() {
  if (state.current.report.doc_type === 'estimate') {
    renderEstimatePreview();
    return;
  }
  const { report, customFields, findings } = state.current;
  const s = reportStats();
  const capex = capexSummary(findings);
  const isJob = report.doc_type === 'job';
  const rows = [
    ['Client', report.client_name || '—'],
    ['Date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
    [isJob ? 'Prepared by' : 'Inspector', report.inspector_name || '—'],
    ['Client email', report.client_email || '—'],
    ['Client phone', report.client_phone || '—'],
    ...customFields.map((f) => [f.name || 'Field', f.value || '—']),
  ];
  $('#preview').innerHTML = `
    <article class="report">
      ${report.cover_url ? `<img class="report-cover" src="${esc(report.cover_url)}" alt="Property photo" />` : ''}
      <div class="report-head">
        <span class="badge">${isJob ? 'Job Report' : 'Home Inspection Report'}</span>
        <h1>${esc(report.address || 'Add a property address to start your report')}</h1>
      </div>
      <div class="report-body">
        <dl class="meta">
          ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        ${report.summary ? `<h3>Executive summary</h3><div class="summary-box">${esc(report.summary)}</div><div class="section-divider"></div>` : ''}
        <h3>Findings (${findings.length})</h3>
        ${
          findings.length
            ? findings
                .map(
                  (f, i) => `
            <div class="r-item">
              <div class="r-main">
                <div class="r-line"><b>${i + 1}. ${esc(f.area)}${f.area && f.title ? ' — ' : ''}${esc(f.title)}</b><span class="pill pill-${esc(
                    String(f.severity || 'Monitor').toLowerCase()
                  )}">${esc(f.severity)}</span>${f.cost ? `<span class="pill pill-cost">~${money(f.cost)}</span>` : ''}</div>
                <p class="r-detail">${esc(f.detail)}</p>
                ${
                  f.photos && f.photos.length
                    ? `<div class="r-photos">${f.photos
                        .map((p) => `<img src="${esc(p.url)}" alt="${esc(p.original_name || 'Finding photo')}" />`)
                        .join('')}</div>`
                    : ''
                }
              </div>
            </div>`
                )
                .join('')
            : '<p class="r-empty">No findings yet — your documented items will be grouped by area here, with photos.</p>'
        }
        <div class="total-row">
          <span>Total estimated repairs: <b>${money(s.total)}</b></span>
          <span>${isJob ? 'Signature' : 'Inspector signature'}: ___________________</span>
        </div>
        ${
          capex
            ? `
        <h3>Capital expenditure summary</h3>
        <table class="capex-table">
          <thead><tr><th>Horizon</th><th class="r">Estimated cost</th></tr></thead>
          <tbody>
            ${capex.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${money(r.amount)}</td></tr>`).join('')}
            <tr class="capex-total"><td>Total</td><td class="r">${money(capex.total)}</td></tr>
          </tbody>
        </table>`
            : ''
        }
        ${companyBlockHtml(report)}
      </div>
    </article>`;
}

/* --- PDF (gated: export is part of the $9/mo plan) --- */

/**
 * PDF button states (two buttons: under the live preview, and at the
 * bottom of the editor — both always show the same state):
 *  - no report open            -> disabled, default label
 *  - report open, has access   -> enabled, normal download (subscription,
 *    comp grant, or the free 7-day trial every new account starts with)
 *  - report open, no access    -> enabled but locked (🔒 PDF — Pro);
 *    clicking it opens the upgrade prompt instead of generating a PDF.
 * Reports, editing and the live preview are always free.
 */
function updatePdfButton() {
  document.querySelectorAll('.pdf-dl-btn').forEach((btn) => {
    if (!state.current) {
      btn.disabled = true;
      btn.classList.remove('btn-locked');
      btn.textContent = '⬇ Download PDF';
      return;
    }
    btn.disabled = false;
    if (hasPdfAccess()) {
      btn.classList.remove('btn-locked');
      btn.textContent = '⬇ Download PDF';
    } else {
      btn.classList.add('btn-locked');
      btn.textContent = '🔒 PDF — Pro';
    }
  });
}

function openUpgrade() {
  const b = state.billing || { priceMonthly: 9, paymentLinkUrl: null };
  $('#upgradeSubscribeWrap').innerHTML = b.paymentLinkUrl
    ? `<a class="btn btn-amber btn-big btn-block" href="${esc(b.paymentLinkUrl)}" target="_blank" rel="noopener">Subscribe — $${b.priceMonthly}/mo</a>`
    : `<button class="btn btn-amber btn-big btn-block" disabled>Subscribe — $${b.priceMonthly}/mo</button>
       <p class="muted small">Payments are not live yet — the Subscribe button activates once the payment link is configured.</p>`;
  $('#upgradeModal').classList.remove('hidden');
}

function closeUpgrade() {
  $('#upgradeModal').classList.add('hidden');
}

$('#upgradeClose').addEventListener('click', closeUpgrade);
$('#upgradeModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeUpgrade();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeUpgrade();
});

document.querySelectorAll('.pdf-dl-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!state.current) return;
    // Refresh billing right before deciding, so a just-granted or
    // just-paid subscription takes effect without a page reload.
    await loadBilling();
    if (!hasPdfAccess()) {
      openUpgrade();
      return;
    }
    const row = btn.closest('.pdf-dl-row');
    const status = row ? row.querySelector('.pdf-status') : null;
    await window.downloadReportPdf({ ...state.current, profile: state.profile }, (msg) => {
      if (status) status.textContent = msg;
    });
  });
});

/* ---------------------------------------------------------------- */
initAuth();
