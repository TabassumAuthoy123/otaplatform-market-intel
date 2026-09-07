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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JV = require('../lib/journal-rules.js');
const LOCK = require('../lib/period-lock.js');
const FYR = require('../lib/financial-year.js');

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
  /**
   * Put back what was there, not null.
   *
   * This restored `lockedThrough = null` unconditionally, which was harmless for as long as
   * the answer was always null anyway. Once a year could actually be closed it silently
   * unlocked a filed year for the whole rest of the run — and the check that noticed was the
   * one asserting a closed year stays sealed, which read like the lock was broken rather than
   * like the test had opened it.
   */
  const was = cur.lockedThrough ?? null;
  cur.lockedThrough = '2026-08-31';
  writeFileSync(BOOK, JSON.stringify(cur, null, 2));
  const locked = await post({
    date: '2026-08-10', narration: 'Into a closed month',
    line_account: ['GL:JVTDEP', 'GL:JVTACC'], line_debit: ['5000', ''], line_credit: ['', '5000'], line_memo: ['', '']
  });
  ok('a voucher dated inside a closed period is refused',
    locked.status === 422 && /closed period/.test(locked.body), `HTTP ${locked.status}`);
  const reopened = JSON.parse(readFileSync(BOOK, 'utf8'));
  reopened.lockedThrough = was;
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

/* ------------------------------ the P&L against the ledger, on the page */

/**
 * The bridge check, read off the rendered page rather than called as a function.
 *
 * It exists because reconciliation() cannot see this class of failure: it compares ten
 * control accounts, and "does the P&L bottom line match income less expense in the
 * journal" is a different question. The P&L ignored journal vouchers entirely for a
 * while — 67,700 of depreciation, accrued rent and a counter shortage — and the balance
 * sheet, which derives retained earnings from that same journal, disagreed about profit
 * by exactly that much while both screens looked healthy.
 *
 * Then the check itself carried an arithmetic error for a day, subtracting supplier
 * refunds from a cost figure that was already net of them. It claimed to explain
 * 1,322,500 of an 867,000 gap and reported `unexplained` as -455,500 — a negative
 * unexplained gap, which is nonsense on its face, and which quietly absorbed 455,500 of
 * real discrepancy into its own "known reason" bucket.
 *
 * It survived a day because nothing rendered its answer. An uncalled check is not a
 * check, so this reads the page.
 */
{
  const page = await (await fetch(`${APP}/accounts/financials`, { headers: { cookie: s.cookie } })).text();
  const flat = page.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').split(/\s+/).join(' ');

  ok('the P&L-against-the-ledger check is on the page, not just in the code',
    /The P&L against the ledger/.test(flat), 'an uncalled check is not a check');

  /**
   * The difference itself, with nothing netted against it.
   *
   * There used to be an "unexplained" figure here, arrived at by subtracting a bucket of
   * things believed to be legitimate. That bucket was somewhere a real misstatement could
   * sit and still read clean — and it did: the subtraction was wrong and absorbed 455,500.
   * Supplier bills on unissued invoices are capitalised at source now, so there is nothing
   * legitimate left to explain and the difference IS the answer.
   */
  const diff = flat.match(/Difference (-?)৳([\d,]+)/);
  const value = diff ? Number(diff[2].replace(/,/g, '')) * (diff[1] ? -1 : 1) : NaN;
  ok('the P&L bottom line equals income less expense in the ledger, exactly',
    value === 0, diff ? `difference ${diff[1]}৳${diff[2]}` : 'could not read the figure');

  const stray = flat.match(/In cost of sales but unrecognised (-?)৳([\d,]+)/);
  ok('no supplier cost sits in cost of sales that cost of sales does not recognise',
    stray && Number(stray[2].replace(/,/g, '')) === 0,
    stray ? `${stray[1]}৳${stray[2]}` : 'could not read the figure');

  ok('the check reports what is capitalised rather than netting it off',
    /Capitalised — invoices still in draft/.test(flat) && !/Unexplained/.test(flat),
    'reported, never subtracted');
}

/* ------------- a voucher on an account the P&L derives from vouchers */

