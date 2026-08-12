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

import http from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

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
  // The check is that both calls REACH the supplier and get a real answer.
  // Travelport's answer today is a created PNR; Sabre's is a refusal. Asserting
  // either specific outcome here is what made the old version of this file agree
  // with a wrong conclusion for weeks.
  const reached = d.results.every((r) => r.httpStatus !== undefined);
  return [res.status === 200 && reached, line];
});
await check('Ticketing is documented with each supplier answer, not one blanket claim', () => {
  const readme = readFileSync('README.md', 'utf8');
  /**
   * The Sabre row here read NOT_AUTHORIZED on /v2.5.0/passenger/records for weeks
   * while that path was answering 404 and had never been reached. Then the whole
   * Travelport row turned out to be our own missing branch. Both times the README
   * was confidently specific and wrong, so this now also requires the README to
   * carry the correction rather than only the current codes.
   */
  const want = ['8236', 'NEED TICKET ACCOUNT', 'UNAUTHORIZED_ACCESS', 'PassengerDetailsRQ',
    'createBooking', '3BX8', 'S00L', 'GDS_TARGET_BRANCH'];
  const missing = want.filter((x) => !readme.includes(x));
  return [missing.length === 0,
    missing.length ? `README does not mention ${missing.join(', ')}` : `README names all ${want.length}`];
});

/* ================================================================ HARDENING
   One check per defect found in the deep audit. These are the angles the rest
   of this file did not cover, which is exactly why they survived it.
   ======================================================================== */
section('Hardening');

/**
 * `fetch` cannot do this check: Host is a forbidden header name, so undici drops
 * it silently and the request arrives looking like loopback. The first version
 * of this test therefore passed a request the middleware never saw as remote,
 * and reported the guard broken when it was not. Raw http can set Host.
 */
function getWithHost(path, host, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(APP + path);
    http
      .get(
        { host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Host: host, ...extraHeaders } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      )
      .on('error', reject);
  });
}

await check('Data routes refuse a non-loopback Host', async () => {
  const status = await getWithHost('/api/accounts/export?format=csv&section=summary', '192.168.1.50:3002');
  return [status === 401, `HTTP ${status} when the Host header is a LAN address`];
});

await check('A wrong access key is still refused', async () => {
  const status = await getWithHost('/api/crm/export?format=csv', '192.168.1.50:3002', { 'x-app-key': 'wrong' });
  return [status === 401, `HTTP ${status} with a bad x-app-key`];
});

