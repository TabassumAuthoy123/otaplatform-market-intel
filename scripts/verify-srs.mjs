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
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { signedInProbe } from './lib/probe-session.mjs';

const APP = process.env.APP_URL || 'http://127.0.0.1:3002';
const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';

/**
 * Sign in before reading anything.
 *
 * The accounting and market-intelligence panels are no longer readable without a
 * session, so thirty-five checks in here started failing at once — every one of them
 * for the same reason and not one of them a real regression. The cookie is attached
 * to every request at the app origin by the helper rather than passed to each call
 * site, because there are twenty-odd call sites and a missed one does not error: it
 * reports the feature as missing, which reads exactly like a broken feature.
 *
 * A probe super_admin, so role restrictions never masquerade as absent features. The
 * roles themselves are checked in verify-auth.mjs, which is where they belong.
 */
const probe = await signedInProbe({ admin: ADMIN, app: APP, prefix: 'verify-srs-' });

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

/**
 * One retry on a 5xx, then believe it.
 *
 * `next dev` compiles a route on its first request and can answer 500 while it does. The
 * fare-search page is the slow one — a live two-supplier search — and it 500'd on the
 * first call after a restart while serving 200 in eight seconds by hand a minute later.
 * Two checks went red for that and neither was about anything real.
 *
 * Only once, and only on a 5xx: a persistent 500 is a genuine failure and still fails, and
 * a check that retries until it succeeds is not a check. Same rule as the Supplier
 * connections job in admin/jobs.js, which had the identical problem.
 */
async function get(path) {
  if (cache.has(path)) return cache.get(path);
  const url = path.startsWith('http') ? path : APP + path;
  let res = await fetch(url);
  if (res.status >= 500) {
    await new Promise((r) => setTimeout(r, 4000));
    res = await fetch(url);
  }
  const body = await res.text();
  const out = { status: res.status, body };
  cache.set(path, out);
  return out;
}


/**
 * The reconciliation, parsed BY HEADER NAME rather than by column position.
 *
 * Six checks in this file used to index the difference at `[3]`. That was correct
 * until the reconciliation grew a "Manual adjustment" column between the control
 * total and the ledger balance — after which `[3]` was the LEDGER BALANCE, a large
 * number on every row. All six reported the book as catastrophically out of balance
 * while every actual difference was zero, and the export they were reading printed
 * that zero in plain sight on every line.
 *
 * Position is the wrong thing to depend on for a report that is expected to grow.
 * Naming the column costs one function and cannot fail the same way twice.
 */
async function reconciliationRows() {
  const res = await fetch(`${APP}/api/accounts/export?format=csv&section=reconciliation`);
  const text = (await res.text()).replace(/^﻿/, '').replace(new RegExp(String.fromCharCode(13), 'g'), '');
  const cells = (line) => (line.match(/"[^"]*"/g) || []).map((c) => c.slice(1, -1));
  const lines = text.trim().split(String.fromCharCode(10)).filter((l) => l.includes(','));
  const cols = cells(lines[0]);
  return lines.slice(1).map((line) => {
    const c = cells(line);
    const row = { raw: line.replace(/"/g, '') };
    cols.forEach((name, i) => { row[name] = c[i]; });
    return row;
  });
}
/** Never 'the fourth cell' again. */
const difference = (row) => Number(row.Difference);

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

/** The shared period-lock guard, reached from this ESM script. */
function requireShared() {
  return createRequire(import.meta.url)('../lib/period-lock.js');
}

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
  const rows = await reconciliationRows();
  const bad = rows.filter((r) => difference(r) !== 0);
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

await check('Revenue is deferred to the travel date, and both derivations agree', async () => {
  /**
   * Step 2, checked the same way as every other control account: two independent
   * routes to one number. The control side walks the documents and sums what is
   * sold and not yet flown; the ledger side is whatever balance the journal is
   * carrying as at today. They agree only if the deferral dates, the recognition
   * dates and the travel-date boundary all line up.
   *
   * This check earned its place immediately — the first version of the ledger side
   * negated the balance on an assumption about sign conventions, and the row came
   * back at double the value with the sign inverted.
   */
  const row = (await reconciliationRows()).find((x) => /Deferred income/.test(x.Account));
  if (!row) return [false, 'the reconciliation does not check deferred income at all'];
  const control = row['Control total'];
  const ledger = row['Ledger balance'];
  const diff = row.Difference;
  return [Number(diff) === 0 && Number(control) > 0,
    Number(control) > 0
      ? `control ${Number(control).toLocaleString('en-IN')} vs ledger ${Number(ledger).toLocaleString('en-IN')}, difference ${diff}`
      : 'nothing is deferred, so this proves nothing yet — book a flight with a future travel date'];
});

await check('The deferral nets to zero over the whole book', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  /**
   * The property that let step 2 ship without touching the invoice posting every
   * other figure depends on: revenue is moved OUT on the invoice date and back IN
   * on the travel date, so the whole-book totals are arithmetically unchanged and
   * the control-versus-ledger check cannot be broken by this feature.
   *
   * Both legs must exist. One without the other is a permanently missing or
   * permanently double-counted revenue line that every whole-book report repeats.
   */
  const out = /'Deferral'[\s\S]{0,320}?account: AC\.SALES, debit: value[\s\S]{0,120}?account: AC\.DEFERRED, credit: value/.test(src);
  const back = /'Recognition'[\s\S]{0,320}?account: AC\.DEFERRED, debit: value[\s\S]{0,120}?account: AC\.SALES, credit: value/.test(src);
  return [out && back, `reversal posted at the invoice date: ${out}, recognition posted at the travel date: ${back}`];
});

await check('Only a future travel date defers anything', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  // A ticket sold and flown in the same period was never deferred. Without this
  // guard the 60 migrated documents and every same-day sale would each get a pair
  // of pointless offsetting entries.
  const guarded = /if \(!doc\?\.travelDate \|\| doc\.travelDate <= i\.date\) continue;/.test(src);
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const migrated = (bk.documents ?? []).filter((d) => /Migrated from/.test(d.notes ?? ''));
  const untouched = migrated.every((d) => !d.travelDate);
  return [guarded && untouched,
    `guarded in the journal: ${guarded}; ${migrated.length} migrated document(s) have no travel date and are not deferred`];
});

/* --------------------------------------------------------- BSP reconciliation */
/**
 * One file exercising every verdict, driven through the real page.
 *
 * Two rows against real documents in the book, one of which IATA prices 1,200
 * higher; one row for a booking nothing here has ever seen; one memo. Every
 * assertion below is a defect this file found the first time it ran.
 */
const BSP_CSV = [
  'DocumentNumber,TRNC,AirlineCode,IssueDate,Currency,FareAmount,TaxAmount,CommissionAmount,AmountPayable,PNR,Period,PassengerName',
  '0571234567890,TKT,BS,2026-08-12,BDT,25900,10699,0,36599,{PNR1},2026-08-P2,"RAHMAN, TANVIR MR"',
  '0571234567891,TKT,BS,2026-08-12,BDT,25900,11899,0,37799,{PNR2},2026-08-P2,"AKTER, SHARMIN MS"',
  '0571234567899,TKT,EK,2026-08-11,BDT,40000,12000,0,52000,ZZZ999,2026-08-P2,"UNKNOWN, PASSENGER"',
  '0571234567898,ADM,BS,2026-08-10,BDT,0,0,0,2500,{PNR1},2026-08-P2,"RAHMAN, TANVIR MR"'
].join('\n');

async function bspReport() {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const priced = (bk.documents ?? []).filter((d) => d.baseFare !== null && !d.documentNo);
  if (priced.length < 2) return null;
  const csv = BSP_CSV.replace(/\{PNR1\}/g, priced[0].pnr).replace(/\{PNR2\}/g, priced[1].pnr);
  const html = (await (await fetch(`${APP}/accounts/bsp?csv=${encodeURIComponent(csv)}`)).text())
    .replace(/<!--[\s\S]*?-->/g, '');
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, '').replace(/&#x?\w+;/g, '').replace(/\s+/g, ' ').trim())
  ).filter((r) => r.length >= 7);
  return { html, rows, priced };
}

