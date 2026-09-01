/**
 * Create or edit a book record through the admin portal, from the command line.
 *
 *   PW=... node scripts/portal-record.mjs payments '{"supplierId":"SUP-002","amount":100000}'
 *   PW=... node scripts/portal-record.mjs payments '{"amount":5000}' PAY-0007
 *
 * WHY THIS EXISTS RATHER THAN EDITING content/accounting.json
 *
 * Writing the JSON directly is quicker and skips everything that makes a write safe: the
 * validators, the period lock, the fingerprint concurrency check, the atomic write and the
 * audit entry. A record created that way looks identical afterwards and proves nothing —
 * the whole point of exercising a code path is that the code actually ran.
 *
 * It exists because several features had a route, a form, a validator and a journal
 * account, and no data had ever gone through any of them. Supplier-deposit drawdowns, FX
 * settlements, supplier credit notes: all wired, none exercised. Filling them in by hand
 * would have left the same hole.
 *
 * The password comes from the PW environment variable, never an argument — argv is visible
 * in `ps` and in shell history.
 */

import { readFileSync } from 'node:fs';

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@softifybd.com';

const [, , collection, patchJson, existingId] = process.argv;
if (!collection || !patchJson) {
  console.error('usage: PW=... node scripts/portal-record.mjs <collection> \'{"field":"value"}\' [existingId]');
  process.exit(2);
}
if (!process.env.PW) {
  console.error('Set PW to the admin password. It is never taken from the command line.');
  process.exit(2);
}
const patch = JSON.parse(patchJson);

const login = await fetch(`${ADMIN}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: EMAIL, password: process.env.PW }).toString()
});
const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('ota_admin='));
if (!cookie) {
  console.error(`login failed: HTTP ${login.status}`);
  process.exit(1);
}

const form = (url) => fetch(url, { headers: { cookie } }).then((r) => r.text());
const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];

let id = existingId;
if (!id) {
  const list = await form(`${ADMIN}/books?col=${encodeURIComponent(collection)}`);
  const csrf = field(list, 'csrf');
  const made = await fetch(`${ADMIN}/books/new?col=${encodeURIComponent(collection)}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }).toString()
  });
  id = (made.headers.get('location') || '').replace(/.*id=/, '').replace(/&.*/, '');
  if (!id) {
    console.error(`could not create a blank ${collection}: HTTP ${made.status}`);
    process.exit(1);
  }
}

/**
 * Every field the edit form carries is posted back, with the patch applied on top.
 *
 * Posting only the changed fields would blank the rest — the handler replaces the record
 * with what the form sends, which is what a browser does when a person clicks Save.
 */
const page = await form(`${ADMIN}/books/edit?col=${encodeURIComponent(collection)}&id=${encodeURIComponent(id)}`);
const body = new URLSearchParams();
body.set('csrf', field(page, 'csrf') || '');
for (const hidden of ['__fp', '__nums', '__bools']) {
  const v = field(page, hidden);
  if (v !== undefined) body.set(hidden, v);
}
for (const m of page.matchAll(/name="(rec\.[a-zA-Z0-9_]+)"(?:[^>]*?value="([^"]*)")?/g)) {
  const key = m[1].slice(4);
  body.set(m[1], Object.prototype.hasOwnProperty.call(patch, key) ? String(patch[key]) : (m[2] ?? ''));
}
// A select renders its value on the option, not the element, so pick the selected one.
for (const sel of page.matchAll(/<select name="(rec\.[a-zA-Z0-9_]+)"[\s\S]*?<\/select>/g)) {
  const key = sel[1].slice(4);
  if (Object.prototype.hasOwnProperty.call(patch, key)) { body.set(sel[1], String(patch[key])); continue; }
  const chosen = sel[0].match(/<option value="([^"]*)" selected/);
  body.set(sel[1], chosen ? chosen[1] : '');
}
for (const [k, v] of Object.entries(patch)) if (!body.has(`rec.${k}`)) body.set(`rec.${k}`, String(v));

const saved = await fetch(`${ADMIN}/books/edit?col=${encodeURIComponent(collection)}&id=${encodeURIComponent(id)}`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString()
});

if (saved.status === 302) {
  const book = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const rec = (book[collection] || []).find((r) => r.id === id);
  console.log(`${id}  saved`);
  console.log(JSON.stringify(rec));
} else {
  const html = await saved.text();
  const errs = [...html.matchAll(/<li[^>]*>([^<]{4,200})<\/li>/g)].map((m) => m[1]).slice(0, 6);
  console.error(`HTTP ${saved.status}${errs.length ? '\n  ' + errs.join('\n  ') : ''}`);
  process.exit(1);
}
