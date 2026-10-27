'use strict';

/**
 * AI provider module.
 *
 * Talks to any OpenAI-compatible chat-completions API:
 *   AI_API_KEY      — API key (if unset, AI is disabled and we fall back)
 *   AI_API_BASE_URL — default https://api.openai.com/v1
 *   AI_MODEL        — default gpt-4o-mini
 *
 * If no key is configured (or the API call fails), every feature falls back
 * to a built-in keyword-based implementation so the app still works:
 *   - structureNotes(notes)          -> findings[]
 *   - polishFinding(finding)         -> { title, detail }
 *   - summarizeReport(report, list)  -> summary string
 */

const SEVERITIES = ['Good', 'Monitor', 'Repair', 'Urgent'];

function aiConfigured() {
  return Boolean(process.env.AI_API_KEY);
}

function baseUrl() {
  return (process.env.AI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function model() {
  return process.env.AI_MODEL || 'gpt-4o-mini';
}

/** Ask the model for a JSON object. Returns null on any failure. */
async function chatJSON(system, user) {
  if (!aiConfigured()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: model(),
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[ai] chat/completions failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    console.warn(`[ai] request failed, using fallback: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cleanSeverity(value, fallback = 'Monitor') {
  const s = SEVERITIES.find((x) => x.toLowerCase() === String(value || '').toLowerCase());
  return s || fallback;
}

function cleanCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function cleanFinding(f, fallbackArea = '') {
  return {
    area: String(f.area || fallbackArea || 'General').slice(0, 80),
    title: String(f.title || 'Finding').slice(0, 160),
    detail: String(f.detail || '').slice(0, 4000),
    severity: cleanSeverity(f.severity),
    cost: cleanCost(f.cost),
  };
}

/* ------------------------------------------------------------------ */
/* Fallback (no AI key): keyword-based structuring                     */
/* ------------------------------------------------------------------ */

const AREAS = [
  'kitchen', 'bathroom', 'bedroom', 'living room', 'roof', 'attic', 'basement',
  'crawl space', 'garage', 'exterior', 'electrical', 'plumbing', 'hvac',
  'furnace', 'water heater', 'foundation', 'deck', 'porch', 'laundry',
];

// Ordered most-severe first; the first rule whose keyword appears wins.
const RULES = [
  { severity: 'Urgent', cost: 650, keys: ['gas leak', 'carbon monoxide', 'sewage', 'burst pipe', 'sparking', 'exposed wire', 'flooding', 'no power', 'no water'] },
  { severity: 'Urgent', cost: 450, keys: ['active leak', 'leak', 'water damage', 'mold', 'double-tapped', 'double tapped'] },
  { severity: 'Repair', cost: 300, keys: ['shingle', 'roof', 'crack', 'broken', 'damaged', 'damage', 'rot', 'corrosion', 'rust', 'missing', 'loose', 'stain'] },
  { severity: 'Repair', cost: 260, keys: ['breaker', 'panel', 'outlet', 'gfci', 'furnace', 'hvac', 'water heater', 'drain', 'faucet', 'toilet'] },
  { severity: 'Monitor', cost: 120, keys: ['monitor', 'minor', 'cosmetic', 'aging', 'watch', 'worn', 'filter', 'caulk', 'paint'] },
  { severity: 'Good', cost: 0, keys: ['good condition', 'no issues', 'no issue', 'working properly', 'new ', 'replaced', 'operational', 'functional'] },
];

function detectArea(text) {
  const lower = ` ${text.toLowerCase()} `;
  for (const area of AREAS) {
    if (lower.includes(area)) {
      return area.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return 'General';
}

function fallbackStructure(notes) {
  let chunks = String(notes || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length <= 1 && chunks[0] && chunks[0].length > 140) {
    chunks = chunks[0].split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  }
  return chunks.map((chunk) => {
    const lower = chunk.toLowerCase();
    let rule = RULES.find((r) => r.keys.some((k) => lower.includes(k)));
    if (!rule) rule = { severity: 'Monitor', cost: 150 };
    const title = chunk.charAt(0).toUpperCase() + chunk.slice(1);
    return {
      area: detectArea(chunk),
      title: title.length > 110 ? `${title.slice(0, 107)}…` : title,
      detail: `${title.replace(/[.\s]+$/, '')}. Documented during the inspection; see attached photos where available.`,
      severity: rule.severity,
      cost: rule.cost,
    };
  });
}

function fallbackPolish(finding) {
  const tidy = (s) =>
    String(s || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^./, (c) => c.toUpperCase());
  const title = tidy(finding.title) || 'Finding';
  let detail = tidy(finding.detail);
  if (detail && !/[.!?]$/.test(detail)) detail += '.';
  return { title, detail };
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fallbackSummary(report, findings) {
  const total = findings.reduce((sum, f) => sum + Number(f.cost || 0), 0);
  const urgent = findings.filter((f) => f.severity === 'Urgent').length;
  const where = report.address ? ` at ${report.address}` : '';
  if (!findings.length) {
    return `A home inspection was completed${where}. No findings have been recorded yet.`;
  }
  return (
    `A home inspection was completed${where}. ${findings.length} finding` +
    `${findings.length === 1 ? ' was' : 's were'} documented` +
    `${urgent ? `, including ${urgent} urgent item${urgent === 1 ? '' : 's'} that should be addressed promptly` : ''}. ` +
    `The total estimated cost of recommended repairs is ${money(total)}. ` +
    `See the findings below for details, severity ratings, and photos for each item.`
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

async function structureNotes(notes) {
  const parsed = await chatJSON(
    'You structure home-inspection field notes into report findings. ' +
      'Respond with a JSON object: {"findings":[{"area":"Kitchen","title":"short title",' +
      '"detail":"1-2 professional sentences","severity":"Good|Monitor|Repair|Urgent",' +
      '"cost":250}]}. "cost" is a realistic USD repair estimate (number, no symbols). ' +
      'Severity: Good = sound condition, Monitor = watch/minor, Repair = needs repair, ' +
      'Urgent = safety hazard or active damage. One finding per distinct issue in the notes.',
    `Field notes:\n${notes}`
  );
  if (parsed && Array.isArray(parsed.findings) && parsed.findings.length) {
    return parsed.findings.map((f) => cleanFinding(f));
  }
  return fallbackStructure(notes);
}

async function polishFinding(finding) {
  const parsed = await chatJSON(
    'You rewrite home-inspection finding text so it reads professionally for a client report. ' +
      'Keep the meaning and facts identical; do not invent details. ' +
      'Respond with JSON: {"title":"...","detail":"..."}.',
    JSON.stringify({ title: finding.title || '', detail: finding.detail || '' })
  );
  if (parsed && (parsed.title || parsed.detail)) {
    return {
      title: String(parsed.title || finding.title || '').slice(0, 160),
      detail: String(parsed.detail || finding.detail || '').slice(0, 4000),
    };
  }
  return fallbackPolish(finding);
}

async function summarizeReport(report, findings) {
  const parsed = await chatJSON(
    'You write a short executive summary (3-5 sentences) for a home-inspection report. ' +
      'Professional, factual tone. Mention the number of findings, how many are urgent, ' +
      'and the total estimated repair cost. Respond with JSON: {"summary":"..."}.',
    JSON.stringify({
      address: report.address,
      findings: findings.map((f) => ({
        area: f.area, title: f.title, severity: f.severity, cost: Number(f.cost || 0),
      })),
    })
  );
  if (parsed && parsed.summary) return String(parsed.summary).slice(0, 4000);
  return fallbackSummary(report, findings);
}

module.exports = { structureNotes, polishFinding, summarizeReport, aiConfigured, SEVERITIES };
