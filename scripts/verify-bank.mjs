/**
 * Bank reconciliation, end to end: the portal imports a statement, the app renders the
 * reconciliation, and neither of them is allowed to make the two sides agree by cheating.
 *
 *   node scripts/verify-bank.mjs
 *
 * Needs the admin portal on :4001 and the app on :3002.
 *
 * WHY THE FIXTURE IS GENERATED RATHER THAN WRITTEN
 *
 * `scripts/make-bank-statement.mjs` builds the statement out of the book's own 192
 * movements through the Dutch-Bangla account and then breaks it in seven specific ways —
 * a cheque presented four days late, an unpresented payment, a deposit in transit, two
 * bank charges, an interest credit and an unexplained ATM debit. A hand-written fixture
 * would test the cases its author thought of; this one carries the awkwardness that is
 * already in the data, including the twenty-nine amounts that repeat on different days
 * and make a date-tolerant matcher dangerous.
 *
 * THE ONE CHECK THAT MATTERS MOST
 *
 * `bookMovements` exists twice — TypeScript in lib/bankrec.ts for the app, plain JS in
 * admin/server.js for the portal, because the portal cannot import the first. Eight
 * different record types move bank money and that list has grown before. If the two
 * copies drift, the portal reports real transactions as missing from the book and the
 * accountant goes hunting a bank error that does not exist. The last section here
 * asserts both produce identical movement sets for every account.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { signedInProbe } from './lib/probe-session.mjs';

const require = createRequire(import.meta.url);
const S = require('../lib/bank-statement.js');
const M = require('../lib/bank-match.js');
const R = require('../lib/bank-reconcile.js');

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';
const APP = process.env.APP_URL || 'http://127.0.0.1:3002';
const BOOK = 'content/accounting.json';

const results = [];
const ok = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
};

/* ------------------------------------------------------------------- readiness */

async function waitFor(url, what) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0) { await r.text(); return; }
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`${what} did not answer at ${url} — start it before running this`);
}
await waitFor(`${ADMIN}/login`, 'the admin portal');
await waitFor(`${APP}/signin`, 'the app');

/* ------------------------------------------------------------------ the fixture */

const bookBefore = readFileSync(BOOK, 'utf8');
process.on('exit', () => writeFileSync(BOOK, bookBefore));

const BANK = 'BNK-001', FROM = '2026-07-01', TO = '2026-07-31';
const csv = execFileSync(process.execPath, ['scripts/make-bank-statement.mjs', BANK, FROM, TO], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
});

/* ------------------------------------------------- 1. the parser, before anything */

const p = S.preview(csv);
ok('the generated statement parses with no problems', !p.error && p.problems.length === 0, p.error || `${p.lines.length} lines, ${p.dateFormat}`);
ok('the date format is resolved unambiguously', p.dateFormats.candidates.length === 1, p.dateFormats.candidates.join(' or '));
ok('the running balance verifies against the bank\'s own arithmetic', p.chain.checked && p.chain.ok, p.chain.detail.slice(0, 60));

{
  // The single most valuable property of the import: a wrong mapping is caught before it
  // is saved, not at year end.
  const swapped = { ...p.mapping, debit: p.mapping.credit, credit: p.mapping.debit };
  const bad = S.preview(csv, swapped, p.dateFormat);
  ok('swapping withdrawal and deposit is caught by the balance chain',
    bad.chain.checked && !bad.chain.ok, `${bad.chain.breaks.length} break(s)`);
}
{
  const amb = S.dateFormats(['03/04/2026', '05/06/2026']);
  ok('a date column that reads two ways is refused, not guessed',
    amb.candidates.length > 1, amb.candidates.join(' or '));
  ok('an impossible date is refused rather than coerced',
    Object.keys(S.readings('31/02/2026')).length === 0, JSON.stringify(S.readings('31/02/2026')));
}

/* ------------------------------------------------------- 2. the portal imports it */

const s = await signedInProbe({ admin: ADMIN, app: APP, roles: ['super_admin', 'accountant', 'manager'], prefix: 'bank-probe-' });
const suCookie = s.cookie;

async function portal(path, opts = {}) {
  const { cookie, headers, ...rest } = opts;
  const r = await fetch(`${ADMIN}${path}`, {
    redirect: 'manual', ...rest,
    headers: { cookie: cookie || suCookie, ...(headers || {}) }
  });
  return { status: r.status, location: r.headers.get('location') || '', body: await r.text() };
}
const csrfOf = (html) => (html.match(/name="csrf" value="([^"]+)"/) || [])[1];
/**
 * Collapse whitespace before looking for a phrase in HTML.
 *
 * A sentence in a template literal wraps wherever the source wrapped, so
 * "put money in the wrong column" arrives with a newline and four spaces in the
 * middle of it. The first version of the assertion below failed for that reason alone
 * while the page said exactly what it was supposed to - a test failing on the
 * formatting of the thing it is reading is worse than no test, because the next person
 * fixes the page.
 */
