import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The accounting book. content/accounting.json is authoritative and the admin
 * portal on :4001 writes it; everything below is derived, never stored, so a
 * hand edit to a voucher can never leave a total stale.
 *
 * Single-entry with derived control accounts, not a full double-entry ledger —
 * see the General Ledger note in README.md for what that does and does not give
 * you.
 */

/* ------------------------------------------------------------------- types */

export type PayMethod = 'cash' | 'bank_transfer' | 'card' | 'mfs' | 'online';
export type InvoiceStatus = 'draft' | 'confirmed' | 'partially_paid' | 'paid' | 'cancelled';
export type BillStatus = 'unpaid' | 'partially_paid' | 'paid';

export type Customer = { id: string; name: string; type: string; phone: string; email: string; address: string; openingBalance: number };
export type Supplier = { id: string; name: string; type: string; phone: string; email: string; openingBalance: number };
export type Service = { id: string; name: string; category: string };
export type Bank = { id: string; name: string; accountNo: string; branch: string; openingBalance: number };
export type Named = { id: string; name: string };
export type Employee = { id: string; name: string; role: string; phone: string };

export type InvoiceLine = {
  serviceId: string; description: string; pnr: string; pax: number;
  qty: number; unitPrice: number; supplierCost: number; supplierId: string;
};

export type Invoice = {
  id: string; no: string; date: string; customerId: string;
  status: InvoiceStatus; vatRate: number; lines: InvoiceLine[]; notes: string;
};

export type Receipt = {
  id: string; no: string; date: string; customerId: string; invoiceId: string;
  method: PayMethod; bankId: string | null; amount: number; ref: string;
};

export type Bill = {
  id: string; no: string; date: string; supplierId: string; invoiceRef: string;
  status: BillStatus; amount: number; notes: string;
};

export type Payment = {
  id: string; no: string; date: string; supplierId: string; billId: string;
  method: PayMethod; bankId: string | null; amount: number; ref: string;
};

/**
 * Reasons a sale gets reversed. `cancellation` is the whole ticket going back,
 * the rest are partial adjustments.
 */
export type CreditReason = 'cancellation' | 'partial_refund' | 'date_change' | 'overcharge' | 'goodwill' | 'write_off';

/**
 * A credit note reverses part or all of a sale.
 *
 * `settlement` is the difference between the two things people call a refund:
 *
 *   credit_balance  the customer had not paid yet, so we simply reduce what
 *                   they owe. No money moves.
 *   a pay method    the customer had already paid, so cash or bank goes back
 *                   out on this date.
 *
 * Getting that distinction wrong is how a book ends up double-counting a
 * refund: reducing the receivable AND paying the money out for the same
 * credit. Exactly one of the two happens, decided by this field.
 *
 * `supplierRefund` is the other half of a cancellation — what the airline or
 * consolidator gives back on the bill behind the sale. It reduces the payable,
 * so a cancelled ticket does not leave a phantom debt to the carrier.
 */
export type CreditNote = {
  id: string; no: string; date: string;
  customerId: string; invoiceId: string; billId: string | null;
  reason: CreditReason;
  amount: number;
  settlement: 'credit_balance' | PayMethod;
  bankId: string | null;
  supplierRefund: number;
  notes: string;
};

export type Expense = {
  id: string; no: string; date: string; categoryId: string; method: PayMethod;
  bankId: string | null; amount: number; description: string; employeeId: string | null;
};

export type Book = {
  _meta: { note: string; revision: number; lastEditedBy: string; lastEditedAt: string };
  company: {
    name: string; tradingAs: string; address: string; phone: string; email: string;
    binVat: string; currency: string; currencySymbol: string; vatRate: number;
    invoicePrefix: string; receiptPrefix: string; billPrefix: string;
    paymentPrefix: string; expensePrefix: string;
    openingCash: number; financialYearStart: string;
  };
  roles: { name: string; can: string }[];
  customers: Customer[];
  suppliers: Supplier[];
  services: Service[];
  banks: Bank[];
  expenseCategories: Named[];
  employees: Employee[];
  invoices: Invoice[];
  receipts: Receipt[];
  bills: Bill[];
  payments: Payment[];
  expenses: Expense[];
  creditNotes: CreditNote[];
};