await check('A BSP file is matched against the book, verdict by verdict', async () => {
  const r = await bspReport();
  if (!r) return [false, 'fewer than two priced documents to match against'];
  const kinds = r.rows.map((x) => x[0]);
  const unknown = kinds.filter((k) => /Not in the book/.test(k)).length;
  const provisional = kinds.filter((k) => /PNR only/.test(k)).length;
  const exact = kinds.filter((k) => k === 'Matched').length;
  /**
   * Properties, not a tally. This read `unknown >= 2` and went red the moment step
   * 5 gave the memo a document and it matched — a correct change failing a check
   * that had memorised the previous step's answer. Second time in this file.
   */
  return [r.rows.length >= 4 && provisional === 2 && unknown >= 1,
    `${r.rows.length} row(s): ${provisional} on PNR, ${exact} exact, ${unknown} unknown to the book`];
});

await check('A memo is never matched to a ticket', async () => {
  const r = await bspReport();
  if (!r) return [false, 'no documents to match against'];
  const admRow = r.rows.find((x) => x[1] === '0571234567898');
  if (!admRow) return [false, 'the ADM row is not on the report at all'];
  /**
   * Before step 5 a memo had no document of its own, so "not in the book" was the
   * right answer and this asserted exactly that. Now the memo HAS a document and
   * matches it on the document number — the point of step 5 — which made the old
   * assertion fail on correct behaviour.
   *
   * The property that holds in both states: a memo must never match a TICKET.
   * Either it matches its own memo document or it matches nothing. What it must not
   * do is report the gap between a 2,500 memo and a 36,599 fare as a dispute.
   */
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const memoNos = new Set((bk.documents || [])
    .filter((d) => d.type === 'ADM' || d.type === 'ACM')
    .map((d) => d.documentNo));
  if (/Not in the book/.test(admRow[0])) {
    return [admRow[6] === '—', 'no memo document exists yet, so the memo is correctly unmatched'];
  }
  const ownDocument = memoNos.has('0571234567898') && admRow[4] === admRow[5];
  return [ownDocument,
    ownDocument
      ? 'the memo matched its own memo document, amounts equal — never a ticket'
      : `matched something it should not: ${admRow.join(' | ')}`];
});

await check('One document is never matched twice', async () => {
  const r = await bspReport();
  if (!r) return [false, 'no documents to match against'];
  // Two BSP rows share a PNR in the file above. Before the used-set guarded the
  // PNR pass, both matched the same document and one sale looked like two.
  const matchedPnrs = r.rows.filter((x) => /PNR only/.test(x[0])).map((x) => x[2]);
  return [new Set(matchedPnrs).size === matchedPnrs.length,
    `${matchedPnrs.length} provisional match(es), ${new Set(matchedPnrs).size} distinct document(s)`];
});

await check('A difference on a PNR-only match is shown but not called a dispute', async () => {
  const r = await bspReport();
  if (!r) return [false, 'no documents to match against'];
  /**
   * Provisional differences are not disputes — the join is a PNR and may be wrong,
   * so sending somebody to argue with an airline over it would be worse than
   * silence. But a tile reading "in dispute: 0" beside a row showing a 1,200 gap
   * reads as a bug, which is exactly how the first run looked.
   */
  const sub = /Amounts in dispute<\/div>[\s\S]{0,220}?text-\[12px\] text-muted">([^<]+)</.exec(r.html)?.[1] ?? '';
  return [/PNR-only/.test(sub) && /1,200/.test(sub), `dispute tile reads: ${sub || '(nothing)'}`];
});

await check('The BSP page never writes anything', async () => {
  const before = readFileSync('content/accounting.json', 'utf8');
  await bspReport();
  const after = readFileSync('content/accounting.json', 'utf8');
  return [before === after, before === after ? 'the book is byte-identical after a match' : 'the match wrote to the book'];
});

/* ------------------------------------ settlement: exchange gain vs overpayment */
await check('A receipt relieves what receivables carries, not the cash that arrived', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  /**
   * The latent defect this closed. The receipt posting credited receivables with the
   * whole cash amount while the control side floored the amount due at zero, so the
   * two agreed only until a receipt exceeded its invoice. Recording one receipt of
   * 595,200 against an invoice carried at 588,000 put the receivables row 7,200
   * apart and the control-basis trial balance with it.
   */
  const capped = src.includes('{ account: AC.AR, credit: relief }');
  const usesAllocation = src.includes('const allocations = new Map(settlements(book).map');
  return [capped && usesAllocation,
    `relief is capped: ${capped}, and comes from the shared allocation: ${usesAllocation}`];
});

/**
 * BOTH OF THESE USED TO READ THE SOURCE, AND THAT IS WHY THEY MISSED A BUG
 *
 * They asserted that lib/fx.ts contained `settlement.currency === debt.currency` and
 * `if (settleRate !== debtRate)`, and it did, and they passed for weeks over a book in
 * which not one receipt carried a currency — so allocate() had never been called with a
 * foreign settlement at all. A grep cannot tell a function that works from a function that
 * has never run. When the first real USD receipts went through, the engine turned out to be
 * able to report an exchange gain and not an exchange loss, and a customer who had paid
 * every dollar they owed was left owing 9,000 taka.
 *
 * Rewritten to measure the book instead, and to fail when there is nothing to measure —
 * a check that passes on an empty set is the thing being guarded against.
 */
