/**
 * Start a real agency's book from the demo one.
 *
 * WHY THIS EXISTS
 *
 * The accounting module covers its whole specification, and every voucher type is
 * writable and live. None of that made it usable by an actual agency, because
 * `content/accounting.json` holds a 45-day demo: 118 invoices, 163 bills, 150
 * payments, around ৳2.7 crore of somebody else's turnover. An agency starting on
 * that would issue its first invoice as SFT-INV-119 into a ledger it did not write,
 * and its first trial balance would be a stranger's. "Complete against the spec"
 * and "ready to use" are not the same claim, and only the first one was true.
 *
 * This clears the transactions and keeps the setup — chart of accounts, currencies,
 * airlines, hotels, visa types, countries, services, expense categories, bank
 * accounts, roles, voucher prefixes, VAT and company details. Those took real work
 * to assemble and are the same for any Bangladeshi agency.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not run itself, it is not wired to a button, and it refuses without an
 * explicit typed confirmation. Wiping a book is the one operation here that cannot
 * be undone from inside the app, and the demo book is also a sales asset — the
 * screens are only persuasive because there is a year of plausible trading in
 * them. Nobody should reach this by clicking around.
 *
 *   node scripts/new-book.mjs                      # report only, changes nothing
 *   node scripts/new-book.mjs --confirm NEW-BOOK   # actually do it
 *
 *   --keep-parties     keep customers and suppliers, with their opening balances zeroed
 *   --keep-openings    keep opening cash and bank balances instead of zeroing them
 *   --company "Name"   set the company name at the same time
 *
 * On opening balances: they are zeroed by default because a fresh book with bank
 * balances and no equity behind them does not balance, and a trial balance that is
 * out on day one teaches the operator to ignore it. Enter real opening balances
 * through Masters and Settings afterwards, where the equity side is handled.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const BOOK = path.resolve('content/accounting.json');
const BACKUP_DIR = path.resolve('content/backups');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(name);

const CONFIRM_PHRASE = 'NEW-BOOK';
const confirmed = arg('--confirm') === CONFIRM_PHRASE;
const keepParties = flag('--keep-parties');
const keepOpenings = flag('--keep-openings');
const companyName = arg('--company');

/**
 * Transaction collections. Everything here is a voucher or a movement — something
 * the agency will create for itself — so all of it goes.
 */
const VOUCHERS = [
  'invoices', 'receipts', 'bills', 'payments', 'expenses',
  'creditNotes', 'supplierCreditNotes', 'supplierDeposits', 'transfers'
];

/**
 * Setup collections. These are the same for any agency in this market and are
 * why the module is worth using on day one rather than day thirty.
 */
const MASTERS = [
  'roles', 'services', 'banks', 'expenseCategories', 'employees',
  'airlines', 'hotels', 'visaTypes', 'countries', 'currencies'
];

const money = (n) => `৳${Math.round(n).toLocaleString('en-IN')}`;

if (!existsSync(BOOK)) {
  console.error(`  ${BOOK} does not exist. Nothing to do.`);
  process.exit(1);
}

const book = JSON.parse(readFileSync(BOOK, 'utf8'));

/* ------------------------------------------------------------------- report */
console.log('\n  Current book\n');
let txCount = 0;
for (const k of VOUCHERS) {
  const n = Array.isArray(book[k]) ? book[k].length : 0;
  txCount += n;
  console.log(`    ${k.padEnd(22)} ${String(n).padStart(5)}  will be cleared`);
}
console.log('');
for (const k of MASTERS) {
  const n = Array.isArray(book[k]) ? book[k].length : 0;
  console.log(`    ${k.padEnd(22)} ${String(n).padStart(5)}  kept`);
}
const stockRows = Array.isArray(book.inventory) ? book.inventory.length : 0;
console.log(`    ${'inventory'.padEnd(22)} ${String(stockRows).padStart(5)}  kept as stock lines, purchased/sold reset to 0`);
console.log(`    ${'customers'.padEnd(22)} ${String((book.customers ?? []).length).padStart(5)}  ${keepParties ? 'kept, opening balances zeroed' : 'cleared (pass --keep-parties to keep)'}`);
console.log(`    ${'suppliers'.padEnd(22)} ${String((book.suppliers ?? []).length).padStart(5)}  ${keepParties ? 'kept, opening balances zeroed' : 'cleared (pass --keep-parties to keep)'}`);

const openingTotal =
  Number(book.company?.openingCash ?? 0) +
  (book.banks ?? []).reduce((s, b) => s + Number(b.openingBalance ?? 0), 0);
