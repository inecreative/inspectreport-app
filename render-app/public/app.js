'use strict';

/* InspectReport AI — single-page frontend (vanilla JS). */

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  billing: null,
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

async function api(path, options = {}) {
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
  return data;
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

function billingHtml() {
  const b = state.billing || { priceMonthly: 49, paymentLinkUrl: null };
  if (b.subscribed) {
    const viaNote =
      b.subscribedVia === 'comp'
        ? 'Complimentary access. All features unlocked, including PDF export.'
        : b.subscribedVia === 'stripe'
          ? 'Paid via Stripe. All features unlocked, including PDF export.'
          : 'Access granted. All features unlocked, including PDF export.';
    return `
    <h2>Billing</h2>
    <div class="billing-inner">
      <div>
        <div class="billing-price">Plan: Active <small>✓</small></div>
        <p class="muted">${viaNote}</p>
      </div>
      <div><span class="pill pill-good">Subscribed</span></div>
    </div>${adminBoxHtml(b)}`;
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

/* Admin-only: grant/revoke subscription access by email.
   Rendered solely when /api/billing says the signed-in user is an admin. */
function adminBoxHtml(b) {
  if (!b.isAdmin) return '';
  return `
    <div class="admin-box">
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

function renderBilling() {
  for (const id of ['#billingCardList', '#billingCardEditor']) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = billingHtml();
    const grantBtn = el.querySelector('.admin-grant');
    const revokeBtn = el.querySelector('.admin-revoke');
    if (grantBtn) grantBtn.addEventListener('click', () => adminAccess(el, true));
    if (revokeBtn) revokeBtn.addEventListener('click', () => adminAccess(el, false));
  }
}

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
  $('#editorView').classList.remove('hidden');
  updatePdfButton();
  const r = state.current.report;
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
        <button class="btn btn-navy btn-sm" data-save-template="${f.id}">Save as template</button>
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
  } catch (err) {
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
    const res = await fetch(`/api/reports/${state.current.report.id}/photos`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Upload failed.');
    await refreshCurrent();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    e.target.value = '';
  }
});

/* --- Findings --- */
const SEVERITIES = ['Good', 'Monitor', 'Repair', 'Urgent'];

function renderFindings() {
  const wrap = $('#findingList');
  const findings = state.current.findings;
  if (!findings.length) {
    wrap.innerHTML = '<p class="muted">No findings yet. Paste field notes above and hit “AI Structure notes”, or add one manually.</p>';
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
          <button class="btn btn-navy btn-sm" data-polish="${f.id}">✨ Polish</button>
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
      await api(`/api/findings/${id}`, { method: 'PUT', body: JSON.stringify(payload()) });
      await refreshCurrent();
    };
    card.querySelectorAll('.f-area,.f-title,.f-detail,.f-severity,.f-cost').forEach((el) => {
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
        const res = await fetch(`/api/reports/${state.current.report.id}/photos`, {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        });
        if (!res.ok) throw new Error('Upload failed.');
        await refreshCurrent();
      } catch (err) {
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

$('#addFindingBtn').addEventListener('click', async () => {
  if (!state.current) return;
  await api(`/api/reports/${state.current.report.id}/findings`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await refreshCurrent();
});

$('#structureBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const notes = $('#notesBox').value.trim();
  const msg = $('#structureMsg');
  if (!notes) {
    msg.textContent = 'Write some field notes first.';
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
    msg.textContent = `Added ${findings.length} finding${findings.length === 1 ? '' : 's'}${
      aiUsed ? ' using AI' : ' using the built-in structurer (no AI key configured)'
    }. Review and adjust severity and costs below.`;
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

/* --- Preview (mirrors the approved report document look) --- */
function renderPreview() {
  const { report, customFields, findings } = state.current;
  const s = reportStats();
  const rows = [
    ['Client', report.client_name || '—'],
    ['Date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
    ['Inspector', report.inspector_name || '—'],
    ['Client email', report.client_email || '—'],
    ['Client phone', report.client_phone || '—'],
    ...customFields.map((f) => [f.name || 'Field', f.value || '—']),
  ];
  $('#preview').innerHTML = `
    <article class="report">
      ${report.cover_url ? `<img class="report-cover" src="${esc(report.cover_url)}" alt="Property photo" />` : ''}
      <div class="report-head">
        <span class="badge">Home Inspection Report</span>
        <h1>${esc(report.address || 'Add a property address to start your report')}</h1>
        <p>Professional inspection report · Generated with InspectReport AI</p>
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
          <span>Inspector signature: ___________________</span>
        </div>
        <p class="disclaimer">This report summarizes visible conditions at the time of inspection. It is not a warranty or guarantee. Costs are ballpark estimates for planning only — obtain licensed contractor quotes for exact pricing. Photos are inspector-provided.</p>
      </div>
    </article>`;
}

/* --- PDF (gated: export is part of the $49/mo plan) --- */

/**
 * Header PDF button states:
 *  - no report open            -> disabled, default label
 *  - report open, has access   -> enabled, normal download (subscription,
 *    comp grant, or the free 3-day trial every new account starts with)
 *  - report open, no access    -> enabled but locked (🔒 PDF — Pro);
 *    clicking it opens the upgrade prompt instead of generating a PDF.
 * Reports, editing and the live preview are always free.
 */
function updatePdfButton() {
  const btn = $('#pdfBtn');
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

$('#pdfBtn').addEventListener('click', async () => {
  if (!state.current) return;
  // Refresh billing right before deciding, so a just-granted or
  // just-paid subscription takes effect without a page reload.
  await loadBilling();
  if (!hasPdfAccess()) {
    openUpgrade();
    return;
  }
  await window.downloadReportPdf(state.current, (msg) => {
    $('#pdfStatus').textContent = msg;
  });
});

/* ---------------------------------------------------------------- */
initAuth();