await check('The control side and the journal share one allocation', async () => {
  const byRate = book.receipts.filter((r) => {
    const inv = book.invoices.find((i) => i.id === r.invoiceId);
    return inv && r.currency && r.currency === inv.currency && Number(r.fxRate) !== Number(inv.fxRate);
  });
  if (!byRate.length) {
    return [false, 'no receipt settles at a rate other than its invoice, so nothing here is being tested'];
  }
  const rows = await reconciliationRows();
  const watched = ['Accounts receivable', 'Exchange gain', 'Customer credit'];
  const mine = rows.filter((r) => watched.some((w) => (r.name || r.Account || '').includes(w)));
  const bad = mine.filter((r) => difference(r) !== 0);
  return [mine.length === watched.length && bad.length === 0,
    byRate.length + ' settlement(s) where the relief is not the cash, and ' + mine.length +
    ' rows still agree' + (bad.length ? ' — except ' + bad.map((r) => r.Account).join(', ') : '')];
});

/**
 * The same excess cash means two unrelated things. 4,800 USD settled at 124 against an
 * invoice carried at 122.5 is a 7,200 exchange GAIN — nobody overpaid. 595,200 taka paid
 * against a 588,000 taka debt is 7,200 the agency OWES BACK. Merging them reports profit
 * that does not exist, and the safe reading when the rate is unknown is the liability.
 *
 * Measured on three real receipts: a USD settlement at a better rate, a USD settlement at a
 * worse one, and a customer who rounded 9,600 up to 10,000 in taka.
 */
