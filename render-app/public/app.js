'use strict';

/* InspectReport AI — single-page frontend (vanilla JS). */

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  billing: null,
  profile: null,
  templates: [],
  current: null, // { report, customFields, findings, photos }
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
      priceMonthly: 49,
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
   3-day trial every new account starts with. */
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
  const b = state.billing || { priceMonthly: 49, paymentLinkUrl: null };
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
}

function showProfile() {
  $('#listView').classList.add('hidden');
  $('#editorView').classList.add('hidden');
  $('#profileView').classList.remove('hidden');
  loadProfile();
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
          ${r.finding_count} findings · ${r.urgent_count} urgent<br />${money(r.total_cost)} est. repairs
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
  showEditor();
});

/* ---------------------------------------------------------------- */
/* Editor                                                            */
/* ---------------------------------------------------------------- */

async function openReport(id) {
  state.current = await api(`/api/reports/${id}`);
  await loadTemplates();
  showEditor();
}

function showEditor() {
  $('#listView').classList.add('hidden');
  $('#profileView').classList.add('hidden');
  $('#editorView').classList.remove('hidden');
  updatePdfButton();
  const r = state.current.report;
  resetSaveStatus();
  $('#f_doc_type').value = r.doc_type === 'job' ? 'job' : 'inspection';
  updateDocTypeLabels();
  $('#f_address').value = r.address || '';
  $('#f_client_name').value = r.client_name || '';
  $('#f_client_email').value = r.client_email || '';
  $('#f_client_phone').value = r.client_phone || '';
  $('#f_inspector_name').value = r.inspector_name || '';
  $('#f_inspection_date').value = r.inspection_date ? String(r.inspection_date).slice(0, 10) : '';
  $('#summaryBox').value = r.summary || '';
  $('#notesBox').value = '';
  $('#structureMsg').textContent = '';
  renderEditor();
}

