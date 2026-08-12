/**
 * Create documents from the invoice lines that already carry a PNR.
 *
 * WHAT THIS WILL AND WILL NOT INVENT
 *
 * 89 invoice lines in this book carry a real-shaped PNR. None of them carry a
 * ticket number, a base fare, a tax breakdown or a commission, because until now
 * there was nowhere to put those. This script migrates the four things it actually
 * knows — the PNR, the service, the supplier and the amount paid — and leaves
 * every unknown field null.
 *
 * It does NOT synthesise a document number, and it does NOT split `supplierCost`
 * into a plausible-looking fare and tax. A fabricated 13-digit number is worse
 * than an empty one: it reconciles against nothing, and the first person to match
 * it against a BSP file spends a day finding out it was never real. A guessed fare
 * split produces a margin that looks precise and is not, which is the exact
 * failure this project has spent its time removing.
 *
 * So the documents it creates are `status: "booked"` — a PNR exists, nothing was
 * issued. That is not a compromise, it is literally our position: Travelport
 * creates real PNRs on these credentials and Galileo refuses to issue.
 *
 *   node scripts/backfill-documents.mjs            # report only, writes nothing
 *   node scripts/backfill-documents.mjs --write    # do it
 *
 * Safe to re-run. A line that already has a documentId is skipped, so it will not
 * create a second document for the same sale.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

const BOOK = path.resolve('content/accounting.json');
const BACKUP_DIR = path.resolve('content/backups');
const write = process.argv.includes('--write');

const book = JSON.parse(readFileSync(BOOK, 'utf8'));
const services = Object.fromEntries((book.services ?? []).map((s) => [s.id, s]));
const money = (n) => `৳${Math.round(n).toLocaleString('en-IN')}`;

/**
 * Only air services become documents.
 *
 * A Hajj package and an Umrah package also carry a PNR in this book, and they are
 * genuinely multi-component sales — flight plus hotel plus ground — so turning one
 * into a single ticket document would misrepresent it. Air only, and the rest are
 * left alone until there is a package model to hang them off.
 */
const isAir = (serviceId) => /air ticket/i.test(services[serviceId]?.name ?? '');

book.documents = Array.isArray(book.documents) ? book.documents : [];
const existingIds = new Set(book.documents.map((d) => d.id));
let seq = book.documents.length;

const created = [];
const skipped = { alreadyLinked: 0, noPnr: 0, notAir: 0 };

for (const invoice of book.invoices) {
  for (const line of invoice.lines) {
    if (line.documentId) { skipped.alreadyLinked += 1; continue; }
    if (!line.pnr || !String(line.pnr).trim()) { skipped.noPnr += 1; continue; }
    if (!isAir(line.serviceId)) { skipped.notAir += 1; continue; }

    seq += 1;
    let id = `DOC-${String(seq).padStart(4, '0')}`;
    while (existingIds.has(id)) { seq += 1; id = `DOC-${String(seq).padStart(4, '0')}`; }
    existingIds.add(id);

    const doc = {
      id,
      // Not invented. There is no ticket number in this book to migrate.
      documentNo: null,
      type: 'TKT',
      status: 'booked',
      pnr: String(line.pnr).trim(),
      platingCarrier: '',
      passengerName: '',
      sectors: [],
      issueDate: null,
      // No sector means no departure means no travel date. Deferral (step 2) will
      // skip these rather than guess, and the screen says how many are unknown.
      travelDate: null,
      currency: invoice.currency ?? book.company.currency,
      fxRate: Number(invoice.fxRate) || 1,
      // The split is unknown. Recording the total as a base fare with zero tax
      // would be a lie that every margin report would then repeat.
      baseFare: null,
      taxes: [],
      commissionPct: null,
      commissionAmt: null,
      formOfPayment: 'bsp_cash',
      supplierId: line.supplierId || null,
      settlementRef: null,
      settled: false,
      branchId: null,
      consultantId: null,
      notes: `Migrated from ${invoice.no}. PNR known; fare breakdown was never recorded.`
    };

    book.documents.push(doc);
    line.documentId = id;
    created.push({ id, pnr: doc.pnr, invoice: invoice.no, cost: line.supplierCost });
  }
}

console.log('');
console.log(`  would create        ${created.length} document(s) from lines carrying a PNR`);
console.log(`  skipped, no PNR     ${skipped.noPnr}`);
console.log(`  skipped, not air    ${skipped.notAir}  (packages carry a PNR but are not one ticket)`);
console.log(`  skipped, linked     ${skipped.alreadyLinked}`);
if (created.length) {
  console.log('');
  console.log('  first few:');
  for (const c of created.slice(0, 6)) {
    console.log(`    ${c.id}  PNR ${c.pnr.padEnd(8)} from ${c.invoice}  cost ${money(c.cost)}`);
  }
  console.log('');
  console.log('  every one of them: documentNo null, baseFare null, taxes [] — nothing invented.');
}

if (!write) {
  console.log('');
  console.log('  Report only — nothing was written. Re-run with --write to apply.');
  console.log('');
  process.exit(0);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(BACKUP_DIR, `accounting-before-documents-${stamp}.json`);
writeFileSync(backup, readFileSync(BOOK, 'utf8'), 'utf8');

book._meta = {
  ...book._meta,
  revision: Number(book._meta?.revision ?? 0) + 1,
  lastEditedBy: 'scripts/backfill-documents.mjs',
  lastEditedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
};

const tmp = `${BOOK}.tmp`;
writeFileSync(tmp, JSON.stringify(book, null, 2), 'utf8');
renameSync(tmp, BOOK);

console.log('');
console.log(`  Backed up to ${path.relative(process.cwd(), backup)}`);
console.log(`  Wrote ${created.length} document(s) and linked them to their invoice lines.`);

/* ---------------------------------- the point of the whole exercise: prove nothing moved */
const appUrl = process.env.APP_URL || 'http://127.0.0.1:3002';
try {
  const res = await fetch(`${appUrl}/api/accounts/export?format=csv&section=reconciliation`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.text()).trim().split(/\r?\n/).slice(1);
  const bad = rows.filter((r) => {
    const cells = r.split('","').map((c) => c.replace(/^"|"$/g, ''));
    return Number(cells[3]) !== 0;
  });
  console.log('');
  console.log(`  Reconciliation after the write: ${rows.length} account(s), ${bad.length} out of balance`);
  if (bad.length) {
    console.log('  THE BOOK MOVED. Restore the backup — a document must never change a total.');
    for (const r of bad) console.log(`    ${r}`);
    process.exit(1);
  }
  console.log('  Every control account still agrees with the ledger. Nothing moved, which is the whole claim.');
  console.log('');
} catch (err) {
  console.log('');
  console.log(`  Could not reach ${appUrl} to verify (${err.message}).`);
  console.log('  Start the app and open /accounts/financials before trusting this.');
  console.log('');
}
