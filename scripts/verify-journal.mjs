/**
 * Manual journal vouchers, end to end: the portal writes one, the app renders it, and
 * the reconciliation survives it.
 *
 *   node scripts/verify-journal.mjs
 *
 * Needs the admin portal on :4001 and the app on :3002.
 *
 * WHY THE RECONCILIATION ASSERTIONS ARE THE POINT OF THIS FILE
 *
 * A journal voucher posts to the ledger and to nothing else. This book's central
 * safety property is that the same figures are derived twice by independent routes
 * and cross-checked, so the moment a voucher touches a control account those two
 * routes stop agreeing through no fault of either. The design answer was to STATE the
 * adjustment rather than to hide it or to ban the entry — see lib/journals.ts. These
 * checks are what stop that from silently becoming "the difference column got wider".
 *
 * The book is restored byte for byte at the end and on a crash.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { signedInProbe } from './lib/probe-session.mjs';

const ADMIN = 'http://127.0.0.1:4001';
const APP = 'http://127.0.0.1:3002';
const BOOK = 'content/accounting.json';
const bookBefore = readFileSync(BOOK, 'utf8');
process.on('exit', () => writeFileSync(BOOK, bookBefore));

// give the book somewhere to post to
const db = JSON.parse(bookBefore);
/**
 * Appended, never assigned over.
 *
 * The first version replaced `ledgerAccounts` outright, which left the seeded vouchers
 * pointing at accounts that no longer existed — and the journal trial balance came
 * apart by 10,200 with nothing on screen to explain it. That turned out to be a real
 * defect in `summariseBalances` rather than a test artefact, so it is fixed there and
 * the test stops causing it here; both were worth doing.
 */
const need = [
  { id: 'JVT-0001', code: 'JVTDEP', name: 'Test depreciation expense', group: 'expense', note: '' },
  { id: 'JVT-0002', code: 'JVTACC', name: 'Test accumulated depreciation', group: 'liability', note: '' },
  { id: 'JVT-0003', code: 'JVTSUS', name: 'Test suspense', group: 'asset', note: '' }
];
db.ledgerAccounts = [...(db.ledgerAccounts || []).filter((a) => !need.some((n) => n.id === a.id)), ...need];
writeFileSync(BOOK, JSON.stringify(db, null, 2));

const results = [];
const ok = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
};

const s = await signedInProbe({ admin: ADMIN, app: APP, roles: ['super_admin', 'accountant', 'manager'], prefix: 'jv-probe-' });
const suCookie = s.cookie;

async function portal(path, opts = {}) {
  // Headers merged and applied LAST. Spreading `opts` over an options object that
  // already had `headers` replaced the whole header bag, cookie included — so every
  // POST arrived anonymous and redirected to /login, which read exactly like the
  // route guard rejecting them.
  const { cookie, headers, ...rest } = opts;
  const r = await fetch(`${ADMIN}${path}`, {
    redirect: 'manual',
    ...rest,
    headers: { cookie: cookie || suCookie, ...(headers || {}) }
  });
  return { status: r.status, location: r.headers.get('location') || '', body: await r.text() };
}
const csrfOf = (html) => (html.match(/name="csrf" value="([^"]+)"/) || [])[1];

/* ---------------------------------------------------------- the screen */
const screen = await portal('/journal');
ok('the journal screen loads for a super_admin', screen.status === 200 && /Post a voucher/.test(screen.body), `HTTP ${screen.status}`);
ok('the chart offers the accountant\'s own accounts', /Test depreciation expense/.test(screen.body), 'the account THIS test created is selectable, not the seeded one');
ok('control accounts are labelled as such', /Accounts receivable — control/.test(screen.body), 'so nobody posts to one unaware');

const csrf = csrfOf(screen.body);

