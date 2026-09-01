/**
 * Build a realistic bank statement out of the book's own movements, with the things
 * that actually go wrong deliberately left in.
 *
 *   node scripts/make-bank-statement.mjs BNK-001 2026-07-01 2026-07-31 > statement.csv
 *
 * WHY GENERATE ONE RATHER THAN HAND-WRITE A FIXTURE
 *
 * A hand-written fixture tests the matcher against the cases its author thought of. This
 * one is built from 192 real movements through the Dutch-Bangla account, so it carries
 * the awkwardness that is already in the data — in particular the twenty-nine amounts
 * that repeat on different days, which is what makes a date-tolerant matcher dangerous.
 *
 * The imperfections below are not noise added for realism. Each one is a distinct thing
 * a reconciliation has to get right, and each is labelled so a failing test says which:
 *
 *   DRIFT        a cheque presented days after it was written. A matcher with no date
 *                tolerance misses it; a matcher with too much tolerance mismatches it
 *                against one of the repeated amounts.
 *   UNPRESENTED  a payment in the book that the bank has not seen. Must survive as a
 *                reconciling item, NOT be reported as a book error.
 *   IN_TRANSIT   a deposit banked on the last day, credited after the statement closes.
 *   CHARGE       a fee the bank took and nobody told the book about. Must become a
 *                journal voucher, not a silent adjustment.
 *   INTEREST     the same in the other direction.
 *   AMBIGUOUS    two book payments of the same amount inside the drift window, so one
 *                statement line fits both. Must NOT auto-match either.
 *   UNKNOWN      a line the book has never heard of, which is how a fraud or a
 *                misdirected debit first shows up.
 *
 * The output is deliberately in a bank's shape and not the book's: DD/MM/YYYY dates,
 * Indian-grouped amounts, separate Withdrawal and Deposit columns, a running balance,
 * and narrations that echo the voucher number only sometimes — because a real narration
 * says "TFR TO AKASH TRAVELS" far more often than it says "SFT-PAY-0134".
 */

import { readFileSync } from 'node:fs';

const [, , bankId = 'BNK-001', from = '2026-07-01', to = '2026-07-31'] = process.argv;
const book = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
const bank = book.banks.find((b) => b.id === bankId);
if (!bank) {
  console.error(`No bank ${bankId}. Have: ${book.banks.map((b) => b.id + ' ' + b.name).join(', ')}`);
  process.exit(1);
}

/** Every movement, the same eight kinds lib/bankrec.ts flattens. */
const isRefunded = (c) => c.settlement === 'bank_transfer' || c.settlement === 'cash';
const moves = [];
const add = (r, direction, kind, note) =>
  moves.push({ id: r.id, ref: r.no ?? r.id, date: r.date, amount: Math.abs(r.amount), direction, kind, note: note ?? r.notes ?? r.ref ?? '' });

for (const r of book.receipts) if (r.bankId === bankId) add(r, 'in', 'receipt');
for (const p of book.payments) if (p.bankId === bankId) add(p, 'out', 'payment');
for (const e of book.expenses) if (e.bankId === bankId) add(e, 'out', 'expense', e.description);
for (const c of book.creditNotes || []) if (c.bankId === bankId && isRefunded(c)) add(c, 'out', 'refund');
for (const t of book.transfers || []) if (t.bankId === bankId) add(t, t.direction === 'deposit' ? 'in' : 'out', 'transfer');
for (const c of book.supplierCreditNotes || []) if (c.bankId === bankId && c.settlement !== 'credit_balance') add(c, 'in', 'supplier_credit');
for (const d of book.supplierDeposits || []) if (d.bankId === bankId && d.method !== 'cash') add(d, 'out', 'supplier_deposit');

const inPeriod = moves.filter((m) => m.date >= from && m.date <= to).sort((a, b) => a.date.localeCompare(b.date));
if (inPeriod.length < 8) {
  console.error(`Only ${inPeriod.length} movements through ${bankId} between ${from} and ${to} — pick a wider period.`);
  process.exit(1);
}