const BOOK_FILE = path.join(process.cwd(), 'content', 'accounting.json');

export async function getBook(): Promise<Book> {
  return JSON.parse(await readFile(BOOK_FILE, 'utf8')) as Book;
}

/* --------------------------------------------------------------- formatting */

export function money(n: number, symbol = '৳'): string {
  const v = Math.round(n);
  return `${v < 0 ? '-' : ''}${symbol}${Math.abs(v).toLocaleString('en-IN')}`;
}

/** ৳2,41,74,700 is unreadable on a tile — this gives ৳2.42 cr / ৳16.8 lakh. */
export function moneyShort(n: number, symbol = '৳'): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}${symbol}${(a / 1e7).toFixed(2)} cr`;
  if (a >= 1e5) return `${sign}${symbol}${(a / 1e5).toFixed(1)} lakh`;
  if (a >= 1e3) return `${sign}${symbol}${(a / 1e3).toFixed(0)}k`;
  return `${sign}${symbol}${Math.round(a)}`;
}

export const LABEL: Record<string, string> = {
  cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', mfs: 'bKash / Nagad', online: 'Online',
  draft: 'Draft', confirmed: 'Confirmed', partially_paid: 'Partially paid', paid: 'Paid', cancelled: 'Cancelled',
  unpaid: 'Unpaid',
  agency: 'Agency', walk_in: 'Walk-in', corporate: 'Corporate',
  airline: 'Airline', consolidator: 'Consolidator', hotel: 'Hotel', visa: 'Visa',
  air: 'Air ticket', hajj_umrah: 'Hajj / Umrah', tour: 'Tour', other: 'Other',
  cancellation: 'Cancellation', partial_refund: 'Partial refund', date_change: 'Date change',
  overcharge: 'Overcharge', goodwill: 'Goodwill', write_off: 'Write-off',
  credit_balance: 'Credit balance (no money moved)'
};

/* --------------------------------------------------------------- credit notes */

/** A credit that was refunded in money, rather than left against the balance. */
export const isRefunded = (n: CreditNote) => n.settlement !== 'credit_balance';

/**
 * Credit still sitting against an invoice — the part that reduces what the
 * customer owes. Refunded credits are excluded: that money already went back
 * out through cash or bank, so counting it here as well would relieve the debt
 * twice.
 */
export function creditOnInvoice(invoiceId: string, notes: CreditNote[]): number {
  return notes.filter((n) => n.invoiceId === invoiceId && !isRefunded(n)).reduce((t, n) => t + n.amount, 0);
}

/** Everything credited against an invoice, refunded or not. */
export function creditedTotal(invoiceId: string, notes: CreditNote[]): number {
  return notes.filter((n) => n.invoiceId === invoiceId).reduce((t, n) => t + n.amount, 0);
}

/** What a supplier gave back against one bill. */
export function refundOnBill(billId: string, notes: CreditNote[]): number {
  return notes.filter((n) => n.billId === billId).reduce((t, n) => t + n.supplierRefund, 0);
}

/* -------------------------------------------------------------- invoice math */

export type InvoiceTotals = {
  gross: number; vat: number; total: number;
  cost: number; profit: number; marginPct: number;
  paid: number; due: number;
  /** Credited and left against the balance — reduces what is owed. */
  credited: number;
  /** Credited in total, including amounts already refunded in money. */
  creditedAll: number;
  /** Sale value after credit notes. This is what the invoice is now worth. */
  net: number;
  cancelled: boolean;
  effectiveStatus: InvoiceStatus;
};

export function invoiceTotals(inv: Invoice, receipts: Receipt[], creditNotes: CreditNote[] = []): InvoiceTotals {
  const gross = inv.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
  const cost = inv.lines.reduce((t, l) => t + l.qty * l.supplierCost, 0);
  const vat = Math.round(gross * (inv.vatRate || 0) / 100);
  const total = gross + vat;
  const paid = receipts.filter((r) => r.invoiceId === inv.id).reduce((t, r) => t + r.amount, 0);
  const credited = creditOnInvoice(inv.id, creditNotes);
  const creditedAll = creditedTotal(inv.id, creditNotes);
  const due = Math.max(0, total - credited - paid);
  const net = total - creditedAll;

  /**
   * A fully credited invoice reads as cancelled whatever the stored status
   * says. The credit note is the evidence; the status field is a label, and
   * where they disagree the money wins.
   */
  const cancelled = inv.status === 'cancelled' || (total > 0 && creditedAll >= total);

  let effectiveStatus: InvoiceStatus = inv.status;
  if (cancelled) effectiveStatus = 'cancelled';
  else if (inv.status !== 'draft') {
    effectiveStatus = paid <= 0 ? 'confirmed' : due <= 0 ? 'paid' : 'partially_paid';
  }

  return {
    gross, vat, total, cost,
    profit: gross - cost,
    marginPct: gross > 0 ? ((gross - cost) / gross) * 100 : 0,
    paid, due, credited, creditedAll, net, cancelled, effectiveStatus
  };
}

export function billPaid(bill: Bill, payments: Payment[]): number {
  return payments.filter((p) => p.billId === bill.id).reduce((t, p) => t + p.amount, 0);
}

/** What is still owed on a bill after payments and any supplier refund. */
export function billDue(bill: Bill, payments: Payment[], creditNotes: CreditNote[] = []): number {
  return Math.max(0, bill.amount - billPaid(bill, payments) - refundOnBill(bill.id, creditNotes));
}

/* -------------------------------------------------------------- aggregations */

/** Invoices that count as trading — drafts and cancellations do not. */
export const isLive = (i: Invoice) => i.status !== 'draft' && i.status !== 'cancelled';

/**
 * Trading, and not reversed by a credit note.
 *
 * `isLive` only reads the stored status, which a full credit note does not
 * touch. Reports that list individual sales have to use this instead, or a
 * cancelled ticket keeps showing up as a sale with a margin on it.
 */
export const isTrading = (i: Invoice, notes: CreditNote[]) =>
  isLive(i) && !invoiceTotals(i, [], notes).cancelled;

export function summarise(book: Book, from?: string, to?: string) {
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);

  const invoices = book.invoices.filter((i) => isLive(i) && inRange(i.date));
  const receipts = book.receipts.filter((r) => inRange(r.date));
  const bills = book.bills.filter((b) => inRange(b.date));
  const payments = book.payments.filter((p) => inRange(p.date));
  const expenses = book.expenses.filter((e) => inRange(e.date));
  const notes = (book.creditNotes ?? []).filter((n) => inRange(n.date));

  /**
   * Credit notes land in the period they were issued, not the period of the
   * invoice they reverse. A December cancellation of a November sale belongs in
   * December — restating a closed month is how reported figures stop matching
   * what was filed.
   */
  const grossSales = invoices.reduce((t, i) => t + invoiceTotals(i, book.receipts).total, 0);
  const credited = notes.reduce((t, n) => t + n.amount, 0);
  const supplierRefunds = notes.reduce((t, n) => t + n.supplierRefund, 0);
  const grossCost = invoices.reduce((t, i) => t + invoiceTotals(i, book.receipts).cost, 0);

  const sales = grossSales - credited;
  const cost = grossCost - supplierRefunds;
  const collected = receipts.reduce((t, r) => t + r.amount, 0);
  const paidOut = payments.reduce((t, p) => t + p.amount, 0);
  const spent = expenses.reduce((t, e) => t + e.amount, 0);

  return {
    invoiceCount: invoices.length,
    grossSales,
    credited,
    creditNoteCount: notes.length,
    supplierRefunds,
    /** Net of credit notes. Every margin below is built on this, not on gross. */
    sales,
    cost,
    grossProfit: sales - cost,
    marginPct: sales > 0 ? ((sales - cost) / sales) * 100 : 0,
    collected,
    /** Money handed back to customers, which is a cash outflow like any other. */
    refunded: notes.filter(isRefunded).reduce((t, n) => t + n.amount, 0),
    paidOut,
    expenses: spent,
    netProfit: sales - cost - spent,
    billed: bills.reduce((t, b) => t + b.amount, 0)
  };
}

/** Money customers still owe us, across the whole book. */
export function receivables(book: Book) {
  const rows = book.invoices
    .filter((i) => i.status !== 'draft')
    .map((i) => ({ inv: i, t: invoiceTotals(i, book.receipts, book.creditNotes ?? []) }))
    .filter((r) => !r.t.cancelled && r.t.due > 0);
  return { rows, total: rows.reduce((t, r) => t + r.t.due, 0) };
}

/** Money we still owe suppliers. */
export function payables(book: Book) {
  const notes = book.creditNotes ?? [];
  const rows = book.bills
    .map((b) => ({ bill: b, paid: billPaid(b, book.payments), refunded: refundOnBill(b.id, notes) }))
    .map((r) => ({ ...r, due: Math.max(0, r.bill.amount - r.paid - r.refunded) }))
    .filter((r) => r.due > 0);
  return { rows, total: rows.reduce((t, r) => t + r.due, 0) };
}

/** Opening + receipts − payments = closing, for cash only. */
export function cashBook(book: Book, from?: string, to?: string) {
  const before = (d: string) => (from ? d < from : false);
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);

  const cashIn = (r: Receipt) => r.method === 'cash';
  const cashOut = (p: Payment | Expense) => p.method === 'cash';
  /** A credit note only touches cash when it was settled by handing notes back. */
  const cashRefund = (c: CreditNote) => c.settlement === 'cash';
  const notes = book.creditNotes ?? [];

  const opening =
    book.company.openingCash +
    book.receipts.filter((r) => cashIn(r) && before(r.date)).reduce((t, r) => t + r.amount, 0) -
    book.payments.filter((p) => cashOut(p) && before(p.date)).reduce((t, p) => t + p.amount, 0) -
    book.expenses.filter((e) => cashOut(e) && before(e.date)).reduce((t, e) => t + e.amount, 0) -
    notes.filter((c) => cashRefund(c) && before(c.date)).reduce((t, c) => t + c.amount, 0);

  const receiptsIn = book.receipts.filter((r) => cashIn(r) && inRange(r.date));
  const paymentsOut = book.payments.filter((p) => cashOut(p) && inRange(p.date));
  const expensesOut = book.expenses.filter((e) => cashOut(e) && inRange(e.date));
  const refundsOut = notes.filter((c) => cashRefund(c) && inRange(c.date));

  const totalIn = receiptsIn.reduce((t, r) => t + r.amount, 0);
  const totalOut =
    paymentsOut.reduce((t, p) => t + p.amount, 0) +
    expensesOut.reduce((t, e) => t + e.amount, 0) +
    refundsOut.reduce((t, c) => t + c.amount, 0);

  return { opening, receiptsIn, paymentsOut, expensesOut, refundsOut, totalIn, totalOut, closing: opening + totalIn - totalOut };
}

/** Same shape as the cash book, for one bank account. */
export function bankBook(book: Book, bankId: string, from?: string, to?: string) {
  const bank = book.banks.find((b) => b.id === bankId);
  const before = (d: string) => (from ? d < from : false);
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const mine = (x: { bankId: string | null }) => x.bankId === bankId;
  const notes = book.creditNotes ?? [];
  const bankRefund = (c: CreditNote) => isRefunded(c) && mine(c);

  const opening =
    (bank?.openingBalance ?? 0) +
    book.receipts.filter((r) => mine(r) && before(r.date)).reduce((t, r) => t + r.amount, 0) -
    book.payments.filter((p) => mine(p) && before(p.date)).reduce((t, p) => t + p.amount, 0) -
    book.expenses.filter((e) => mine(e) && before(e.date)).reduce((t, e) => t + e.amount, 0) -
    notes.filter((c) => bankRefund(c) && before(c.date)).reduce((t, c) => t + c.amount, 0);

  const receiptsIn = book.receipts.filter((r) => mine(r) && inRange(r.date));
  const paymentsOut = book.payments.filter((p) => mine(p) && inRange(p.date));
  const expensesOut = book.expenses.filter((e) => mine(e) && inRange(e.date));
  const refundsOut = notes.filter((c) => bankRefund(c) && inRange(c.date));

  const totalIn = receiptsIn.reduce((t, r) => t + r.amount, 0);
  const totalOut =
    paymentsOut.reduce((t, p) => t + p.amount, 0) +
    expensesOut.reduce((t, e) => t + e.amount, 0) +
    refundsOut.reduce((t, c) => t + c.amount, 0);

  return { bank, opening, receiptsIn, paymentsOut, expensesOut, refundsOut, totalIn, totalOut, closing: opening + totalIn - totalOut };
}

/** Every bank's closing balance, plus the combined figure. */
export function allBankBalances(book: Book, to?: string) {
  const rows = book.banks.map((b) => ({ bank: b, closing: bankBook(book, b.id, undefined, to).closing }));
  return { rows, total: rows.reduce((t, r) => t + r.closing, 0) };
}

export function expensesByCategory(book: Book, from?: string, to?: string) {
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const m = new Map<string, number>();
  for (const e of book.expenses.filter((x) => inRange(x.date))) {
    m.set(e.categoryId, (m.get(e.categoryId) ?? 0) + e.amount);
  }
  return book.expenseCategories
    .map((c) => ({ category: c, amount: m.get(c.id) ?? 0 }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

export function salesByService(book: Book, from?: string, to?: string) {
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const m = new Map<string, { sales: number; cost: number; count: number }>();
  const notes = book.creditNotes ?? [];
  for (const inv of book.invoices.filter((i) => isTrading(i, notes) && inRange(i.date))) {
    for (const l of inv.lines) {
      const cur = m.get(l.serviceId) ?? { sales: 0, cost: 0, count: 0 };
      cur.sales += l.qty * l.unitPrice;
      cur.cost += l.qty * l.supplierCost;
      cur.count += 1;
      m.set(l.serviceId, cur);
    }
  }
  return book.services
    .map((s) => ({ service: s, ...(m.get(s.id) ?? { sales: 0, cost: 0, count: 0 }) }))
    .filter((r) => r.count > 0)
    .map((r) => ({ ...r, profit: r.sales - r.cost }))
    .sort((a, b) => b.sales - a.sales);
}

export function customerLedger(book: Book, customerId: string) {
  const rows: { date: string; ref: string; detail: string; debit: number; credit: number }[] = [];
  for (const i of book.invoices.filter((x) => x.customerId === customerId && isLive(x))) {
    rows.push({ date: i.date, ref: i.no, detail: 'Invoice', debit: invoiceTotals(i, book.receipts).total, credit: 0 });
  }
  for (const r of book.receipts.filter((x) => x.customerId === customerId)) {
    rows.push({ date: r.date, ref: r.no, detail: `Receipt — ${LABEL[r.method] ?? r.method}`, debit: 0, credit: r.amount });
  }
  for (const c of (book.creditNotes ?? []).filter((x) => x.customerId === customerId)) {
    // A refunded credit leaves the balance where it was: the sale comes off and
    // the money goes back out, so both sides of the ledger move together.
    if (isRefunded(c)) {
      rows.push({ date: c.date, ref: c.no, detail: `Credit note — ${LABEL[c.reason] ?? c.reason}`, debit: 0, credit: c.amount });
      rows.push({ date: c.date, ref: c.no, detail: `Refund paid — ${LABEL[c.settlement] ?? c.settlement}`, debit: c.amount, credit: 0 });
    } else {
      rows.push({ date: c.date, ref: c.no, detail: `Credit note — ${LABEL[c.reason] ?? c.reason}`, debit: 0, credit: c.amount });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  let bal = book.customers.find((c) => c.id === customerId)?.openingBalance ?? 0;
  return rows.map((r) => ({ ...r, balance: (bal += r.debit - r.credit) }));
}

export function supplierLedger(book: Book, supplierId: string) {
  const rows: { date: string; ref: string; detail: string; debit: number; credit: number }[] = [];
  for (const b of book.bills.filter((x) => x.supplierId === supplierId)) {
    rows.push({ date: b.date, ref: b.no, detail: 'Supplier bill', debit: 0, credit: b.amount });
  }
  for (const p of book.payments.filter((x) => x.supplierId === supplierId)) {
    rows.push({ date: p.date, ref: p.no, detail: `Payment — ${LABEL[p.method] ?? p.method}`, debit: p.amount, credit: 0 });
  }
  for (const c of (book.creditNotes ?? []).filter((x) => x.supplierRefund > 0 && x.billId)) {
    const bill = book.bills.find((b) => b.id === c.billId);
    if (bill?.supplierId !== supplierId) continue;
    rows.push({ date: c.date, ref: c.no, detail: `Supplier refund on ${bill.no}`, debit: c.supplierRefund, credit: 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  let bal = book.suppliers.find((s) => s.id === supplierId)?.openingBalance ?? 0;
  return rows.map((r) => ({ ...r, balance: (bal += r.credit - r.debit) }));
}

/** Profit & loss for a window. */
export function profitAndLoss(book: Book, from?: string, to?: string) {
  const s = summarise(book, from, to);
  const byCat = expensesByCategory(book, from, to);
  return {
    grossRevenue: s.grossSales,
    creditNotes: s.credited,
    revenue: s.sales,
    supplierRefunds: s.supplierRefunds,
    costOfSales: s.cost,
    grossProfit: s.grossProfit,
    grossMarginPct: s.marginPct,
    expenseRows: byCat,
    totalExpenses: s.expenses,
    netProfit: s.netProfit,
    netMarginPct: s.sales > 0 ? (s.netProfit / s.sales) * 100 : 0
  };
}

/**
 * Control-account trial balance, derived from the vouchers rather than from
 * posted journal lines.
 *
 * Purchases are taken from the bills raised, not from the cost lines on live
 * invoices. That matters: a bill is what creates the payable, so if a bill is
 * raised against an invoice that is later drafted or cancelled, the cost has to
 * stay on the purchases side or the two columns drift apart. Taking it from
 * invoice lines instead leaves exactly that gap, which is a real bug this once
 * had.
 *
 * With purchases on that basis the identity holds algebraically:
 *   cash+bank = opening + collections − supplier payments − expenses
 *   receivable = revenue − collections
 *   payable    = purchases − supplier payments
 * so both columns reduce to  opening + revenue + purchases − supplier payments.
 *
 * `difference` is therefore expected to be 0. It is returned and displayed
 * rather than assumed, so that a future data problem shows up on the page
 * instead of hiding.
 */
export function trialBalance(book: Book) {
  const cash = cashBook(book).closing;
  const bank = allBankBalances(book).total;
  const ar = receivables(book).total;
  const ap = payables(book).total;
  const s = summarise(book);
  /**
   * Purchases net of what suppliers gave back. The payable is reduced by the
   * same refunds inside payables(), so both columns move together — reducing
   * one without the other is what would put the balance out.
   */
  const supplierRefunds = (book.creditNotes ?? []).reduce((t, c) => t + c.supplierRefund, 0);
  const purchases = book.bills.reduce((t, b) => t + b.amount, 0) - supplierRefunds;
  const opening = book.company.openingCash + book.banks.reduce((t, b) => t + b.openingBalance, 0);

  const debits = [
    { account: 'Cash in hand', amount: cash },
    { account: 'Bank accounts', amount: bank },
    { account: 'Accounts receivable', amount: ar },
    { account: 'Purchases (supplier bills, net of refunds)', amount: purchases },
    { account: 'Operating expenses', amount: s.expenses }
  ];
  const credits = [
    { account: 'Accounts payable', amount: ap },
    { account: 'Sales revenue (net of credit notes)', amount: s.sales },
    { account: 'Opening balances', amount: opening }
  ];

  const totalDebit = debits.reduce((t, r) => t + r.amount, 0);
  const totalCredit = credits.reduce((t, r) => t + r.amount, 0);

  return { debits, credits, totalDebit, totalCredit, difference: totalDebit - totalCredit };
}

/** One row per day, newest first — the daily report grid. */
export function dailyRollup(book: Book, days = 14) {
  const dates = Array.from(new Set([
    ...book.invoices.map((i) => i.date),
    ...book.receipts.map((r) => r.date),
    ...book.payments.map((p) => p.date),
    ...book.expenses.map((e) => e.date),
    ...(book.creditNotes ?? []).map((c) => c.date)
  ])).sort().reverse().slice(0, days);

  return dates.map((d) => {
    const s = summarise(book, d, d);
    const cash = cashBook(book, d, d);
    return {
      date: d,
      invoices: s.invoiceCount,
      credited: s.credited,
      sales: s.sales,
      cost: s.cost,
      grossProfit: s.grossProfit,
      collected: s.collected,
      paidOut: s.paidOut,
      expenses: s.expenses,
      netProfit: s.netProfit,
      cashClosing: cash.closing
    };
  });
}

/** Newest activity across every voucher type, for the dashboard feed. */
export function recentTransactions(book: Book, limit = 12) {
  type Row = { date: string; type: string; ref: string; party: string; amount: number; direction: 'in' | 'out' };
  const rows: Row[] = [];
  const cust = (id: string) => book.customers.find((c) => c.id === id)?.name ?? id;
  const sup = (id: string) => book.suppliers.find((s) => s.id === id)?.name ?? id;

  for (const i of book.invoices.filter(isLive)) {
    rows.push({ date: i.date, type: 'Invoice', ref: i.no, party: cust(i.customerId), amount: invoiceTotals(i, book.receipts).total, direction: 'in' });
  }
  for (const r of book.receipts) rows.push({ date: r.date, type: 'Receipt', ref: r.no, party: cust(r.customerId), amount: r.amount, direction: 'in' });
  for (const p of book.payments) rows.push({ date: p.date, type: 'Supplier payment', ref: p.no, party: sup(p.supplierId), amount: p.amount, direction: 'out' });
  for (const e of book.expenses) {
    rows.push({ date: e.date, type: 'Expense', ref: e.no, party: book.expenseCategories.find((c) => c.id === e.categoryId)?.name ?? '', amount: e.amount, direction: 'out' });
  }
  for (const c of book.creditNotes ?? []) {
    rows.push({ date: c.date, type: 'Credit note', ref: c.no, party: cust(c.customerId), amount: c.amount, direction: 'out' });
  }

  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.ref.localeCompare(a.ref)).slice(0, limit);
}

/** The single most useful travel-specific view: margin per booking. */
export function bookingProfit(book: Book, limit?: number) {
  const notes = book.creditNotes ?? [];
  const rows = book.invoices.filter((i) => isTrading(i, notes)).map((i) => {
    const t = invoiceTotals(i, book.receipts, notes);
    return {
      invoice: i,
      customer: book.customers.find((c) => c.id === i.customerId)?.name ?? i.customerId,
      pnrs: i.lines.map((l) => l.pnr).filter(Boolean),
      ...t
    };
  });
  rows.sort((a, b) => b.profit - a.profit);
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Credit notes with the invoice, customer and bill they reverse resolved, so
 * the screen and the export both read from one place.
 */
export function creditNoteReport(book: Book) {
  const notes = book.creditNotes ?? [];
  const rows = [...notes]
    .sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no))
    .map((note) => {
      const invoice = book.invoices.find((i) => i.id === note.invoiceId) ?? null;
      const t = invoice ? invoiceTotals(invoice, book.receipts, notes) : null;
      return {
        note,
        invoice,
        customer: book.customers.find((c) => c.id === note.customerId)?.name ?? note.customerId,
        bill: book.bills.find((b) => b.id === note.billId) ?? null,
        bank: book.banks.find((b) => b.id === note.bankId) ?? null,
        /** True when this credit, with any others, reverses the whole invoice. */
        fullCancellation: Boolean(t && t.cancelled),
        invoiceTotal: t?.total ?? 0
      };
    });

  const credited = rows.reduce((t, r) => t + r.note.amount, 0);
  const refunded = rows.filter((r) => isRefunded(r.note)).reduce((t, r) => t + r.note.amount, 0);
  return {
    rows,
    credited,
    /** Money actually handed back, as opposed to credit left on account. */
    refunded,
    onAccount: credited - refunded,
    supplierRecovered: rows.reduce((t, r) => t + r.note.supplierRefund, 0),
    cancellations: rows.filter((r) => r.fullCancellation).length,
    /**
     * What the cancellations cost us: credited to the customer, less what the
     * airline gave back. This is the number an agency owner asks for.
     */
    netLoss: credited - rows.reduce((t, r) => t + r.note.supplierRefund, 0)
  };
}

export const todayISO = (book: Book) => {
  const all = book.invoices.map((i) => i.date).concat(book.receipts.map((r) => r.date)).sort();
  return all[all.length - 1] ?? new Date().toISOString().slice(0, 10);
};

/* ------------------------------------------- supplier deposits & inventory */

export type SupplierDeposit = {
  id: string; no: string; date: string; supplierId: string;
  kind: 'deposit'; method: PayMethod; bankId: string | null;
  amount: number; reference: string; note: string;
};

export type InventoryItem = {
  id: string; name: string; kind: string; supplierId: string;
  purchased: number; sold: number; unitCost: number; unitSell: number;
  expiresOn: string; note: string;
};

export const INVENTORY_KIND: Record<string, string> = {
  hajj_seat: 'Hajj seat block',
  hotel_room: 'Hotel room nights',
  air_seat: 'Group air seats',
  visa_slot: 'Visa processing quota'
};

/**
 * What we have put on account with each supplier, and what we have drawn
 * against it. In travel this matters more than in most trades: an agency
 * pre-funds a consolidator and then issues against that float, so the number
 * that decides whether you can ticket tomorrow is the UNUSED balance, not the
 * payable.
 */
export function supplierDeposits(book: Book) {
  const deposits = (book as unknown as { supplierDeposits?: SupplierDeposit[] }).supplierDeposits ?? [];

  const rows = book.suppliers.map((s) => {
    const paidIn = deposits.filter((d) => d.supplierId === s.id).reduce((t, d) => t + d.amount, 0);
    const billed = book.bills.filter((b) => b.supplierId === s.id).reduce((t, b) => t + b.amount, 0);
    const settled = book.payments.filter((p) => p.supplierId === s.id).reduce((t, p) => t + p.amount, 0);
    // the float is what we advanced, less anything the bills have not already paid for
    const outstandingBills = Math.max(0, billed - settled);
    return {
      supplier: s,
      deposited: paidIn,
      billed,
      settled,
      outstandingBills,
      available: paidIn - outstandingBills,
      depositCount: deposits.filter((d) => d.supplierId === s.id).length
    };
  }).filter((r) => r.deposited > 0 || r.billed > 0);

  return {
    rows: rows.sort((a, b) => b.deposited - a.deposited),
    deposits: [...deposits].sort((a, b) => b.date.localeCompare(a.date)),
    totalDeposited: rows.reduce((t, r) => t + r.deposited, 0),
    totalAvailable: rows.reduce((t, r) => t + r.available, 0),
    totalOutstanding: rows.reduce((t, r) => t + r.outstandingBills, 0)
  };
}

/**
 * Blocks bought up front — Hajj seats, room nights, group fares, visa quota.
 * Unsold units are cash sitting on a shelf with an expiry date on it, which is
 * the whole reason a travel agency needs stock control at all.
 */
export function inventory(book: Book, today = new Date().toISOString().slice(0, 10)) {
  const items = (book as unknown as { inventory?: InventoryItem[] }).inventory ?? [];

  const rows = items.map((i) => {
    const remaining = Math.max(0, i.purchased - i.sold);
    const daysLeft = Math.ceil((Date.parse(i.expiresOn) - Date.parse(today)) / 86400000);
    return {
      item: i,
      supplier: book.suppliers.find((s) => s.id === i.supplierId)?.name ?? i.supplierId,
      remaining,
      soldPct: i.purchased ? (i.sold / i.purchased) * 100 : 0,
      costCommitted: i.purchased * i.unitCost,
      valueAtRisk: remaining * i.unitCost,
      realisedMargin: i.sold * (i.unitSell - i.unitCost),
      potentialMargin: remaining * (i.unitSell - i.unitCost),
      daysLeft,
      expired: daysLeft < 0,
      /** Under 30 days with a third still unsold is where money gets lost. */
      atRisk: daysLeft >= 0 && daysLeft <= 30 && remaining / Math.max(1, i.purchased) > 0.33
    };
  });

  return {
    rows: rows.sort((a, b) => b.valueAtRisk - a.valueAtRisk),
    totalCommitted: rows.reduce((t, r) => t + r.costCommitted, 0),
    totalAtRisk: rows.reduce((t, r) => t + r.valueAtRisk, 0),
    realised: rows.reduce((t, r) => t + r.realisedMargin, 0),
    potential: rows.reduce((t, r) => t + r.potentialMargin, 0),
    expiringSoon: rows.filter((r) => r.atRisk).length,
    expired: rows.filter((r) => r.expired && r.remaining > 0).length
  };
}