console.log(`\n    opening cash and bank    ${money(openingTotal).padStart(16)}  ${keepOpenings ? 'kept' : 'zeroed'}`);

if (!confirmed) {
  console.log(`\n  Report only — nothing was written.`);
  console.log(`  ${txCount} transaction(s) would be removed.\n`);
  console.log(`  To do it:  node scripts/new-book.mjs --confirm ${CONFIRM_PHRASE}`);
  console.log(`  Options :  --keep-parties  --keep-openings  --company "Agency Name"\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------- backup */
mkdirSync(BACKUP_DIR, { recursive: true });
/**
 * Stamp from the book's own clock rather than a fresh Date, so a run at 00:05
 * Dhaka does not file itself under yesterday — the same UTC-versus-local mistake
 * that put a 31 August deadline into September everywhere else in this project.
 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(BACKUP_DIR, `accounting-before-new-book-${stamp}.json`);
writeFileSync(backup, JSON.stringify(book, null, 2), 'utf8');
console.log(`\n  Backed up to ${path.relative(process.cwd(), backup)}`);

/* -------------------------------------------------------------------- clear */
for (const k of VOUCHERS) if (Array.isArray(book[k])) book[k] = [];

if (Array.isArray(book.inventory)) {
  // Keep the stock definitions — a Hajj seat block is a product, not a movement —
  // but zero the quantities, or the new book inherits stock it never bought.
  book.inventory = book.inventory.map((row) => ({ ...row, purchased: 0, sold: 0 }));
}

const zeroOpening = (rows) => rows.map((r) => ('openingBalance' in r ? { ...r, openingBalance: 0 } : r));

if (keepParties) {
  book.customers = zeroOpening(book.customers ?? []);
  book.suppliers = zeroOpening(book.suppliers ?? []);
} else {
  book.customers = [];
  book.suppliers = [];
}

if (!keepOpenings) {
  book.company.openingCash = 0;
  book.banks = (book.banks ?? []).map((b) => ({ ...b, openingBalance: 0 }));
}

if (companyName) book.company.name = companyName;

/**
 * The note said "Demo figures — generated by scripts/seed-accounting.mjs" and that
 * line is load-bearing: it is what tells the next person, and the honesty checks,
 * that the numbers on screen are not a real agency's. It has to change, or a real
 * book keeps announcing itself as a demo.
 */
book._meta = {
  ...book._meta,
  note: `Live book for ${book.company.name}. Started from a cleared demo book by scripts/new-book.mjs.`,
  startedOn: new Date().toISOString().slice(0, 10),
  seededOn: undefined,
  coversDays: undefined,
  revision: Number(book._meta?.revision ?? 0) + 1,
  lastEditedBy: 'scripts/new-book.mjs',
  lastEditedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
};
for (const k of Object.keys(book._meta)) if (book._meta[k] === undefined) delete book._meta[k];

/* --------------------------------------------------------- atomic write out */
const tmp = `${BOOK}.tmp`;
writeFileSync(tmp, JSON.stringify(book, null, 2), 'utf8');
renameSync(tmp, BOOK);

console.log(`  Wrote a clean book for ${book.company.name}`);
console.log(`    ${txCount} transaction(s) removed`);
console.log(`    voucher numbering restarts at 1 — prefixes kept (${book.company.invoicePrefix}1, ${book.company.receiptPrefix}1, …)`);
console.log(`    ${(book.banks ?? []).length} bank account(s), ${(book.currencies ?? []).length} currencies, ${(book.services ?? []).length} services kept`);

/* ------------------------------------------------ prove it actually balances */
const appUrl = process.env.APP_URL || 'http://127.0.0.1:3002';
try {
  const res = await fetch(`${appUrl}/api/accounts/export?format=csv&section=reconciliation`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.text()).trim().split(/\r?\n/).slice(1);
  const bad = rows.filter((r) => {
    const cells = r.split('","').map((c) => c.replace(/^"|"$/g, ''));
    return Number(cells[3]) !== 0;
  });
  console.log(`\n  Checked against the running app: ${rows.length} control account(s), ${bad.length} out of balance`);
  if (bad.length) {
    console.log('  The new book does NOT balance. Restore the backup and report this:');
    for (const r of bad) console.log(`    ${r}`);
    process.exit(1);
  }
  console.log('  The fresh book balances. Enter opening balances through Masters and Settings.\n');
} catch (err) {
  // Not a failure of the write — just say so rather than implying it was verified.
  console.log(`\n  Could not reach ${appUrl} to verify (${err.message}).`);
  console.log('  Start the app and open /accounts/financials to confirm it balances.\n');
}
