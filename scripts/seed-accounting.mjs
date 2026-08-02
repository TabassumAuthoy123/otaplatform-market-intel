/**
 * Generates content/accounting.json — the seed book for the accounting module.
 *
 *   node scripts/seed-accounting.mjs
 *
 * Re-running overwrites the file, so do not run it once you have real entries.
 * Amounts are invented demo figures; the point is that they reconcile, not that
 * they are anyone's real trading.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'content', 'accounting.json');

// deterministic pseudo-random so re-seeding gives the same book
let s = 20260802;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi, step = 1) => lo + Math.floor(rnd() * ((hi - lo) / step + 1)) * step;

const DAYS = 45; // book covers the last 45 days
const TODAY = new Date('2026-08-02T00:00:00Z');
const dayOffset = (n) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const customers = [
  ['CUS-001', 'Rodela International', 'agency', '02-9345998', 'Naya Paltan, Dhaka'],
  ['CUS-002', 'Zamzam Travels BD', 'agency', '01733-391826', 'Purana Paltan, Dhaka'],
  ['CUS-003', 'FlyTrek', 'agency', '01616-124565', 'Uttara Sector 7, Dhaka'],
  ['CUS-004', 'Union Travels Ltd', 'agency', '01967-605243', 'Motijheel C/A, Dhaka'],
  ['CUS-005', 'Atiya Travels', 'agency', '01711-382113', 'Zindabazar, Sylhet'],
  ['CUS-006', 'Md. Shahidul Islam', 'walk_in', '01712-445566', 'Mirpur, Dhaka'],
  ['CUS-007', 'Nusrat Jahan', 'walk_in', '01819-223344', 'Dhanmondi, Dhaka'],
  ['CUS-008', 'Beximco Group', 'corporate', '02-9881824', 'Gulshan, Dhaka']
].map(([id, name, type, phone, address]) => ({
  id, name, type, phone, email: '', address, openingBalance: 0
}));

const suppliers = [
  ['SUP-001', 'Biman Bangladesh Airlines', 'airline'],
  ['SUP-002', 'Qatar Airways', 'airline'],
  ['SUP-003', 'Saudia', 'airline'],
  ['SUP-004', 'US-Bangla Airlines', 'airline'],
  ['SUP-005', 'Flyhub Consolidator', 'consolidator'],
  ['SUP-006', 'Makkah Hotel Partner', 'hotel'],
  ['SUP-007', 'Madinah Hotel Partner', 'hotel'],
  ['SUP-008', 'KSA Visa Processing', 'visa']
].map(([id, name, type]) => ({ id, name, type, phone: '', email: '', openingBalance: 0 }));

const services = [
  ['SRV-001', 'Air Ticket — International', 'air'],
  ['SRV-002', 'Air Ticket — Domestic', 'air'],
  ['SRV-003', 'Umrah Package', 'hajj_umrah'],
  ['SRV-004', 'Hajj Package', 'hajj_umrah'],
  ['SRV-005', 'Hotel Booking', 'hotel'],
  ['SRV-006', 'Visa Processing', 'visa'],
  ['SRV-007', 'Tour Package', 'tour'],
  ['SRV-008', 'Service Charge', 'other']
].map(([id, name, category]) => ({ id, name, category }));

const banks = [
  // The operating account carries the working capital. An agency settling
  // ~2.2cr of supplier bills against ~2.1cr of collections needs a real float
  // sitting behind it — that gap is unpaid customer invoices.
  { id: 'BNK-001', name: 'Dutch-Bangla Bank — Current', accountNo: '101-110-45231', branch: 'Gulshan', openingBalance: 14000000 },
  { id: 'BNK-002', name: 'City Bank — USD', accountNo: '220-341-99017', branch: 'Motijheel', openingBalance: 640000 },
  { id: 'BNK-003', name: 'bKash Merchant', accountNo: '01712-345678', branch: 'MFS', openingBalance: 125000 }
];

const expenseCategories = [
  ['EXC-001', 'Government Fees'],
  ['EXC-002', 'Office Expenses'],
  ['EXC-003', 'Marketing'],
  ['EXC-004', 'IT & Development'],
  ['EXC-005', 'Employee Expenses'],
  ['EXC-006', 'Travel Expenses'],
  ['EXC-007', 'Transportation'],
  ['EXC-008', 'Miscellaneous']
].map(([id, name]) => ({ id, name }));

const employees = [
  { id: 'EMP-001', name: 'Tabassum Mustafa Authoy', role: 'Manager', phone: '' },
  { id: 'EMP-002', name: 'Accounts Officer', role: 'Accountant', phone: '' },
  { id: 'EMP-003', name: 'Reservation Desk', role: 'Sales Executive', phone: '' }
];

const ROUTES = [
  ['DAC', 'JED', 'SUP-003'], ['DAC', 'DXB', 'SUP-002'], ['DAC', 'DOH', 'SUP-002'],
  ['DAC', 'KUL', 'SUP-005'], ['DAC', 'CXB', 'SUP-004'], ['DAC', 'ZYL', 'SUP-001'],
  ['DAC', 'CCU', 'SUP-005']
];

function pnr() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 6 }, () => (rnd() < 0.5 ? L[Math.floor(rnd() * L.length)] : String(between(0, 9)))).join('');
}

/* ------------------------------------------------------------------ build */

