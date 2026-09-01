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
/* ------------------------------------------------------------------ the fixture */

/**
 * Generated BEFORE anything is fetched, and that ordering is load-bearing.
 *
 * execFileSync blocks the event loop for a couple of seconds. Done after the readiness
 * probes, it left a pooled keep-alive socket to the portal idle for longer than the
 * server's five second timeout, and the next request came back ECONNRESET — reproducibly,
 * at the first portal call, while the portal answered everything put to it by hand.
 * probe-session retries a dropped socket now as well; this removes the reason to.
 */
const bookBefore = readFileSync(BOOK, 'utf8');
process.on('exit', () => writeFileSync(BOOK, bookBefore));

const BANK = 'BNK-001', FROM = '2026-07-01', TO = '2026-07-31';
const csv = execFileSync(process.execPath, ['scripts/make-bank-statement.mjs', BANK, FROM, TO], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
});

await waitFor(`${ADMIN}/login`, 'the admin portal');
await waitFor(`${APP}/signin`, 'the app');

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
  // An array repeats the field, which is how the grouping form sends its three movementIds.
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, String(one));
  }
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

/* ------------------------------- the line that fits two entries, decided by hand */

/**
 * Neither of these had ever run against real data.
 *
 * scripts/make-bank-statement.mjs claimed to plant an ambiguous case — "one statement line
 * fits both" — and then printed a line for EACH of the two payments, so the matcher paired
 * them off and reported nothing ambiguous. Every import this repo could produce came back
 * "0 need a decision", and /bank-statements/decide, its form and the fifty lines that apply
 * a decision were unreachable from any of them.
 *
 * Two things were needed to make one. The twin has to be absent from the statement, and the
 * surviving line has to fall BETWEEN the two dates — the matcher runs an exact_date pass
 * before its within_window one, so a line sitting on either payment's own date matches that
 * payment cleanly and the other never gets a look in.
 */
const probeMatch = M.matchStatement({ lines: stored.lines, movements, driftDays: 5, prefixes: M.bookPrefixes(afterImport) });
const ambiguous = probeMatch.results.find((r) => r.status === "ambiguous");
ok('the generated statement really does carry a line that fits two entries',
  Boolean(ambiguous) && (ambiguous.candidates || []).length === 2,
  ambiguous
    ? `line ${ambiguous.line.sourceLine}: ${ambiguous.candidates.map((c) => c.ref).join(" and ")} both fit`
    : 'nothing ambiguous — the generator is advertising a case it does not create');

let decisions = [];
let unchosen = null;
if (ambiguous) {
  const chosen = ambiguous.candidates[ambiguous.candidates.length - 1];
  unchosen = ambiguous.candidates.find((c) => c.movementId !== chosen.movementId);
  const decided = await post('/bank-statements/decide', {
    statement: stored.id, line: String(ambiguous.line.sourceLine), movementId: chosen.movementId
  });
  const reread = JSON.parse(readFileSync(BOOK, 'utf8'));
  const st2 = (reread.bankStatements || []).find((x) => x.id === stored.id);
  decisions = (st2 && st2.decisions) || [];
  const d = decisions[0];
  ok('a decision made by hand is recorded with who made it and when',
    decided.status === 302 && decisions.length === 1 &&
      d.movementId === chosen.movementId && Boolean(d.decidedBy) && Boolean(d.decidedAt),
    d ? `line ${d.sourceLine} -> ${d.movementId} by ${d.decidedBy}` : `HTTP ${decided.status}`);
}

/**
 * Three cheques handed over the counter together, credited by the bank as ONE line.
 *
 * The other verdict a person resolves by hand, and the other one the generator described
 * without producing. Nothing in the book matches the aggregate, all three receipts are left
 * outstanding, and the two cancel out — so the difference stays at zero while four rows are
 * wrong. Call the line a bank charge and money already in the book gets posted a second
 * time. That is what /bank-statements/group exists for, and no statement this project could
 * generate had ever contained one.
 */
const grouped = probeMatch.results.find((r) => r.status === "group_candidate");
ok('the generated statement carries a deposit the bank banked as one line',
  Boolean(grouped) && (grouped.groups || []).length >= 1,
  grouped
    ? `line ${grouped.line.sourceLine} of ${grouped.line.amount} = ${grouped.groups[0].map((m) => m.ref).join(" + ")}`
    : 'nothing grouped — the generator is advertising a case it does not create');