/**
 * The hole one layer below the original bug, found by planting one.
 *
 * The first fix let the P&L pick up journal-only accounts and EXCLUDED the ones the
 * voucher figures already cover — Sales, Purchases, the expense categories. But
 * `expensesByCategory` walks `book.expenses`, so it represents the VOUCHER part of a
 * category and nothing else: a journal voucher posted to Government Fees reached the
 * ledger and no part of the P&L at all. Planting a 50,000 one moved `unexplained` on the
 * bridge from 0 to exactly 50,000, which is the bridge doing its job and the P&L failing
 * to do its own.
 *
 * The split is now by ORIGIN rather than by account: voucher postings are in the rows
 * above, manual postings are listed separately, and every income or expense account is
 * covered by exactly one of the two.
 */
{
  const book = JSON.parse(readFileSync(BOOK, 'utf8'));
  const planted = JSON.parse(JSON.stringify(book));
  const category = planted.expenseCategories[0];
  planted.journalEntries = (planted.journalEntries || []).concat([{
    id: 'jv_probe_pl', no: 'SFT-JV-9998', date: '2026-07-20',
    narration: 'Probe: a journal voucher on an expense category',
    lines: [
      { account: `EXP:${category.id}`, debit: 50000, credit: 0, memo: 'probe' },
      { account: 'GL:JVTACC', debit: 0, credit: 50000, memo: 'probe' }
    ],
    createdBy: 'probe', createdAt: '2026-07-20'
  }]);
  planted._meta.revision = (planted._meta.revision || 0) + 1;
  writeFileSync(BOOK, JSON.stringify(planted, null, 2));

  const page = await (await fetch(`${APP}/accounts/financials`, { headers: { cookie: s.cookie } })).text();
  const flat = page.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').split(/\s+/).join(' ');

  ok('a voucher on an expense category appears on the P&L',
    flat.includes(`Journal — ${category.name}`), `looked for "Journal — ${category.name}"`);

  const m = flat.match(/Difference (-?)৳([\d,]+)/);
  ok('and the bridge still closes to zero once it does',
    m && Number(m[2].replace(/,/g, '')) === 0, m ? `difference ${m[1]}৳${m[2]}` : 'could not read');

  writeFileSync(BOOK, JSON.stringify(book, null, 2));
}

/* ----------------------- the same net profit wherever it is printed */

/**
 * One export file printed "Net profit" twice with two different numbers, 69,324 apart:
 * the Summary sheet from summarise() alone, the P&L sheet including journal vouchers. A
 * reader who quotes the wrong one is not being careless; the file gave them two answers.
 */
{
  const csv = await (await fetch(`${APP}/api/accounts/export?format=csv`)).text();
  const bare = csv.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.startsWith('"Net profit"'));
  ok('no two rows in the export are both labelled just "Net profit"',
    bare.length <= 1, `${bare.length} such row(s)`);
  ok('and the summary says which figure it is',
    /Net profit — trading only, before journal adjustments/.test(csv), 'labelled rather than silently changed');
}

/* ------------------------------- unwinding a close the way it was wound */