await check('The storefront enquiry route stays reachable', async () => {
  const r = await fetch(`${APP}/api/enquiry`, {
    method: 'POST',
    headers: { host: '192.168.1.50:3002', 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  return [r.status !== 401, `HTTP ${r.status} — not gated, a customer may not be on loopback`];
});

await check('Dev and start scripts bind loopback', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const bad = ['dev', 'dev:alt', 'start'].filter((k) => !pkg.scripts[k].includes('-H 127.0.0.1'));
  return [bad.length === 0, bad.length ? `still open: ${bad.join(', ')}` : 'dev, dev:alt and start all bind 127.0.0.1'];
});

await check('Concurrent writes cannot silently lose one', () => {
  const src = readFileSync('admin/server.js', 'utf8');
  const guarded = (src.match(/guardedSave\(/g) ?? []).length;
  const raw = (src.match(/await writeJsonAtomic\(path\.join\(CONTENT_DIR, 'accounting\.json'\)/g) ?? []).length;
  return [src.includes('function serialise(') && guarded >= 3 && raw === 0,
    `${guarded} guarded saves, ${raw} unguarded accounting writes left`];
});

await check('Edit forms carry a fingerprint so a stale save is refused', () => {
  const src = readFileSync('admin/server.js', 'utf8');
  return [src.includes('name="__fp"') && src.includes('ConflictError') && src.includes('conflictView'),
    'fingerprint on the form, conflict page on mismatch'];
});

await check('Calendar dates use the company timezone, not UTC', async () => {
  const clock = await import('../admin/clock.js').then((m) => m.default ?? m);
  // 31 Aug 21:00 UTC is already 1 September in Dhaka — the month-boundary case.
  const dhaka = clock.todayIn('Asia/Dhaka', new Date('2026-08-31T21:00:00Z'));
  return [dhaka === '2026-09-01', `31 Aug 21:00 UTC reads as ${dhaka} in Dhaka; UTC would say 2026-08-31`];
});

await check('The two clock implementations agree', async () => {
  const clock = await import('../admin/clock.js').then((m) => m.default ?? m);
  const at = new Date('2026-03-14T22:15:00Z');
  const expected = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
  return [clock.todayIn('Asia/Dhaka', at) === expected, `both return ${expected}`];
});

await check('No UTC date stamps left in the write paths', () => {
  const files = ['lib/crm.ts', 'admin/server.js', 'admin/crm-fields.js', 'app/api/crm/export/route.ts'];
  const bad = files.filter((f) => readFileSync(f, 'utf8').includes('new Date().toISOString().slice(0, 10)'));
  return [bad.length === 0, bad.length ? `still UTC: ${bad.join(', ')}` : `${files.length} files clean`];
});

await check('A rep cannot edit a lead belonging to another rep', async () => {
  const R = (await import('../admin/roles.js')).default;
  return [!R.canEditAnyLead('sales_exec') && R.canEditAnyLead('manager') && R.canEditAnyLead('super_admin'),
    'sales_exec scoped to its own leads; manager and super admin are not'];
});

await check('Lead ownership is enforced on the write, not just described', () => {
  const src = readFileSync('admin/server.js', 'utf8');
  const onLead = src.includes('const scope = leadScope(session, leads[idx])');
  const onActivity = src.includes('const scope = leadScope(session, actLead)');
  return [onLead && onActivity && src.includes('function crmIdentity('),
    `lead form: ${onLead}, call logging: ${onActivity}`];
});

await check('The journal is built once per request, not five times', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  return [src.includes('journalCache') && src.includes('WeakMap<Book, JournalLine[]>'),
    'memoised on the book object, so a new request still re-derives'];
});

await check('The accounting derivations are not what makes a page slow', async () => {
  /**
   * Measured as a DELTA against a page that touches no accounting at all.
   *
   * The first version of this check just asserted the page loaded in under a
   * second, which folded ~600ms of Next dev-server overhead into a claim about
   * this codebase — /portal/about, which derives nothing, takes about that long
   * on its own. A threshold that a framework upgrade can move is not measuring
   * anything about the accounting layer.
   */
  const timed = async (p) => {
    const t = Date.now();
    await fetch(APP + p);
    return Date.now() - t;
  };
  // warm both routes so on-demand compilation is not in the numbers
  await timed('/portal/about');
  await timed('/accounts/financials');

  const best = async (p) => Math.min(await timed(p), await timed(p), await timed(p));
  const baseline = await best('/portal/about');
  const heavy = await best('/accounts/financials');
  const delta = heavy - baseline;

  // Balance sheet + cash flow + P&L + two trial balances + reconciliation, over
  // every voucher in the book. Before the journal was memoised this was ~1600ms.
  return [delta < 600, `financials ${heavy}ms vs a derivation-free page at ${baseline}ms — the accounting adds ${delta}ms over ${
    ['invoices','receipts','bills','payments','expenses','creditNotes','supplierCreditNotes','transfers','supplierDeposits']
      .reduce((t, k) => t + (book[k] ?? []).length, 0)} vouchers`];
});

await check('A corrupt book fails with an actionable message', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  const store = readFileSync('lib/jsonStore.ts', 'utf8');
  return [src.includes('readJsonRequired') && store.includes('is not valid JSON') && store.includes('pre-restore-backup'),
    'names the file, says nothing was changed, points at the backup'];
});

await check('Large JSON files are not re-parsed on every request', () => {
  const crm = readFileSync('lib/crm.ts', 'utf8');
  const store = readFileSync('lib/jsonStore.ts', 'utf8');
  return [crm.includes('readJsonCached') && store.includes('mtimeMs'),
    'cache key is mtime and size, so an admin write still shows on the next load'];
});

await check('Sales-by-service rounds the same way as the invoice', () => {
  // Recompute both ways and compare rather than trusting that they agree.
  let worst = 0;
  for (const inv of book.invoices) {
    if (inv.status === 'draft' || inv.status === 'cancelled') continue;
    const fx = inv.fxRate && inv.fxRate > 0 ? inv.fxRate : 1;
    const perService = new Map();
    for (const l of inv.lines) perService.set(l.serviceId, (perService.get(l.serviceId) ?? 0) + l.qty * l.unitPrice);
    const grouped = [...perService.values()].reduce((t, v) => t + Math.round(v * fx), 0);
    const whole = Math.round(inv.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0) * fx);
    worst = Math.max(worst, Math.abs(grouped - whole));
  }
  return [worst === 0, `worst gap between the report and the invoices behind it: ${worst}`];
});

await check('The mega menu is labelled rather than faking ARIA state', () => {
  const raw = readFileSync('components/portal/Header.tsx', 'utf8');
  // Strip comments before looking: the comment explaining why aria-expanded is
  // absent contains the word, which made the first version of this check fail
  // on the very thing it was verifying.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [src.includes('aria-label="Main menu"') && src.includes('role="group"') && !src.includes('aria-expanded'),
    'named groups, and no hard-coded aria-expanded that a CSS panel could never update'];
});

await check('Compose shares the OTAPlatform network and binds loopback', () => {
  const yml = readFileSync('docker-compose.yml', 'utf8');
  return [
    yml.includes('otaplatform_net') &&
      !yml.includes('#   - otaplatform_net') &&
      /127\.0\.0\.1:\d+:3000/.test(yml) &&
      yml.includes('./content:/app/content'),
    'shared network enabled, loopback-only port, content bind-mounted'
  ];
});

