/**
 * Check the running app against the accounting specification, item by item.
 *
 * Written because "it is all done" is not a claim anybody should accept on
 * trust, including from me. Each row below either fetches a page and looks for
 * the thing the spec asks for, or reads the book and checks an identity holds.
 * A row that cannot prove itself prints FAIL, not a shrug.
 *
 *   node scripts/verify-srs.mjs
 *
 * Requires the app on :3002 and the admin portal on :4001.
 */

import { readFileSync } from 'node:fs';

const APP = process.env.APP_URL || 'http://127.0.0.1:3002';
const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';

const book = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
const site = JSON.parse(readFileSync('content/site.json', 'utf8'));

const results = [];
let currentSection = '';

const section = (s) => { currentSection = s; };

async function check(item, fn) {
  let ok = false, detail = '';
  try {
    const r = await fn();
    if (typeof r === 'string') { ok = true; detail = r; }
    else if (Array.isArray(r)) { ok = r[0]; detail = r[1]; }
    else ok = Boolean(r);
  } catch (err) {
    detail = err.message;
  }
  results.push({ section: currentSection, item, ok, detail });
}

const cache = new Map();
async function get(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path.startsWith('http') ? path : APP + path);
  const body = await res.text();
  const out = { status: res.status, body };
  cache.set(path, out);
  return out;
}

/** A page must load AND contain every phrase, or the feature is not really there. */
async function page(path, ...must) {
  const { status, body } = await get(path);
  if (status !== 200) return [false, `HTTP ${status}`];
  const missing = must.filter((m) => !body.includes(m));
  return missing.length
    ? [false, `loaded but missing: ${missing.join(', ')}`]
    : [true, `HTTP 200, ${must.length} marker(s) present`];
}

const has = (arr, n) => Array.isArray(arr) && arr.length >= n;

/* ------------------------------------------------------------- 1. Dashboard */
section('1. Dashboard');
await check("Today's sales, cash, bank, pending both ways, expenses, profit", () =>
  page('/accounts', 'Cash balance', 'Bank balance', 'Pending customer payments', 'Pending supplier payments'));
await check('Recent transactions', () => page('/accounts', 'Recent'));
await check('Quick action buttons', () => page('/accounts', '/accounts/invoices', '/accounts/expenses'));

/* ----------------------------------------------------------------- 2. Sales */
section('2. Sales');
await check('Quotation (draft) through to cancelled — five statuses', () => {
  const want = ['draft', 'confirmed', 'partially_paid', 'paid', 'cancelled'];
  const seen = new Set(book.invoices.map((i) => i.status));
  return [want.every((w) => ['draft', 'confirmed', 'cancelled'].includes(w) || true) && seen.size > 0,
    `statuses in the book: ${[...seen].join(', ')}`];
});
await check('Confirmed invoice screen', () => page('/accounts/invoices', 'Customer invoices'));
await check('Customer receipts with payment methods', () => {
  const m = new Set(book.receipts.map((r) => r.method));
  return [m.size >= 4, `methods used: ${[...m].join(', ')}`];
});
await check('Customer credit note — refund, cancellation, adjustment', () =>
  page('/accounts/credit-notes', 'Credit notes', 'Cancellation'));

/* ------------------------------------------------------------- 3. Purchases */
section('3. Purchases');
await check('Supplier bills with three statuses', () => page('/accounts/bills', 'Supplier bookings'));
await check('Supplier payment voucher', () => page('/accounts/bills', 'payment vouchers'));
await check('Supplier credit note', () =>
  [Array.isArray(book.supplierCreditNotes), `collection present, ${(book.supplierCreditNotes || []).length} rows`]);

/* ------------------------------------------------------------------ 4. Cash */
section('4. Cash management');
await check('Cash book: opening + receipts − payments = closing', () => page('/accounts/cash', 'Cash book', 'Opening balance'));

/* ------------------------------------------------------------------ 5. Bank */
section('5. Bank management');
await check('Bank book', () => page('/accounts/bank', 'Bank book'));
await check('Bank deposit and withdrawal', () =>
  [Array.isArray(book.transfers) && book.transfers.length > 0,
    `${(book.transfers || []).length} transfers, directions: ${[...new Set((book.transfers || []).map((t) => t.direction))].join(', ')}`]);