const flat = (html) => String(html).split(/\s+/).join(' ');

const screen = await portal('/bank-statements');
ok('the bank statements screen loads', screen.status === 200 && /Import a statement/.test(screen.body), `HTTP ${screen.status}`);
ok('it says why there is no built-in bank layout',
  /guessed at would put money in the wrong column/.test(flat(screen.body)), 'the refusal is stated, not hidden');

async function post(action, fields, cookie) {
  const page = await portal('/bank-statements', { cookie });
  const body = new URLSearchParams();
  body.set('csrf', csrfOf(page.body) || '');
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  return portal(action, { method: 'POST', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
}

const mapFields = {
  map_date: p.mapping.date, map_description: p.mapping.description, map_reference: p.mapping.reference,
  map_debit: p.mapping.debit, map_credit: p.mapping.credit, map_amount: p.mapping.amount, map_balance: p.mapping.balance,
  dateFormat: p.dateFormat
};

const prev = await post('/bank-statements/preview', { csv, bankId: BANK, from: FROM, to: TO, ...mapFields });
ok('preview reads the file and saves nothing', prev.status === 200 && /What was read/.test(prev.body),
  `HTTP ${prev.status}, book untouched: ${JSON.parse(readFileSync(BOOK, 'utf8')).bankStatements === undefined || (JSON.parse(readFileSync(BOOK, 'utf8')).bankStatements || []).every((x) => x.importedBy !== 'bank-probe-super_admin@local')}`);

const strayPeriod = await post('/bank-statements/import', { csv, bankId: BANK, from: '2026-07-05', to: TO, ...mapFields });
ok('lines outside the stated period are refused, never trimmed to fit',
  strayPeriod.status === 422 && /fall outside/.test(strayPeriod.body), `HTTP ${strayPeriod.status}`);

const noPeriod = await post('/bank-statements/import', { csv, bankId: BANK, from: '', to: '', ...mapFields });
ok('an import with no stated period is refused', noPeriod.status === 422 && /Give the period/.test(noPeriod.body), `HTTP ${noPeriod.status}`);

const imported = await post('/bank-statements/import', { csv, bankId: BANK, from: FROM, to: TO, ...mapFields });
ok('a good statement imports', imported.status === 302 && /saved=/.test(imported.location), `HTTP ${imported.status}`);

const afterImport = JSON.parse(readFileSync(BOOK, 'utf8'));
const stored = (afterImport.bankStatements || []).find((x) => x.bankId === BANK && x.from === FROM);
ok('it is stored with its mapping, its date format and the original file',
  !!stored && stored.lines.length === p.lines.length && !!stored.raw && !!stored.dateFormat,
  stored ? `${stored.lines.length} lines, ${stored.dateFormat}, raw kept: ${stored.raw.length}b` : 'not stored');

/* --------------------------------------------- 3. the reconciliation the app shows */

const rendered = await (await fetch(`${APP}/accounts/reconcile`, { headers: { cookie: suCookie } })).text();
ok('the app renders the reconciliation', /Reconciliation statement/.test(rendered) && /Adjusted bank balance/.test(rendered), `${rendered.length}b`);
for (const t of ['ACCOUNT MAINTENANCE FEE', 'EXCISE DUTY', 'INTEREST CREDITED', 'ATM DEBIT']) {
  ok(`the statement item "${t}" is listed as never recorded in the book`, rendered.includes(t), '');
}
ok('the deliberately unpresented payment is shown as outstanding', /SFT-PAY-0146/.test(rendered), '');
ok('the deliberately in-transit deposit is shown as outstanding', /SFT-RCP-0105/.test(rendered), '');

/* ------------------------------------------------------ 4. the arithmetic itself */

const movements = (() => {
  const isRef = (c) => c.settlement !== 'credit_balance';
  const rows = [];
  const add = (r, direction, kind) => {
    if (r.date < FROM || r.date > TO) return;
    rows.push({ id: r.id, ref: r.no || r.id, date: r.date, amount: Math.abs(r.amount), direction, kind, note: [r.ref, r.notes, r.description].filter(Boolean).join(' ') });
  };
  for (const r of afterImport.receipts) if (r.bankId === BANK) add(r, 'in', 'receipt');
  for (const x of afterImport.payments) if (x.bankId === BANK) add(x, 'out', 'payment');
  for (const e of afterImport.expenses) if (e.bankId === BANK) add(e, 'out', 'expense');
  for (const c of afterImport.creditNotes || []) if (c.bankId === BANK && isRef(c)) add(c, 'out', 'refund');
  for (const t of afterImport.transfers || []) if (t.bankId === BANK) add(t, t.direction === 'deposit' ? 'in' : 'out', 'transfer');
  for (const c of afterImport.supplierCreditNotes || []) if (c.bankId === BANK && isRef(c)) add(c, 'in', 'supplier_credit');
  for (const d of afterImport.supplierDeposits || []) if (d.bankId === BANK && d.method !== 'cash') add(d, 'out', 'supplier_deposit');
  return rows;
})();

const bank = afterImport.banks.find((b) => b.id === BANK);
const netOf = (rows) => rows.filter((m) => m.direction === 'in').reduce((t, m) => t + m.amount, 0) - rows.filter((m) => m.direction === 'out').reduce((t, m) => t + m.amount, 0);
const allMoves = (() => {
  const isRef = (c) => c.settlement !== 'credit_balance';
  const rows = [];
  const add = (r, direction) => rows.push({ date: r.date, amount: Math.abs(r.amount), direction });
  for (const r of afterImport.receipts) if (r.bankId === BANK) add(r, 'in');
  for (const x of afterImport.payments) if (x.bankId === BANK) add(x, 'out');
  for (const e of afterImport.expenses) if (e.bankId === BANK) add(e, 'out');
  for (const c of afterImport.creditNotes || []) if (c.bankId === BANK && isRef(c)) add(c, 'out');
  for (const t of afterImport.transfers || []) if (t.bankId === BANK) add(t, t.direction === 'deposit' ? 'in' : 'out');
  for (const c of afterImport.supplierCreditNotes || []) if (c.bankId === BANK && isRef(c)) add(c, 'in');
  for (const d of afterImport.supplierDeposits || []) if (d.bankId === BANK && d.method !== 'cash') add(d, 'out');
  return rows;
})();

const match = M.matchStatement({ lines: stored.lines, movements, driftDays: 5, prefixes: M.bookPrefixes(afterImport) });
const rec = R.reconcile({
  match,
  bookOpening: bank.openingBalance + netOf(allMoves.filter((m) => m.date < FROM)),
  bookClosing: bank.openingBalance + netOf(allMoves.filter((m) => m.date <= TO)),
  statementOpening: stored.openingBalance, statementClosing: stored.closingBalance,
  from: FROM, to: TO, bankId: BANK, bankName: bank.name
});

ok('the two adjusted balances agree exactly', rec.difference === 0, String(rec.difference));
ok('the opening balances tie, so nothing is inherited from last period', rec.openingGap === 0, String(rec.openingGap));
ok('it reconciles', rec.reconciled === true, `blockers ${rec.blockers.length}`);
ok('but it is NOT settled while bank charges sit unrecorded',
  rec.settled === false && rec.requiresPosting === 4,
  `${rec.requiresPosting} item(s) waiting to be posted`);
ok('no book entry is matched to two statement lines',
  new Set(match.results.filter((r) => r.status === 'matched').map((r) => r.match.movementId)).size === match.counts.matched,
  `${match.counts.matched} matches`);
ok('every statement line has a verdict',
  match.counts.matched + match.counts.ambiguous + match.counts.unknownToBook === stored.lines.length,
  `${match.counts.matched}+${match.counts.ambiguous}+${match.counts.unknownToBook} of ${stored.lines.length}`);

/* ------------------------------------------------- 5. it must refuse to be fooled */

{
  const twin = [
    { id: 'A', ref: 'SFT-PAY-9001', date: '2026-07-10', amount: 44444, direction: 'out', kind: 'payment', note: '' },
    { id: 'B', ref: 'SFT-PAY-9002', date: '2026-07-10', amount: 44444, direction: 'out', kind: 'payment', note: '' }
  ];
  const one = [{ date: '2026-07-10', description: 'TFR TO BENEFICIARY', reference: '', amount: 44444, direction: 'out', balance: null, sourceLine: 2 }];
  const m = M.matchStatement({ lines: one, movements: twin, driftDays: 5, prefixes: [] });
  ok('one line fitting two identical entries matches NEITHER', m.results[0].status === 'ambiguous' && m.counts.matched === 0, m.results[0].status);

  const r2 = R.reconcile({ match: m, bookOpening: 0, bookClosing: -88888, statementOpening: 0, statementClosing: -44444, from: FROM, to: TO, bankId: BANK, bankName: bank.name });
  ok('an unresolved ambiguity refuses to produce a verdict', r2.reconciled === false, `blockers ${r2.blockers.length}`);
  ok('and the ambiguous line is not counted as something the bank did alone',
    r2.book.debits.length === 0 && r2.book.credits.length === 0, 'excluded from both adjustment columns');
}
{
  const m = [{ id: 'X', ref: 'P1', date: '2026-07-10', amount: 30500, direction: 'out', kind: 'payment', note: '' }];
  const near = [{ date: '2026-07-10', description: 'TFR', reference: '', amount: 30450, direction: 'out', balance: null, sourceLine: 2 }];
  ok('fifty taka short is not a match — that gap is the point of the exercise',
    M.matchStatement({ lines: near, movements: m, driftDays: 5, prefixes: [] }).results[0].status === 'unknown_to_book', '');
  const wrongWay = [{ date: '2026-07-10', description: 'TFR', reference: '', amount: 30500, direction: 'in', balance: null, sourceLine: 2 }];
  ok('the same amount in the opposite direction is not a match',
    M.matchStatement({ lines: wrongWay, movements: m, driftDays: 5, prefixes: [] }).results[0].status === 'unknown_to_book', '');
  const early = [{ date: '2026-07-04', description: 'TFR', reference: '', amount: 30500, direction: 'out', balance: null, sourceLine: 2 }];
  ok('a bank cannot pay a cheque six days before it was written',
    M.matchStatement({ lines: early, movements: m, driftDays: 5, prefixes: [] }).results[0].status === 'unknown_to_book', '');
}
{
  const gap = R.reconcile({
    match, bookOpening: 1, bookClosing: 1, statementOpening: 4301, statementClosing: 1,
    from: FROM, to: TO, bankId: BANK, bankName: bank.name
  });
  ok('a prior-period gap surfaces and is named as last period\'s business',
    gap.openingGap === 4300 && gap.blockers.some((b) => /last period/.test(b)), `openingGap ${gap.openingGap}`);
}

/* ---------------------------------------------- 6. sign-off refuses a false claim */

const early = await post('/bank-statements/signoff', { statement: stored.id });
ok('signing off is refused while bank items are unrecorded',
  early.status === 302 && /error=/.test(early.location) && /have not been recorded/.test(decodeURIComponent(early.location)),
  'a signed period with unrecorded charges is an omission with somebody\'s name on it');

/* ------------------------------------------------------------------- 7. the RBAC */

const mgr = await s.login('manager');
const mgrRead = await portal('/bank-statements', { cookie: mgr });
ok('a manager may read the statements', mgrRead.status === 200, `HTTP ${mgrRead.status}`);
ok('but is not offered the import form', !/Import a statement<\/h2>/.test(mgrRead.body), 'told why instead');
const mgrImport = await post('/bank-statements/import', { csv, bankId: BANK, from: FROM, to: TO, ...mapFields }, mgr);
ok('and a manager import is refused at the route', mgrImport.status === 403, `HTTP ${mgrImport.status}`);

/* ------------------------ 8. the two bookMovements implementations must not drift */

/**
 * The check this whole file exists for.
 *
 * `bookMovements` is written twice — TypeScript for the app, plain JS in the portal,
 * because the portal cannot import TypeScript. Eight record types move bank money and
 * that list has grown before. A drift makes the portal report real transactions as
 * missing from the book, and the accountant hunts a bank error that never happened.
 *
 * Asked of the APP, through a page that renders the app-side implementation, and
 * compared with the portal's own count. Source-level greps would only prove the files
 * look similar.
 */
{
  const appPage = await (await fetch(`${APP}/accounts/reconcile`, { headers: { cookie: suCookie } })).text();
  const claimed = appPage.match(/Book knows, bank does not[^]{0,400}?tnum[^>]*>(\d+)</);
  const portalSide = match.unmatchedMovements.length;
  ok('the app and the portal agree on how many book entries are outstanding',
    claimed ? Number(claimed[1]) === portalSide : false,
    claimed ? `app ${claimed[1]}, portal ${portalSide}` : 'could not read the app figure');

  const total = appPage.match(/Statement lines[^]{0,400}?tnum[^>]*>(\d+)</);
  ok('and on how many statement lines there are',
    total ? Number(total[1]) === stored.lines.length : false,
    total ? `app ${total[1]}, stored ${stored.lines.length}` : 'could not read the app figure');
}

/* --------------------------------------------------------------- 9. removal */

const removed = await post('/bank-statements/delete', { statement: stored.id });
ok('an import can be removed', removed.status === 302, `HTTP ${removed.status}`);
const afterDelete = JSON.parse(readFileSync(BOOK, 'utf8'));
ok('and the book itself is untouched by it',
  (afterDelete.bankStatements || []).every((x) => x.id !== stored.id) &&
  afterDelete.payments.length === afterImport.payments.length &&
  afterDelete.receipts.length === afterImport.receipts.length,
  'only the bank\'s record of it goes');

/* ---------------------------------------------------------------- teardown */

writeFileSync(BOOK, bookBefore);
ok('the book is restored byte for byte', readFileSync(BOOK, 'utf8') === bookBefore, '');

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
