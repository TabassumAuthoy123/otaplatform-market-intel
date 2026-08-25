/**
 * Generate a bank statement and import it, so the reconciliation screen has something
 * real to show.
 *
 *   node scripts/seed-bank-statement.mjs                       # DBBL, July 2026
 *   node scripts/seed-bank-statement.mjs BNK-001 2026-07-01 2026-07-31
 *
 * The statement comes from `scripts/make-bank-statement.mjs`, which builds it out of the
 * book's own movements and then breaks it on purpose in seven specific ways — a cheque
 * presented late, an unpresented payment, a deposit in transit, two bank charges, an
 * interest credit and an unexplained ATM debit. That is what makes the screen worth
 * looking at: a reconciliation with nothing wrong demonstrates nothing.
 *
 * It goes through exactly the same parser the portal import uses, so what lands in the
 * book here is what would land there. A seeder with its own shortcut would be a second
 * import path, and the first thing to drift.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../lib/bank-statement.js');

const [, , bankId = 'BNK-001', from = '2026-07-01', to = '2026-07-31'] = process.argv;

const BOOK = 'content/accounting.json';
const book = JSON.parse(readFileSync(BOOK, 'utf8'));
const bank = book.banks.find((b) => b.id === bankId);
if (!bank) {
  console.error(`No bank ${bankId}. Have: ${book.banks.map((b) => `${b.id} ${b.name}`).join(', ')}`);
  process.exit(1);
}

const csv = execFileSync(process.execPath, ['scripts/make-bank-statement.mjs', bankId, from, to], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit']
});

const p = S.preview(csv);
if (p.error) {
  console.error(`The generated statement did not parse: ${p.error}`);
  process.exit(1);
}
if (p.problems.length) {
  console.error(`${p.problems.length} line(s) unreadable:`);
  for (const x of p.problems.slice(0, 5)) console.error('  ' + x);
  process.exit(1);
}
if (p.chain.checked && !p.chain.ok) {
  console.error(`The running balance does not verify: ${p.chain.detail}`);
  process.exit(1);
}

const id = `BST-${bankId}-${from}`;
const statement = {
  id,
  bankId,
  from,
  to,
  openingBalance: p.summary.openingPrinted,
  closingBalance: p.summary.closingPrinted,
  balanceSource: 'file',
  dateFormat: p.dateFormat,
  mapping: p.mapping,
  lines: p.lines,
  decisions: [],
  importedAt: `${to}T10:00:00.000Z`,
  importedBy: 'seed-bank-statement (demo data)',
  raw: csv,
  seededBy: 'seed-bank-statement'
};

book.bankStatements = [
  ...(book.bankStatements || []).filter((s) => s.id !== id),
  statement
];
book.bankReconciliations = book.bankReconciliations || [];
book._meta.revision = (book._meta.revision || 0) + 1;
book._meta.lastEditedBy = 'scripts/seed-bank-statement.mjs';
writeFileSync(BOOK, JSON.stringify(book, null, 2));

console.log(`Imported ${p.lines.length} lines for ${bank.name}, ${from} to ${to}.`);
console.log(`  date format   ${p.dateFormat}`);
console.log(`  running balance ${p.chain.checked ? (p.chain.ok ? 'verified against the bank\'s own arithmetic' : 'BROKEN') : 'absent'}`);
console.log(`  opening ${p.summary.openingPrinted}  closing ${p.summary.closingPrinted}`);
console.log('\nOpen /accounts/reconcile to see it.');
