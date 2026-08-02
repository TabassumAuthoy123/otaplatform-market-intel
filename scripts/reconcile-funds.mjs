/**
 * Keep the seeded book's cash and bank accounts solvent on every single day.
 *
 * This exists because the demo book is generated, and generated money moves in
 * ways real money does not: every supplier advance funded from one account,
 * every receipt landing somewhere else. Recording supplier deposits as a real
 * outflow — which they are, and which the book previously did not do — pushed
 * cash to -540,400 and the operating bank account to -4,904,700.
 *
 * A negative bank balance is not a rounding artefact. It is the book claiming
 * the agency spent money it did not have, and anybody reading the cash book
 * would be right to stop trusting the rest of it.
 *
 * What this does, in order:
 *
 *   1. Spreads supplier advances across the bank accounts instead of draining
 *      one, and stops any of them being paid in cash — nobody hands an airline
 *      forty lakh in notes.
 *   2. Adds the treasury movements that were missing entirely: counter takings
 *      banked, and cash drawn back out to run the office.
 *   3. Walks every account day by day, finds its worst moment, and raises the
 *      opening balance so that moment clears a floor with room to spare.
 *
 * Step 3 is the honest one. An agency carrying an 88 lakh supplier float is
 * capitalised to carry it; the seed simply never said so. Raising the opening
 * balance says it, and because opening balances sit on the equity side, the
 * trial balance is untouched.
 *
 *   node scripts/reconcile-funds.mjs          report only
 *   node scripts/reconcile-funds.mjs --write  apply
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'content/accounting.json';
const FLOOR = 300000; // every account must stay this far above zero
const write = process.argv.includes('--write');

const book = JSON.parse(readFileSync(FILE, 'utf8'));
const banks = book.banks.map((b) => b.id);
const money = (n) => (n < 0 ? '-' : '') + '৳' + Math.abs(Math.round(n)).toLocaleString('en-IN');

/* ------------------------------------------------- 1. spread the advances */

let moved = 0;
book.supplierDeposits.forEach((d, i) => {
  const target = banks[i % banks.length];
  if (d.method !== 'bank_transfer' || d.bankId !== target) moved++;
  d.method = 'bank_transfer';
  d.bankId = target;
});

/* ---------------------------------------------- 2. the treasury movements */

const dates = book.receipts.map((r) => r.date).sort();
const at = (frac) => dates[Math.floor(dates.length * frac)] ?? book.company.financialYearStart;

book.transfers = [
  { direction: 'deposit', bankId: 'BNK-001', amount: 850000, ref: 'Counter takings', at: 0.15 },
  { direction: 'withdrawal', bankId: 'BNK-001', amount: 300000, ref: 'Office float', at: 0.28 },
  { direction: 'deposit', bankId: 'BNK-003', amount: 420000, ref: 'MFS settlement', at: 0.42 },
  { direction: 'deposit', bankId: 'BNK-001', amount: 1100000, ref: 'Counter takings', at: 0.55 },
  { direction: 'withdrawal', bankId: 'BNK-002', amount: 250000, ref: 'Petty cash top-up', at: 0.66 },
  { direction: 'deposit', bankId: 'BNK-001', amount: 700000, ref: 'Counter takings', at: 0.78 },
  { direction: 'withdrawal', bankId: 'BNK-001', amount: 400000, ref: 'Office float', at: 0.88 },
  { direction: 'deposit', bankId: 'BNK-002', amount: 950000, ref: 'Counter takings', at: 0.95 }
].map((t, i) => ({
  id: `TRF-${String(i + 1).padStart(4, '0')}`,
  no: `${book.company.transferPrefix}${String(i + 1).padStart(4, '0')}`,
  date: at(t.at),
  direction: t.direction,
  bankId: t.bankId,
  amount: t.amount,
  ref: t.ref,
  notes: t.direction === 'deposit' ? 'Cash banked' : 'Cash drawn for office use'
}));

/* ------------------------------ 3. walk each account and find its worst day */

/** Every dated movement for one funds account, signed. */
function movements(account) {
  const isCash = account === 'CASH';
  const bankId = isCash ? null : account;
  const hits = (m, b) => (isCash ? m === 'cash' : m !== 'cash' && b === bankId);
  const out = [];

  for (const r of book.receipts) if (hits(r.method, r.bankId)) out.push([r.date, r.amount]);
  for (const p of book.payments) if (p.method !== 'supplier_deposit' && hits(p.method, p.bankId)) out.push([p.date, -p.amount]);
  for (const e of book.expenses) if (hits(e.method, e.bankId)) out.push([e.date, -e.amount]);
  for (const d of book.supplierDeposits) if (hits(d.method, d.bankId)) out.push([d.date, -d.amount]);
  for (const c of book.creditNotes ?? []) {
    if (c.settlement !== 'credit_balance' && hits(c.settlement, c.bankId)) out.push([c.date, -c.amount]);
  }
  for (const c of book.supplierCreditNotes ?? []) {
    if (c.settlement !== 'credit_balance' && hits(c.settlement, c.bankId)) out.push([c.date, c.amount]);
  }
  for (const t of book.transfers) {
    if (isCash) out.push([t.date, t.direction === 'deposit' ? -t.amount : t.amount]);
    else if (t.bankId === bankId) out.push([t.date, t.direction === 'deposit' ? t.amount : -t.amount]);
  }

  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

const accounts = ['CASH', ...banks];
const report = [];
let raised = 0;

for (const account of accounts) {
  const isCash = account === 'CASH';
  const bank = isCash ? null : book.banks.find((b) => b.id === account);
  const opening = isCash ? book.company.openingCash : bank.openingBalance;

  let running = opening;
  let low = opening;
  let lowDate = book.company.financialYearStart;
  for (const [date, delta] of movements(account)) {
    running += delta;
    if (running < low) {
      low = running;
      lowDate = date;
    }
  }

  const shortfall = FLOOR - low;
  const bump = shortfall > 0 ? Math.ceil(shortfall / 100000) * 100000 : 0;
  if (bump > 0) {
    if (isCash) book.company.openingCash += bump;
    else bank.openingBalance += bump;
    raised += bump;
  }

  report.push({
    name: isCash ? 'Cash in hand' : bank.name,
    opening,
    low,
    lowDate,
    bump,
    newOpening: opening + bump,
    newLow: low + bump,
    newClosing: running + bump
  });
}

/* ------------------------------------------------------------------ output */

console.log(`Supplier advances re-pointed: ${moved} of ${book.supplierDeposits.length}`);
console.log(`Treasury movements added:     ${book.transfers.length}`);
console.log(`Floor:                        ${money(FLOOR)}\n`);
console.log('Account                        was low on      lowest   opening +   new lowest   new closing');
for (const r of report) {
  console.log(
    r.name.padEnd(30) +
    r.lowDate.padEnd(15) +
    money(r.low).padStart(12) +
    money(r.bump).padStart(12) +
    money(r.newLow).padStart(13) +
    money(r.newClosing).padStart(14)
  );
}
console.log(`\nOpening capital raised by ${money(raised)} — equity side, so the trial balance does not move.`);

if (write) {
  writeFileSync(FILE, JSON.stringify(book, null, 2) + '\n', 'utf8');
  console.log(`\nWritten to ${FILE}`);
} else {
  console.log('\nReport only. Re-run with --write to apply.');
}