const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Indian grouping, the way a local statement prints it. */
const money = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Narrations that look like a bank's, echoing the reference only sometimes. */
const narrate = (m, i) => {
  const party = (m.note || '').replace(/[^A-Za-z0-9 &.-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 28);
  if (m.kind === 'transfer') return m.direction === 'in' ? 'CASH DEPOSIT COUNTER' : 'CASH WITHDRAWAL COUNTER';
  if (m.kind === 'expense') return `DR TFR ${party || 'SUNDRY'}`;
  if (m.kind === 'receipt') return i % 3 === 0 ? `CR TFR ${m.ref}` : `INWARD CLEARING ${party || 'CUSTOMER'}`;
  if (m.kind === 'supplier_deposit') return `RTGS OUTWARD ${party || 'CONSOLIDATOR'}`;
  return i % 4 === 0 ? `CHQ ${m.ref}` : `TFR TO ${party || 'BENEFICIARY'}`;
};

/* ------------------------------------------------- pick the imperfections */

const outs = inPeriod.filter((m) => m.direction === 'out');
const ins = inPeriod.filter((m) => m.direction === 'in');

/** Two book payments of the same amount, close enough in date to be confusable. */
let ambiguousPair = null;
for (let i = 0; i < outs.length && !ambiguousPair; i++) {
  for (let j = i + 1; j < outs.length; j++) {
    const gap = (new Date(outs[j].date) - new Date(outs[i].date)) / 86400000;
    if (outs[i].amount === outs[j].amount && gap > 0 && gap <= 6) { ambiguousPair = [outs[i], outs[j]]; break; }
  }
}

const drifted = outs.find((m) => m !== (ambiguousPair || [])[0] && m !== (ambiguousPair || [])[1]);
const unpresented = outs[outs.length - 1];
const inTransit = ins[ins.length - 1];
/**
 * The ambiguous case has to be MADE, not just described.
 *
 * This file said "one statement line fits both" and then printed a line for each of them,
 * so the matcher paired them off one-to-one and reported nothing ambiguous at all. The July
 * import came back "126 lines · 122 matched · 0 need a decision" and the two routes that
 * resolve a decision by hand — /bank-statements/decide and /bank-statements/group — could
 * not be reached from any statement this generator produced. They had never run.
 *
 * Dropping the twin is what creates the ambiguity: one line, two book payments of the same
 * amount days apart, no reference in the narration to break the tie. Whichever the person
 * picks, the other becomes an outstanding item — and since the two are equal, the
 * arithmetic lands in the same place either way, which is precisely why the matcher must
 * not choose on its own. It has no way to be right, only a way to look decided.
 */
const ambiguousTwin = ambiguousPair ? ambiguousPair[1] : null;
const ambiguousGap = ambiguousPair
  ? Math.round((new Date(ambiguousPair[1].date) - new Date(ambiguousPair[0].date)) / 86400000)
  : 0;
const skip = new Set([unpresented?.id, inTransit?.id].filter(Boolean));

const notes = [];
const lines = [];

for (const m of inPeriod) {
  if (skip.has(m.id)) {
    notes.push(`${m.direction === 'out' ? 'UNPRESENTED' : 'IN_TRANSIT'}  ${m.ref} ${m.date} ${m.amount} — in the book, deliberately absent from the statement`);
    continue;
  }
  if (ambiguousTwin && m.id === ambiguousTwin.id) continue;   // the line it would have had is the one below
  let date = m.date;
  if (drifted && m.id === drifted.id) {
    date = shift(m.date, 4);
    notes.push(`DRIFT        ${m.ref} written ${m.date}, presented ${date}`);
  }
  // A narration carrying the voucher number would settle the tie, and so would landing on
  // one of the two dates: the matcher runs an exact_date pass before its within_window one,
  // so a line dated the same day as either payment matches that one cleanly and the other
  // never gets a look in. That is what the first attempt at this did — the line sat on the
  // earlier payment's own date and came back cleanly matched. The line has to fall BETWEEN
  // them, close enough to both to be in the window and equal to neither.
  let desc = narrate(m, lines.length);
  if (ambiguousPair && m.id === ambiguousPair[0].id) {
    desc = 'TFR TO BENEFICIARY';
    date = shift(m.date, ambiguousGap === 1 ? 2 : Math.round(ambiguousGap / 2));
  }
  lines.push({ date, desc, amount: m.amount, direction: m.direction, tag: m.ref });
}

if (ambiguousPair) {
  notes.push(`AMBIGUOUS    ${ambiguousPair[0].ref} and ${ambiguousPair[1].ref} are both ${ambiguousPair[0].amount} within ${Math.round((new Date(ambiguousPair[1].date) - new Date(ambiguousPair[0].date)) / 86400000)} days. Only ONE line is printed, with no reference in the narration, so it fits both and the matcher must refuse to choose. ${ambiguousPair[1].ref} is therefore absent from the statement.`);
} else {
  notes.push('AMBIGUOUS    none available in this period (no two same-amount payments close together)');
}

/** Things only the bank knows. Amounts are ordinary BD retail-banking charges. */
const mid = inPeriod[Math.floor(inPeriod.length / 2)].date;
lines.push({ date: shift(mid, 1), desc: 'ACCOUNT MAINTENANCE FEE', amount: 500, direction: 'out', tag: 'CHARGE' });
lines.push({ date: shift(mid, 1), desc: 'EXCISE DUTY ON ACCOUNT', amount: 3000, direction: 'out', tag: 'CHARGE' });
lines.push({ date: to, desc: 'INTEREST CREDITED', amount: 1875.5, direction: 'in', tag: 'INTEREST' });
lines.push({ date: shift(mid, 2), desc: 'ATM DEBIT DHANMONDI BRANCH', amount: 12000, direction: 'out', tag: 'UNKNOWN' });
notes.push('CHARGE       ACCOUNT MAINTENANCE FEE 500 and EXCISE DUTY 3000 — bank knows, book does not');
notes.push('INTEREST     INTEREST CREDITED 1875.50 — bank knows, book does not');
notes.push('UNKNOWN      ATM DEBIT 12000 — in neither the book nor anybody\'s intention. This is what a misdirected debit looks like.');

lines.sort((a, b) => a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag));