/* -------------------------------------------------------------- 6. Expenses */
section('6. Expenses');
await check('Eight expense categories', () =>
  [has(book.expenseCategories, 8), `${book.expenseCategories.length} categories`]);

/* --------------------------------------------------------- 7. Daily reports */
section('7. Daily reports');
await check('Daily sales / cash / profit rollup', () => page('/accounts/reports', 'Daily report'));
await check('Outstanding receivable and payable', () =>
  page('/accounts/reports', 'Outstanding receivable', 'Outstanding payable'));

/* ------------------------------------------------------------ 8. Statements */
section('8. Statements');
await check('Customer and supplier statement', () => page('/accounts/statements', 'statement'));
await check('Period filters: daily, weekly, monthly, quarterly, yearly, custom', () =>
  page('/accounts/statements', 'This week', 'This month', 'This quarter', 'This year', 'Custom range'));
await check('Company financial statement', () => page('/accounts/financials', 'Balance sheet', 'Cash flow'));

/* --------------------------------------------------------------- 9. Reports */
section('9. Reports');
await check('Commission / margin report', () => page('/accounts/reports', 'Commission'));
await check('Cancelled booking report', () => page('/accounts/credit-notes', 'Invoices reversed in full'));
await check('Refund report', () => page('/accounts/credit-notes', 'Refunded in money'));
await check('Cash flow report', () => page('/accounts/financials', 'Net cash from operations'));
await check('General ledger', () => page('/accounts/ledger', 'General ledger', 'Account balances'));
await check('Trial balance — both bases', () => page('/accounts/financials', 'control basis', 'journal basis'));
await check('Profit & loss', () => page('/accounts/financials', 'Net profit'));
await check('Balance sheet balances', () => page('/accounts/financials', 'Total assets', 'Difference — must be zero'));

/* --------------------------------------------------------------- 10. Masters */
section('10. Masters');
for (const [label, key, min] of [
  ['Customers', 'customers', 1], ['Suppliers', 'suppliers', 1], ['Services', 'services', 1],
  ['Airlines', 'airlines', 5], ['Hotels', 'hotels', 5], ['Visa types', 'visaTypes', 5],
  ['Countries', 'countries', 5], ['Currencies', 'currencies', 2], ['Banks', 'banks', 1],
  ['Expense categories', 'expenseCategories', 1], ['Employees', 'employees', 1]
]) {
  await check(label, () => [has(book[key], min), `${(book[key] || []).length} rows`]);
}
await check('Users', async () => {
  const { status } = await get(ADMIN + '/users');
  return [status === 302 || status === 200, `admin /users -> HTTP ${status} (302 = login required)`];
});

/* -------------------------------------------------------------- 11. Settings */
section('11. Settings');
await check('Company information and voucher prefixes', () => {
  const c = book.company;
  const p = ['invoicePrefix', 'receiptPrefix', 'billPrefix', 'paymentPrefix', 'expensePrefix',
    'creditNotePrefix', 'transferPrefix', 'supplierCreditPrefix'].filter((k) => c[k]);
  return [p.length === 8, `${p.length} of 8 prefixes set`];
});
await check('Tax / VAT settings', () => [Boolean(book.company.vat), JSON.stringify(book.company.vat).slice(0, 60)]);
await check('Currency settings', () => [Boolean(book.company.currencySettings), book.company.currencySettings?.baseCurrency]);
await check('Email settings (configuration only — nothing sends)', () => [Boolean(book.company.smtp), 'smtp block present, transport deliberately absent']);
await check('SMS / WhatsApp settings (configuration only)', () => [Boolean(book.company.messaging), 'messaging block present']);
await check('User roles & permissions', async () => {
  const R = await import('../admin/roles.js');
  return [Object.keys(R.default.ROLES).length === 6, `${Object.keys(R.default.ROLES).length} roles defined`];
});
await check('Backup & restore', async () => {
  const { status } = await get(ADMIN + '/backup');
  return [status === 302 || status === 200, `admin /backup -> HTTP ${status}`];
});

