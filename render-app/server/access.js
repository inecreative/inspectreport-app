'use strict';

/**
 * Subscription access helpers.
 *
 * A user counts as subscribed when either:
 *  - their `users.subscribed` flag is set (via Stripe webhook or an admin
 *    grant), or
 *  - their email is on the comp list (COMP_EMAILS env var, comma-separated,
 *    case-insensitive; defaults to the founder's email when unset).
 *
 * Comp-listed users are also the ADMINS: they can grant/revoke access for
 * beta testers by email (POST /api/admin/access), and webhook-driven
 * revocations never apply to them.
 *
 * On top of that, every account gets a free TRIAL_DAYS-day trial of full
 * access starting at signup (derived from `users.created_at`; no card is
 * collected). While the trial runs, PDF export is unlocked even without a
 * subscription. Once it ends, access falls back to the subscription rules
 * above — see pdfAccessState(), the single place that decides PDF access.
 */

const db = require('./db');

const TRIAL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_COMP_EMAILS = ['inecreative@gmail.com'];

function compEmails() {
  const raw = process.env.COMP_EMAILS;
  const list = raw
    ? raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_COMP_EMAILS;
  return new Set(list);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isCompEmail(email) {
  return compEmails().has(normalizeEmail(email));
}

function isAdminEmail(email) {
  return isCompEmail(email);
}

/** Effective subscription state for a users table row. */
function subscriptionState(userRow) {
  if (!userRow) return { subscribed: false, subscribedVia: null };
  if (isCompEmail(userRow.email)) return { subscribed: true, subscribedVia: 'comp' };
  if (userRow.subscribed) {
    return { subscribed: true, subscribedVia: userRow.subscribed_via || 'manual' };
  }
  return { subscribed: false, subscribedVia: null };
}

/** Moment the free trial ends for a users row (signup time + TRIAL_DAYS). */
function trialEndsAt(userRow) {
  if (!userRow || !userRow.created_at) return null;
  const created = new Date(userRow.created_at);
  if (Number.isNaN(created.getTime())) return null;
  return new Date(created.getTime() + TRIAL_DAYS * DAY_MS);
}

/**
 * Trial state for a users table row: whether the free trial is still
 * running, when it ends (ISO string, null when unknown), and the whole
 * days left (ceil, so a fresh signup reads 3 and the last day reads 1).
 */
function trialInfo(userRow, now = new Date()) {
  const ends = trialEndsAt(userRow);
  if (!ends) return { inTrial: false, trialEndsAt: null, trialDaysLeft: 0 };
  const msLeft = ends.getTime() - now.getTime();
  const inTrial = msLeft > 0;
  return {
    inTrial,
    trialEndsAt: ends.toISOString(),
    trialDaysLeft: inTrial ? Math.ceil(msLeft / DAY_MS) : 0,
  };
}

/**
 * The one place that decides PDF-download access for a users row.
 * Access comes from, in priority order: the comp list ('comp'), a stored
 * subscription flag ('subscription'), or a still-running free trial
 * ('trial'). Also carries the plain subscription state and trial info so
 * callers (e.g. GET /api/billing) can present each piece accurately.
 */
function pdfAccessState(userRow, now = new Date()) {
  const sub = subscriptionState(userRow);
  const trial = trialInfo(userRow, now);
  let accessVia = null;
  if (sub.subscribedVia === 'comp') accessVia = 'comp';
  else if (sub.subscribed) accessVia = 'subscription';
  else if (trial.inTrial) accessVia = 'trial';
  return {
    hasPdfAccess: sub.subscribed || trial.inTrial,
    accessVia,
    subscribed: sub.subscribed,
    subscribedVia: sub.subscribedVia,
    inTrial: trial.inTrial,
    trialEndsAt: trial.trialEndsAt,
    trialDaysLeft: trial.trialDaysLeft,
  };
}

async function userByEmail(email) {
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [
    normalizeEmail(email),
  ]);
  return rows[0] || null;
}

async function userById(id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Set/clear the stored subscription flag for the account with this email.
 * Returns the updated row, or null when no account has that email.
 * Comp-listed accounts are never modified by revocations: their access
 * comes from the comp list, not the flag.
 */
async function setSubscribedByEmail(email, subscribed, via) {
  const user = await userByEmail(email);
  if (!user) return null;
  if (!subscribed && isCompEmail(user.email)) return user;
  await db.query('UPDATE users SET subscribed = $1, subscribed_via = $2 WHERE id = $3', [
    Boolean(subscribed),
    subscribed ? via || null : null,
    user.id,
  ]);
  return userById(user.id);
}

module.exports = {
  compEmails,
  normalizeEmail,
  isCompEmail,
  isAdminEmail,
  subscriptionState,
  TRIAL_DAYS,
  trialEndsAt,
  trialInfo,
  pdfAccessState,
  userByEmail,
  userById,
  setSubscribedByEmail,
};