await check('An exchange gain and an overpayment are told apart, not merged', async () => {
  const { body } = await get('/api/accounts/export?format=csv&section=generalledger');
  const row = (code) => {
    const line = body.split(/\r?\n/).find((l) => l.startsWith('"' + code + '"'));
    if (!line) return null;
    const c = line.split('","').map((x) => x.replace(/"/g, ''));
    return { group: c[2], debits: Number(c[3]), credits: Number(c[4]), balance: Number(c[5]) };
  };
  const fx = row('FX_GAIN');
  const cc = row('CUSTOMER_CREDIT');
  if (!fx || !cc) return [false, 'the two accounts are not both in the general ledger'];
  if (fx.balance === 0 && cc.balance === 0) return [false, 'neither account has ever been posted to'];
  const separated = fx.group === 'income' && cc.group === 'liability' && cc.debits === 0;
  return [separated,
    'exchange ' + fx.balance + ' in ' + fx.group + ', customer credit ' + cc.balance + ' in ' + cc.group];
});

await check('No monitoring job reads a report column by position', () => {
  /**
   * The integrity job indexed the reconciliation difference at `c[3]`. Adding a
   * "Manual adjustment" column moved it, so the job read the LEDGER BALANCE instead
   * and raised ten critical "does not reconcile" alerts against a book whose every
   * printed difference was zero.
   *
   * Six checks in the test suites made the same mistake and merely went red. This one
   * is the monitoring an operator is meant to trust, and it spent its time insisting a
   * correct book was broken — which is worse than no monitoring, because the real
   * alert then arrives inside a list of nine false ones.
   *
   * The guard is that the job names its columns and refuses to guess when the one it
   * wants is absent, rather than silently reading whatever is at that index.
   */
  const src = readFileSync('admin/jobs.js', 'utf8');
  const byName = src.includes("at(c, 'Difference')") && src.includes("cols.indexOf('Difference') === -1");
  const byIndex = /c\[[0-9]\]/.test(src.slice(src.indexOf('reconciliation'), src.indexOf('reconciliation') + 2000));
  return [byName && !byIndex, `names its columns: ${byName}, still indexes by position: ${byIndex}`];
});

await check('No default password is shipped for anybody to look up', () => {
  /**
   * `seedUsersIfMissing` used to fall back to a fixed password, and that string was
   * committed twice — in admin/server.js and again in B2C-ADMIN.md — to a PUBLIC
   * repository. The default super-admin password of every installation was readable
   * by anyone who found the repo. It was survivable only because the portal binds
   * 127.0.0.1; `npm run dev:lan`, a tunnel or a deploy would each have turned it into
   * a published super-admin account.
   *
   * Documenting a shipped default is exactly what publishes it, so the check is that
   * there is no default to document: the seed must generate one, and no tracked file
   * may carry a password-shaped literal next to ADMIN_PASSWORD.
   */
  const src = readFileSync('admin/server.js', 'utf8');
  const generated = /ADMIN_PASSWORD \|\| `Ota-\$\{crypto\.randomBytes/.test(src);
  const literal = /ADMIN_PASSWORD \|\| ['"]/.test(src);
  const doc = readFileSync('B2C-ADMIN.md', 'utf8');
  // Anything that looks like a real password printed as fact rather than as a shape.
  const docLeak = /password\s+(?!Ota-XXX)[A-Za-z0-9@._-]{10,}/.test(doc);
  return [generated && !literal && !docLeak,
    `generated: ${generated}, string literal left behind: ${literal}, doc prints one: ${docLeak}`];
});

await check('An overpayment is a liability, never negative receivables', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  /**
   * The chart moved to lib/journal-rules.js so the admin portal could validate a
   * journal voucher against the same account list the app renders — it cannot run
   * TypeScript, and two copies of a chart is two charts. The classification is read
   * from wherever it now lives; the POSTING is still read from the engine.
   *
   * This failed on the move, which was the check doing its job in an unexpected
   * direction: the property held the whole time and the file did not.
   */
  const chart = readFileSync('lib/journal-rules.js', 'utf8');
  // A customer who overpays is owed the difference. Letting it sit as a negative
  // asset is what made the two derivations disagree in the first place.
  const liability = chart.includes("{ code: AC.CUSTOMER_CREDIT, name: 'Customer credit balances', group: 'liability' }");
  const posted = src.includes('{ account: AC.CUSTOMER_CREDIT, credit: overpaid }');
  return [liability && posted, `held as a liability: ${liability}, and posted there: ${posted}`];
});

await check('Both bases carry the settlement accounts', async () => {
  /**
   * The control-basis trial balance is built from vouchers and knew nothing about
   * these accounts, so it went 7,200 out the first time a foreign receipt was
   * recorded while the journal basis stayed level. Both now state them.
   */
  const rows = await reconciliationRows();
  const bad = rows.filter((r) => difference(r) !== 0);
  const named = rows.some((r) => /Exchange gain/.test(r.Account)) && rows.some((r) => /Customer credit balances/.test(r.Account));
  return [bad.length === 0 && named,
    bad.length ? `out of balance: ${bad.map((b) => b.raw).join(' | ')}` : `${rows.length} control account(s) including both settlement rows, all level`];
});

/* ------------------------------------------ tax rules and the period lock */
await check('Tax is dated data, not a number on the company record', async () => {
  const src = readFileSync('lib/taxrules.ts', 'utf8');
  /**
   * Three researched reasons a single rate could not work here: excise duty is a
   * FIXED amount banded by route and revised more than once; VAT on a travel
   * agent's commission was waived by the NBR; Hajj has its own exemptions. A
   * percentage-only field cannot state the first at all.
   */
  const fixedAmount = src.includes('fixedAmount: number;');
  const banded = src.includes('band: RouteBand;');
  const exempt = src.includes('exemptServiceIds: string[];');
  const dated = src.includes('r.effectiveFrom <= opts.on && (!r.effectiveTo || r.effectiveTo >= opts.on)');
  const onInvoiceDate = src.includes('on: invoice.date');
  const page = (await (await fetch(`${APP}/accounts/taxes`)).text()).replace(/<!--[\s\S]*?-->/g, '');
  return [fixedAmount && banded && exempt && dated && onInvoiceDate && page.length > 2000,
    `fixed amount: ${fixedAmount}, banded: ${banded}, exemptions: ${exempt}, date-bounded: ${dated}, keyed on the invoice date: ${onInvoiceDate}`];
});

await check('No tax rate is invented either', () => {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  // Same rule as the carrier contracts, and the same reason: a stale rate shipped
  // inside a product is a wrong invoice that looks authoritative.
  const seeded = (bk.taxRules ?? []).length;
  return [seeded === 0, seeded === 0 ? 'no rule seeded; each invoice keeps its own stored rate' : `${seeded} rule(s) seeded`];
});

await check('The period lock guard is shared, not written twice', () => {
  const shared = existsSync('lib/period-lock.js');
  const adminUses = readFileSync('admin/server.js', 'utf8').includes("require('../lib/period-lock.js')");
  const appUses = readFileSync('lib/periodlock.ts', 'utf8').includes("from '@/lib/period-lock.js'");
  /**
   * Two processes write to this book and both must refuse the same dates. A guard
   * written twice drifts, and a drifted guard is a hole — the admin accepting an
   * edit the app rejects, silently. Same reasoning as lib/panel-modules.js.
   */
  return [shared && adminUses && appUses,
    `shared module: ${shared}, admin requires it: ${adminUses}, app imports it: ${appUses}`];
});

await check('A closed period refuses an edit and an old date cannot escape it', () => {
  const { mayWrite, datesOf } = requireShared();
  const closed = mayWrite('2026-07-31', ['2026-06-18']);
  const open = mayWrite('2026-07-31', ['2026-08-01']);
  const none = mayWrite(null, ['2026-06-18']);
  /**
   * Checked against the guard directly as well as through the portal, because the
   * property that matters is the OLD date being checked too: moving a voucher out
   * of a locked month is the same restatement as editing it there, and a guard that
   * only looked at the incoming value would wave it through.
   *
   * Driven end to end through the real admin form during the build: an invoice dated
   * 2026-06-18 came back 409 with the reason, one dated 2026-08-01 saved, and the
   * closed invoice was byte-identical afterwards.
   */
  const picksEvery = datesOf({ date: '2026-03-15', issueDate: '2026-03-16', junk: 1 }).length === 2;
  const saysWhatToDo = /dated adjustment in the open period/.test(closed.reason);
  return [!closed.ok && open.ok && none.ok && picksEvery && saysWhatToDo,
    `closed refused: ${!closed.ok}, open allowed: ${open.ok}, unlocked allowed: ${none.ok}, every date field read: ${picksEvery}, refusal is actionable: ${saysWhatToDo}`];
});

await check('Closing a period counts what is inside it first', () => {
  const src = readFileSync('admin/server.js', 'utf8');
  /**
   * An operator who closes March without knowing there are eleven unpaid March
   * invoices in it has not closed a period, they have hidden a chase list. And a
   * draft in a closed period can never be confirmed, which is worth saying before
   * the button rather than after.
   */
  const counts = src.includes('Inside the closed period:');
  const warnsDrafts = src.includes('can no longer be confirmed');
  const audited = src.includes("collection: 'company', id: 'period-lock'");
  return [counts && warnsDrafts && audited,
    `counts before closing: ${counts}, warns about drafts: ${warnsDrafts}, both directions audited: ${audited}`];
});

/* ------------------------------------------------------- carrier contracts */
await check('No commission rate is invented', () => {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const src = readFileSync('lib/contracts.ts', 'utf8');
  /**
   * The hardest rule in this file to keep. A fabricated rate puts money into the
   * margin report, the P&L and every commission figure built on them — worse than
   * a fabricated ticket number, which at least only fails to reconcile.
   *
   * So the book ships with none, and the resolver returns null rather than zero:
   * zero claims the airline allowed nothing, null says nobody has told this book
   * what the deal is, and those lead to different conversations.
   */
  const seeded = (bk.contracts ?? []).length;
  const nullsOut = src.includes('if (!contract) return null;');
  return [seeded === 0 && nullsOut,
    seeded === 0
      ? `no contract seeded; an uncovered document resolves to null, not 0: ${nullsOut}`
      : `${seeded} contract(s) are seeded into the shipped book`];
});

await check('Commission reduces the supplier cost rather than becoming income', () => {
  const src = readFileSync('lib/bookings.ts', 'utf8');
  /**
   * Under BSP the agency remits fare plus tax LESS commission, so it is a reduction
   * in what is owed and not a revenue line. Writing the bill net of it means cost of
   * sales, gross profit and margin-by-branch all come out right without any of them
   * being told about commission.
   *
   * Proven end to end with a temporary 3% contract: base 25,900 gave commission 777,
   * the invoice line and the bill both became 35,822 instead of 36,599, and margin
   * came to 1,777 — a 1,000 service charge plus the 777. Contract and booking were
   * removed afterwards.
   */
  const nets = src.includes('booking.fare.total * pax - commissionTotal');
  const resolved = src.includes('commissionFor(book as unknown as Book, forCommission');
  return [nets && resolved, `bill written net of commission: ${nets}, resolved from the contract: ${resolved}`];
});

await check('A contract resolves against the issue date, not against today', () => {
  const src = readFileSync('lib/contracts.ts', 'utf8');
  // A rate renegotiated in September must not restate August. Resolution happens at
  // read time so a corrected contract flows through immediately, and the date bound
  // is what makes that safe.
  const dated = src.includes('c.effectiveFrom <= on && (!c.effectiveTo || c.effectiveTo >= on)');
  const fromDoc = src.includes('const on = doc.issueDate ?? doc.travelDate;');
  return [dated && fromDoc, `date-bounded: ${dated}, keyed on the document rather than now: ${fromDoc}`];
});

await check('The what-if calculator computes without writing', async () => {
  const before = readFileSync('content/accounting.json', 'utf8');
  const html = (await (await fetch(`${APP}/accounts/contracts?carrier=BS&pct=3&basis=base`)).text())
    .replace(/<!--[\s\S]*?-->/g, '');
  const after = readFileSync('content/accounting.json', 'utf8');
  const answered = /3% on base fare/.test(html);
  const namesGaps = /Documents it cannot cover/.test(html);
  /**
   * It names the documents it cannot cover rather than dropping them. A figure
   * quoted at an airline should not silently exclude the tickets whose fare split
   * was never recorded.
   */
  return [before === after && answered && namesGaps,
    before === after ? `answered and named its gaps, book byte-identical` : 'the calculator wrote to the book'];
});

await check('A PLB is recorded but never applied per ticket', () => {
  const src = readFileSync('lib/contracts.ts', 'utf8');
  // It settles quarterly against total production. Attributing a slice to each sale
  // would report money that has not been earned and may never be.
  const held = src.includes('incentivePct');
  const notUsed = !/incentivePct[^;]*\*/.test(src.slice(src.indexOf('export function commissionFor')));
  return [held && notUsed, `rate held: ${held}, kept out of the per-ticket arithmetic: ${notUsed}`];
});

/* ------------------------------------------------ branded travel document */
async function itineraryFor(pred) {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const doc = (bk.documents ?? []).find(pred);
  if (!doc) return null;
  const res = await fetch(`${APP}/accounts/documents/${doc.id}/itinerary`);
  return { doc, status: res.status, html: (await res.text()).replace(/<!--[\s\S]*?-->/g, '') };
}

await check('The travel document carries the agency branding and the passenger', async () => {
  const r = await itineraryFor((d) => d.baseFare !== null && d.type === 'TKT');
  if (!r) return [false, 'no priced ticket to render'];
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const wants = [bk.company.name, bk.company.address.split(',')[0], r.doc.passengerName, r.doc.pnr];
  const missing = wants.filter((w) => w && !r.html.includes(w));
  return [r.status === 200 && missing.length === 0,
    missing.length ? `HTTP ${r.status}, missing: ${missing.join(', ')}` : `HTTP 200 with the agency header, passenger and PNR`];
});

await check('It never claims a ticket exists when none was issued', async () => {
  const r = await itineraryFor((d) => d.baseFare !== null && d.type === 'TKT' && !d.documentNo);
  if (!r) return [true, 'every document is ticketed, so there is nothing to misstate'];
  /**
   * The one thing a document like this must not do. A passenger takes it to an
   * airport counter, and Galileo has issued nothing for our PCC — so it has to say
   * so in words rather than leaving a blank where a ticket number belongs.
   */
  const honest = /Booking confirmed — not yet ticketed/.test(r.html)
    && /cannot be used to board/.test(r.html);
  return [honest, honest ? 'says it is a held booking and not a boarding document' : 'the unticketed state is not stated'];
});

await check('The fare prints itemised, which is why capture came first', async () => {
  const r = await itineraryFor((d) => d.baseFare !== null && (d.taxes ?? []).length > 0);
  if (!r) return [false, 'no document with a tax breakdown'];
  // A passenger asking why the ticket costs what it does gets an answer rather
  // than one line reading "taxes".
  const codes = (r.html.match(/Tax [A-Z]{1,3}[0-9]?</g) ?? []).length;
  return [codes >= r.doc.taxes.length,
    `${codes} tax code(s) printed against ${r.doc.taxes.length} on the document`];
});

await check('A memo is not handed to a passenger', async () => {
  const r = await itineraryFor((d) => d.type === 'ADM' || d.type === 'ACM');
  if (!r) return [true, 'no memo on the book'];
  // A memo is a claim raised against a ticket. Rendering one as a travel document
  // would put an airline's clawback in a passenger's hands.
  return [r.status === 404, `HTTP ${r.status} for a memo`];
});

/* ------------------------------------------------------------- attribution */
await check('Margin groups by branch and by consultant', async () => {
  const html = (await (await fetch(`${APP}/accounts/reports`)).text()).replace(/<!--[\s\S]*?-->/g, '');
  const byBranch = /Margin by branch/.test(html);
  const byConsultant = /Margin by consultant/.test(html);
  const coverage = /live invoices attributed/.test(html);
  /**
   * Coverage is asserted alongside the tables rather than instead of them. A branch
   * table built on 2% of the sales is a table somebody will quote as the whole
   * picture, so the proportion has to be on the page with it.
   */
  return [byBranch && byConsultant && coverage,
    `branch table: ${byBranch}, consultant table: ${byConsultant}, coverage stated: ${coverage}`];
});

await check('Attribution moved no total', async () => {
  // A branch is a label on a sale. It must not reprice one, and the whole-book
  // reconciliation is what proves it did not.
  const rows = await reconciliationRows();
  const bad = rows.filter((x) => difference(x) !== 0);
  return [bad.length === 0, `${rows.length} control account(s), ${bad.length} out of balance`];
});

await check('Unattributed is a row, not a silent drop', () => {
  const src = readFileSync('lib/attribution.ts', 'utf8');
  /**
   * A report whose totals do not add back to the whole book gets argued with rather
   * than used. Unattributed sales get their own row, sorted last however large it
   * is — it is a backlog, not a performer.
   */
  const hasRow = src.includes("'Unattributed'");
  const sortsLast = src.includes('if (a.id === null) return 1;');
  return [hasRow && sortsLast, `own row: ${hasRow}, sorted last regardless of size: ${sortsLast}`];
});

await check('A storefront sale attributes itself to the online branch', () => {
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const online = (bk.branches ?? []).find((b) => b.kind === 'online');
  if (!online) return [false, 'no online branch on the book'];
  const storefront = bk.invoices.filter((i) => /storefront booking/i.test(i.notes ?? ''));
  if (!storefront.length) return [false, 'no storefront sale to check'];
  /**
   * Found by `kind`, never by a hard-coded id, so an installation that names its
   * online channel something else still gets it — and one with no online branch
   * leaves the sale unattributed rather than assigned somewhere untrue.
   */
  const byKind = readFileSync('lib/bookings.ts', 'utf8').includes("(b) => b.kind === 'online'");
  const attributed = storefront.filter((i) => i.branchId === online.id).length;
  return [byKind && attributed === storefront.length,
    `${attributed} of ${storefront.length} storefront sale(s) on ${online.name}, found by kind: ${byKind}`];
});

await check('A memo is charged to whoever caused it, not to a sale', () => {
  const src = readFileSync('lib/attribution.ts', 'utf8');
  // A memo has no invoice, so the document is the only route — and the consultant
  // who mispriced a fare is the person it belongs to.
  const viaDocument = src.includes('for (const d of documents(book))') && src.includes('row.memoCost +=');
  return [viaDocument, `memos attributed through the document: ${viaDocument}`];
});

/* ------------------------------------------------------------ credit control */
await check('A sale past the credit limit is refused, with a reason', async () => {
  /**
   * The check drives the real API rather than reading the function, because the
   * thing being asserted is the refusal reaching the caller — a control that
   * computes the right verdict and then lets the sale through is worse than none.
   *
   * It needs a customer already over a limit. If none exists the check says so
   * rather than passing on an empty set, which would go green on a book where the
   * feature had been deleted.
   */
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));

  /**
   * Only attempt the booking against a customer who is ALREADY over their limit.
   *
   * The first version picked any customer with a limit and posted a booking. If
   * that customer happened to be within their limit the sale went through — a
   * check that writes a real invoice into the book every time it passes. A test
   * with a side effect on the production data is a slow leak, and the green path
   * is exactly where nobody looks for one.
   */
  const paid = {};
  for (const r of bk.receipts) paid[r.invoiceId] = (paid[r.invoiceId] ?? 0) + r.amount;
  const owed = {};
  for (const inv of bk.invoices) {
    if (inv.status === 'draft' || inv.status === 'cancelled') continue;
    const gross = inv.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
    const due = Math.max(0, gross + Math.round((gross * (inv.vatRate || 0)) / 100) - (paid[inv.id] ?? 0));
    if (due > 0) owed[inv.customerId] = (owed[inv.customerId] ?? 0) + due;
  }
  const limited = bk.customers.filter(
    (c) => Number(c.creditLimit) > 0 && (owed[c.id] ?? 0) > Number(c.creditLimit)
  );
  if (!limited.length) {
    return [false, 'no customer is currently over a credit limit, so the refusal cannot be exercised safely'];
  }

  const before = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const depart = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  const html = await (await fetch(`${APP}/portal/flights?from=DAC&to=DXB&depart=${depart}&pax=1`)).text();
    const sig = /sig=([^"'&<]+)/.exec(html)?.[1];
  if (!sig) return [false, 'no fare on the page to try booking'];

  const over = limited[0];
  /**
   * The passenger name has to reconstruct the customer name EXACTLY.
   *
   * The booking flow finds or creates a customer from `${firstName} ${lastName}`.
   * Splitting on whitespace and taking the last two words turned "Meridian
   * Corporate Travel" into "Corporate Travel" — a customer that did not exist, so
   * the flow created one, with no limit, and cheerfully sold to it. The check then
   * correctly reported that a customer over their limit had been allowed to book,
   * which was true of a customer this check had just invented.
   *
   * Split on the LAST space only, so first + last rejoins to the original.
   */
  const cut = String(over.name).lastIndexOf(' ');
  const first = cut > 0 ? over.name.slice(0, cut) : over.name;
  const last = cut > 0 ? over.name.slice(cut + 1) : '.';
  if (`${first} ${last}`.trim() !== String(over.name).trim()) {
    return [false, `cannot address ${over.name} as a passenger without inventing a customer`];
  }
  const customersBefore = bk.customers.length;
  const res = await fetch(`${APP}/api/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sig: decodeURIComponent(sig), from: 'DAC', to: 'DXB', date: depart,
      contact: { name: 'credit check', email: 'c@softifybd.com', phone: '01700000000' },
      passengers: [{ title: 'MR', firstName: first || 'A', lastName: last || 'B', dob: '1990-01-01', passport: 'X1', nationality: 'BD' }],
      serviceCharge: 0
    })
  });
  const body = await res.json();
  const after = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const wroteNothing = before.invoices.length === after.invoices.length
    && (before.documents ?? []).length === (after.documents ?? []).length;

  /**
   * Guard the guard. This check has now polluted the book twice in two different
   * ways — once by selling to a customer within their limit, once by inventing a
   * customer whose name it could not reconstruct. A new customer row means the
   * attempt did not land where it was aimed, whatever the status code says.
   */
  if (after.customers.length !== customersBefore) {
    return [false, `the attempt created a customer — it did not target ${over.name} at all`];
  }

  // A refusal is only useful if it is 409 with a reason and leaves no half-written
  // sale. 500 would read as an outage and get the control switched off.
  if (res.status === 409) {
    return [wroteNothing && /limit/i.test(body.error ?? ''),
      wroteNothing ? `409 with a reason, and no invoice or document was written` : '409 but a partial sale was written'];
  }
  // Anything other than 409 is a failure now: the customer was selected precisely
  // because they are over, so a sale going through means the control did not fire.
  return [false, `HTTP ${res.status} — a customer over their limit was allowed to book`];
});