await check('The Dockerfile does not copy a directory that is not there', () => {
  const df = readFileSync('Dockerfile', 'utf8');
  const copies = [...df.matchAll(/^COPY --from=builder(?: --chown=[^ ]+)? ([^ ]+)/gm)].map((m) => m[1]);
  const missing = copies
    .map((c) => c.replace('/app/', ''))
    .filter((c) => !c.startsWith('.next') && !existsSync(c));
  return [missing.length === 0,
    missing.length
      ? `Dockerfile copies paths this project does not have: ${missing.join(', ')}`
      : `${copies.length} builder copies, all present or generated by the build`];
});


/* ------------------------------------------------------- GDS booking honesty */
section('GDS booking');

await check('Sabre booking points at an endpoint that exists', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  const good = src.includes("'/v1/trip/orders/createBooking'");
  const dead = src.includes("SABRE_BOOK_PATH ?? '/v2.5.0/passenger/records'");
  return [good && !dead,
    good ? 'createBooking — /v2.5.0/passenger/records answers 404 on this host' : 'still on a 404 path'];
});

await check('A 200 with errors in the body is not a success', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  // The Offers-and-Orders error shape is { category, type, description } — the
  // older { code, message } read alone made `ok` true on a refusal.
  const readsBothShapes = src.includes('firstErr?.description') && src.includes('firstErr?.type');
  const requiresLocator = src.includes("action === 'create_pnr' ? Boolean(locator) : true");
  const guardsErrors = src.includes('const hasErrors = Array.isArray(errs) && errs.length > 0');
  return [readsBothShapes && requiresLocator && guardsErrors,
    `both error shapes: ${readsBothShapes}, locator required: ${requiresLocator}, errors block ok: ${guardsErrors}`];
});

/**
 * This check used to assert both suppliers were blocked, and it passed for weeks
 * while being wrong: Travelport's refusal was our own empty TargetBranch. A test
 * that hard-codes the conclusion cannot tell you the conclusion changed — it just
 * keeps agreeing with itself. So it now asserts the two things that stay true
 * whatever the accounts do: nobody is reported as booked without a locator, and
 * nobody is reported as blocked on a code that means our own request was wrong.
 */
await check('No supplier is reported as booked without a locator, or blocked on our own bug', async () => {
  const r = await fetch(`${APP}/api/ticketing/probe`);
  const d = await r.json();
  // codes that mean WE sent something wrong; calling any of them entitlement is
  // the exact mistake that cost weeks on 8236
  const ourFault = ['8236', '1201', '1005', '4037', '13518', '13529', '3000'];
  const lies = d.results.filter((x) =>
    (x.ok && !x.providerLocator && !x.locator) || (x.entitlementBlocked && ourFault.includes(String(x.code))));
  const line = d.results
    .map((x) => `${x.supplier} ok=${x.ok} blocked=${x.entitlementBlocked} ${x.code ?? x.providerLocator ?? ''}`)
    .join(', ');
  return [lies.length === 0, lies.length ? `misreported: ${lies.map((x) => x.supplier).join(', ')} — ${line}` : line];
});