const invoices = [];
const receipts = [];
const bills = [];
const payments = [];
const expenses = [];

let invNo = 0, rcpNo = 0, billNo = 0, payNo = 0, expNo = 0;
const pad = (n) => String(n).padStart(4, '0');

for (let d = DAYS; d >= 0; d--) {
  const date = dayOffset(d);
  const perDay = between(1, 4);

  for (let k = 0; k < perDay; k++) {
    const cust = pick(customers);
    const svc = pick(services.slice(0, 7));
    const lineCount = svc.category === 'hajj_umrah' ? 1 : between(1, 2);
    const lines = [];

    for (let li = 0; li < lineCount; li++) {
      const [from, to, supId] = pick(ROUTES);
      const isPkg = svc.category === 'hajj_umrah';
      const qty = isPkg ? between(1, 4) : between(1, 3);
      const cost = isPkg ? between(140000, 260000, 5000) : between(9000, 68000, 500);
      const margin = isPkg ? between(8000, 24000, 1000) : between(900, 4500, 100);
      lines.push({
        serviceId: svc.id,
        description: isPkg ? `${svc.name} — ${qty} pax` : `${from}–${to} ${svc.name}`,
        pnr: svc.category === 'air' || isPkg ? pnr() : '',
        pax: qty,
        qty,
        unitPrice: cost + margin,
        supplierCost: cost,
        supplierId: supId
      });
    }

    invNo += 1;
    const id = `INV-${pad(invNo)}`;
    // most are settled; a tail is left open so receivables are not zero
    const status = d > 7 ? (rnd() < 0.88 ? 'paid' : 'partially_paid') : pick(['confirmed', 'paid', 'partially_paid', 'draft']);
    const gross = lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);

    invoices.push({
      id,
      no: `SFT-INV-${pad(invNo)}`,
      date,
      customerId: cust.id,
      status,
      vatRate: 0,
      lines,
      notes: ''
    });

    if (status === 'paid' || status === 'partially_paid') {
      const part = status === 'paid' ? gross : Math.round(gross * (0.3 + rnd() * 0.4) / 500) * 500;
      const method = pick(['cash', 'bank_transfer', 'card', 'mfs']);
      rcpNo += 1;
      receipts.push({
        id: `RCP-${pad(rcpNo)}`,
        no: `SFT-RCP-${pad(rcpNo)}`,
        date,
        customerId: cust.id,
        invoiceId: id,
        method,
        // Deterministic routing, so each account's inflow matches its outflow:
        // bank transfers land in the operating account that pays the suppliers,
        // card settlement lands in the USD account, MFS in the wallet.
        bankId: method === 'cash' ? null : method === 'mfs' ? 'BNK-003' : method === 'card' ? 'BNK-002' : 'BNK-001',
        amount: part,
        ref: ''
      });
    }

    // supplier side — one bill per distinct supplier on the invoice
    const bySupplier = new Map();
    for (const l of lines) bySupplier.set(l.supplierId, (bySupplier.get(l.supplierId) ?? 0) + l.qty * l.supplierCost);
    for (const [supId, amount] of bySupplier) {
      billNo += 1;
      const bid = `BIL-${pad(billNo)}`;
      const bStatus = d > 10 ? 'paid' : pick(['unpaid', 'paid', 'partially_paid']);
      bills.push({
        id: bid,
        no: `SFT-BIL-${pad(billNo)}`,
        date,
        supplierId: supId,
        invoiceRef: id,
        status: bStatus,
        amount,
        notes: ''
      });
      if (bStatus === 'paid' || bStatus === 'partially_paid') {
        const part = bStatus === 'paid' ? amount : Math.round((amount * 0.5) / 500) * 500;
        // Airlines and consolidators settle through the bank (BSP), not over the
        // counter. Keeping this mostly bank also stops the cash book going
        // negative: cash comes in on roughly a quarter of receipts, so cash
        // cannot go out on half of a much larger payment run.
        const method = rnd() < 0.2 ? 'cash' : 'bank_transfer';
        payNo += 1;
        payments.push({
          id: `PAY-${pad(payNo)}`,
          no: `SFT-PAY-${pad(payNo)}`,
          date,
          supplierId: supId,
          billId: bid,
          method,
          bankId: method === 'cash' ? null : 'BNK-001',
          amount: part,
          ref: ''
        });
      }
    }
  }

  // a couple of expenses most days
  for (let e = 0; e < between(0, 2); e++) {
    const cat = pick(expenseCategories);
    // small office spend is cash, the bigger items go through the bank
    const method = rnd() < 0.45 ? 'cash' : 'bank_transfer';
    expNo += 1;
    expenses.push({
      id: `EXP-${pad(expNo)}`,
      no: `SFT-EXP-${pad(expNo)}`,
      date,
      categoryId: cat.id,
      method,
      bankId: method === 'cash' ? null : 'BNK-001',
      amount: between(1500, 45000, 500),
      description: cat.name,
      employeeId: rnd() < 0.3 ? pick(employees).id : null
    });
  }
}