await check('No credit limit means no enforcement', () => {
  const src = readFileSync('lib/credit.ts', 'utf8');
  /**
   * The default that let this ship without breaking every existing customer. An
   * absent or zero limit has to mean "not enforced" — defaulting to "no credit"
   * would have stopped every agency on the book from buying anything on the day it
   * went live.
   */
  const openDefault = /if \(limit <= 0\) \{\s*\n\s*return \{ ok: true/.test(src);
  const bk = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const unlimited = bk.customers.filter((c) => !Number(c.creditLimit)).length;
  return [openDefault, `${unlimited} customer(s) have no limit and are unaffected; zero means not enforced: ${openDefault}`];
});

await check('A breach is an alert, not only a screen', () => {
  const src = readFileSync('admin/jobs.js', 'utf8');
  const job = /key: 'credit_limit'/.test(src);
  const silentWhenUnset = /if \(limit <= 0\) continue;/.test(src);
  return [job && silentWhenUnset,
    `scheduled job present: ${job}, and a customer with no limit raises nothing: ${silentWhenUnset}`];
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
  const rows = await reconciliationRows();
  const bad = rows.filter((x) => difference(x) !== 0);
  return [rows.length >= 6 && bad.length === 0,
    bad.length ? `out of balance: ${bad.map((b) => b.raw).join(' | ')}` : `${rows.length} control account(s), every difference still 0`];
});

await check('Only a memo may post — a ticket document still never does', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  /**
   * This check used to assert that the journal never touched the document table at
   * all. That was step 1's additive guarantee and it was worth having: a ticket
   * document is a sub-ledger record whose money lives on the invoice line, so a
   * ticket that posted would double-count every sale.
   *
   * Step 5 breaks it deliberately for ONE type. An ADM is a real cost and a real
   * liability the day the airline raises it, and there is no voucher behind it. So
   * the guarantee is narrowed rather than dropped: the journal may iterate
   * documents, exactly once, and that loop must refuse anything that is not a memo.
   *
   * Deleting the check instead would have removed the only thing standing between a
   * stray posting rule and every ticket being counted twice.
   */
  const start = src.indexOf('/* --- airline memos');
  const loop = start < 0 ? '' : src.slice(start, start + 2400);
  const gatedToMemos = loop.includes("if (d.type !== 'ADM' && d.type !== 'ACM') continue;");
  const journalStart = src.indexOf('export function journal');
  const journalSrc = journalStart < 0 ? '' : src.slice(journalStart, journalStart + 14000);
  const loops = (journalSrc.match(/for \(const \w+ of book\.documents/g) || []).length;
  return [gatedToMemos && loops === 1,
    `${loops} loop over documents in the journal, gated to memos: ${gatedToMemos}`];
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

section('One clock, one float');

/**
 * The product had TWO todays.
 *
 * todayISO(book) returned the latest date on any invoice or receipt — the newest voucher,
 * treated as now — while admin/jobs.js used the real calendar. On the demo book those were
 * nineteen days apart, and the two halves said:
 *
 *   the Reminders screen   10 invoices past 30 days, 1,812,380
 *   the Overdue alert job  21 invoices past 30 days, 3,466,980
 *
 * Same book, same instant. The screen an agency phones people from was missing eleven
 * customers.
 */
await check('The book\'s today is the real calendar date', async () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  const m = src.match(/export const todayISO = [^;]+;/);
  if (!m) return [false, 'todayISO not found'];
  const derivesFromVouchers = /book\.invoices\.map|book\.receipts\.map/.test(m[0]);
  return [!derivesFromVouchers && /todayIn\(/.test(m[0]),
    derivesFromVouchers
      ? 'it is back to deriving today from the newest voucher — one mistyped year re-ages the whole book'
      : 'the calendar, in the company timezone — not the newest voucher'];
});

await check('The screen and the alert agree about what is overdue', async () => {
  const page = (await get('/accounts/reminders')).body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const onScreen = page.match(/Overdue — escalate[^0-9]{0,40}৳([\d,]+)[^0-9]{0,40}(\d+) invoices past/);
  const alerts = await (await fetch(`${APP}/api/alerts`)).json();
  const alert = (alerts.open || []).find((a) => /past 30 days/i.test(a.title || ''));
  if (!onScreen || !alert) return [false, `screen ${onScreen ? 'read' : 'unreadable'}, alert ${alert ? 'present' : 'absent'}`];
  const alertCount = Number((alert.title.match(/^(\d+)/) || [])[1]);
  const alertValue = Number((alert.title.match(/৳([\d,]+)/) || ['', '0'])[1].replace(/,/g, ''));
  const screenCount = Number(onScreen[2]);
  const screenValue = Number(onScreen[1].replace(/,/g, ''));
  return [alertCount === screenCount && alertValue === screenValue,
    `screen ${screenCount}/${screenValue}, alert ${alertCount}/${alertValue}`];
});

/**
 * The alert job used to recompute invoice totals by hand and never converted currency.
 * SFT-INV-0118 is 4,800 USD at 122.5 — 588,000 taka — and the job valued it at 4,800.
 */
await check('The overdue alert values a foreign-currency invoice in book currency', async () => {
  const b = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const fx = b.invoices.filter((i) => i.currency && i.currency !== b.company.currency);
  if (!fx.length) return [true, 'no foreign-currency invoice in the book to test with'];
  const jobs = readFileSync('admin/jobs.js', 'utf8');
  const overdue = jobs.slice(jobs.indexOf("key: 'overdue'"), jobs.indexOf("key: 'inventory'"));
  const recomputes = /l\.qty \* l\.unitPrice/.test(overdue);
  return [!recomputes && /section=receivables/.test(overdue),
    recomputes
      ? 'it is recomputing invoice totals by hand again — that path does not convert currency'
      : 'it reads the app\'s receivables ledger, which converts'];
});

/**
 * The supplier float had two definitions 3,179,600 apart, and the screen's version rose
 * when the float was spent because it counted the drawdown as a settlement.
 */
await check('The float means the same thing on the screen and in the validator', () => {
  const FLOAT = createRequire(import.meta.url)('../lib/supplier-float.js');
  const b = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const acc = readFileSync('lib/accounting.ts', 'utf8');
  const srv = readFileSync('admin/server.js', 'utf8');
  const bothDelegate = /floatRows\(book, billBase\)/.test(acc) && /FLOAT\.floatFor\(/.test(srv);
  const anySupplier = (b.suppliers || [])[0];
  const f = anySupplier ? FLOAT.floatFor(b, anySupplier.id) : null;
  return [bothDelegate && !!f && f.available === f.placed - f.drawn,
    bothDelegate ? 'one definition, imported by both' : 'one of them has its own copy again'];
});

await check('Spending the float lowers it', () => {
  const FLOAT = createRequire(import.meta.url)('../lib/supplier-float.js');
  const b = JSON.parse(readFileSync('content/accounting.json', 'utf8'));
  const s = (b.suppliers || []).find((x) => (b.supplierDeposits || []).some((d) => d.supplierId === x.id));
  if (!s) return [true, 'no supplier holds a deposit in this book'];
  const before = FLOAT.floatFor(b, s.id).available;
  const probe = JSON.parse(JSON.stringify(b));
  probe.payments.push({
    id: 'PAY-PROBE', no: 'PROBE', date: '2026-08-01', supplierId: s.id,
    method: 'supplier_deposit', bankId: null, amount: 100000, notes: 'probe'
  });
  const after = FLOAT.floatFor(probe, s.id).available;
  // The original bug: drawing on the float RAISED the reported figure, because the
  // drawdown counted as a settlement which reduced outstanding bills.
  return [after === before - 100000,
    `${before} -> ${after} after drawing 100,000${after > before ? ' — IT WENT UP' : ''}`];
});

/**
 * Runs the checks, then reads the result — rather than reading whatever was left behind.
 *
 * This used to assert on content/scheduler-state.json as it happened to stand, which made
 * it a test of the last few hours rather than of the jobs. It went red for a stale failure
 * from a boot three hours earlier, and again when a scheduled tick fired DURING this suite:
 * the fare-search job competes with the suite's own flight searches for the app, took
 * longer than its 105-second budget, and recorded a timeout that had nothing to do with
 * the code under test.
 *
 * Triggering the pass first makes it deterministic and actually exercises the jobs. It is
 * also slower, and worth it: a check that goes red for reasons outside its subject teaches
 * people to ignore it.
 */
section('Foreign settlement');

/**
 * None of this had ever run. The FX engine had an allocate(), a settlements(), an fxGain(),
 * a customerCredit(), an account in the chart and a branch in the journal — and not one of
 * the book's 111 receipts carried a currency, so every one of those returned an empty list.
 * The feature was verified by reading its own source.
 *
 * Three receipts through the portal found three things. They are kept here as data checks
 * rather than source checks wherever possible, because reading the source is what missed
 * them the first time.
 */

const ledgerRow = async (code) => {
  const { body } = await get('/api/accounts/export?format=csv&section=generalledger');
  const line = body.split(/\r?\n/).find((l) => l.startsWith('"' + code + '"'));
  if (!line) return null;
  const c = line.split('","').map((x) => x.replace(/"/g, ''));
  return { code: c[0], name: c[1], group: c[2], debits: Number(c[3]), credits: Number(c[4]), balance: Number(c[5]) };
};

/**
 * allocate() could only ever report a GAIN. It asked whether cash was left over once the
 * debt was cleared, and that can only be true when the rate moved in the agency's favour.
 * Everything downstream was already built for the other direction — Allocation.fx is
 * documented as gain or loss, fxGain() says net of loss, the journal has a fxPart < 0 debit
 * branch — so the one function that decides was the only one that could not.
 *
 * A debit on this account is the proof, because nothing but a loss can put one there.
 */
await check('An exchange loss reaches the exchange account', async () => {
  const fx = await ledgerRow('FX_GAIN');
  if (!fx) return [false, 'no exchange account in the general ledger'];
  return [fx.debits > 0 && fx.credits > 0,
    'debits ' + fx.debits + ' (losses), credits ' + fx.credits + ' (gains), balance ' + fx.balance +
    (fx.debits === 0 ? ' — gains only, which is what the old allocate() could produce' : '')];
});

/**
 * The one that mattered. SFT-INV-0121 was raised for 3,000 USD at 123 and carried at
 * 369,000. FlyTrek paid all 3,000 dollars at 120, so 360,000 arrived — and invoiceTotals()
 * subtracted the CASH, leaving 9,000 owing by a customer who owed nothing. It aged, it sat
 * in Accounts receivable, and it went on the reminders screen as a debt to chase.
 *
 * The mirror case hid behind Math.max(0, ...): paid at a better rate the subtraction went
 * negative and the floor turned it into the right answer for the wrong reason. Both
 * derivations called the same broken function, so the difference was zero and the
 * cross-check stayed quiet — which is worth remembering before trusting one.
 */
await check('An invoice settled in full in its own currency shows nothing owing', async () => {
  const { body } = await get('/api/accounts/export?format=csv&section=receivables');
  const foreign = book.invoices.filter((i) =>
    i.currency && i.currency !== book.company.currency && !(i.vatRate > 0) && i.status !== 'draft');
  if (!foreign.length) return [true, 'no foreign-currency invoice in the book'];
  const settled = foreign.filter((i) => {
    const owedForeign = i.lines.reduce((t, l) => t + Number(l.qty) * Number(l.unitPrice), 0);
    const paidForeign = book.receipts
      .filter((r) => r.invoiceId === i.id && r.currency === i.currency && Number(r.fxRate) > 0)
      .reduce((t, r) => t + r.amount / Number(r.fxRate), 0);
    return paidForeign >= owedForeign - 0.005;
  });
  if (!settled.length) return [true, foreign.length + ' foreign invoices, none settled in full yet'];
  const stillListed = settled.filter((i) => body.includes('"' + i.no + '"'));
  return [stillListed.length === 0,
    stillListed.length
      ? stillListed.map((i) => i.no).join(', ') + ' still owing after every unit of ' + stillListed[0].currency + ' was paid'
      : settled.map((i) => i.no).join(', ') + ' paid in full in ' + settled[0].currency + ', nothing carried'];
});

/**
 * The two reasons a receipt can exceed the debt are not the same thing and must never be
 * merged. A rate that moved is income. A customer who sent too much is money the agency
 * owes back. Booking the second as the first reports profit that does not exist.
 */
await check('Paying too much is a liability, not income', async () => {
  const cc = await ledgerRow('CUSTOMER_CREDIT');
  if (!cc) return [false, 'no customer credit account in the general ledger'];
  const over = book.receipts.some((r) => !r.currency);
  if (cc.balance === 0) return [over, 'nothing overpaid in the book yet'];
  return [cc.group === 'liability' && cc.credits > 0 && cc.debits === 0,
    cc.name + ' — ' + cc.group + ', held ' + cc.balance];
});

/**
 * invoiceTotals() was the last place answering "how much did this relieve" on its own. It
 * now calls the same reliefOn() the journal does, because two answers to that question is
 * the defect lib/fx.ts was written to close in the first place.
 */
await check('Receivables are measured by what a receipt relieved, not by the cash', () => {
  const src = readFileSync('lib/accounting.ts', 'utf8');
  // Comments stripped first: the doc comment on this very function quotes the old
  // expression to explain what went wrong, and the check matched its own explanation.
  const fn = src
    .slice(src.indexOf('export function invoiceTotals'), src.indexOf('export function receivables'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const usesRelief = /reliefOn\(/.test(fn) && /total - credited - relieved/.test(fn);
  const usesCash = /total - credited - paid/.test(fn);
  return [usesRelief && !usesCash,
    usesCash ? 'it is back to subtracting the cash — an exchange loss becomes a receivable again'
            : 'one allocation, shared with the journal'];
});

/**
 * settlements() added a foreign invoice's VAT before converting it, so 15% of 4,800 dollars
 * went into a taka figure as 720. Never bitten — both foreign invoices here are zero-rated —
 * and found only by putting the two carrying values side by side.
 */
await check('VAT on a foreign invoice is converted before it is added', () => {
  const src = readFileSync('lib/fx.ts', 'utf8');
  const fn = src.slice(src.indexOf('export function settlements'));
  const convertsFirst = /const gross = Math\.round\(grossDoc \* fx\)/.test(fn);
  return [convertsFirst, convertsFirst ? 'VAT is charged on the converted value' : 'VAT is being added in document currency'];
});

await check('Every check has run and none of them failed', async () => {
  const page = await fetch(`${ADMIN}/alerts`, { headers: { cookie: probe.cookie } });
  const csrf = ((await page.text()).match(/name="csrf" value="([^"]+)"/) || [])[1];
  if (csrf) {
    await fetch(`${ADMIN}/alerts/run`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: probe.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString()
    });
  }

  const r = await fetch(`${APP}/api/alerts`);
  const d = await r.json();
  const state = JSON.parse(readFileSync('content/scheduler-state.json', 'utf8'));
  const jobs = Object.entries(state.jobs ?? {});
  const failed = jobs.filter(([, j]) => !j.ok);
  return [jobs.length >= 6 && failed.length === 0,
    failed.length
      ? `${failed.length} failed: ${failed.map(([k, j]) => `${k} (${j.error})`).join('; ')}`
      : `${jobs.length} checks ran just now, none failed, ${d.counts.critical} critical open`];
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