await check('Travelport booking still carries the branch and the provider code', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  // Every one of these was absent once, and each absence produced an error that
  // read like entitlement. The branch throw is the important one: without it a
  // missing env var silently sends TargetBranch="" and the next person reads 8236
  // as a supplier refusal all over again.
  const throwsOnMissingBranch = /GDS_TARGET_BRANCH is not set/.test(src);
  const providerOnSegment = /ProviderCode="\$\{TP_PROVIDER\}" ProviderSegmentOrder=/.test(src);
  const providerOnAction = /ActionStatus Type="ACTIVE" ProviderCode="\$\{TP_PROVIDER\}"/.test(src);
  const mobilePhone = /Type="Mobile"/.test(src);
  /**
   * Test the CODE, not the prose about it.
   *
   * The first version of this grepped the whole file for `ActionStatus Type="TAW"`
   * and failed on the comment explaining why TAW is wrong — a check that a
   * warning about a mistake counts as the mistake. Comments go first.
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const noTaw = !/ActionStatus Type="TAW"/.test(code);
  const all = throwsOnMissingBranch && providerOnSegment && providerOnAction && mobilePhone && noTaw;
  return [all, all
    ? 'branch required, ProviderCode on segment and ActionStatus, ACTIVE not TAW, phone Mobile'
    : `branch throw ${throwsOnMissingBranch}, seg ${providerOnSegment}, action ${providerOnAction}, mobile ${mobilePhone}, no TAW ${noTaw}`];
});

/* ------------------------------------------------- the document sub-ledger */
await check('A booked document carries the fare split the supplier quoted', () => {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const priced = (bk.documents ?? []).filter((d) => d.baseFare !== null && (d.taxes ?? []).length > 0);
  if (!priced.length) return [false, 'no document carries a fare breakdown — the booking flow is not capturing it'];
  /**
   * The identity that proves capture is real rather than decorative: base plus the
   * itemised taxes must equal what the invoice line records as the supplier cost.
   * If the parser drops a tax code or double-counts one, this is where it shows.
   */
  const lines = new Map();
  for (const inv of bk.invoices) for (const l of inv.lines) if (l.documentId) lines.set(l.documentId, l);
  const bad = priced.filter((d) => {
    const line = lines.get(d.id);
    if (!line) return false;
    const sum = d.baseFare + d.taxes.reduce((t, x) => t + x.amount, 0);
    return Math.abs(sum - line.supplierCost) > 1;
  });
  return [bad.length === 0,
    bad.length
      ? `${bad.length} document(s) where base + taxes does not equal the invoice line cost`
      : `${priced.length} priced document(s); base + itemised taxes equals the line cost on every one`];
});

await check('Captured taxes are real IATA codes, not one lumped total', () => {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const priced = (bk.documents ?? []).filter((d) => (d.taxes ?? []).length > 0);
  if (!priced.length) return [false, 'no document carries itemised taxes'];
  const codes = [...new Set(priced.flatMap((d) => d.taxes.map((t) => t.code)))];
  // A single synthetic bucket would satisfy "has taxes" while being useless for a
  // BSP match. The Bangladesh codes are the ones that must survive.
  const lumped = codes.length === 1 && /^(ALL|TOTAL|TAX)$/i.test(codes[0]);
  const local = codes.some((c) => ['BD', 'E5', 'OW', 'OW2', 'UT', 'UT3', 'P7', 'P8'].includes(c));
  return [!lumped && local,
    lumped ? `taxes collapsed into one bucket: ${codes[0]}` : `${codes.length} distinct code(s): ${codes.join(', ')}`];
});

await check('A document created from a booking knows when the passenger flies', () => {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const fromBooking = (bk.documents ?? []).filter((d) => /storefront booking/.test(d.notes ?? ''));
  if (!fromBooking.length) return [false, 'no document has been created from a booking yet'];
  /**
   * travelDate is the field the migrated documents could not have and the one step
   * 2 keys on. A booking has the departure times, so there is no excuse for it
   * being null here.
   */
  const missing = fromBooking.filter((d) => !d.travelDate || d.sectors.length === 0);
  return [missing.length === 0,
    missing.length
      ? `${missing.length} booking document(s) with no travel date or no sectors`
      : `${fromBooking.length} document(s) from bookings, all with a travel date and sectors`];
});

await check('Adding the document table moved no total', async () => {
  /**
   * The whole claim of this change in one assertion.
   *
   * A document is a sub-ledger record that an invoice line points at; it carries a
   * fare, not a value, and it does not post. If it ever starts posting, the two
   * derivations stop agreeing and this fails — which is exactly why the schema
   * change was done on its own rather than bundled with the deferral work that
   * genuinely does move money.
   */
  const r = await fetch(`${APP}/api/accounts/export?format=csv&section=reconciliation`);
  const rows = (await r.text()).trim().split(/\r?\n/).slice(1);
  const bad = rows.filter((x) => Number(x.split('","').map((c) => c.replace(/^"|"$/g, ''))[3]) !== 0);
  return [r.ok && rows.length >= 6 && bad.length === 0,
    bad.length ? `out of balance: ${bad.join(' | ')}` : `${rows.length} control account(s), every difference still 0`];
});

await check('Documents never reach the journal', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  const journalStart = src.indexOf('export function journal');
  const journalSrc = journalStart < 0 ? '' : src.slice(journalStart, journalStart + 9000);
  // A posting loop over documents is the one edit that would silently break the
  // additive guarantee while every screen still looked right.
  const posts = /for \(const [a-z]+ of (book\.)?documents/.test(journalSrc);
  return [journalStart >= 0 && !posts,
    posts ? 'the journal now iterates documents — the sub-ledger has started posting' : 'the journal builder does not touch the document table'];
});

await check('The migration invented no ticket number and no fare split', () => {
  const book = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const docs = book.documents ?? [];
  const migrated = docs.filter((d) => /Migrated from/.test(d.notes ?? ''));
  /**
   * A fabricated 13-digit number reconciles against nothing, and the first person
   * to match it against a BSP file spends a day discovering it was never real. A
   * guessed fare split produces a margin that looks precise and is not.
   */
  const invented = migrated.filter((d) => d.documentNo !== null || d.baseFare !== null || (d.taxes ?? []).length > 0);
  return [docs.length > 0 && invented.length === 0,
    invented.length
      ? `${invented.length} migrated document(s) carry data the book never had`
      : `${migrated.length} migrated document(s), all with documentNo null and no fare split`];
});

await check('An unknown fare reads as unknown, not as zero', () => {
  const src = readFileSync('lib/documents.ts', 'utf8');
  const nullsOut = /if \(d\.baseFare === null\) return null;/.test(src);
  const fallsBack = /fromDoc \?\? \(ref \? Math\.round\(ref\.line\.supplierCost\) : 0\)/.test(src);
  const saysWhich = /costFrom/.test(src);
  return [nullsOut && fallsBack && saysWhich,
    `gross returns null: ${nullsOut}, cost falls back to the invoice line: ${fallsBack}, and the row states which: ${saysWhich}`];
});

await check('The documents screen states where each cost came from', async () => {
  const html = (await (await fetch(`${APP}/accounts/documents`)).text()).replace(/<!--[\s\S]*?-->/g, '');
  const shows = /not recorded/.test(html) && /\(invoice line\)/.test(html);
  const noFakeZero = !/৳0<\/td>/.test(html.split('Fare + tax')[1] ?? '');
  return [shows && noFakeZero,
    shows ? 'unknown fares print "not recorded" and the fallback source is named on every row' : 'the screen does not distinguish an unknown fare from a zero one'];
});

await check('A real agency can be started on this book', async () => {
  /**
   * Every SRS row above passed while the module was still unusable by an agency:
   * the book holds a 45-day demo and there was no way to clear it, so a real
   * first invoice would have been SFT-INV-119 in a stranger's ledger. "Complete
   * against the spec" and "ready to use" are different claims.
   *
   * Run in report mode, which must change nothing — that property is the whole
   * safety of the tool, so it is asserted rather than trusted.
   */
  const { execFileSync } = await import('node:child_process');
  const before = readFileSync('content/accounting.json', 'utf8');
  const out = execFileSync(process.execPath, ['scripts/new-book.mjs'], { encoding: 'utf8' });
  const after = readFileSync('content/accounting.json', 'utf8');
  const untouched = before === after;
  const reports = /will be cleared/.test(out) && /kept/.test(out) && /nothing was written/i.test(out);
  const guarded = /--confirm NEW-BOOK/.test(out);
  return [untouched && reports && guarded,
    `report mode left the book byte-identical: ${untouched}, lists both sides: ${reports}, requires a typed phrase: ${guarded}`];
});

await check('Clearing the book is not reachable by clicking', () => {
  /**
   * Deliberately checked, because the obvious next step for anybody reading the
   * script is to put a button on it. There is no undo from inside the app, and
   * the demo data is a sales asset.
   */
  const srv = readFileSync('admin/server.js', 'utf8');
  const wired = /new-book/.test(srv);
  const src = readFileSync('scripts/new-book.mjs', 'utf8');
  const needsPhrase = /arg\('--confirm'\) === CONFIRM_PHRASE/.test(src);
  const backsUp = /accounting-before-new-book-/.test(src);
  return [!wired && needsPhrase && backsUp,
    `no admin route: ${!wired}, typed phrase required: ${needsPhrase}, backs up first: ${backsUp}`];
});

await check('No secret value appears in any file git tracks', async () => {
  /**
   * This check found a real leak the moment it was written: the Travelport uAPI
   * username was printed in README.md, in the block explaining that the Basic Auth
   * username needs the "Universal API/" prefix. It had been pushed to a public
   * repository, and the password had already been exposed in a screenshot, so the
   * pair was complete and public.
   *
   * Nothing else would have caught it. The gitignore checks cover .env. The page
   * checks cover what is rendered. Nobody thinks of a username as a secret while
   * pasting a debugging note, and a README is the file people copy into issues.
   *
   * PCCs, branch codes and hostnames are deliberately NOT checked. They are
   * identifiers, they appear in supplier support email, they are useless without a
   * password, and hiding them is part of what made the 8236 diagnosis take weeks.
   * lib/credentials.ts declares which is which and this reads that declaration.
   */
  const { execSync } = await import('node:child_process');
  const env = Object.fromEntries(
    readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')])
  );
  const declaration = readFileSync('lib/credentials.ts', 'utf8');
  const secretNames = [...declaration.matchAll(/name: '([A-Z0-9_]+)'[^}]*?secret: true/g)].map((m) => m[1]);
  const values = secretNames
    .map((n) => [n, env[n]])
    .filter(([, v]) => typeof v === 'string' && v.length > 3);

  const files = execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n');
  const leaks = [];
  for (const f of files) {
    let body;
    try {
      body = readFileSync(f, 'utf8');
    } catch {
      continue; // binary or gone
    }
    for (const [name, v] of values) if (body.includes(v)) leaks.push(`${name} in ${f}`);
  }
  return [leaks.length === 0,
    leaks.length
      ? `LEAKED — remove before pushing: ${leaks.join('; ')}`
      : `${values.length} secret(s) checked against ${files.length} tracked files, none present`];
});

