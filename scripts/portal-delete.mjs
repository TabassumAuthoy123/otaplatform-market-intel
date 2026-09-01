/**
 * Delete book records through the admin portal, from the command line.
 *
 * Same reason portal-record.mjs exists: editing content/accounting.json directly skips the
 * period lock, the audit entry and the atomic write, and a record removed that way leaves no
 * trace that it ever existed or who took it out.
 *
 *   PW=... node portal-delete.mjs supplierCreditNotes SCN-0002 SCN-0003
 */
import { readFileSync } from 'node:fs';

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@softifybd.com';
const [, , collection, ...ids] = process.argv;
if (!collection || !ids.length) {
  console.error('usage: PW=... node portal-delete.mjs <collection> <id> [id...]');
  process.exit(2);
}
if (!process.env.PW) {
  console.error('Set PW to the admin password. It is never taken from the command line.');
  process.exit(2);
}

const login = await fetch(`${ADMIN}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: EMAIL, password: process.env.PW }).toString()
});
const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('ota_admin='));
if (!cookie) { console.error(`login failed: HTTP ${login.status}`); process.exit(1); }

for (const id of ids) {
  const list = await (await fetch(`${ADMIN}/books?col=${encodeURIComponent(collection)}`, { headers: { cookie } })).text();
  const csrf = (list.match(/name="csrf" value="([^"]*)"/) || [])[1] || '';
  const res = await fetch(`${ADMIN}/books/delete?col=${encodeURIComponent(collection)}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, remove: id }).toString()
  });
  const book = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const gone = !(book[collection] || []).some((r) => r.id === id);
  console.log(`  ${id}  ${res.status === 302 && gone ? 'removed' : `NOT removed (HTTP ${res.status})`}`);
}