async function post(fields, cookie) {
  const body = new URLSearchParams();
  body.set('csrf', csrfOf((await portal('/journal', { cookie })).body) || csrf);
  for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) body.append(k, String(one));
  return portal('/journal/new', { method: 'POST', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
}

/* ------------------------------------------------- refusals come first */
const unbalanced = await post({
  date: '2026-08-10', narration: 'Depreciation',
  line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['5000', ''], line_credit: ['', '4000'], line_memo: ['', '']
});
ok('an unbalanced voucher is refused', unbalanced.status === 422 && /out by 1000/.test(unbalanced.body), `HTTP ${unbalanced.status}`);
ok('the refusal hands the typed voucher back', /value="Depreciation"/.test(unbalanced.body), 'nothing to retype');

const noNarration = await post({
  date: '2026-08-10', narration: '',
  line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['5000', ''], line_credit: ['', '5000'], line_memo: ['', '']
});
ok('a voucher with no narration is refused', noNarration.status === 422 && /narration is required/.test(noNarration.body), `HTTP ${noNarration.status}`);

const oneLine = await post({
  date: '2026-08-10', narration: 'Half an entry',
  line_account: ['GL:JVTDEP'], line_debit: ['5000'], line_credit: [''], line_memo: ['']
});
ok('a one-line voucher is refused', oneLine.status === 422 && /at least two lines/.test(oneLine.body), `HTTP ${oneLine.status}`);

const bothSides = await post({
  date: '2026-08-10', narration: 'Debit and credit on one line',
  line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['5000', '0'], line_credit: ['5000', '5000'], line_memo: ['', '']
});
ok('a line that is both a debit and a credit is refused', bothSides.status === 422 && /not both/.test(bothSides.body), `HTTP ${bothSides.status}`);

const unknown = await post({
  date: '2026-08-10', narration: 'Made-up account',
  line_account: ['GL:NOPE', 'GL:JVTACC'], line_debit: ['5000', ''], line_credit: ['', '5000'], line_memo: ['', '']
});
ok('an account not in the chart is refused', unknown.status === 422 && /not an account in this book/.test(unknown.body), `HTTP ${unknown.status}`);

/* ------------------------------------------------------ the period lock */
{
  const cur = JSON.parse(readFileSync(BOOK, 'utf8'));
  cur.lockedThrough = '2026-08-31';
  writeFileSync(BOOK, JSON.stringify(cur, null, 2));
  const locked = await post({
    date: '2026-08-10', narration: 'Into a closed month',
    line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['5000', ''], line_credit: ['', '5000'], line_memo: ['', '']
  });
  ok('a voucher dated inside a closed period is refused',
    locked.status === 422 && /closed period/.test(locked.body), `HTTP ${locked.status}`);
  const reopened = JSON.parse(readFileSync(BOOK, 'utf8'));
  reopened.lockedThrough = null;
  writeFileSync(BOOK, JSON.stringify(reopened, null, 2));
}

/* --------------------------------------------------------- the good one */
const good = await post({
  date: '2026-08-10', narration: 'Depreciation for August',
  line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['5000', ''], line_credit: ['', '5000'], line_memo: ['office fit-out', '']
});
ok('a balanced voucher posts', good.status === 302 && good.location.includes('posted='),
  good.status === 302 ? `HTTP 302 -> ${good.location}` : `HTTP ${good.status}: ${(good.body.match(/<li>([^<]+)<\/li>/g) || []).join(' ') || 'no error list'}`);

const afterOne = JSON.parse(readFileSync(BOOK, 'utf8'));
// Found by narration, not by position. The demo book ships seeded vouchers, so index
// 0 is somebody else's — asserting on it tested the seed rather than the post.
const mine = (afterOne.journalEntries || []).find((v) => v.narration === 'Depreciation for August');
ok('it is written to the book with a number and an author',
  !!mine && /^SFT-JV-[0-9]{4}$/.test(mine.no) && mine.createdBy.startsWith('jv-probe-'),
  mine ? `${mine.no} by ${mine.createdBy}` : 'not found in the book');

/* -------------------------------------------- a control account voucher */
const control = await post({
  date: '2026-08-10', narration: 'Opening receivable brought in from the old system',
  line_account: ['AR', 'GL:JVTSUS'], line_debit: ['7000', ''], line_credit: ['', '7000'], line_memo: ['', '']
});
ok('a voucher touching a control account posts, it is not banned', control.status === 302, `HTTP ${control.status}`);

const recon = await (await fetch(`${APP}/api/accounts/export?format=csv&section=reconciliation`)).text();
const arRow = recon.split(/\r?\n/).find((l) => l.startsWith('"Accounts receivable"'));
const cells = (arRow || '').match(/"([^"]*)"/g).map((x) => x.slice(1, -1));
ok('the reconciliation shows it as an adjustment and still reads zero',
  cells[2] === '7000' && cells[4] === '0',
  `control ${cells[1]}, adjustment ${cells[2]}, ledger ${cells[3]}, difference ${cells[4]}`);