/* ------------------------------------------------------ the running balance */

/**
 * Walked forward from the book's opening for the period, so the printed balance is
 * arithmetically consistent with the lines above it. That is what lets the importer's
 * balance-chain check verify the operator's column mapping — a statement with a made-up
 * balance column would make that check meaningless.
 */
const before = moves.filter((m) => m.date < from);
const opening =
  bank.openingBalance +
  before.filter((m) => m.direction === 'in').reduce((t, m) => t + m.amount, 0) -
  before.filter((m) => m.direction === 'out').reduce((t, m) => t + m.amount, 0);

let running = opening;
const out = ['Txn Date,Transaction Details,Cheque No,Withdrawal Amt.,Deposit Amt.,Closing Balance'];
for (const l of lines) {
  running += l.direction === 'in' ? l.amount : -l.amount;
  const cheque = /^CHQ (\S+)/.exec(l.desc);
  out.push([
    ddmmyyyy(l.date),
    `"${l.desc}"`,
    cheque ? cheque[1] : '',
    l.direction === 'out' ? `"${money(l.amount)}"` : '',
    l.direction === 'in' ? `"${money(l.amount)}"` : '',
    `"${money(running)}"`
  ].join(','));
}

console.log(out.join('\n'));
console.error(`\n${bank.name} · ${from} to ${to}`);
console.error(`opening ${money(opening)} · ${lines.length} statement lines · closing ${money(running)}`);
console.error('\nWhat was done to it on purpose:');
for (const n of notes) console.error('  ' + n);