const book = {
  _meta: {
    note: 'Accounting book for the /accounts module. Edited from the admin portal on :4001. Demo figures — generated by scripts/seed-accounting.mjs.',
    revision: 1,
    lastEditedBy: 'seed',
    lastEditedAt: '2026-08-02',
    seededOn: '2026-08-02',
    coversDays: DAYS
  },
  company: {
    name: 'Softifybd Limited',
    tradingAs: 'OTA Platform — Travel Accounts',
    address: 'Tower of Aakash, Level 18, 54 Gulshan Avenue, Dhaka 1212',
    phone: '096-12345-100',
    email: 'info@softifybd.com',
    binVat: '',
    currency: 'BDT',
    currencySymbol: '৳',
    vatRate: 0,
    invoicePrefix: 'SFT-INV-',
    receiptPrefix: 'SFT-RCP-',
    billPrefix: 'SFT-BIL-',
    paymentPrefix: 'SFT-PAY-',
    expensePrefix: 'SFT-EXP-',
    openingCash: 900000,
    financialYearStart: '2026-07-01'
  },
  roles: [
    { name: 'Super Admin', can: 'Everything, including settings and user management' },
    { name: 'Accountant', can: 'All vouchers, reports and statements. No settings' },
    { name: 'Sales Executive', can: 'Quotations, invoices and customer receipts only' },
    { name: 'Operations Staff', can: 'Supplier bookings and bills only' },
    { name: 'Manager', can: 'Read all, approve credit notes and cancellations' },
    { name: 'Read Only', can: 'Reports and statements, nothing editable' }
  ],
  customers,
  suppliers,
  services,
  banks,
  expenseCategories,
  employees,
  invoices,
  receipts,
  bills,
  payments,
  expenses,
  creditNotes: []
};

await writeFile(OUT, JSON.stringify(book, null, 2), 'utf8');

const gross = invoices.reduce((t, i) => t + i.lines.reduce((x, l) => x + l.qty * l.unitPrice, 0), 0);
const cost = invoices.reduce((t, i) => t + i.lines.reduce((x, l) => x + l.qty * l.supplierCost, 0), 0);
console.log(`wrote ${OUT}`);
console.log(`  invoices ${invoices.length} · receipts ${receipts.length} · bills ${bills.length} · payments ${payments.length} · expenses ${expenses.length}`);
console.log(`  gross sales ${gross.toLocaleString('en-IN')} · supplier cost ${cost.toLocaleString('en-IN')} · gross profit ${(gross - cost).toLocaleString('en-IN')}`);