$('#backBtn').addEventListener('click', async () => {
  state.current = null;
  $('#editorView').classList.add('hidden');
  $('#profileView').classList.add('hidden');
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
  renderPreview();
}

/* --- Document type (per report): Inspection Report vs Job Report ---
   Job Report is the trades-facing document: same layout, but the badge,
   the preparer label and the signature line drop the inspector wording.
   The preview and the PDF read the same doc_type, so they never drift. */
function updateDocTypeLabels() {
  const isJob = $('#f_doc_type').value === 'job';
  $('#f_inspector_name_label').textContent = isJob ? 'Prepared by' : 'Inspector name';
  $('#f_inspection_date_label').textContent = isJob ? 'Job date' : 'Inspection date';
  $('#f_inspector_name').placeholder = isJob
    ? 'Alex Carter, Carter Plumbing Co.'
    : 'Alex Carter, Licensed Inspector';
}

$('#f_doc_type').addEventListener('change', async () => {
  updateDocTypeLabels();
  if (!state.current) return;
  state.current = await api(`/api/reports/${state.current.report.id}`, {
    method: 'PUT',
    body: JSON.stringify({ doc_type: $('#f_doc_type').value }),
  });
  renderPreview();
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
        <button class="btn btn-white btn-sm" data-save-template="${f.id}">Save Custom Field</button>
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
  wrap.querySelectorAll('[data-save-template]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const f = state.current.customFields.find((x) => x.id === Number(btn.dataset.saveTemplate));
      if (!f) return;
      await api('/api/templates', {
        method: 'POST',
        body: JSON.stringify({ name: f.name, value: f.value }),
      });
      await loadTemplates();
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

/* --- Saved templates --- */
async function loadTemplates() {
  const { templates } = await api('/api/templates');
  state.templates = templates;
  renderTemplates();
}

function renderTemplates() {
  const wrap = $('#templateList');
  if (!wrap) return;
  if (!state.templates.length) {
    wrap.innerHTML = '<p class="muted small">No saved fields yet.</p>';
    return;
  }
  wrap.innerHTML = state.templates
    .map(
      (t) => `
      <div class="tpl-row" data-template="${t.id}">
        <input class="tpl-name" value="${esc(t.name)}" placeholder="Field name" />
        <input class="tpl-value" value="${esc(t.value)}" placeholder="Value" />
        <button class="btn btn-amber btn-sm" data-add-template="${t.id}">+ Add to report</button>
        <button class="btn btn-danger-ghost btn-sm" data-del-template="${t.id}">Delete</button>
      </div>`
    )
    .join('');
  wrap.querySelectorAll('[data-template]').forEach((row) => {
    const id = Number(row.dataset.template);
    const save = async () => {
      await api(`/api/templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: row.querySelector('.tpl-name').value,
          value: row.querySelector('.tpl-value').value,
        }),
      });
      await loadTemplates();
    };
    row.querySelector('.tpl-name').addEventListener('change', save);
    row.querySelector('.tpl-value').addEventListener('change', save);
  });
  wrap.querySelectorAll('[data-add-template]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const t = state.templates.find((x) => x.id === Number(btn.dataset.addTemplate));
      if (!t || !state.current) return;
      await api(`/api/reports/${state.current.report.id}/fields`, {
        method: 'POST',
        body: JSON.stringify({ name: t.name, value: t.value }),
      });
      await refreshCurrent();
    });
  });
  wrap.querySelectorAll('[data-del-template]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/templates/${btn.dataset.delTemplate}`, { method: 'DELETE' });
      await loadTemplates();
    });
  });
}

$('#addTemplateBtn').addEventListener('click', async () => {
  const name = $('#tplName').value.trim();
  if (!name) return;
  await api('/api/templates', {
    method: 'POST',
    body: JSON.stringify({ name, value: $('#tplValue').value }),
  });
  $('#tplName').value = '';
  $('#tplValue').value = '';
  await loadTemplates();
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
        ${(f.raw_note || f.input_source === 'voice') ? `
        <div class="raw-note">
          <span class="raw-note-label">${f.input_source === 'voice' ? '🎙️ Voice note' : 'Raw note'}</span>
          <input class="f-raw-note" value="${esc(f.raw_note || '')}" placeholder="The rough note this finding came from" />
          <button class="btn btn-white btn-sm" data-restructure="${f.id}">Re-structure</button>
        </div>` : ''}
        <div class="finding-foot">
          <label class="field-inline"><span>Severity</span>
            <select class="f-severity sev-${esc(f.severity)}">
              ${SEVERITIES.map((s) => `<option ${s === f.severity ? 'selected' : ''}>${s}</option>`).join('')}
            </select></label>
          <label class="field-inline"><span>Est. cost $</span>
            <input class="f-cost" type="number" min="0" step="1" value="${Number(f.cost || 0)}" /></label>
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
    card.querySelectorAll('.f-area,.f-title,.f-detail,.f-severity,.f-cost').forEach((el) => {
      el.addEventListener('change', save);
    });
    card.querySelector('[data-polish]').addEventListener('click', async () => {
      await api(`/api/findings/${id}/polish`, { method: 'POST', body: JSON.stringify(payload()) });
      await refreshCurrent();
    });
    const rawInput = card.querySelector('.f-raw-note');
    if (rawInput) {
      rawInput.addEventListener('change', async () => {
        await api(`/api/findings/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...payload(), raw_note: rawInput.value }),
        });
        await refreshCurrent();
      });
    }
    const reBtn = card.querySelector('[data-restructure]');
    if (reBtn && rawInput) {
      reBtn.addEventListener('click', async () => {
        const notes = rawInput.value.trim();
        if (!notes) return;
        reBtn.disabled = true;
        reBtn.textContent = 'Re-structuring…';
        try {
          await api(`/api/findings/${id}/restructure`, {
            method: 'POST',
            body: JSON.stringify({ notes }),
          });
          await refreshCurrent();
        } catch (err) {
          window.alert(err.message);
          reBtn.disabled = false;
          reBtn.textContent = 'Re-structure';
        }
      });
    }
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

/* --- Voice-to-Finding ------------------------------------------------
   One big button: snap a photo -> talk -> the transcript is bound to
   that photo and AI structures it into a finding with the photo
   attached. Speech recognition uses the browser's built-in engine
   when available (free, live preview); browsers without it record the
   audio and send it to /api/transcribe. The transcript is always
   editable before generating, and "Queue it & snap another" lets the
   inspector keep capturing while earlier pairs structure in the
   background. */
let voicePhoto = null; // { id, url } of the uploaded photo awaiting its note
let voiceQueue = []; // [{ photoId, transcript }] waiting to be structured
let voiceProcessing = false;
let voiceRec = null; // active SpeechRecognition instance
let voiceRecorder = null; // active MediaRecorder (fallback mode)
let voiceStream = null;
let voiceChunks = [];
let voiceMode = null; // 'speech' | 'media' | null
let voiceFinal = ''; // finalised transcript chunks (speech mode)
let voiceTimerInt = null;
let voiceSeconds = 0;
const VOICE_MAX_SEC = 60;

function voiceMsg(text) {
  const el = $('#voiceMsg');
  if (el) el.textContent = text || '';
}
function voiceState(text) {
  const el = $('#voiceState');
  if (el) el.textContent = text || '';
}
function voiceQueueStatus(text) {
  const el = $('#voiceQueueStatus');
  if (el) el.textContent = text || '';
}

function paintVoiceTimer() {
  const el = $('#voiceTimer');
  if (!el) return;
  const m = Math.floor(voiceSeconds / 60);
  const s = String(voiceSeconds % 60).padStart(2, '0');
  el.textContent = `${m}:${s} / 1:00`;
}

function startVoiceTimer() {
  voiceSeconds = 0;
  paintVoiceTimer();
  clearInterval(voiceTimerInt);
  voiceTimerInt = setInterval(() => {
    voiceSeconds += 1;
    paintVoiceTimer();
    if (voiceSeconds >= VOICE_MAX_SEC) stopVoiceRecording();
  }, 1000);
}

function stopVoiceTimer() {
  clearInterval(voiceTimerInt);
  voiceTimerInt = null;
}

function setMicUi(recording) {
  const btn = $('#voiceMicBtn');
  if (!btn) return;
  btn.classList.toggle('recording', recording);
  btn.textContent = recording ? '⏹️' : '🎙️';
}

async function startVoiceRecording() {
  if (!state.current) return;
  voiceFinal = $('#voiceTranscript').value.trim();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    try {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          if (r.isFinal) voiceFinal = `${voiceFinal} ${r[0].transcript}`.trim();
          else interim += r[0].transcript;
        }
        $('#voiceTranscript').value = `${voiceFinal} ${interim}`.trim();
      };
      rec.onerror = (e) => {
        stopVoiceRecording();
        voiceState('Mic stopped — you can type the note instead.');
        if (e.error === 'not-allowed') voiceMsg('Microphone permission was blocked. Allow the mic in your browser, or type the note.');
        else if (e.error !== 'aborted') voiceMsg('Speech recognition had a problem — typing the note works too.');
      };
      rec.onend = () => {
        if (voiceMode === 'speech') {
          voiceMode = null;
          stopVoiceTimer();
          setMicUi(false);
          voiceState('Done — check the text, fix anything misheard.');
        }
      };
      voiceRec = rec;
      voiceMode = 'speech';
      rec.start();
      setMicUi(true);
      startVoiceTimer();
      voiceState('Listening… tap the mic again to stop.');
      voiceMsg('');
      return;
    } catch (_) {
      /* fall through to audio recording */
    }
  }
  // Fallback: record the audio, transcribe on the server afterwards.
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    voiceMsg('This browser cannot record audio here — type your note in the box instead.');
    return;
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    voiceMsg('Microphone permission was blocked. Allow the mic in your browser, or type the note.');
    return;
  }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; }
  });
  voiceChunks = [];
  voiceRecorder = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : undefined);
  voiceRecorder.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
  voiceRecorder.onstop = onVoiceAudioRecorded;
  voiceMode = 'media';
  voiceRecorder.start();
  setMicUi(true);
  startVoiceTimer();
  voiceState('Recording… tap the mic again to stop.');
  voiceMsg('');
}

async function onVoiceAudioRecorded() {
  voiceMode = null;
  stopVoiceTimer();
  setMicUi(false);
  if (voiceStream) voiceStream.getTracks().forEach((t) => t.stop());
  voiceStream = null;
  const blob = new Blob(voiceChunks, { type: (voiceRecorder && voiceRecorder.mimeType) || 'audio/webm' });
  voiceChunks = [];
  if (!blob.size) return;
  voiceState('Transcribing…');
  try {
    noteSaveStart();
    const form = new FormData();
    form.append('audio', blob, 'voice-note');
    const res = await fetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Transcription failed.');
    $('#voiceTranscript').value = data.text || '';
    voiceState('Done — check the text, fix anything misheard.');
    noteSaveDone();
  } catch (err) {
    noteSaveError();
    voiceState('Could not transcribe — type the note instead.');
    voiceMsg(err.message);
  }
}

function stopVoiceRecording() {
  if (voiceMode === 'speech' && voiceRec) {
    try { voiceRec.stop(); } catch (_) {}
    voiceRec = null;
  } else if (voiceMode === 'media' && voiceRecorder) {
    try { voiceRecorder.stop(); } catch (_) {}
  } else {
    stopVoiceTimer();
    setMicUi(false);
  }
}

function resetVoiceCard() {
  stopVoiceRecording();
  voicePhoto = null;
  $('#voiceCard').classList.add('hidden');
  $('#voiceTranscript').value = '';
  $('#voiceThumb').removeAttribute('src');
  voiceMsg('');
  voiceState('Ready when you are');
  voiceSeconds = 0;
  paintVoiceTimer();
}

$('#voiceMicBtn').addEventListener('click', () => {
  if (voiceMode) stopVoiceRecording();
  else startVoiceRecording();
});

$('#voicePhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !state.current) return;
  // Show the card (and thumbnail) immediately; upload in the background.
  resetVoiceCard();
  $('#voiceCard').classList.remove('hidden');
  $('#voiceThumb').src = URL.createObjectURL(file);
  voiceState('Uploading photo…');
  $('#voiceCard').scrollIntoView({ block: 'nearest' });
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
    if (!res.ok) throw new Error((data && data.error) || 'Photo upload failed.');
    const photo = data && data.photos && data.photos[0];
    if (!photo) throw new Error('Photo upload failed.');
    voicePhoto = { id: photo.id, url: photo.url };
    $('#voiceThumb').src = photo.url;
    voiceState('Photo saved. Tap the mic and talk.');
    noteSaveDone();
  } catch (err) {
    noteSaveError();
    voiceState('Photo upload failed.');
    voiceMsg(err.message);
  }
});

$('#voiceCancelBtn').addEventListener('click', async () => {
  const photoId = voicePhoto && voicePhoto.id;
  resetVoiceCard();
  if (photoId) {
    // A cancelled capture should not leave an orphan photo behind.
    try { await api(`/api/photos/${photoId}`, { method: 'DELETE' }); await refreshCurrent(); } catch (_) {}
  }
});

async function processVoiceQueue() {
  if (voiceProcessing) return;
  voiceProcessing = true;
  let made = 0;
  while (voiceQueue.length) {
    const item = voiceQueue[0];
    voiceQueueStatus(`⏳ Structuring voice finding… (${voiceQueue.length} in queue)`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await api(`/api/reports/${state.current.report.id}/structure`, {
        method: 'POST',
        body: JSON.stringify({ notes: item.transcript, inputSource: 'voice', photoId: item.photoId }),
      });
      made += 1;
    } catch (err) {
      voiceQueueStatus(`⚠ One voice finding failed: ${err.message}`);
      voiceQueue.shift();
      voiceProcessing = false;
      await refreshCurrent();
      return;
    }
    voiceQueue.shift();
    // eslint-disable-next-line no-await-in-loop
    await refreshCurrent();
  }
  voiceProcessing = false;
  if (made) voiceQueueStatus(`✓ ${made} voice finding${made === 1 ? '' : 's'} added below — photo attached, severity and cost filled in.`);
}

function enqueueVoiceFinding() {
  const transcript = $('#voiceTranscript').value.trim();
  if (!voicePhoto || !voicePhoto.id) {
    voiceMsg('The photo is still uploading — give it a second.');
    return false;
  }
  if (!transcript) {
    voiceMsg('Record or type the note first.');
    return false;
  }
  voiceQueue.push({ photoId: voicePhoto.id, transcript });
  return true;
}

$('#voiceGenerateBtn').addEventListener('click', async () => {
  if (voiceMode) stopVoiceRecording();
  if (!enqueueVoiceFinding()) return;
  resetVoiceCard();
  await processVoiceQueue();
});

$('#voiceQueueBtn').addEventListener('click', async () => {
  if (voiceMode) stopVoiceRecording();
  if (!enqueueVoiceFinding()) return;
  resetVoiceCard();
  processVoiceQueue();
  // Straight into the next capture.
  $('#voicePhotoInput').click();
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
  const { report, customFields, findings } = state.current;
  const s = reportStats();
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
        ${companyBlockHtml(report)}
      </div>
    </article>`;
}

/* --- PDF (gated: export is part of the $49/mo plan) --- */

/**
 * PDF button states (two buttons: under the live preview, and at the
 * bottom of the editor — both always show the same state):
 *  - no report open            -> disabled, default label
 *  - report open, has access   -> enabled, normal download (subscription,
 *    comp grant, or the free 3-day trial every new account starts with)
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
  const b = state.billing || { priceMonthly: 49, paymentLinkUrl: null };
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
