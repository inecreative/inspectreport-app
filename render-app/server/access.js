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
 */

const db = require('./db');

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
  userByEmail,
  userById,
  setSubscribedByEmail,
};
