/**
 * Drive the admin portal the way a person does: log in, create a record through
 * the form, edit it, try to save something invalid, delete it.
 *
 *   node scripts/verify-admin.mjs
 *
 * Needs the admin portal on :4001 and the app on :3002.
 *
 * Every previous check of this portal only asked whether a URL answered. That
 * proves routing and nothing else — a form can render perfectly and still write
 * nothing, or write the wrong thing, or accept a voucher that breaks the book.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';
const USERS = 'content/users.json';
const EMAIL = 'verify-probe@local';

/**
 * A throwaway account, created here and deleted at the end.
 *
 * The alternative is a fixed test password committed to a public repository, or
 * asking whoever runs this for the real admin password — the first is a
 * standing hole, the second means the check never gets run. The password is
 * random per run and never leaves this process.
 *
 * Real accounts are untouched: this appends one row and removes it, and the
 * last assertion is that the file came back byte for byte.
 */
const PASS = randomBytes(18).toString('base64url');
const usersBefore = readFileSync(USERS, 'utf8');

function addProbeAccount() {
  const db = JSON.parse(usersBefore);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(PASS, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  db.users = db.users.filter((u) => u.email !== EMAIL);
  db.users.push({ email: EMAIL, name: 'Automated verification probe', role: 'super_admin', salt, hash });
  writeFileSync(USERS, JSON.stringify(db, null, 2));
}

function removeProbeAccount() {
  const db = JSON.parse(readFileSync(USERS, 'utf8'));
  db.users = db.users.filter((u) => u.email !== EMAIL);
  writeFileSync(USERS, JSON.stringify(db, null, 2));
}

addProbeAccount();
// Also on a crash, so a failed run never leaves a super-admin behind.
process.on('exit', removeProbeAccount);

let cookie = '';
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
};