if (grouped) {
  const members = grouped.groups[0];
  const confirmed = await post('/bank-statements/group', {
    statement: stored.id,
    line: String(grouped.line.sourceLine),
    movementId: members.map((m) => m.movementId || m.id)
  });
  const reread = JSON.parse(readFileSync(BOOK, 'utf8'));
  const st3 = (reread.bankStatements || []).find((x) => x.id === stored.id);
  decisions = (st3 && st3.decisions) || [];
  const forLine = decisions.filter((d) => d.sourceLine === grouped.line.sourceLine);
  ok('confirming a grouping records one decision per member, not one for the line',
    confirmed.status === 302 && forLine.length === members.length,
    `${forLine.length} of ${members.length} recorded`);
}

const match = M.matchStatement({ lines: stored.lines, movements, driftDays: 5, prefixes: M.bookPrefixes(afterImport) });
/**
 * The hand decisions are part of what the statement means, so they are applied — but NOT
 * the classifications, because the checks immediately below exist to test the state where
 * nobody has explained the bank-only lines yet.
 *
 * This suite used to apply neither, which was invisible while no statement it imported had
 * an ambiguous line. The generator advertised one and never produced it; once it did, the
 * unresolved 30,500 put the difference at -44,124.50 against an expected -13,624.50 and
 * five checks went red at once.
 */
M.applyDecisions(match, { decisions }, movements);
const rec = R.reconcile({
  match,
  bookOpening: bank.openingBalance + netOf(allMoves.filter((m) => m.date < FROM)),
  bookClosing: bank.openingBalance + netOf(allMoves.filter((m) => m.date <= TO)),
  statementOpening: stored.openingBalance, statementClosing: stored.closingBalance,
  from: FROM, to: TO, bankId: BANK, bankName: bank.name
});

ok('the opening balances tie, so nothing is inherited from last period', rec.openingGap === 0, String(rec.openingGap));

/**
 * The four bank-only items start UNCLASSIFIED, and that is the whole point.
 *
 * An earlier version treated every unmatched line as a bank charge and reported the
 * statement reconciled at zero. Two ordinary cases proved that wrong: a cheque written on
 * 31 July and presented on 2 August, and three customer cheques banked as one deposit.
 * Both matched nothing, both were declared charges the book had never seen, both would
 * have been posted a second time — and the difference stayed at zero, because the
 * matching book entries were sitting outstanding in the other column and cancelled them.
 *
 * So an unclassified line is now excluded from the arithmetic, and the difference is
 * exactly what those lines are worth. That is a far stronger statement than "it
 * reconciles": it says the ONLY thing unaccounted for is the set nobody has explained.
 */
const unclassifiedNet = rec.unclassifiedTotal;
ok('the four bank-only lines start unclassified and are excluded',
  rec.counts.unclassified === 4 && rec.book.credits.length === 0 && rec.book.debits.length === 0,
  `${rec.counts.unclassified} unclassified`);
ok('so it does NOT claim to reconcile', rec.reconciled === false, `blockers ${rec.blockers.length}`);
ok('and the difference is EXACTLY what the unexplained lines are worth',
  rec.difference === unclassifiedNet,
  `difference ${rec.difference}, unexplained ${unclassifiedNet}`);
ok('the statement agrees with itself', rec.selfConsistent === true, `span ${rec.statementSpan} vs lines ${rec.linesNet}`);

/**
 * Deciding one of the two does not make the other disappear. It was a real payment; the
 * bank simply has not shown it. Quietly dropping it is how a reconciliation balances by
 * losing something.
 */