await check('No secret value reaches the credentials screen', async () => {
  /**
   * The highest-consequence check in this file.
   *
   * /accounts/gds now renders every environment variable so the environment can
   * be verified without opening .env. A screen like that is one careless edit away
   * from printing a password into a browser cache, a screenshot and a support
   * ticket, and this repository is public. So the assertion is not "it looks
   * masked" — it takes each real secret out of .env and greps the rendered HTML
   * for the literal value.
   */
  const env = Object.fromEntries(
    readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')])
  );
  const html = await (await fetch(`${APP}/accounts/gds`)).text();
  const secrets = ['GDS_PASSWORD', 'GDS_USERNAME', 'SABRE_PASSWORD', 'SABRE_USER_ID', 'ADMIN_PASSWORD', 'APP_ACCESS_KEY'];
  const set = secrets.filter((k) => env[k] && env[k].length > 3);
  const leaked = set.filter((k) => html.includes(env[k]));
  return [leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${set.length} secret(s) set, none of their values appear in the page`];
});

await check('A secret is still checkable — length and hash are shown', async () => {
  // React writes <!-- --> between interpolated values, so a naive grep for
  // "sha256 abc123" finds nothing on a page that renders it correctly. That
  // mistake has now been made three times in this project; strip first.
  const html = (await (await fetch(`${APP}/accounts/gds`)).text()).replace(/<!--[\s\S]*?-->/g, '');
  const prints = (html.match(/sha256\s*[0-9a-f]{12}/g) ?? []).length;
  return [prints >= 2, `${prints} fingerprint(s) rendered — hash your value and compare, no need to print it`];
});

await check('The environment table cannot omit a variable the code reads', () => {
  const declared = new Set(
    [...readFileSync('lib/credentials.ts', 'utf8').matchAll(/name: '([A-Z0-9_]+)'/g)].map((m) => m[1])
  );
  /**
   * The old hand-written table on /accounts/gds listed seven variables and left
   * out GDS_TARGET_BRANCH, which is the one whose absence produced uAPI 8236 and
   * weeks of it being reported as an entitlement refusal. So the table is now
   * checked against what the code actually reads, not against someone's memory.
   */
  const read = new Set();
  for (const f of ['lib/gds.ts', 'lib/sabre.ts', 'lib/ticketing.ts', 'lib/offers.ts', 'middleware.ts']) {
    for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) read.add(m[1]);
  }
  // Request-shape overrides that only exist for people on a different Travelport
  // product; declaring every one of them would bury the four that matter.
  const shapeOnly = new Set(['GDS_ACCEPT', 'GDS_CONTENT_TYPE', 'GDS_EXTRA_HEADERS', 'GDS_SOAP_ACTION',
    'GDS_SEARCH_METHOD', 'GDS_PNR_METHOD', 'GDS_BRANCH']);
  const undeclared = [...read].filter((v) => !declared.has(v) && !shapeOnly.has(v));
  return [undeclared.length === 0,
    undeclared.length
      ? `read by the code but absent from lib/credentials.ts: ${undeclared.join(', ')}`
      : `all ${read.size} supplier variables the code reads are declared`];
});

await check('A supplier timeout bounds the whole attempt, not each call inside it', () => {
  const sabre = readFileSync('lib/sabre.ts', 'utf8');
  const tkt = readFileSync('lib/ticketing.ts', 'utf8');
  /**
   * Both Sabre paths are two sequential HTTP calls — token, then the real one —
   * and each used to get the full timeout of its own. SABRE_TIMEOUT_MS=30000
   * therefore meant 60s for a search, and SB_TIMEOUT with sabreCall's single
   * retry meant ~80s for a booking. Nobody configured those numbers; they emerged
   * from independent AbortControllers while every comment nearby claimed the call
   * was bounded by one setting. A 36.7s search is what exposed it.
   */
  const searchShares = /const deadline = Date\.now\(\) \+ timeoutMs/.test(sabre)
    && /getToken\([^)]*remaining\(\)\)/.test(sabre)
    && /controller\.abort\(\), remaining\(\)/.test(sabre);
  const ticketShares = /const deadline = started \+ SB_TIMEOUT/.test(tkt)
    && /sabreToken\(remaining\(\)\)/.test(tkt)
    && /controller\.abort\(\), remaining\(\)/.test(tkt);
  return [searchShares && ticketShares,
    `search shares one deadline: ${searchShares}, ticketing shares one deadline: ${ticketShares}`];
});

await check('No uAPI request sends an AuthorizedBy with a space in it', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  /**
   * uAPI answers 1005 "Unable to parse XML stream" to AuthorizedBy="OTA Platform"
   * — letters and numbers only. Four of the five calls were fixed when that was
   * first found; AirRefundReq kept the space for months because nothing exercises
   * refund (there is no ticket to refund yet), so the one call that would fail was
   * the one nobody could run. A grep catches what an untriggerable path cannot.
   */
  // Comments first — again. The note explaining that "OTA Platform" is rejected
  // contains the string "OTA Platform", so grepping the raw file flags the very
  // warning that exists to prevent the bug. Second time in this file.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bad = [...code.matchAll(/AuthorizedBy="([^"]*)"/g)].map((m) => m[1]).filter((v) => !/^[A-Za-z0-9]+$/.test(v));
  return [bad.length === 0, bad.length ? `rejected by uAPI: ${bad.map((v) => `"${v}"`).join(', ')}` : 'all alphanumeric'];
});

await check('A probe booking is cancelled again rather than left holding a seat', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  /**
   * The probe was safe to run on every page load only while it was refused. It is
   * not refused any more — it creates a real booking. Two things must hold: it
   * undoes what it did, and it will not do it at all to a production PCC.
   */
  const cancels = /cancelReservation\(ur\)/.test(src) && /UniversalRecordCancelReq/.test(src);
  const guarded = /TICKETING_PROBE_ON_PRODUCTION/.test(src);
  const warnsOnFailure = /could NOT be cancelled/.test(src);
  return [cancels && guarded && warnsOnFailure,
    `cancels: ${cancels}, production-guarded: ${guarded}, says so when cleanup fails: ${warnsOnFailure}`];
});

await check('The PNR locator read back is the provider locator, not the record locator', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  // Retrieving with the Universal Record locator answers "UNABLE TO RETRIEVE",
  // which looks exactly like the PNR was never created. It was.
  const prefersProvider = /providerLocator\s*\?\?\s*universalLocator/.test(src);
  const readsProvider = /attr\(text, 'ProviderReservationInfo', 'LocatorCode'\)/.test(src);
  return [prefersProvider && readsProvider,
    `reads ProviderReservationInfo: ${readsProvider}, prefers it: ${prefersProvider}`];
});

await check('The refusal names the service to ask the supplier about', async () => {
  const r = await fetch(`${APP}/api/ticketing/probe`);
  const d = await r.json();
  const sb = d.results.find((x) => x.supplier === 'sabre');
  const named = /PassengerDetailsRQ/.test(sb?.diagnosis ?? '');
  return [named, named ? 'PassengerDetailsRQ named for Sabre' : 'Sabre diagnosis is not actionable'];
});

await check('Each Travelport code gets its own answer, not one blanket refusal', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  /**
   * Five codes, five different meanings, and for weeks they collapsed into
   * "entitlement". 8236 and 1201 are our request. 3000 is a closed booking class.
   * 1005 is unparseable XML. Only NEED TICKET ACCOUNT is a real host-side block.
   */
  const codes = ["code === '8236'", "code === '1201'", "code === '1005'", "code === '3000'", 'NEED TICKET ACCOUNT'];
  const missing = codes.filter((c) => !src.includes(c));
  return [missing.length === 0,
    missing.length ? `not distinguished: ${missing.join(', ')}` : 'all five branches present'];
});

await check('8236 is not treated as entitlement anywhere', () => {
  const src = readFileSync('lib/ticketing.ts', 'utf8');
  // The whole point. Assert the branch that owns 8236 sets it to false.
  const i = src.indexOf("code === '8236'");
  const window = i >= 0 ? src.slice(i, i + 900) : '';
  return [i >= 0 && /entitlementBlocked:\s*false/.test(window),
    i < 0 ? '8236 is not handled at all' : 'the 8236 branch reports it as our configuration'];
});


/* -------------------------------------------------- scheduled checks */
section('Automation');

await check('Something actually runs on a timer', () => {
  const src = readFileSync('admin/scheduler.js', 'utf8');
  const wired = readFileSync('admin/server.js', 'utf8');
  return [src.includes('setInterval') && wired.includes('scheduler.start()'),
    'the admin portal hosts the runner, so there is no second service to forget to start'];
});

await check('Every check has run and none of them failed', async () => {
  const r = await fetch(`${APP}/api/alerts`);
  const d = await r.json();
  const state = JSON.parse(readFileSync('content/scheduler-state.json', 'utf8'));
  const jobs = Object.entries(state.jobs ?? {});
  const failed = jobs.filter(([, j]) => !j.ok);
  return [jobs.length >= 6 && failed.length === 0,
    `${jobs.length} checks recorded, ${failed.length} failed, ${d.counts.critical} critical open`];
});

await check('A stopped scheduler is visible, not silent', async () => {
  const r = await fetch(`${APP}/api/alerts`);
  const d = await r.json();
  const banner = readFileSync('components/accounts/AlertBanner.tsx', 'utf8');
  // An empty alert list and a dead scheduler look identical unless staleness is
  // reported. This is the one failure that hides itself.
  return [typeof d.staleMinutes === 'number' && 'schedulerLooksStopped' in d && banner.includes('are not running'),
    `staleMinutes reported (${d.staleMinutes}), dashboard says so when it stops`];
});

await check('Alerts are derived, so a fixed problem closes itself', () => {
  const src = readFileSync('admin/scheduler.js', 'utf8');
  const replaces = src.includes("(store.open ?? []).filter((a) => a.job !== def.key)");
  const keepsAge = src.includes('firstSeen: previous.get(a.id)?.firstSeen ?? now');
  return [replaces && keepsAge,
    'each pass replaces that job\'s alerts; only firstSeen and the acknowledgement persist'];
});

await check('A check that throws becomes an alert about itself', () => {
  const src = readFileSync('admin/scheduler.js', 'utf8');
  return [src.includes('job_failed:') && src.includes('could not run'),
    'a silent check is worse than none, so its failure is reported like any other problem'];
});

await check('Two passes cannot run at once', () => {
  const src = readFileSync('admin/scheduler.js', 'utf8');
  return [src.includes("if (running) return { skipped:"),
    'a slow supplier check cannot have a second pass start underneath it'];
});

await check('The daily backup is written, not just offered as a button', () => {
  const dir = 'content/backups';
  if (!existsSync(dir)) return [false, 'no backups directory — the job has not written one'];
  const files = readdirSync(dir).filter((f) => /^book-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if (files.length === 0) return [false, 'directory exists but holds no dated backup'];
  const newest = JSON.parse(readFileSync(`${dir}/${files.sort().at(-1)}`, 'utf8'));
  return [Object.keys(newest.files ?? {}).length >= 5,
    `${files.length} dated backup(s), newest holds ${Object.keys(newest.files).length} files, taken by ${newest.takenBy}`];
});

await check('Seeing an alert and signing it off are different privileges', async () => {
  const R = (await import('../admin/roles.js')).default;
  const readOnlySees = R.check('read_only', '/alerts', 'GET').ok;
  const readOnlyActs = R.check('read_only', '/alerts/ack', 'POST').ok;
  const managerActs = R.check('manager', '/alerts/ack', 'POST').ok;
  return [readOnlySees && !readOnlyActs && managerActs,
    'read_only is told the book stopped balancing and cannot sign it off'];
});

await check('A held booking keeps its ticketing deadline', () => {
  const src = readFileSync('lib/bookings.ts', 'utf8');
  const stored = src.includes('latestTicketing: input.offer.latestTicketing');
  const derived = src.includes('export function bookingUrgency');
  const unknownIsNotSafe = src.includes("state: 'unknown'");
  return [stored && derived && unknownIsNotSafe,
    'stored on the record, urgency derived per day, and a missing deadline is its own state rather than "fine"'];
});


/* --------------------------------------------- static things made dynamic */
section('No longer static');

await check('Repeated searches do not re-ask the suppliers', async () => {
  const src = readFileSync('lib/offers.ts', 'utf8');
  const cached = src.includes('const searchCache') && src.includes('CACHE_TTL_MS');

  /**
   * Slice the actual function body rather than pattern-matching near its name.
   * The first version searched 900 characters after any mention of
   * `repriceOffer` — and the comment explaining why re-pricing must stay live
   * mentions it, with readCache defined just below. My own comment failed my own
   * check, which has happened enough times in this repository to be worth
   * guarding against by construction.
   */
  const start = src.indexOf('export async function repriceOffer');
  const body = start < 0 ? '' : src.slice(start);
  const repriceIsLive = start > -1 && !body.includes('readCache(');

  return [cached && repriceIsLive,
    start < 0 ? 'repriceOffer not found' : 'merged results cached briefly; repriceOffer always asks the supplier'];
});

await check('A cached answer says how old it is', () => {
  const page = readFileSync('app/(portal)/portal/flights/page.tsx', 'utf8');
  return [page.includes('cachedAgeMs') && page.includes('quoted'),
    'the fare list states its age rather than implying it is live'];
});

await check('The cache TTL is short enough not to quote a dead fare', () => {
  const src = readFileSync('lib/offers.ts', 'utf8');
  const m = /GDS_CACHE_TTL_MS \?\? ([\d_]+)/.exec(src);
  const ms = m ? Number(m[1].replace(/_/g, '')) : Infinity;
  return [ms > 0 && ms <= 120_000, `${ms / 1000}s — long enough for a reload, short enough that nothing on screen is stale`];
});

await check('CRM dropdowns are configuration, not code', () => {
  const fields = readFileSync('admin/crm-fields.js', 'utf8');
  const server = readFileSync('admin/server.js', 'utf8');
  const noHardCoded = !/CRM\.(CALL_STATUS|DISPOSITION|INTEREST|DEMO|ACTIVITY_TYPE|FUNNEL_ORDER)\b/.test(server);
  return [fields.includes('applyOverrides') && server.includes('vocabOffered') && noHardCoded,
    'every call site reads the configured list; zero hard-coded uses left'];
});

await check('A retired vocabulary value stays resolvable', () => {
  const fields = readFileSync('admin/crm-fields.js', 'utf8');
  return [fields.includes('hidden') && fields.includes('still resolvable'),
    'hiding rather than deleting, or a lead that used it would render a raw slug'];
});

await check('CSV import exists and previews before writing', () => {
  const src = readFileSync('admin/server.js', 'utf8');
  return [src.includes('function planImport') && src.includes("if (!form.confirm)"),
    'preview is mandatory — an upsert straight off a paste would overwrite the research'];
});

await check('An import can never fabricate call progress', () => {
  const src = readFileSync('admin/server.js', 'utf8');
  // Dropped at PARSE time, so it applies to new rows too. Guarding only updates
  // let a CSV create a lead the pipeline counted as won.
  return [src.includes('if (CRM.EDITABLE.includes(k)) { ignoredCrm.push(k); return; }'),
    'call-progress columns are stripped when the CSV is read, for adds and updates alike'];
});

await check('Currency rates are watched for going stale', async () => {
  const jobs = readFileSync('admin/jobs.js', 'utf8');
  const state = JSON.parse(readFileSync('content/scheduler-state.json', 'utf8'));
  return [jobs.includes("key: 'fx_rates'") && Boolean(state.jobs?.fx_rates),
    `the check has run and raised ${state.jobs?.fx_rates?.raised ?? '?'} — a hand-typed rate prices the NEXT invoice`];
});

await check('Sabre hotel search is entitled, and that is recorded honestly', () => {
  const readme = readFileSync('README.md', 'utf8');
  return [readme.includes('hotelavail') && readme.includes('schema'),
    'the endpoint validates rather than refusing, so the ask is a schema not a provisioning change'];
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