const items = recon.includes('21B') ? '' : '';
const app = await fetch(`${APP}/accounts/financials`, { headers: { cookie: suCookie } });
const finHtml = await app.text();
ok('the financials page lists the voucher as a reconciling item',
  /Manual vouchers behind the adjustment column/.test(finHtml) && /Opening receivable brought in/.test(finHtml),
  'listed by narration, not netted away');

/* ---------------------------------------------------------- reversal */
const target = JSON.parse(readFileSync(BOOK, 'utf8')).journalEntries.find((v) => v.narration.startsWith('Opening receivable'));
const revBody = new URLSearchParams();
revBody.set('csrf', csrfOf((await portal('/journal')).body));
revBody.set('id', target.id);
const rev = await portal('/journal/reverse', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: revBody.toString() });
ok('a voucher can be reversed', rev.status === 302, `HTTP ${rev.status}`);

const afterRev = JSON.parse(readFileSync(BOOK, 'utf8'));
const original = afterRev.journalEntries.find((v) => v.id === target.id);
const reversal = afterRev.journalEntries.find((v) => v.reversalOf === target.id);
ok('both vouchers are kept and each points at the other',
  !!original.reversedBy && !!reversal && original.reversedBy === reversal.id,
  'nothing deleted, the correction is itself a fact about the month');
ok('the reversal mirrors every line',
  reversal.lines[0].credit === original.lines[0].debit && reversal.lines[1].debit === original.lines[1].credit,
  'debits and credits swapped');

const recon2 = await (await fetch(`${APP}/api/accounts/export?format=csv&section=reconciliation`)).text();
const bad = recon2.split(/\r?\n/).slice(1).filter((l) => l.trim()).filter((l) => {
  const c = l.match(/"([^"]*)"/g).map((x) => x.slice(1, -1));
  return Number(c[c.length - 1]) !== 0;
});
ok('the whole reconciliation is still clean after all of it', bad.length === 0, bad.length ? bad.join(' | ') : 'every difference zero');

/* ------------------------------------------------------------- the RBAC */
const mgr = await s.login('manager');
const mgrRead = await portal('/journal', { cookie: mgr });
ok('a manager may read the journal', mgrRead.status === 200, `HTTP ${mgrRead.status}`);
ok('but is not offered the posting form', !/Post a voucher/.test(mgrRead.body), 'told why instead');
const mgrPost = await post({
  date: '2026-08-11', narration: 'Manager tries to post',
  line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['100', ''], line_credit: ['', '100'], line_memo: ['', '']
}, mgr);
ok('and a manager POST is refused at the route, not just hidden', mgrPost.status === 403, `HTTP ${mgrPost.status}`);

const acct = await s.login('accountant');
const acctPost = await post({
  date: '2026-08-11', narration: 'Accrue an unbilled courier charge',
  line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['250', ''], line_credit: ['', '250'], line_memo: ['', '']
}, acct);
ok('an accountant may post', acctPost.status === 302, `HTTP ${acctPost.status}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