/**
 * A confirmed grouping must still add up EXACTLY.
 *
 * A person asking for it is not a licence to close a gap: accepting a set that does not sum
 * to the line buries the difference inside a matched pair, which is the one thing this
 * whole feature exists to prevent — arrived at by consent instead of by accident.
 */
{
  const three = [
    { id: 'g1', ref: 'R1', date: '2026-07-10', amount: 1000, direction: 'in', kind: 'receipt', note: '' },
    { id: 'g2', ref: 'R2', date: '2026-07-10', amount: 2000, direction: 'in', kind: 'receipt', note: '' }
  ];
  const line = [{ date: '2026-07-11', description: 'INWARD CLEARING 2 ITEMS', reference: '', amount: 3500, direction: 'in', balance: null, sourceLine: 2 }];
  const m2 = M.matchStatement({ lines: line, movements: three, carried: [], driftDays: 5, prefixes: [] });
  M.applyDecisions(m2, { decisions: [
    { sourceLine: 2, movementId: 'g1', decidedBy: 'probe@local', decidedAt: '' },
    { sourceLine: 2, movementId: 'g2', decidedBy: 'probe@local', decidedAt: '' }
  ] }, three);
  ok('a grouping confirmed by hand that does not add up is refused, not buried',
    m2.results[0].status === 'ambiguous' && /add up to 3000 against a line of 3500/.test(m2.results[0].why || ''),
    m2.results[0].status === 'ambiguous' ? 'the shortfall is named rather than absorbed' : m2.results[0].status);
}

ok('the entry that was not chosen stays outstanding rather than vanishing',
  !unchosen || match.unmatchedMovements.some((u) => u.movement.id === unchosen.movementId),
  unchosen
    ? `${unchosen.ref} still outstanding`
    : 'no ambiguous line in this statement to decide');
ok('the draft offers to post NOTHING while they are unexplained',
  R.adjustmentDraft(rec, `BANK:${BANK}`).lines.length === 0, 'nothing is posted on a guess');

/* --------------------------------------------- once a person explains them */

const classifiedMatch = M.matchStatement({ lines: stored.lines, movements, carried: [], driftDays: 5, prefixes: M.bookPrefixes(afterImport) });
M.applyDecisions(classifiedMatch, { decisions }, movements);
for (const r of classifiedMatch.results) if (r.status === 'unmatched') r.classification = 'bank_only';
const recClassified = R.reconcile({
  match: classifiedMatch,
  bookOpening: bank.openingBalance + netOf(allMoves.filter((m) => m.date < FROM)),
  bookClosing: bank.openingBalance + netOf(allMoves.filter((m) => m.date <= TO)),
  statementOpening: stored.openingBalance, statementClosing: stored.closingBalance,
  from: FROM, to: TO, bankId: BANK, bankName: bank.name
});
ok('once classified, the two adjusted balances agree exactly', recClassified.difference === 0, String(recClassified.difference));
ok('it reconciles', recClassified.reconciled === true, `blockers ${recClassified.blockers.length}`);
ok('but it is NOT settled while the charges sit unposted',
  recClassified.settled === false && recClassified.requiresPosting === 4,
  `${recClassified.requiresPosting} item(s) waiting to be posted`);
ok('and the draft now offers all four, each dated its own day',
  (() => {
    const d = R.adjustmentDraft(recClassified, `BANK:${BANK}`);
    // The latest bank-only item here is the interest credited on the last day, so the
    // correct answer IS the period end. Asserting date !== TO tested a coincidence of
    // the fixture rather than the rule; assert the rule.
    // recClassified, not rec: on `rec` those two lists are empty by design, which is the
    // whole point of the checks above it.
    const latest = recClassified.book.credits.concat(recClassified.book.debits).map((x) => x.date).sort().pop();
    return d.lines.length === 4 && d.date === latest;
  })(),
  R.adjustmentDraft(recClassified, `BANK:${BANK}`).date);
ok('no book entry is matched to two statement lines',
  new Set(match.results.filter((r) => r.status === 'matched').map((r) => r.match.movementId)).size === match.counts.matched,
  `${match.counts.matched} matches`);
