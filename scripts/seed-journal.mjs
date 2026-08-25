/**
 * A starting chart of adjustment accounts, and four worked journal vouchers.
 *
 *   node scripts/seed-journal.mjs
 *
 * WHY THIS IS SEEDED AT ALL
 *
 * The trading side of this book is generated from 45 days of invented invoices and
 * bills, and it reads convincingly because there is a lot of it. The journal had
 * nothing, which made the screen that explains the most interesting design decision
 * in the accounting module — that a manual voucher may touch a control account, and
 * that when it does the reconciliation states it rather than hiding it — the one
 * screen with nothing on it to look at.
 *
 * The four below are the four reasons an agency actually posts one: an expense that
 * is real but has no bill, spending already paid for that belongs to a later month,
 * an asset losing value, and money that went missing at the counter. The last one
 * touches Cash, deliberately, so the reconciling-items panel on Financials has
 * something in it.
 *
 * Re-running replaces what this script wrote and leaves anything else alone, so it is
 * safe on a book somebody has already posted to.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const BOOK = 'content/accounting.json';
const book = JSON.parse(readFileSync(BOOK, 'utf8'));

/** Marked, so a re-run can tell its own rows from an accountant's. */
const SEEDED = 'seed-journal';

const ACCOUNTS = [
  { id: 'GLA-0001', code: 'OFFEQ', name: 'Office equipment — at cost', group: 'asset', note: 'Counters, computers, the printer that does the tickets.' },
  { id: 'GLA-0002', code: 'ACCDEP', name: 'Accumulated depreciation — office equipment', group: 'liability', note: 'Contra-asset. Held as a liability group so the balance sheet nets it against the cost above.' },
  { id: 'GLA-0003', code: 'PREPAID', name: 'Prepaid expenses', group: 'asset', note: 'Rent, insurance and licences paid for a period that has not happened yet.' },
  { id: 'GLA-0004', code: 'ACCRUED', name: 'Accrued expenses', group: 'liability', note: 'Costs the month really incurred and no supplier has billed yet.' },
  { id: 'GLA-0005', code: 'DEPEXP', name: 'Depreciation expense', group: 'expense', note: '' },
  { id: 'GLA-0006', code: 'RENTEXP', name: 'Rent expense', group: 'expense', note: '' },
  { id: 'GLA-0007', code: 'SHORTAGE', name: 'Cash shortages and write-offs', group: 'expense', note: 'Counter differences. Small, and worth seeing rather than absorbing into an expense category.' },
  {
    id: 'GLA-0008', code: 'SUSPENSE', name: 'Suspense', group: 'asset',
    note: 'For a figure that is known to be wrong and not yet known to be what. A balance here at month end is a question nobody has answered — it should be empty before a period is closed.'
  },
  { id: 'GLA-0009', code: 'RETAINED', name: 'Retained earnings brought forward', group: 'equity', note: 'Where last year lands once a year is closed.' }
];

const VOUCHERS = [
  {
    id: 'jv_seed_0001', no: 'SFT-JV-0001', date: '2026-07-31',
    narration: 'Depreciation on office equipment for July — 3 years straight line',
    lines: [
      { account: 'GL:DEPEXP', debit: 8750, credit: 0, memo: 'counters, 2 desktops, ticket printer' },
      { account: 'GL:ACCDEP', debit: 0, credit: 8750, memo: '' }
    ]
  },
  {
    id: 'jv_seed_0002', no: 'SFT-JV-0002', date: '2026-07-31',
    narration: 'Accrue July office rent — landlord invoices in arrears',
    lines: [
      { account: 'GL:RENTEXP', debit: 45000, credit: 0, memo: 'Gulshan counter' },
      { account: 'GL:ACCRUED', debit: 0, credit: 45000, memo: '' }
    ]
  },
  {
    id: 'jv_seed_0003', no: 'SFT-JV-0003', date: '2026-08-01',
    narration: 'Release one month of the annual IATA licence paid in advance',
    lines: [
      { account: 'GL:RENTEXP', debit: 0, credit: 0, memo: '' }
    ]
  },
  {
    id: 'jv_seed_0004', no: 'SFT-JV-0004', date: '2026-08-12',
    narration: 'Cash shortage at the Gulshan counter, written off after recount',
    lines: [
      { account: 'GL:SHORTAGE', debit: 1450, credit: 0, memo: 'two days recounted, difference not traced' },
      { account: 'CASH', debit: 0, credit: 1450, memo: 'control account — appears as a reconciling item' }
    ]
  }
];

// The third one above is written properly here rather than inline, because a prepaid
// release is the one of the four whose direction people get backwards: the ASSET goes
// down and the expense goes up, not the other way round.
VOUCHERS[2].lines = [
  { account: 'GL:RENTEXP', debit: 12500, credit: 0, memo: 'one twelfth of the annual licence' },
  { account: 'GL:PREPAID', debit: 0, credit: 12500, memo: '' }
];

book.ledgerAccounts = [
  ...(book.ledgerAccounts || []).filter((a) => a.seededBy !== SEEDED && !ACCOUNTS.some((x) => x.id === a.id)),
  ...ACCOUNTS.map((a) => ({ ...a, seededBy: SEEDED }))
];

book.journalEntries = [
  ...(book.journalEntries || []).filter((v) => v.seededBy !== SEEDED && !VOUCHERS.some((x) => x.id === v.id)),
  ...VOUCHERS.map((v) => ({
    ...v,
    createdBy: 'seed-journal (demo data)',
    createdAt: `${v.date}T04:00:00.000Z`,
    seededBy: SEEDED
  }))
];

book._meta.revision = (book._meta.revision || 0) + 1;
book._meta.lastEditedBy = 'scripts/seed-journal.mjs';

writeFileSync(BOOK, JSON.stringify(book, null, 2));

const total = VOUCHERS.reduce((t, v) => t + v.lines.reduce((s, l) => s + l.debit, 0), 0);
console.log(`Seeded ${ACCOUNTS.length} ledger accounts and ${VOUCHERS.length} journal vouchers, ${total.toLocaleString('en-IN')} in total.`);
console.log('One of them posts to Cash on purpose, so the reconciling-items panel on /accounts/financials has something in it.');