/**
 * A REOPEN PUTS BACK WHAT ITS OWN CLOSE RECORDED MOVING. THAT IS ONLY SAFE NEWEST FIRST.
 *
 * On the FIRST close of a book, cut.moved.lockedThrough.before is null — nothing was locked
 * before it. So reopening an EARLIER cut while a later one is still live sets lockedThrough
 * to null and leaves the later year filed, live, drift-checked, and completely writable.
 *
 * Measured before the rule existed, by replaying the route's own mutation on a two-close
 * book: closedThrough stayed 2027-06-30, lockedThrough became null, isLocked(null,
 * "2027-03-15") came back false, financialYearStart walked back a year, and the audit line
 * said only "Reopened FY2026".
 *
 * 467 checks were green over that, because the book has one close and the case needs two.
 * So this synthesises the second one — which is also the only way to test the rule at all.
 */
{
  const filedBook = JSON.parse(readFileSync(BOOK, 'utf8'));
  const first = (filedBook.closes || [])[0];

  if (!first) {
    ok('a filed year cannot be reopened out of order', true, 'no year is filed on this book');
  } else {
    /* the invariant, on the book as it actually stands */
    const through = FYR.closedThrough(filedBook);
    ok('the lock is never behind the newest filed year',
      !through || (filedBook.lockedThrough && filedBook.lockedThrough >= through),
      `filed through ${through}, locked through ${JSON.stringify(filedBook.lockedThrough)}`);

    /* a two-close book, in memory, with the real recorded `before` on the first cut */
    const two = JSON.parse(JSON.stringify(filedBook));
    const second = JSON.parse(JSON.stringify(first));
    second.id = 'CUT-2027-06-30';
    second.label = 'FY2027 to 2027-06-30';
    second.closedThrough = '2027-06-30';
    second.opensOn = '2027-07-01';
    second.moved = {
      lockedThrough: { before: first.closedThrough, after: '2027-06-30' },
      financialYearStart: { before: '2026-07-01', after: '2027-07-01' }
    };
    two.closes = [...two.closes, second];
    two.lockedThrough = '2027-06-30';
    two.company = { ...two.company, financialYearStart: '2027-07-01' };

    const older = FYR.reopenRefusals(two, first.id);
    ok('reopening an earlier filed year while a later one is live is refused',
      older.length > 0 && /newest first/i.test(older[0]) && older[0].includes(second.label),
      older.length ? older[0].slice(0, 88) : 'allowed — the later year would be filed and writable at once');

    const newest = FYR.reopenRefusals(two, second.id);
    ok('and the newest one may be reopened, so a book is not stuck',
      newest.length === 0, newest.length ? newest[0].slice(0, 80) : 'allowed');

    /**
     * What the refusal is protecting, stated as the measurement rather than as an argument:
     * the value that WOULD have gone back, and what the lock would then have said about a
     * date inside the year that is still filed.
     */
    const wouldRestore = first.moved.lockedThrough.before;
    ok('because the value it would restore leaves the later year unsealed',
      !LOCK.isLocked(wouldRestore, '2027-03-15') && FYR.closedThrough(two) === '2027-06-30',
      `would restore ${JSON.stringify(wouldRestore)}; 2027-03-15 inside the filed FY2027 would be locked: ${LOCK.isLocked(wouldRestore, "2027-03-15")}`);

    /* and through the real route, on a book that really has two closes */
    writeFileSync(BOOK, JSON.stringify(two, null, 2));
    const page = await portal('/year-end', { cookie: suCookie });
    const body = new URLSearchParams();
    body.set('csrf', csrfOf(page.body));
    body.set('id', first.id);
    body.set('reason', 'testing the ordering rule');
    const res = await portal('/year-end/reopen', {
      method: 'POST', cookie: suCookie,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const after = JSON.parse(readFileSync(BOOK, 'utf8'));
    const stillSealed = after.lockedThrough === '2027-06-30';
    const notStamped = !(after.closes || []).some((c) => c.id === first.id && c.reopened);
    ok('the route refuses it too, and nothing is stamped or unsealed',
      stillSealed && notStamped && /error=/.test(res.location || ''),
      `HTTP ${res.status}, lock ${JSON.stringify(after.lockedThrough)}${notStamped ? "" : ", but the cut was stamped"}`);

    writeFileSync(BOOK, JSON.stringify(filedBook, null, 2));
  }
}

/* --------------------- the detection half of the close, actually made to detect */

/**
 * THE LOCK IS THE PREVENTION. THE DRIFT PANEL IS THE DETECTION. THIS IS THE DETECTION.
 *
 * Two restatements walk past the write guard and always will, because period-lock's
 * datesOf() reads four field names and neither of these is on the record being written:
 *
 *   banks[].openingBalance   drives the OPENING journal entry, which is dated inside the
 *                            closed year
 *   an invoice line repointed at a document whose travelDate sits in the closed year,
 *                            which moves the Deferral/Recognition pair
 *
 * Extending datesOf to catch them means asking "what dates does this record post on", which
 * means calling buildJournal from the guard — and then the guard and the journal are one
 * derivation, which is the one thing this codebase does not do. So they are detected instead,
 * and the close's whole answer to "the lock cannot see everything" is that panel.
 *
 * WHICH MAKES "drift is clean on the shipped book" A CHECK THAT CANNOT FAIL. A drift function
 * that returned clean unconditionally would pass it. So this plants the restatement and
 * measures what every guard says, which is the only way to know the panel is load-bearing:
 *
 *   total assets            2,39,24,824  ->  2,44,24,824
 *   reconciliation          clean        ->  clean
 *   balance sheet diff      0            ->  0
 *   both trial balances     0            ->  0
 *   drift                   clean        ->  2 rows, named, with both figures
 *
 * Half a million added to a closed year, and one thing in the product notices.
 */
{
  const filed = JSON.parse(readFileSync(BOOK, 'utf8'));
  const cut = (filed.closes || []).filter((c) => !c.reopened).pop();

  if (!cut) {
    ok('the drift panel notices a restatement the lock cannot refuse', true, 'no year is filed on this book');
  } else {
    const drift = async () => {
      const r = await fetch(`${APP}/api/accounts/year-end/drift`);
      const j = await r.json();
      const row = (j.drift || []).find((d) => d.cut && d.cut.id === cut.id);
      return { clean: j.clean, moved: (row && row.moved) || [] };
    };
    const guards = async () => {
      const cells = (l) => (l.match(/"[^"]*"/g) || []).map((c) => c.slice(1, -1));
      const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '') || 0);
      const grab = async (section) =>
        (await (await fetch(`${APP}/api/accounts/export?format=csv&section=${section}`)).text())
          .split(/\r?\n/).filter((l) => l.includes(",")).map(cells);
      const rec = await grab("reconciliation");
      const bs = await grab("balance_sheet");
      const tb = await grab("trial_balance");
      return {
        recBad: rec.slice(1).filter((c) => c.length && num(c[c.length - 1]) !== 0).length,
        bsDiff: num((bs.find((c) => c[0] === "Check" && /Difference/i.test(c[1] || "")) || [])[2]),
        tbDiff: tb.filter((c) => /difference/i.test(c[0] || "")).map((c) => num(c[1])),
        assets: num((bs.find((c) => c[0] === "Assets" && /Total assets/i.test(c[1] || "")) || [])[2])
      };
    };

    const beforeGuards = await guards();
    const beforeDrift = await drift();
    ok('the filed year still derives to what was filed',
      beforeDrift.clean === true && beforeDrift.moved.length === 0,
      beforeDrift.clean ? `drift clean against ${cut.id}` : `${beforeDrift.moved.length} row(s) already moved`);

    /* plant it — nothing in the product refuses this, which is the point */
    const planted = JSON.parse(readFileSync(BOOK, 'utf8'));
    const bank = planted.banks[0];
    const was = bank.openingBalance;
    bank.openingBalance = was + 500000;
    writeFileSync(BOOK, JSON.stringify(planted, null, 2));

    const afterGuards = await guards();
    const afterDrift = await drift();

    ok('a bank opening balance can be moved inside a closed year without refusal',
      afterGuards.assets === beforeGuards.assets + 500000,
      `total assets ${beforeGuards.assets.toLocaleString("en-IN")} -> ${afterGuards.assets.toLocaleString("en-IN")}`);

    ok('and every ordinary guard still reads clean over it',
      afterGuards.recBad === 0 && afterGuards.bsDiff === 0 && afterGuards.tbDiff.every((d) => d === 0),
      `reconciliation ${afterGuards.recBad ? afterGuards.recBad + " disagree" : "clean"}, balance sheet ${afterGuards.bsDiff}, trial balances ${afterGuards.tbDiff.join("/")}`);

    const named = afterDrift.moved.filter((m) =>
      typeof m.what === "string" && Number.isFinite(m.filed) && Number.isFinite(m.now) && m.difference !== 0);
    ok('so the drift panel is the only thing that notices, and it names what moved',
      afterDrift.clean === false && named.length >= 1 &&
        named.some((m) => Math.abs(m.difference) === 500000),
      named.length
        ? named.map((m) => `${m.what} filed ${m.filed.toLocaleString("en-IN")}, now ${m.now.toLocaleString("en-IN")}`).join("; ")
        : 'drift reported nothing — the close has no detection at all');

    writeFileSync(BOOK, JSON.stringify(filed, null, 2));
    const back = await drift();
    ok('and it goes quiet again once the restatement is put back',
      back.clean === true,
      back.clean ? 'clean' : `${back.moved.length} row(s) still moved`);
  }
}

/* ------------------------- the seal on a filed year, and the door beside it */

/**
 * The lock is what seals a closed year, and Settings has a text box that sets the lock.
 *
 * Blanking it would have left a filed year writable again with nothing on the year-end
 * screen saying so and nothing stamped on the cut — the audit line reads "Reopened the whole
 * book", which is true and is not the same as telling anyone that FY2026 is no longer
 * sealed. Reopening a year is a different act with its own route: it demands a reason in
 * writing, stamps the cut, and restores the previous lock rather than clearing it.
 *
 * Locking a LATER month is still allowed, because that is what the box was for.
 */
{
  const live = JSON.parse(readFileSync(BOOK, 'utf8'));
  const filed = (live.closes || []).filter((c) => !c.reopened).pop();
  if (!filed) {
    ok('the Settings lock cannot unseal a filed year', true, 'no year is filed on this book');
  } else {
    const setLock = async (value) => {
      const page = await portal('/design?tab=lock', { cookie: suCookie });
      const body = new URLSearchParams();
      body.set('csrf', csrfOf(page.body));
      body.set('lockedThrough', value);
      const r = await portal('/design/lock', {
        method: 'POST', cookie: suCookie,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const after = JSON.parse(readFileSync(BOOK, 'utf8'));
      return { status: r.status, body: r.body, lock: after.lockedThrough };
    };

    const cleared = await setLock('');
    ok('clearing the Settings lock cannot unseal a filed year',
      cleared.status === 422 && cleared.lock === filed.closedThrough,
      cleared.lock === filed.closedThrough
        ? `refused, still sealed through ${cleared.lock}`
        : `the lock became ${JSON.stringify(cleared.lock)}`);

    const back = await setLock('2026-05-31');
    ok('nor can it be moved back behind one',
      back.status === 422 && back.lock === filed.closedThrough && /Year end/.test(back.body),
      back.status === 422 ? 'refused, and it points at the Year end screen' : `HTTP ${back.status}`);

    const later = await setLock('2026-08-31');
    ok('but a later month can still be locked, which is what the box is for',
      later.status === 302 && later.lock === '2026-08-31',
      `HTTP ${later.status}, lock ${JSON.stringify(later.lock)}`);

    await setLock(filed.closedThrough);
  }
}

/* ----------------------- the account a voucher may not reach, through the real form */

/**
 * The derivation-level rule is checked in verify-srs. This is the same refusal through the
 * portal a person actually uses, because a rule the form never reaches is a rule in name
 * only — and this one exists to stop the single most natural wrong move in the product.
 */
{
  const live = JSON.parse(readFileSync(BOOK, 'utf8'));
  const page = await portal('/journal', { cookie: suCookie });
  const csrf = (page.body.match(/name="csrf" value="([^"]*)"/) || [])[1];
  const body = new URLSearchParams();
  body.set('csrf', csrf);
  body.set('date', live.company.financialYearStart);
  body.set('narration', 'Bring last year in as an opening entry');
  for (const l of [
    { a: "CASH", d: "1000", c: "" },
    { a: "EQUITY_OPENING", d: "", c: "1000" }
  ]) {
    body.append('line_account', l.a);
    body.append('line_debit', l.d);
    body.append('line_credit', l.c);
  }
  const res = await portal('/journal/new', {
    method: 'POST', cookie: suCookie,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const after = JSON.parse(readFileSync(BOOK, 'utf8'));
  const wrote = (after.journalEntries || []).length !== (live.journalEntries || []).length;
  ok('the portal refuses a voucher against the derived opening balance',
    res.status === 422 && /derived, not posted/.test(res.body) && !wrote,
    res.status === 422
      ? 'refused, and nothing was written'
      : `HTTP ${res.status}${wrote ? " and it posted" : ""}`);
}

/* ------------------------- what a voucher may be dated, and why that changed */

/**
 * THE FINANCIAL YEAR IS A NAME, NOT A FLOOR.
 *
 * validateVoucher refused any voucher dated before company.financialYearStart, and nothing
 * else in the product enforced that boundary at all — 176 invoices, receipts, bills,
 * payments, expenses, supplier deposits and transfers are dated in the prior year and every
 * one of them was accepted. So the single voucher type that can post anything to anywhere
 * was the only type forbidden from the period the book actively traded in.
 *
 * It cost a real thing: a June bank statement could be imported and matched and never signed
 * off, because the bank's own charges on it had no date they could be posted on. The screen
 * said "4 item(s) need posting to the book" and there was nowhere to post them.
 *
 * These call the shared rule directly rather than through the portal. A voucher, once
 * posted, can only be REVERSED — there is no delete — so a check that posts one to see
 * whether it may leaves it in the book forever, which is how two probe vouchers ended up in
 * this book before this was written.
 */
{
  const live = JSON.parse(readFileSync(BOOK, 'utf8'));
  const opens = JV.openingDate(live);
  const fy = live.company.financialYearStart;
  const dayBefore = new Date(Date.parse(opens) - 86400000).toISOString().slice(0, 10);

  const errorsOn = (date) => JV.validateVoucher(live, {
    date,
    narration: 'A dated adjustment in the year being closed',
    lines: [
      { account: 'GL:BANKCHG', debit: 500, credit: 0 },
      { account: 'BANK:' + live.banks[0].id, debit: 0, credit: 500 }
    ]
  }, LOCK.isLocked).errors;

  ok('the book opens before the year it is named for',
    Boolean(opens) && opens < fy,
    `opens ${opens}, financial year named ${fy}`);

  /**
   * PHRASED AS A PROPERTY, BECAUSE THE ANSWER CHANGES AND THE RULE DOES NOT.
   *
   * This asserted that a prior-year date is ACCEPTED, which was right until the day somebody
   * closed the prior year — after which it is refused, correctly, by the lock. The check had
   * memorised a state rather than a rule and went red on the feature working.
   *
   * What must hold either way: a date is never refused for being before the financial year
   * START. If it is refused it is because a person closed that period or because the book did
   * not exist yet — both of them acts or facts, not a setting that rolls forward on its own.
   */
  const prior = errorsOn(opens);
  const forTheYearName = prior.filter((e) => /before the financial year starts/i.test(e));
  const forAnAct = prior.filter((e) => /closed period|before this book opens/i.test(e));
  ok('a prior-year date is never refused for being before the financial year start',
    forTheYearName.length === 0 && prior.length === forAnAct.length,
    prior.length === 0
      ? `${opens} is before ${fy} and takes a posting`
      : `refused, but only because: ${forAnAct.map((e) => e.split('.')[0]).join('; ').slice(0, 90)}`);

  const tooEarly = errorsOn(dayBefore);
  ok('a voucher before the book opens is refused, and says on what day it does',
    tooEarly.some((e) => e.includes('before this book opens') && e.includes(opens)),
    tooEarly[0] ? tooEarly[0].slice(0, 90) : 'accepted, which would post against money not yet brought in');

  /**
   * One date, two readers. lib/accounting.ts dates the opening entry with openingDate() and
   * this rule refuses anything before it. Computed separately they would agree the day they
   * were written and not for long after, and the drift would be a voucher the portal accepts
   * and the journal posts before the money exists.
   */
  const engine = readFileSync('lib/accounting.ts', 'utf8');
  ok('the opening entry and the floor read the same date from one place',
    /openingDate\(book\)/.test(engine) && /openingDate/.test(readFileSync('lib/journal-rules.js', 'utf8')),
    'both call openingDate() in lib/journal-rules.js');

  /**
   * And the lock is what actually protects a closed year. It uses <=, so a voucher dated ON
   * the boundary is inside it — which is why anything that closes a period has to write its
   * own vouchers first and set the lock second.
   */
  const locked = { ...live, lockedThrough: opens };
  const onBoundary = JV.validateVoucher(locked, {
    date: opens, narration: 'x',
    lines: [
      { account: 'GL:BANKCHG', debit: 500, credit: 0 },
      { account: 'BANK:' + live.banks[0].id, debit: 0, credit: 500 }
    ]
  }, LOCK.isLocked).errors;
  ok('the lock, not the year, is what closes a period — and it includes its own last day',
    onBoundary.some((e) => e.includes('closed period')),
    'so a close writes its vouchers first and sets the lock second');
}

/* ------------------------------------------ closing a year, and closing it twice */

/**
 * POSTING THE CLOSE TWICE IS THE HAZARD THIS REPO ALREADY DOCUMENTED.
 *
 * lib/accounting.ts rejected a period-end journal voucher for the work-in-progress problem
 * on exactly this ground: "a voucher can be posted twice, and posting it twice takes the
 * difference to MINUS 867,000 with every check still reading clean."
 *
 * A close inherits that hazard the moment it is a thing somebody can do twice, and it is
 * defensible only because the door closes behind it. Two independent refusals, both asserted
 * here: the close itself refuses a date already closed, and the period lock refuses anything
 * on or before it. Either alone would do; both is what makes it structural rather than
 * remembered.
 */
{
  const FYM = require('../lib/financial-year.js');
  const live = JSON.parse(readFileSync(BOOK, 'utf8'));
  const filed = FYM.closes(live).filter((c) => !c.reopened);

  if (!filed.length) {
    ok('closing a year that is already closed is refused', true, 'no year has been closed on this book');
  } else {
    const last = filed[filed.length - 1];
    const again = FYM.closeRefusals(live, last.closedThrough, { today: '2027-01-01', openingDate: JV.openingDate(live) });
    ok('closing a year that is already closed is refused',
      again.some((e) => /already closed/i.test(e)),
      again[0] ? again[0].slice(0, 96) : 'accepted, which would file the same year twice');

    const onLast = JV.validateVoucher(live, {
      date: last.closedThrough, narration: 'x',
      lines: [
        { account: 'GL:BANKCHG', debit: 500, credit: 0 },
        { account: 'BANK:' + live.banks[0].id, debit: 0, credit: 500 }
      ]
    }, LOCK.isLocked).errors;
    ok('and the lock seals the closed year including its own last day',
      onLast.some((e) => /closed period/i.test(e)),
      onLast[0] ? onLast[0].slice(0, 88) : 'the last day of a filed year is still writable');

    /**
     * The close recorded what it moved, so a reopen can put back exactly that and not a
     * guess. A cut is never deleted — "who reopened June, and what has moved since" has to
     * be answerable from the book, not only from the audit log, which a restore can
     * overwrite.
     */
    ok('a filed year records what it moved, so reopening restores rather than guesses',
      Boolean(last.moved && last.moved.lockedThrough && last.moved.financialYearStart) &&
        last.moved.lockedThrough.after === last.closedThrough,
      `lock ${JSON.stringify(last.moved && last.moved.lockedThrough)}, year ${JSON.stringify(last.moved && last.moved.financialYearStart)}`);

    /**
     * And it records BOTH derivations. One number is a claim; two derived by routes that
     * cannot see each other, landing in the same place, is evidence — and it is the only
     * thing that makes the drift check meaningful later.
     */
    ok('a filed year carries both derivations, not just the one that was convenient',
      typeof last.ledger.yearProfit === 'number' && typeof last.control.netProfit === 'number' &&
        last.ledger.yearProfit === last.control.netProfit,
      `journal ${last.ledger.yearProfit}, vouchers ${last.control.netProfit}`);
  }
}

/* ========================================================================= */
/*  THE CLOSE'S AGREEMENT GATE, WHICH REFUSED EVERY FUTURE CLOSE OF THIS BOOK  */
/* ========================================================================= */
/**
 * The close derives the year two ways and refuses to file one the book cannot agree with
 * itself about. That gate compared a YEAR against a LIFETIME, and separately compared a
 * journal-inclusive figure against a trading-only one. It agreed on the first close of this
 * book for one reason — there was no previous cut to subtract, so the year WAS the lifetime,
 * and no journal voucher was dated before the cut, so the two origins matched. Both
 * coincidences were spent the moment the first year was filed.
 *
 * Measured for a second close at 2027-06-30 before the fix:
 *
 *   journal, this year                                      597,136
 *   what the gate compared it to (whole book, trading)      812,360   gap -215,224
 *   window fixed and nothing else (this year, trading)      668,260   gap  -71,124
 *   window and origin both fixed                           597,136   gap        0
 *
 * Two wrongnesses in one comparison. Fixing either alone still refuses, which is why the
 * middle line is checked below and not only the last one.
 */
{
  const previousCut = FYR.lastClose(db);
  const through = '2027-06-30';

  /* --- the window itself, no app needed --- */
  const shapes = [
    [{ company: db.company }, null, 'nothing closed'],
    [{ company: db.company, closes: [] }, null, 'an empty list'],
    [db, previousCut ? FYR.nextDay(previousCut.closedThrough) : null, 'the live book'],
    [{ ...db, closes: (db.closes || []).map((c) => ({ ...c, reopened: { at: 'x', by: 'y', reason: 'z' } })) },
      null, 'every cut reopened'],
    [{ ...db, closes: [...(db.closes || []), { id: 'CUT-2027-06-30', closedThrough: through, ledger: { cumulativeProfit: 0 }, reopened: null }] },
      FYR.nextDay(through), 'a second cut filed']
  ];
  const badWindow = [];
  for (const [shape, want, what] of shapes) {
    const got = FYR.closingWindow(shape, through);
    if ((got.from ?? null) !== want) badWindow.push(`${what}: from ${JSON.stringify(got.from)}, expected ${JSON.stringify(want)}`);
    if (got.to !== through) badWindow.push(`${what}: to ${JSON.stringify(got.to)}`);
  }
  ok('the year being closed spans the day after the last live cut to the cut itself',
    badWindow.length === 0,
    badWindow.length ? badWindow.join('; ') : `${shapes.length} book shapes`);

  /* --- and what the app derives over it --- */
  let pv = null;
  try {
    pv = await (await fetch(`${APP}/api/accounts/year-end/preview?through=${through}`)).json();
  } catch (e) { pv = { _err: e.message }; }

  if (!pv || !pv.control || !pv.ledger) {
    ok('the close can derive a second year at all', false, JSON.stringify(pv && pv._err ? pv._err : pv));
  } else {
    const want = previousCut ? FYR.nextDay(previousCut.closedThrough) : null;
    ok('both derivations are bounded to the same year, and it is the right year',
      (pv.control.from ?? null) === want && pv.control.to === through,
      `control covers ${JSON.stringify(pv.control.from)} to ${JSON.stringify(pv.control.to)}, wanted ${JSON.stringify(want)}`);

    /**
     * THE GATE ITSELF. admin/server.js refuses the close on exactly this comparison, so a
     * non-zero gap here is a book that can never file another year.
     */
    const gap = pv.ledger.yearProfit - pv.control.netProfit;
    ok('the next close of this book is not refused for a profit gap that is not there',
      gap === 0,
      `journal ${pv.ledger.yearProfit} against vouchers ${pv.control.netProfit}, gap ${gap}`);

    /**
     * The middle line of the table above. If this book had no journal voucher dated inside
     * the open year, matching the window alone would be enough and the origin half of the
     * defect could come back unnoticed — so say so out loud rather than pass on nothing.
     */
    const jn = pv.control.journalNet;
    ok('matching the window alone would not have been enough, and the check can see that',
      typeof jn === 'number' && jn !== 0 &&
        pv.control.netProfitBeforeJournal + jn === pv.control.netProfit &&
        pv.control.netProfitBeforeJournal !== pv.ledger.yearProfit,
      typeof jn !== 'number'
        ? 'no journalNet recorded'
        : jn === 0
          ? 'no journal voucher is dated in the open year, so this check proves nothing today'
          : `trading ${pv.control.netProfitBeforeJournal} plus journal ${jn} is ${pv.control.netProfit}, and trading alone would have missed by ${pv.control.netProfitBeforeJournal - pv.ledger.yearProfit}`);

    /**
     * The gate's gap decomposes into two things the product already watches: the bridge
     * between the two origins, and drift in the year already filed. If it ever holds a third
     * term, the gate is refusing for a reason nothing on any screen explains.
     */
    const drift = pv.ledger.yearProfitDerived - pv.ledger.yearProfit;
    ok('the gap between the two derivations is the bridge plus drift in the filed year, and nothing else',
      gap === drift - pv.statements.bridgeDifference,
      `gap ${gap} against drift ${drift} less bridge ${pv.statements.bridgeDifference}`);

    /**
     * And the year derived by subtracting a stored figure equals the year derived off the
     * journal directly. When it does not, the close refuses by naming the drift — not by
     * telling somebody filing a year that the vouchers disagree, which would be a lie about
     * which two things disagreed.
     */
    ok('the filed year has not drifted, so this year can be measured at all',
      drift === 0 || (pv.refusals || []).some((r) => /no longer derives to what was filed/.test(r)),
      drift === 0
        ? `the year derives to ${pv.ledger.yearProfitDerived} both ways`
        : `drifted by ${drift} and the refusal ${(pv.refusals || []).some((r) => /no longer derives/.test(r)) ? "names it" : "DOES NOT NAME IT"}`);
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