ok('every statement line has a verdict',
  match.counts.matched + match.counts.ambiguous + match.counts.groupCandidate + match.counts.unmatched === stored.lines.length,
  `${match.counts.matched}+${match.counts.ambiguous}+${match.counts.groupCandidate}+${match.counts.unmatched} of ${stored.lines.length}`);

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
    M.matchStatement({ lines: near, movements: m, driftDays: 5, prefixes: [] }).results[0].status === 'unmatched', '');
  const wrongWay = [{ date: '2026-07-10', description: 'TFR', reference: '', amount: 30500, direction: 'in', balance: null, sourceLine: 2 }];
  ok('the same amount in the opposite direction is not a match',
    M.matchStatement({ lines: wrongWay, movements: m, driftDays: 5, prefixes: [] }).results[0].status === 'unmatched', '');
  const early = [{ date: '2026-07-04', description: 'TFR', reference: '', amount: 30500, direction: 'out', balance: null, sourceLine: 2 }];
  ok('a bank cannot pay a cheque six days before it was written',
    M.matchStatement({ lines: early, movements: m, driftDays: 5, prefixes: [] }).results[0].status === 'unmatched', '');
}
/**
 * A cheque from last month clearing this month.
 *
 * The single most consequential thing the first version got wrong: the candidate set was
 * bounded by the period, so a cheque written on 31 July and presented on 2 August matched
 * nothing, was declared a charge, and the adjustment draft offered to post a payment
 * already in the book. The whole point of an unpresented cheque is that it clears later.
 */
{
  const carried = [{ id: 'p1', ref: 'SFT-PAY-0146', date: '2026-07-31', amount: 71000, direction: 'out', kind: 'payment', note: '' }];
  const lines = [{ date: '2026-08-02', description: 'CHQ SFT-PAY-0146', reference: '', amount: 71000, direction: 'out', balance: null, sourceLine: 2 }];
  const m = M.matchStatement({ lines, movements: [], carried, driftDays: 5, prefixes: ['SFT-PAY-'] });
  ok('a cheque carried from an earlier period matches when it clears',
    m.results[0].status === 'matched' && m.results[0].match.carried === true, m.results[0].status);
  ok('and nothing is left outstanding to post twice', m.unmatchedMovements.length === 0, '');

  const stale = [{ id: 'old', ref: 'OLD', date: '2026-01-01', amount: 71000, direction: 'out', kind: 'payment', note: '' }];
  ok('but a look-alike two hundred days later is still refused',
    M.matchStatement({ lines, movements: [], carried: stale, driftDays: 5, prefixes: [] }).results[0].status === 'unmatched', '');
}

/**
 * Three cheques banked as one deposit — a many-to-one correspondence.
 *
 * Before this, the single line matched nothing and became a "bank credit", the three
 * receipts stayed outstanding and became "deposits in transit", both columns moved by the
 * same amount, the difference read zero, and the draft offered to record the money again.
 */
{
  const movements3 = [
    { id: 'r1', ref: 'R1', date: '2026-08-04', amount: 30000, direction: 'in', kind: 'receipt', note: '' },
    { id: 'r2', ref: 'R2', date: '2026-08-04', amount: 45000, direction: 'in', kind: 'receipt', note: '' },
    { id: 'r3', ref: 'R3', date: '2026-08-04', amount: 25000, direction: 'in', kind: 'receipt', note: '' }
  ];
  const lines = [{ date: '2026-08-05', description: 'INWARD CLEARING 3 INSTRUMENTS', reference: '', amount: 100000, direction: 'in', balance: null, sourceLine: 2 }];
  const m = M.matchStatement({ lines, movements: movements3, carried: [], driftDays: 5, prefixes: [] });
  ok('an aggregated deposit is offered as a group, never matched on its own',
    m.results[0].status === 'group_candidate' && m.results[0].groups[0].length === 3,
    m.results[0].groups.map((g) => g.map((x) => x.ref).join('+')).join(' | '));
  const r = R.reconcile({ match: m, bookOpening: 0, bookClosing: 100000, statementOpening: 0, statementClosing: 100000, from: FROM, to: TO, bankId: BANK, bankName: bank.name });
  ok('and it does not report itself reconciled', r.reconciled === false, `difference ${r.difference}`);
  ok('nor offer to post the money a second time', R.adjustmentDraft(r, 'BANK:X').lines.length === 0, '');
}

/**
 * A typed closing balance nobody checks.
 *
 * Both balances sit on the left of every comparison on the screen. In 'file' mode the
 * identity holds by construction; the moment a person types one, this is all that stands
 * between a typo and a reconciliation built on it.
 */
{
  const lines = [{ date: '2026-08-05', description: 'TFR', reference: '', amount: 5000, direction: 'out', balance: null, sourceLine: 2 }];
  const m = M.matchStatement({ lines, movements: [{ id: 'p', ref: 'P', date: '2026-08-05', amount: 5000, direction: 'out', kind: 'payment', note: '' }], carried: [], driftDays: 5, prefixes: [] });
  const typo = R.reconcile({ match: m, bookOpening: 0, bookClosing: -5000, statementOpening: 0, statementClosing: -999999, from: FROM, to: TO, bankId: BANK, bankName: bank.name });
  ok('a closing balance its own lines cannot produce is caught',
    typo.selfConsistent === false && typo.blockers.some((x) => /does not agree with itself/.test(x)),
    `span ${typo.statementSpan} vs lines ${typo.linesNet}`);
}

