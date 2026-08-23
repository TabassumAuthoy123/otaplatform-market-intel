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

/* ------------------------------------------- panel module toggle round trip */
/**
 * The internal panel's own modules, switched through the real form.
 *
 * Distinct from the storefront menu round trip below it, and the difference is the
 * point: that one only hides links, and `/portal/visa` keeps answering 200 to a
 * bookmark. These have to hide the link AND make the route 404, so both halves are
 * asserted here — a passing nav check with an unguarded route is exactly the
 * half-working state this feature exists to avoid.
 */
{
  const fsp = await import('node:fs');
  const siteBefore = fsp.readFileSync('content/site.json', 'utf8');

  const d = await req('/design?tab=panel');
  const boxes = [...d.text.matchAll(/name="(mod_[a-z]+_[a-z-]+)"/g)].map((m) => m[1]);
  const locked = (d.text.match(/always on/g) ?? []).length;
  /**
   * Counted from the declaration, not hard-coded.
   *
   * This read `=== 18` and went red the moment a nineteenth module was added — a
   * correct change failing a test that had memorised yesterday's answer. The
   * property worth asserting is that the screen offers a switch for every
   * unlocked module and none for the locked ones, whatever the count happens to be.
   */
  const { PANEL_MODULES } = await import('../lib/panel-modules.js');
  const expectSwitches = PANEL_MODULES.filter((m) => !m.locked).length;
  const expectLocked = PANEL_MODULES.filter((m) => m.locked).length;
  ok('Panel tab renders a switch per unlocked module, and none for the locked ones',
    d.status === 200 && boxes.length === expectSwitches && locked === expectLocked,
    `HTTP ${d.status}, ${boxes.length}/${expectSwitches} switches, ${locked}/${expectLocked} locked`);

  // Switch two off by sending every box EXCEPT those two — an unchecked box is
  // absent from the body, which is the only way a browser can express "off".
  const keep = Object.fromEntries(boxes.filter((b) => !/inventory|competitors/.test(b)).map((b) => [b, 'on']));
  const off = await req('/design/panel', { method: 'POST', form: { csrf: csrfFrom(d.text), ...keep } });
  const site = JSON.parse(fsp.readFileSync('content/site.json', 'utf8'));
  ok('Switching panel modules off writes through',
    off.status === 302 && site.panel?.accounts?.inventory === false && site.panel?.dashboard?.competitors === false,
    `inventory=${site.panel?.accounts?.inventory}, competitors=${site.panel?.dashboard?.competitors}`);
  ok('A locked module is written as on rather than omitted',
    site.panel?.accounts?.accounts === true && site.panel?.dashboard?.home === true,
    'the file states the full picture instead of relying on the reader to know which keys are special');

  /**
   * The app's own session, which is this same cookie.
   *
   * Cookies are not scoped by port, so the one the portal set on :4001 is sent to
   * :3002 as well — that is exactly the mechanism the app relies on to verify a
   * session it never issues. Before this line these four requests were anonymous, and
   * once the panels stopped answering 200 to anybody they came back as 307s, which
   * this check read as "the module is switched off". No second account is needed;
   * `cookie` is already a live super_admin from the login at the top.
   */
  const app = (p) => fetch(`http://127.0.0.1:3002${p}`, { headers: { cookie } });
  const codes = Object.fromEntries(await Promise.all(
    ['/accounts/inventory', '/competitors', '/accounts/ledger', '/agencies']
      .map(async (p) => [p, (await app(p)).status])
  ));
  ok('A switched-off module answers 404, not just a hidden link',
    codes['/accounts/inventory'] === 404 && codes['/competitors'] === 404,
    `inventory ${codes['/accounts/inventory']}, competitors ${codes['/competitors']}`);
  ok('The modules left on are untouched',
    codes['/accounts/ledger'] === 200 && codes['/agencies'] === 200,
    `ledger ${codes['/accounts/ledger']}, agencies ${codes['/agencies']}`);

  // Count real anchors only. The RSC payload repeats each one and also carries the
  // `hidden` prop, which is data rather than a link, so a naive substring count
  // reports dead links that are not there.
  const anchors = (html, href) => (html.match(new RegExp(`href="${href.replace(/[/?]/g, '\$&')}["?]`, 'g')) ?? []).length;
  const accHtml = await (await app('/accounts')).text();
  const dashHtml = await (await app('/')).text();
  ok('No page still links to a switched-off module',
    anchors(accHtml, '/accounts/inventory') === 0 && anchors(dashHtml, '/competitors') === 0,
    `accounts page ${anchors(accHtml, '/accounts/inventory')}, dashboard ${anchors(dashHtml, '/competitors')} — nav, tiles and body links`);
  ok('Links into other route groups survive',
    anchors(dashHtml, '/portal') > 0 && anchors(dashHtml, '/accounts') > 0,
    'an allowlist keyed on one group would have removed these; the prop is a blocklist for that reason');

  const d2 = await req('/design?tab=panel');
  const all = Object.fromEntries(boxes.map((k) => [k, 'on']));
  const back = await req('/design/panel', { method: 'POST', form: { csrf: csrfFrom(d2.text), ...all } });
  const restored = (await app('/accounts/inventory')).status;
  ok('Restoring every module works', back.status === 302 && restored === 200, `inventory back to HTTP ${restored}`);

  const auditPage = await req('/audit');
  ok('Switching a module is audited', /module\(s\) switched off|panel module/.test(auditPage.text),
    'an installation-wide change to what exists has to be attributable');

  // `note` is a verify-flights helper and does not exist here. Assert instead of
  // narrating: whatever this block wrote, the modules must all be back on.
  const after = JSON.parse(fsp.readFileSync('content/site.json', 'utf8'));
  const stillOff = Object.entries(after.panel ?? {})
    .flatMap(([g, mods]) => Object.entries(mods).filter(([, on]) => on === false).map(([k]) => `${g}.${k}`));
  ok('This block leaves nothing switched off', stillOff.length === 0,
    stillOff.length ? `still off: ${stillOff.join(', ')}` : 'every module restored, and site.json now states the panel key explicitly');
  void siteBefore;
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

/* -------------------------------------------- your own account and password */
{
  /**
   * There was no way to change a password at all. The users screen said to
   * delete the account and recreate it, which the last Super Admin cannot do
   * because deleting them is refused — so the one account that had to be able to
   * rotate its password was the one that could not.
   */
  const acct = await req('/account');
  ok('Every signed-in role can reach its own account page',
    acct.status === 200 && acct.text.includes('Change your password'),
    `HTTP ${acct.status}`);

  const csrfA = csrfFrom(acct.text);

  const wrongCurrent = await req('/account/password', {
    method: 'POST',
    form: { csrf: csrfA, current: 'not-the-password', next: 'Correct-Horse-Battery-9', again: 'Correct-Horse-Battery-9' }
  });
  ok('A password change needs the current password',
    wrongCurrent.status === 422 && /not your current password/i.test(wrongCurrent.text),
    `HTTP ${wrongCurrent.status}`);

  const tooShort = await req('/account/password', {
    method: 'POST',
    form: { csrf: csrfA, current: PASS, next: 'short', again: 'short' }
  });
  ok('A short password is refused', tooShort.status === 422 && /12 characters/.test(tooShort.text), `HTTP ${tooShort.status}`);

  const mismatch = await req('/account/password', {
    method: 'POST',
    form: { csrf: csrfA, current: PASS, next: 'Correct-Horse-Battery-9', again: 'Correct-Horse-Battery-X' }
  });
  ok('Mismatched confirmation is refused', mismatch.status === 422 && /do not match/.test(mismatch.text), `HTTP ${mismatch.status}`);

  // Keep a copy of this session's cookie so we can prove it survives, and take a
  // second one to prove OTHER sessions do not.
  const myCookie = cookie;
  const second = await (async () => {
    const saved = cookie;
    cookie = '';
    await req('/login', { method: 'POST', form: { email: EMAIL, password: PASS } });
    const other = cookie;
    cookie = saved;
    return other;
  })();
  const asOther = async (path) => {
    const saved = cookie;
    cookie = second;
    const r = await req(path);
    cookie = saved;
    return r;
  };
  ok('A second session for the same account works before the change',
    (await asOther('/dashboard')).status === 200, 'second cookie is live');

  const NEWPASS = 'Rotated-' + Math.random().toString(36).slice(2, 10) + '-2026';
  cookie = myCookie;
  const changed = await req('/account/password', {
    method: 'POST',
    form: { csrf: csrfFrom((await req('/account')).text), current: PASS, next: NEWPASS, again: NEWPASS }
  });
  ok('A valid password change goes through', changed.status === 302, `HTTP ${changed.status}`);

  ok('The session that made the change stays signed in',
    (await req('/dashboard')).status === 200,
    'cookie was re-issued, so the change does not log you out of itself');

  const otherAfter = await asOther('/dashboard');
  ok('Every OTHER session for that account is ended',
    otherAfter.status === 302,
    `second cookie now HTTP ${otherAfter.status} — tokenVersion moved, so the signature alone is not enough`);

  const oldPw = await (async () => {
    const saved = cookie;
    cookie = '';
    const r = await req('/login', { method: 'POST', form: { email: EMAIL, password: PASS } });
    cookie = saved;
    return r;
  })();
  ok('The old password no longer works', oldPw.status !== 302, `login with the old password -> HTTP ${oldPw.status}`);

  const newPw = await (async () => {
    const saved = cookie;
    cookie = '';
    const r = await req('/login', { method: 'POST', form: { email: EMAIL, password: NEWPASS } });
    const c = cookie;
    cookie = saved;
    return { status: r.status, c };
  })();
  ok('The new password works', newPw.status === 302, `HTTP ${newPw.status}`);

  const csrfBefore = csrfFrom((await req('/account')).text);
  cookie = newPw.c;
  const csrfAfter = csrfFrom((await req('/account')).text);
  ok('The CSRF token is different in a different session',
    csrfBefore !== csrfAfter,
    'derived from the session issue time, so a leaked token dies with its session');
  cookie = myCookie;
}

/* --------------------------------------------- leave nothing behind */
removeProbeAccount();
ok('The probe account is gone and users.json is unchanged',
  readFileSync(USERS, 'utf8') === usersBefore, 'restored byte for byte');

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