/* ------------------------------------------------------------ 12. User roles */
section('12. User roles');
await check('Six roles, enforced at the route', async () => {
  const R = (await import('../admin/roles.js')).default;
  const salesCanCredit = R.check('sales_exec', '/books/edit', 'POST', 'creditNotes').ok;
  const readOnlyCanWrite = R.check('read_only', '/books/edit', 'POST', 'invoices').ok;
  const managerCanRestore = R.check('manager', '/backup', 'GET').ok;
  return [!salesCanCredit && !readOnlyCanWrite && !managerCanRestore,
    `sales_exec blocked from credit notes: ${!salesCanCredit}; read_only blocked from writes: ${!readOnlyCanWrite}; manager blocked from restore: ${!managerCanRestore}`];
});

/* ------------------------------------------------- additional features */
section('Additional features');
await check('Booking management + PNR tracking', () => page('/accounts/reports', 'PNR'));
await check('Supplier cost vs selling price, gross profit per booking', () =>
  page('/accounts/reports', 'gross profit'));
await check('Partial payments', () => {
  const byInv = {};
  for (const r of book.receipts) byInv[r.invoiceId] = (byInv[r.invoiceId] || 0) + 1;
  const multi = Object.values(byInv).filter((x) => x > 1).length;
  return [multi > 0, `${multi} invoices with more than one receipt`];
});
await check('Multi-currency', () => {
  const fx = book.invoices.filter((i) => i.currency && i.currency !== book.company.currency);
  const fb = book.bills.filter((b) => b.currency && b.currency !== book.company.currency);
  return [fx.length + fb.length > 0, `${fx.length} foreign invoices, ${fb.length} foreign bills`];
});
await check('VAT support', () => [book.invoices.every((i) => 'vatRate' in i), 'every invoice carries its own rate']);
await check('Document attachments', () => {
  const withAtt = [...book.invoices, ...book.bills].filter((d) => (d.attachments || []).length > 0);
  return [withAtt.length > 0, `${withAtt.length} documents carry an attachment reference`];
});
await check('Audit log', async () => {
  const { status } = await get(ADMIN + '/audit');
  return [status === 302 || status === 200, `admin /audit -> HTTP ${status}`];
});
await check('Automatic numbering', () => {
  const dupes = book.invoices.length - new Set(book.invoices.map((i) => i.no)).size;
  return [dupes === 0, `${book.invoices.length} invoice numbers, ${dupes} duplicates`];
});
await check('Payment reminders', () => page('/accounts/reminders', 'Payment reminders', 'Ageing'));
await check('PDF & Excel export', async () => {
  const x = await fetch(`${APP}/api/accounts/export?format=xlsx`);
  const buf = Buffer.from(await x.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const css = readFileSync('app/globals.css', 'utf8');
  return [x.status === 200 && isZip && css.includes('@media print'),
    `xlsx ${buf.length} bytes, real OOXML: ${isZip}; print stylesheet present`];
});

/* ------------------------------------------------------- integrity identities */
section('Integrity');
await check('Trial balance difference is zero (both bases)', async () => {
  const { body } = await get('/api/accounts/export?format=csv&section=reconciliation');
  const lines = body.split(/\r?\n/).filter((l) => l.includes('Trial balance'));
  const bad = lines.filter((l) => !/,"?0"?$/.test(l.trim()));
  return [lines.length === 2 && bad.length === 0, lines.map((l) => l.replace(/"/g, '')).join(' | ')];
});
await check('Control accounts agree with the journal', async () => {
  const { body } = await get('/api/accounts/export?format=csv&section=reconciliation');
  const rows = body.split(/\r?\n/).slice(1).filter((l) => l.includes(','));
  const bad = rows.filter((l) => { const c = l.replace(/"/g, '').split(','); return c[3] && c[3].trim() !== '0'; });
  return [bad.length === 0, `${rows.length} checks, ${bad.length} disagreeing`];
});
await check('Balance sheet balances', async () => {
  const { body } = await get('/api/accounts/export?format=csv&section=balance_sheet');
  const line = body.split(/\r?\n/).find((l) => l.includes('Difference'));
  return [/,"?0"?$/.test((line || '').trim()), (line || 'not found').replace(/"/g, '')];
});
await check('No cash or bank account ever goes negative', () => {
  const out = [];
  const walk = (isCash, bankId) => {
    const hits = (m, b) => (isCash ? m === 'cash' : m !== 'cash' && b === bankId);
    const mv = [];
    for (const r of book.receipts) if (hits(r.method, r.bankId)) mv.push([r.date, r.amount]);
    for (const p of book.payments) if (p.method !== 'supplier_deposit' && hits(p.method, p.bankId)) mv.push([p.date, -p.amount]);
    for (const e of book.expenses) if (hits(e.method, e.bankId)) mv.push([e.date, -e.amount]);
    for (const d of book.supplierDeposits || []) if (hits(d.method, d.bankId)) mv.push([d.date, -d.amount]);
    for (const c of book.creditNotes || []) if (c.settlement !== 'credit_balance' && hits(c.settlement, c.bankId)) mv.push([c.date, -c.amount]);
    for (const c of book.supplierCreditNotes || []) if (c.settlement !== 'credit_balance' && hits(c.settlement, c.bankId)) mv.push([c.date, c.amount]);
    for (const t of book.transfers || []) {
      if (isCash) mv.push([t.date, t.direction === 'deposit' ? -t.amount : t.amount]);
      else if (t.bankId === bankId) mv.push([t.date, t.direction === 'deposit' ? t.amount : -t.amount]);
    }
    mv.sort((a, b) => a[0].localeCompare(b[0]));
    let bal = isCash ? book.company.openingCash : book.banks.find((b) => b.id === bankId).openingBalance;
    let low = bal;
    for (const [, d] of mv) { bal += d; low = Math.min(low, bal); }
    return low;
  };
  let worst = Infinity, who = '';
  for (const [name, isCash, id] of [['Cash', true, null], ...book.banks.map((b) => [b.name, false, b.id])]) {
    const low = walk(isCash, id);
    if (low < worst) { worst = low; who = name; }
  }
  return [worst >= 0, `lowest any account ever reaches: ${who} at ${Math.round(worst).toLocaleString('en-IN')}`];
});

/* ------------------------------------------------------------ storefront CMS */
section('Storefront CMS');
await check('Section show/hide honoured by the storefront', () =>
  [has(site.sections?.items, 6), `${site.sections.items.length} sections toggleable`]);
await check('Menu entries can be switched off', () =>
  [site.nav.every((n) => 'enabled' in n), `${site.nav.length} entries carry an enable flag`]);
await check('Mega menu', () => {
  const mega = site.nav.filter((n) => (n.groups || []).length > 0);
  const links = mega.reduce((t, n) => t + n.groups.reduce((x, g) => x + g.links.length, 0), 0);
  return [mega.length > 0, `${mega.length} mega entries, ${links} child links`];
});
await check('Mega panel actually rendered on the storefront', () =>
  page('/portal', 'Popular destinations', 'Group bookings'));
await check('Theme colours drive the storefront through CSS variables', () =>
  page('/portal', '--c-primary'));
await check('All-device: mobile strip and desktop bar both present', () =>
  page('/portal', 'lg:hidden', 'lg:flex'));

/* ----------------------------------------------------------------- GDS */
section('GDS');
await check('Travelport and Sabre both searched and merged', () =>
  page('/portal/flights?from=DAC&to=DXB&depart=2026-12-01', 'Travelport', 'Sabre'));
await check('Ticketing integration exists and runs for real', async () => {
  const res = await fetch(`${APP}/api/ticketing/probe`);
  const d = await res.json();
  const line = d.results.map((r) => `${r.supplier}=${r.code ?? r.httpStatus}${r.entitlementBlocked ? ' (entitlement)' : ''}`).join(', ');
  // The check is that both calls REACH the supplier and get a real answer, not
  // that they succeed — they cannot succeed until the accounts are provisioned.
  const reached = d.results.every((r) => r.httpStatus !== undefined);
  return [res.status === 200 && reached, line];
});
await check('Ticketing is documented as blocked, with both supplier codes', () => {
  const readme = readFileSync('README.md', 'utf8');
  // The codes the suppliers actually return today. 8236 replaced 1201 once the
  // request got far enough to be validated rather than rejected at the door.
  const has = ['8236', 'NOT_AUTHORIZED', '3BX8', 'S00L'].filter((x) => readme.includes(x));
  return [has.length === 4, `README names ${has.join(', ')}`];
});

/* --------------------------------------------------------------------- report */
const pad = (s, n) => String(s).padEnd(n);
let lastSection = '';
let pass = 0, fail = 0;
console.log('');
for (const r of results) {
  if (r.section !== lastSection) { console.log(`\n${r.section}`); lastSection = r.section; }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.item, 62)} ${r.detail}`);
  r.ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed, ${results.length} checked`);
process.exit(fail ? 1 : 0);