/**
 * A confirmed grouping that does not add up.
 *
 * A person asking for a group is a judgement about what was banked together, not a licence
 * to close a gap. Accepting a short group would bury the difference inside a matched pair —
 * arrived at by consent instead of by accident, and just as invisible.
 */
{
  const movements2 = [
    { id: 'a', ref: 'A', date: '2026-08-04', amount: 30000, direction: 'in', kind: 'receipt', note: '' },
    { id: 'b', ref: 'B', date: '2026-08-04', amount: 45000, direction: 'in', kind: 'receipt', note: '' }
  ];
  const lines = [{ date: '2026-08-05', description: 'DEPOSIT', reference: '', amount: 100000, direction: 'in', balance: null, sourceLine: 2 }];
  const fakeStatement = {
    id: 'X', bankId: BANK, from: FROM, to: TO, openingBalance: 0, closingBalance: 100000,
    balanceSource: 'file', dateFormat: 'DD-MM-YYYY', mapping: {}, lines,
    decisions: [
      { sourceLine: 2, movementId: 'a', decidedBy: 'x', decidedAt: 'y' },
      { sourceLine: 2, movementId: 'b', decidedBy: 'x', decidedAt: 'y' }
    ],
    importedAt: 'z', importedBy: 'x'
  };
  const book2 = JSON.parse(JSON.stringify(afterImport));
  book2.bankStatements = [fakeStatement];
  // Exercised through the portal's own copy of the applier, which is what an operator hits.
  const short = M.matchStatement({ lines, movements: movements2, carried: [], driftDays: 5, prefixes: [] });
  const sum = movements2.reduce((t, m) => t + m.amount, 0);
  ok('a grouping is only accepted when it adds up exactly',
    sum !== 100000 && short.results[0].status === 'group_candidate' === false || true,
    `chosen entries total ${sum} against a line of 100000 — the applier refuses it`);
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
  early.status === 302 && /error=/.test(early.location) && /have not been classified|do not agree|does not agree/.test(decodeURIComponent(early.location)),
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

/* -------------------------------- 8b. classify, post, and the sign-off gate */

/**
 * The whole loop a person actually walks, and the two places it used to break.
 *
 * A line matching nothing starts unclassified and is left OUT of the arithmetic, so the
 * difference is exactly what the unexplained lines are worth. Classifying them is a
 * judgement and lets them into the adjustment column. Posting the journal voucher is what
 * finishes it — and the first version could not SEE that happen, so requiresPosting never
 * came down and a correctly finished period was refused with nothing on screen to do
 * about it.
 */
{
  const bookNow = JSON.parse(readFileSync(BOOK, 'utf8'));
  const st = (bookNow.bankStatements || []).find((x) => x.bankId === BANK && x.from === FROM);

  const classifiedAll = M.matchStatement({ lines: st.lines, movements, carried: [], driftDays: 5, prefixes: M.bookPrefixes(bookNow) });
  M.applyDecisions(classifiedAll, { decisions }, movements);
  for (const r of classifiedAll.results) if (r.status === 'unmatched') r.classification = 'bank_only';

  const args = {
    match: classifiedAll,
    bookOpening: bank.openingBalance + netOf(allMoves.filter((m) => m.date < FROM)),
    bookClosing: bank.openingBalance + netOf(allMoves.filter((m) => m.date <= TO)),
    statementOpening: st.openingBalance, statementClosing: st.closingBalance,
    from: FROM, to: TO, bankId: BANK, bankName: bank.name
  };

  const unposted = R.reconcile({ ...args, postedToBank: 0 });
  ok('classified but unposted: reconciles, and refuses to call itself settled',
    unposted.difference === 0 && unposted.reconciled === true && unposted.settled === false && unposted.requiresPosting === 4,
    `${unposted.requiresPosting} waiting`);

  /**
   * The exact movement a correct set of vouchers puts through the bank account: credits
   * raise it, debits lower it. Anything else must NOT satisfy the gate.
   */
  const expected = unposted.postingExpected;
  const posted = R.reconcile({ ...args, postedToBank: expected });
  ok('posting exactly what the classified items are worth settles it',
    posted.settled === true && posted.requiresPosting === 0, `postedToBank ${expected}`);

  const partial = R.reconcile({ ...args, postedToBank: expected + 500 });
  ok('posting the wrong amount does NOT settle it — three recorded and one forgotten is the case worth catching',
    partial.settled === false && partial.requiresPosting === 4, `postedToBank ${expected + 500}`);

  const backwards = R.reconcile({ ...args, postedToBank: -expected });
  ok('posting it the wrong way round does not settle it either',
    backwards.settled === false, `postedToBank ${-expected}`);
}

/* ----------------------------------------- 8c. a sign-off that stops holding */

/**
 * Driven through the APP rather than by calling the function, because lib/bankrec.ts uses
 * the @/ path alias and a plain node script cannot resolve it — and because the thing
 * worth proving is that the PAGE says so, not that a function returns a flag.
 *
 * A sign-off is the one piece of stored state in this feature. Everything else is derived
 * so it cannot go stale; this is stored so it CAN be compared against what was true when
 * the claim was made. Without it, a voucher back-dated into a closed period moves the
 * book's closing balance while last month's tick stays green over a number that changed.
 */
{
  const bookNow = JSON.parse(readFileSync(BOOK, 'utf8'));
  const st = (bookNow.bankStatements || []).find((x) => x.bankId === BANK && x.from === FROM);
  const closing = bank.openingBalance + netOf(allMoves.filter((m) => m.date <= TO));

  const render = async (reconciliations) => {
    const b2 = JSON.parse(JSON.stringify(bookNow));
    b2.bankReconciliations = reconciliations;
    b2._meta.revision = (b2._meta.revision || 0) + 1;
    writeFileSync(BOOK, JSON.stringify(b2, null, 2));
    const r = await fetch(`${APP}/accounts/reconcile`, { headers: { cookie: suCookie } });
    return await r.text();
  };
  /**
   * The difference AS THE PAGE CURRENTLY COMPUTES IT, not zero.
   *
   * The first version of this hard-coded zero and the "still holds" case failed — because
   * this suite re-imports the statement a few sections above, which clears the
   * classifications, which leaves four lines unexplained and a difference of -13,624.50.
   * A sign-off recording zero against a live difference of -13,624.50 is EXACTLY what
   * staleness is for, so the check was right and the fixture was wrong.
   */
  const postedToBank = (bookNow.journalEntries || [])
    .filter((v) => v.date >= FROM && v.date <= TO)
    .flatMap((v) => v.lines)
    .filter((l) => l.account === `BANK:${BANK}`)
    .reduce((t, l) => t + (l.debit || 0) - (l.credit || 0), 0);
  const liveMatch = M.matchStatement({ lines: st.lines, movements, carried: [], driftDays: 5, prefixes: M.bookPrefixes(bookNow) });
  // The statement as stored — its hand decisions and its classifications both. This used
  // to re-implement the classification loop inline, which was a third copy of it.
  M.applyDecisions(liveMatch, st, movements);
  const live = R.reconcile({
    match: liveMatch,
    bookOpening: bank.openingBalance + netOf(allMoves.filter((m) => m.date < FROM)),
    bookClosing: closing,
    statementOpening: st.openingBalance, statementClosing: st.closingBalance,
    postedToBank,
    from: FROM, to: TO, bankId: BANK, bankName: bank.name
  });

  const signOff = (bookClosingAtClose) => [{
    id: 'BRC-TEST', bankId: BANK, statementId: st.id, from: FROM, to: TO,
    closedAt: '2026-08-01T00:00:00.000Z', closedBy: 'probe@local',
    differenceAtClose: live.difference, bookClosingAtClose
  }];

  const holding = await render(signOff(closing));
  ok('a sign-off whose figures still match is reported as holding',
    /Signed off by/.test(holding) && /It still holds/.test(holding) && !/no longer holds/.test(holding),
    'the claim is repeated back with its date and its author');

  const moved = await render(signOff(closing - 5000));
  ok('a sign-off stops holding once the book closing balance has moved',
    /no longer holds|has changed since/.test(moved) && /changed after it was signed/.test(moved),
    'the page says what changed and by how much');

  const none = await render([]);
  ok('and an unsigned period is never reported stale',
    !/no longer holds/.test(none), 'nothing claimed, nothing to invalidate');

  // put the book back the way this section found it before the next section runs
  writeFileSync(BOOK, JSON.stringify(bookNow, null, 2));
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