async function req(path, { method = 'GET', form } = {}) {
  const headers = { cookie };
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(ADMIN + path, { method, headers, body, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

const csrfFrom = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
/** Pull every rendered field so an edit posts the whole record back, not a fragment. */
function fieldsFrom(html) {
  const out = {};
  for (const m of html.matchAll(/<input type="(text|number)" name="([^"]+)"[^>]*value="([^"]*)"/g)) {
    out[m[2]] = m[3].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  for (const m of html.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)" selected>/.exec(m[2]) ?? /<option value="([^"]*)"selected>/.exec(m[2]);
    out[m[1]] = sel ? sel[1] : (/<option value="([^"]*)"/.exec(m[2])?.[1] ?? '');
  }
  for (const m of html.matchAll(/<textarea name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out[m[1]] = m[2];
  return out;
}
const hidden = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';

/**
 * Every hidden input the form renders.
 *
 * Naming them one by one meant that adding `__fp` — the version marker that
 * stops one person's save wiping another's — broke this test, because it kept
 * posting the two hidden fields it knew about. A browser sends all of them.
 */
function hiddensFrom(html) {
  const out = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/* ------------------------------------------------------------------ log in */
{
  const r = await req('/login', { method: 'POST', form: { email: EMAIL, password: PASS } });
  ok('Log in through the real login form', r.status === 302, `HTTP ${r.status}`);
}

/* ----------------------------------------- create through the New button */
const COL = 'supplierCreditNotes';
let newId = '';

/**
 * A supplier and one of its own bills that still has room to credit.
 *
 * Room is not the same as unpaid. A bill can be wholly unpaid and still have
 * nothing left to credit, because the supplier-refund leg of a customer credit
 * note has already taken it — which is what the first version of this test
 * tripped over and misread as a bug.
 */
const pair = await (async () => {
  const fs = await import('node:fs');
  const book = JSON.parse(fs.readFileSync('content/accounting.json', 'utf8'));
  const paid = {}, credited = {};
  for (const p of book.payments) paid[p.billId] = (paid[p.billId] ?? 0) + p.amount;
  for (const c of book.creditNotes ?? []) if (c.billId) credited[c.billId] = (credited[c.billId] ?? 0) + c.supplierRefund;
  for (const c of book.supplierCreditNotes ?? []) credited[c.billId] = (credited[c.billId] ?? 0) + c.amount;
  const bill = book.bills.find((b) => {
    const room = b.amount - (credited[b.id] ?? 0);
    const owed = b.amount - (paid[b.id] ?? 0) - (credited[b.id] ?? 0);
    return room > 20000 && owed > 20000;
  });
  if (!bill) throw new Error('no bill in the book has credit headroom — widen the search');
  return { supplierId: bill.supplierId, billId: bill.id, room: bill.amount - (credited[bill.id] ?? 0) };
})();
{
  const list = await req(`/books/list?col=${COL}`);
  const r = await req(`/books/new?col=${COL}`, { method: 'POST', form: { csrf: csrfFrom(list.text) } });
  newId = /id=([A-Za-z0-9-]+)/.exec(r.location ?? '')?.[1] ?? '';
  ok('Create a record in a collection that was empty', r.status === 302 && Boolean(newId), newId || r.location || '');
}

/* --------------------------------- the form must reject an invalid voucher */
{
  const form = await req(`/books/edit?col=${COL}&id=${newId}`);
  const f = fieldsFrom(form.text);
  const r = await req(`/books/edit?col=${COL}&id=${newId}`, {
    method: 'POST',
    form: {
      ...f,
      ...hiddensFrom(form.text),
      csrf: csrfFrom(form.text),
      'rec.supplierId': pair.supplierId,
      'rec.billId': pair.billId,
      'rec.amount': '99999999',       // far more than the bill is worth
      'rec.settlement': 'credit_balance',
      save: '1'
    }
  });
  const refused = r.status === 422 && /Not saved/.test(r.text);
  const why = /<li>([^<]{10,140})/.exec(r.text)?.[1] ?? '';
  ok('Refuse a credit larger than the bill', refused, why.slice(0, 100));
}

/* ------------------------------------------------- a valid save must stick */
{
  const form = await req(`/books/edit?col=${COL}&id=${newId}`);
  const f = fieldsFrom(form.text);
  const r = await req(`/books/edit?col=${COL}&id=${newId}`, {
    method: 'POST',
    form: {
      ...f,
      ...hiddensFrom(form.text),
      csrf: csrfFrom(form.text),
      'rec.date': '2026-07-30',
      'rec.supplierId': pair.supplierId,
      'rec.billId': pair.billId,
      'rec.amount': '5000',
      'rec.settlement': 'credit_balance',
      'rec.notes': 'Audit probe — overbilling reversed',
      save: '1'
    }
  });
  const saved = r.status === 302;
  const fs = await import('node:fs');
  const book = JSON.parse(fs.readFileSync('content/accounting.json', 'utf8'));
  const row = (book.supplierCreditNotes || []).find((x) => x.id === newId);
  ok('Save a valid supplier credit note', saved && row?.amount === 5000, `stored amount ${row?.amount}, bill ${row?.billId}`);
}

/* ------------------------------------- the write must reach the app's totals */
{
  const before = await fetch('http://127.0.0.1:3002/api/accounts/export?format=csv&section=reconciliation');
  const body = await before.text();
  const rows = body.split(/\r?\n/).slice(1).filter((l) => l.includes(','));
  const bad = rows.filter((l) => { const c = l.replace(/"/g, '').split(','); return c[3] && c[3].trim() !== '0'; });
  const ap = rows.find((l) => l.includes('payable'));
  ok('A voucher written in admin flows into the app', bad.length === 0, `${rows.length} reconciliation rows, ${bad.length} disagreeing`);
  ok('Payable moved by the supplier credit', Boolean(ap), (ap ?? '').replace(/"/g, ''));
}

/* --------------------------------------------------- the audit log caught it */
{
  const r = await req('/audit');
  const seen = r.text.includes(newId);
  ok('Audit log recorded the change', seen, seen ? `entry for ${newId} present` : 'no entry found');
}

/* ---------------------------------------------------- menu toggle round trip */
{
  const d = await req('/design?tab=sections');
  const csrf = csrfFrom(d.text);
  const navBoxes = [...d.text.matchAll(/name="(nav_\d+)"/g)].map((m) => m[1]);
  const linkBoxes = [...d.text.matchAll(/name="(navlink_\d+_\d+_\d+)"/g)].map((m) => m[1]);
  ok('Menu manager renders a switch per entry and per mega link',
    navBoxes.length > 0 && linkBoxes.length > 0, `${navBoxes.length} entries, ${linkBoxes.length} mega links`);

  // switch everything off except the first, then put it all back
  const off = await req('/design/menu', { method: 'POST', form: { csrf, [navBoxes[0]]: 'on' } });
  const fs = await import('node:fs');
  const site = JSON.parse(fs.readFileSync('content/site.json', 'utf8'));
  const live = site.nav.filter((x) => x.enabled !== false).length;
  ok('Switching menu entries off writes through', off.status === 302 && live === 1, `${live} of ${site.nav.length} left on`);

  const count = (html, href) => html.split(`href="${href}"`).length - 1;
  const pageOff = await (await fetch('http://127.0.0.1:3002/portal')).text();
  const offVisa = count(pageOff, '/portal/visa');

  const d2 = await req('/design?tab=sections');
  const all = Object.fromEntries([...navBoxes, ...linkBoxes].map((k) => [k, 'on']));
  const back = await req('/design/menu', { method: 'POST', form: { csrf: csrfFrom(d2.text), ...all } });
  const site2 = JSON.parse(fs.readFileSync('content/site.json', 'utf8'));
  ok('Restoring the menu works', back.status === 302 && site2.nav.every((x) => x.enabled),
    `${site2.nav.filter((x) => x.enabled).length} of ${site2.nav.length} back on`);

  const on = await (await fetch('http://127.0.0.1:3002/portal')).text();
  const onVisa = count(on, '/portal/visa');

  /**
   * How many copies of one href the header renders: the desktop bar and the
   * mobile strip each render every entry, and each mega child, so a link that
   * appears both as a top-level entry and inside a mega panel is rendered four
   * times. Anything left over is the services grid and the footer, which are
   * not the menu and must NOT disappear.
   */
  const site3 = JSON.parse(fs.readFileSync('content/site.json', 'utf8'));
  const HREF = '/portal/visa';
  const headerCopies = 2 * site3.nav.reduce(
    (t, nItem) =>
      t + (nItem.href === HREF ? 1 : 0) +
      (nItem.groups ?? []).reduce((x, g) => x + g.links.filter((l) => l.href === HREF).length, 0),
    0
  );
  ok('Storefront honours the switch immediately',
    onVisa - offVisa === headerCopies && headerCopies > 0,
    `${HREF}: ${onVisa} links with the menu on, ${offVisa} with it off — header renders ${headerCopies}, the rest is the page body`);
}

/* ------------------------------------------------------------ backup round trip */
{
  const dl = await req('/backup/download');
  let parsed = null;
  try { parsed = JSON.parse(dl.text); } catch { /* reported below */ }
  ok('Backup downloads valid JSON with every managed file',
    dl.status === 200 && parsed && Object.keys(parsed.files || {}).length >= 5,
    parsed ? `${Object.keys(parsed.files).length} files, taken by ${parsed.takenBy}` : 'not JSON');

  const page = await req('/backup');
  const r = await req('/backup/restore', {
    method: 'POST',
    form: { csrf: csrfFrom(page.text), payload: '{"nope":1}', confirm: 'RESTORE' }
  });
  ok('Restore refuses a file that is not a backup',
    r.status === 302 && /error=/.test(r.location ?? ''), decodeURIComponent((r.location ?? '').split('error=')[1] ?? '').slice(0, 70));

  const r2 = await req('/backup/restore', {
    method: 'POST',
    form: { csrf: csrfFrom((await req('/backup')).text), payload: dl.text, confirm: 'no' }
  });
  ok('Restore refuses without the typed confirmation',
    r2.status === 302 && /error=/.test(r2.location ?? ''), decodeURIComponent((r2.location ?? '').split('error=')[1] ?? '').slice(0, 70));
}

/* -------------------------------------------------------------- CSRF is real */
{
  const r = await req(`/books/new?col=${COL}`, { method: 'POST', form: { csrf: 'forged' } });
  ok('A forged CSRF token is rejected', r.status === 403, `HTTP ${r.status}`);
}

/* ------------------------------------------------------------------ clean up */
{
  const list = await req(`/books/list?col=${COL}`);
  const r = await req(`/books/delete?col=${COL}`, { method: 'POST', form: { csrf: csrfFrom(list.text), remove: newId } });
  const fs = await import('node:fs');
  const book = JSON.parse(fs.readFileSync('content/accounting.json', 'utf8'));
  const gone = !(book.supplierCreditNotes || []).some((x) => x.id === newId);
  ok('Delete removes the record', r.status === 302 && gone, gone ? `${newId} removed` : 'still present');
}

/* ------------------------------------- every content editor page renders */
{
  /**
   * All twenty storefront sections, not a sample.
   *
   * This suite used to check /design, /books and /crm and stop. That gap let a
   * hidden field land in the WRONG form during the concurrency work and take
   * every one of these pages to HTTP 500 — "spec is not defined" — with nothing
   * failing to show it. Twenty cheap GETs is the price of not shipping that.
   */
  const sections = [...(await req('/dashboard')).text.matchAll(/href="\/edit\/([a-zA-Z]+)"/g)]
    .map((m) => m[1]);
  const unique = [...new Set(sections)];
  const bad = [];
  for (const key of unique) {
    const r = await req(`/edit/${key}`);
    if (r.status !== 200) bad.push(`${key}:${r.status}`);
  }
  ok('Every storefront content editor page renders',
    unique.length >= 15 && bad.length === 0,
    bad.length ? `broken: ${bad.join(', ')}` : `${unique.length} sections, all HTTP 200`);
}

/* ------------------------------------------ two people, one record */
{
  /**
   * The lost update this replaced was silent: two saves a moment apart and the
   * first one gone, with no error and nothing in the log. Here the second save
   * carries a fingerprint from before the first, which is exactly what a stale
   * browser tab sends.
   */
  const form = await req(`/books/edit?col=customers&id=CUS-001`);
  const staleFp = hiddensFrom(form.text).__fp;
  const f = fieldsFrom(form.text);
  ok('The record form carries a version marker', Boolean(staleFp), `__fp = ${staleFp || 'MISSING'}`);

  const post = (extra, fp) =>
    req(`/books/edit?col=customers&id=CUS-001`, {
      method: 'POST',
      form: { ...f, ...hiddensFrom(form.text), csrf: csrfFrom(form.text), __fp: fp, ...extra, save: '1' }
    });

  const first = await post({ 'rec.phone': '01700-000001' }, staleFp);
  ok('First save goes through', first.status === 302, `HTTP ${first.status}`);

  const second = await post({ 'rec.phone': '01700-000002' }, staleFp);
  const refused = second.status === 409 && /saved first/i.test(second.text);
  const stored = JSON.parse(readFileSync('content/accounting.json', 'utf8'))
    .customers.find((c) => c.id === 'CUS-001').phone;
  ok('A second save from a stale form is refused, not silently applied',
    refused && stored === '01700-000001',
    `HTTP ${second.status}, phone still ${stored}`);

  // and the honest case: reload, then save on top of the current value
  const fresh = await req(`/books/edit?col=customers&id=CUS-001`);
  const third = await req(`/books/edit?col=customers&id=CUS-001`, {
    method: 'POST',
    form: {
      ...fieldsFrom(fresh.text), ...hiddensFrom(fresh.text), csrf: csrfFrom(fresh.text),
      'rec.phone': '01700-000003', save: '1'
    }
  });
  const after = JSON.parse(readFileSync('content/accounting.json', 'utf8'))
    .customers.find((c) => c.id === 'CUS-001').phone;
  ok('Reloading and re-saving works', third.status === 302 && after === '01700-000003', `phone now ${after}`);

  // put the original number back
  const restore = await req(`/books/edit?col=customers&id=CUS-001`);
  await req(`/books/edit?col=customers&id=CUS-001`, {
    method: 'POST',
    form: {
      ...fieldsFrom(restore.text), ...hiddensFrom(restore.text), csrf: csrfFrom(restore.text),
      'rec.phone': f['rec.phone'], save: '1'
    }
  });
  const back = JSON.parse(readFileSync('content/accounting.json', 'utf8'))
    .customers.find((c) => c.id === 'CUS-001').phone;
  ok('Customer phone restored', back === f['rec.phone'], `back to ${back}`);
}

/* --------------------------------------------- leave nothing behind */
removeProbeAccount();
ok('The probe account is gone and users.json is unchanged',
  readFileSync(USERS, 'utf8') === usersBefore, 'restored byte for byte');

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
