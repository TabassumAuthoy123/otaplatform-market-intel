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

/**
 * `supplier_deposit` settles a bill out of a float already advanced to that
 * supplier. No fresh money moves — the advance is drawn down instead. Without
 * it, paying from a deposit would take the same money out of the bank twice.
 */
export type PayMethod = 'cash' | 'bank_transfer' | 'card' | 'mfs' | 'online' | 'supplier_deposit';
export type InvoiceStatus = 'draft' | 'confirmed' | 'partially_paid' | 'paid' | 'cancelled';
export type BillStatus = 'unpaid' | 'partially_paid' | 'paid';

export type Customer = { id: string; name: string; type: string; phone: string; email: string; address: string; openingBalance: number };
export type Supplier = { id: string; name: string; type: string; phone: string; email: string; openingBalance: number };
export type Service = { id: string; name: string; category: string };
export type Bank = { id: string; name: string; accountNo: string; branch: string; openingBalance: number };
export type Named = { id: string; name: string };
export type Airline = { id: string; name: string; iataCode: string; accountingCode: string; hub: string; note: string };
export type Hotel = { id: string; name: string; city: string; country: string; stars: string; segment: string };
export type VisaType = { id: string; name: string; category: string; validityDays: string; serviceFee: string; processingDays: string };
export type Country = { id: string; name: string; iso2: string; currency: string; dialCode: string };

/**
 * A currency and what it was worth in the base currency.
 *
 * `rateToBase` is a stored reference, not a live feed, and it is deliberately
 * copied onto a document when the document is raised. A rate that moves next
 * month must not restate a sale that was already made and already paid.
 */
export type Currency = { id: string; name: string; code: string; symbol: string; rateToBase: number; isBase: number };
export type Employee = { id: string; name: string; role: string; phone: string };

export type InvoiceLine = {
  serviceId: string; description: string; pnr: string; pax: number;
  qty: number; unitPrice: number; supplierCost: number; supplierId: string;
};

/**
 * A document raised in a currency other than the book's.
 *
 * `fxRate` is copied onto the document when it is raised and never looked up
 * again. A rate that moves next month must not restate a sale that was already
 * made and already paid — that is the whole reason it is stored here instead of
 * read from the Currencies master at display time.
 *
 * Line amounts stay in the DOCUMENT currency, exactly as the customer sees
 * them. Everything the book totals is converted at this rate, so the ledger is
 * always in one currency and the invoice always reads in the other.
 *
 * Receipts and payments are base currency only. Money moved through a real bank
 * account at a real amount, and pretending otherwise would put an unrealised
 * gain nobody asked for into a book that has no place to hold it.
 */
export type ForeignDoc = { currency?: string; fxRate?: number };

/** 1 unless the document says otherwise, so untouched data behaves as before. */
export const fxOf = (d: ForeignDoc) => (d.fxRate && d.fxRate > 0 ? d.fxRate : 1);
export const isForeign = (d: ForeignDoc, base: string) => Boolean(d.currency && d.currency !== base);

export type Attachment = { name: string; url: string; note: string };

export type Invoice = ForeignDoc & {
  id: string; no: string; date: string; customerId: string;
  status: InvoiceStatus; vatRate: number; lines: InvoiceLine[]; notes: string;
  attachments?: Attachment[];
};

export type Receipt = {
  id: string; no: string; date: string; customerId: string; invoiceId: string;
  method: PayMethod; bankId: string | null; amount: number; ref: string;
};

export type Bill = ForeignDoc & {
  id: string; no: string; date: string; supplierId: string; invoiceRef: string;
  status: BillStatus; amount: number; notes: string;
  attachments?: Attachment[];
};

/**
 * A bill's value in the book's own currency.
 *
 * Every total in this file goes through here rather than reading `amount`
 * directly, because `amount` is what the supplier invoiced — which may be in
 * dollars.
 */
export const billBase = (b: Bill) => Math.round(b.amount * fxOf(b));

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

/**
 * Cash moved between the till and a bank account.
 *
 *   deposit    cash leaves the till and lands in the bank
 *   withdrawal cash comes out of the bank and into the till
 *
 * Without this the two books cannot be reconciled against each other: an
 * agency that banks its counter takings every evening had no way to say so, and
 * the cash book would keep growing while the bank statement disagreed.
 *
 * A transfer never changes total funds, only where they sit, so it can never
 * move the trial balance.
 */
export type Transfer = {
  id: string; no: string; date: string;
  direction: 'deposit' | 'withdrawal';
  bankId: string; amount: number; ref: string; notes: string;
};

/**
 * A supplier credit note — the purchase-side mirror of a customer credit note.
 *
 * An airline reverses an ADM, a consolidator over-billed, a hotel refunds an
 * unused night. `settlement` works the same way and for the same reason: either
 * the bill was unpaid and we now owe less, or it was paid and money comes back
 * IN. Never both.
 *
 * This is separate from the `supplierRefund` field on a customer credit note.
 * That one is the supplier side of a cancelled sale and belongs with it. This
 * one has no customer behind it at all.
 */
export type SupplierCreditNote = {
  id: string; no: string; date: string;
  supplierId: string; billId: string;
  reason: 'overbilled' | 'adm_reversal' | 'service_failure' | 'rebate' | 'other';
  amount: number;
  settlement: 'credit_balance' | PayMethod;
  bankId: string | null;
  notes: string;
};

export type Expense = {
  id: string; no: string; date: string; categoryId: string; method: PayMethod;
  bankId: string | null; amount: number; description: string; employeeId: string | null;
  attachments?: Attachment[];
};

export type Book = {
  _meta: { note: string; revision: number; lastEditedBy: string; lastEditedAt: string };
  company: {
    name: string; tradingAs: string; address: string; phone: string; email: string;
    binVat: string; currency: string; currencySymbol: string; vatRate: number;
    invoicePrefix: string; receiptPrefix: string; billPrefix: string;
    paymentPrefix: string; expensePrefix: string;
    openingCash: number; financialYearStart: string;
    creditNotePrefix: string; transferPrefix: string; supplierCreditPrefix: string;
    vat: { enabled: number; defaultRate: number; registrationNo: string; note: string };
    currencySettings: { baseCurrency: string; symbol: string; decimals: number; note: string };
    /** SMTP setup. `company.email` above is the contact address on documents; this is the sender. */
    smtp: { enabled: number; fromName: string; fromAddress: string; smtpHost: string; smtpPort: number; smtpUser: string; note: string };
    messaging: { smsEnabled: number; smsSenderId: string; smsProvider: string; whatsappEnabled: number; whatsappNumber: string; note: string };
    /** How long an invoice may sit before it is chased, and from what value. */
    reminders: { dueAfterDays: number; escalateAfterDays: number; chaseFrom: number };
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
  transfers: Transfer[];
  supplierCreditNotes: SupplierCreditNote[];
  supplierDeposits: SupplierDeposit[];
  inventory: InventoryItem[];
  airlines: Airline[];
  hotels: Hotel[];
  visaTypes: VisaType[];
  countries: Country[];
  currencies: Currency[];
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
  supplier_deposit: 'Drawn from supplier deposit',
  draft: 'Draft', confirmed: 'Confirmed', partially_paid: 'Partially paid', paid: 'Paid', cancelled: 'Cancelled',
  unpaid: 'Unpaid',
  agency: 'Agency', walk_in: 'Walk-in', corporate: 'Corporate',
  airline: 'Airline', consolidator: 'Consolidator', hotel: 'Hotel', visa: 'Visa',
  air: 'Air ticket', hajj_umrah: 'Hajj / Umrah', tour: 'Tour', other: 'Other',
  cancellation: 'Cancellation', partial_refund: 'Partial refund', date_change: 'Date change',
  overcharge: 'Overcharge', goodwill: 'Goodwill', write_off: 'Write-off',
  credit_balance: 'Credit balance (no money moved)',
  deposit: 'Cash deposited to bank', withdrawal: 'Cash withdrawn from bank',
  overbilled: 'Overbilled', adm_reversal: 'ADM reversal', service_failure: 'Service failure',
  rebate: 'Volume rebate'
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

/** What a supplier gave back against one bill, from a cancelled sale. */
export function refundOnBill(billId: string, notes: CreditNote[]): number {
  return notes.filter((n) => n.billId === billId).reduce((t, n) => t + n.supplierRefund, 0);
}

/** Supplier credit that reduces what we owe, as opposed to money already returned. */
export function supplierCreditOnBill(billId: string, notes: SupplierCreditNote[]): number {
  return notes
    .filter((c) => c.billId === billId && c.settlement === 'credit_balance')
    .reduce((t, c) => t + c.amount, 0);
}

/** Everything a supplier credited on one bill, settled or not. */
export function supplierCreditedTotal(billId: string, notes: SupplierCreditNote[]): number {
  return notes.filter((c) => c.billId === billId).reduce((t, c) => t + c.amount, 0);
}

/**
 * Total credit a bill carries from both directions — the supplier's own credit
 * note and the supplier-refund leg of a cancelled sale.
 */
export function billCredited(billId: string, book: Book): number {
  return refundOnBill(billId, book.creditNotes ?? []) + supplierCreditedTotal(billId, book.supplierCreditNotes ?? []);
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
  /** Rate this document was raised at. 1 for anything in the book's currency. */
  fx: number;
  /** Face value as the customer sees it, before conversion. */
  grossDoc: number;
  totalDoc: number;
};

export function invoiceTotals(inv: Invoice, receipts: Receipt[], creditNotes: CreditNote[] = []): InvoiceTotals {
  /**
   * Lines are in the document currency; everything below is in the book's.
   * Rounding happens once, on the converted figure, so the parts always add up
   * to the whole — converting each line separately and summing would leave the
   * total a rupee or two off its own components.
   */
  const fx = fxOf(inv);
  const grossDoc = inv.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
  const costDoc = inv.lines.reduce((t, l) => t + l.qty * l.supplierCost, 0);
  const gross = Math.round(grossDoc * fx);
  const cost = Math.round(costDoc * fx);
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
    paid, due, credited, creditedAll, net, cancelled, effectiveStatus,
    fx, grossDoc, totalDoc: grossDoc + Math.round(grossDoc * (inv.vatRate || 0) / 100)
  };
}

export function billPaid(bill: Bill, payments: Payment[]): number {
  return payments.filter((p) => p.billId === bill.id).reduce((t, p) => t + p.amount, 0);
}

/**
 * What is still owed on a bill after payments and every kind of credit.
 *
 * Only UNSETTLED supplier credit reduces the debt. A supplier credit that was
 * settled in money has already arrived in the bank, so counting it here as well
 * would relieve the same debt twice — the same trap as a refunded customer
 * credit, in the other direction.
 */
export function billDue(
  bill: Bill,
  payments: Payment[],
  creditNotes: CreditNote[] = [],
  supplierNotes: SupplierCreditNote[] = []
): number {
  return Math.max(
    0,
    billBase(bill) - billPaid(bill, payments) - refundOnBill(bill.id, creditNotes) - supplierCreditOnBill(bill.id, supplierNotes)
  );
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
  const supplierNotes = (book.supplierCreditNotes ?? []).filter((c) => inRange(c.date));

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

  const supplierCredits = supplierNotes.reduce((t, c) => t + c.amount, 0);

  const sales = grossSales - credited;
  const cost = grossCost - supplierRefunds - supplierCredits;
  const collected = receipts.reduce((t, r) => t + r.amount, 0);
  const paidOut = payments.reduce((t, p) => t + p.amount, 0);
  const spent = expenses.reduce((t, e) => t + e.amount, 0);

  return {
    invoiceCount: invoices.length,
    grossSales,
    credited,
    creditNoteCount: notes.length,
    supplierRefunds,
    supplierCredits,
    supplierCreditCount: supplierNotes.length,
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
    billed: bills.reduce((t, b) => t + billBase(b), 0)
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
  const supplierNotes = book.supplierCreditNotes ?? [];
  const rows = book.bills
    .map((b) => ({
      bill: b,
      paid: billPaid(b, book.payments),
      refunded: refundOnBill(b.id, notes),
      credited: supplierCreditOnBill(b.id, supplierNotes)
    }))
    .map((r) => ({ ...r, due: Math.max(0, billBase(r.bill) - r.paid - r.refunded - r.credited) }))
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
  const transfers = book.transfers ?? [];
  const supplierNotes = book.supplierCreditNotes ?? [];
  /** Cash banked leaves the till; cash drawn from the bank arrives in it. */
  const cashOutTransfer = (t: Transfer) => t.direction === 'deposit';
  const cashInTransfer = (t: Transfer) => t.direction === 'withdrawal';
  /** A supplier credit settled in cash is money coming back over the counter. */
  const cashInSupplierCredit = (c: SupplierCreditNote) => c.settlement === 'cash';
  /**
   * An advance placed with a supplier is money that has genuinely left.
   * It carried a method and a bank account from the day it was added and moved
   * neither — 88 lakh of deposits sat in the book while the balances they were
   * paid from never went down.
   */
  const deposits = book.supplierDeposits ?? [];
  const cashDeposit = (d: SupplierDeposit) => d.method === 'cash';

  const opening =
    book.company.openingCash +
    book.receipts.filter((r) => cashIn(r) && before(r.date)).reduce((t, r) => t + r.amount, 0) -
    book.payments.filter((p) => cashOut(p) && before(p.date)).reduce((t, p) => t + p.amount, 0) -
    book.expenses.filter((e) => cashOut(e) && before(e.date)).reduce((t, e) => t + e.amount, 0) -
    notes.filter((c) => cashRefund(c) && before(c.date)).reduce((t, c) => t + c.amount, 0) -
    transfers.filter((t) => cashOutTransfer(t) && before(t.date)).reduce((x, t) => x + t.amount, 0) +
    transfers.filter((t) => cashInTransfer(t) && before(t.date)).reduce((x, t) => x + t.amount, 0) +
    supplierNotes.filter((c) => cashInSupplierCredit(c) && before(c.date)).reduce((x, c) => x + c.amount, 0) -
    deposits.filter((d) => cashDeposit(d) && before(d.date)).reduce((x, d) => x + d.amount, 0);

  const receiptsIn = book.receipts.filter((r) => cashIn(r) && inRange(r.date));
  const paymentsOut = book.payments.filter((p) => cashOut(p) && inRange(p.date));
  const expensesOut = book.expenses.filter((e) => cashOut(e) && inRange(e.date));
  const refundsOut = notes.filter((c) => cashRefund(c) && inRange(c.date));
  const transfersOut = transfers.filter((t) => cashOutTransfer(t) && inRange(t.date));
  const transfersIn = transfers.filter((t) => cashInTransfer(t) && inRange(t.date));
  const supplierCreditsIn = supplierNotes.filter((c) => cashInSupplierCredit(c) && inRange(c.date));
  const depositsOut = deposits.filter((d) => cashDeposit(d) && inRange(d.date));

  const totalIn =
    receiptsIn.reduce((t, r) => t + r.amount, 0) +
    transfersIn.reduce((x, t) => x + t.amount, 0) +
    supplierCreditsIn.reduce((x, c) => x + c.amount, 0);
  const totalOut =
    paymentsOut.reduce((t, p) => t + p.amount, 0) +
    expensesOut.reduce((t, e) => t + e.amount, 0) +
    refundsOut.reduce((t, c) => t + c.amount, 0) +
    transfersOut.reduce((x, t) => x + t.amount, 0) +
    depositsOut.reduce((x, d) => x + d.amount, 0);

  return {
    opening, receiptsIn, paymentsOut, expensesOut, refundsOut,
    transfersIn, transfersOut, supplierCreditsIn, depositsOut,
    totalIn, totalOut, closing: opening + totalIn - totalOut
  };
}

/** Same shape as the cash book, for one bank account. */
export function bankBook(book: Book, bankId: string, from?: string, to?: string) {
  const bank = book.banks.find((b) => b.id === bankId);
  const before = (d: string) => (from ? d < from : false);
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const mine = (x: { bankId: string | null }) => x.bankId === bankId;
  const notes = book.creditNotes ?? [];
  const transfers = (book.transfers ?? []).filter((t) => t.bankId === bankId);
  const supplierNotes = book.supplierCreditNotes ?? [];
  const bankRefund = (c: CreditNote) => isRefunded(c) && mine(c);
  /** A deposit arrives in this account; a withdrawal leaves it. */
  const bankInTransfer = (t: Transfer) => t.direction === 'deposit';
  const bankOutTransfer = (t: Transfer) => t.direction === 'withdrawal';
  const bankInSupplierCredit = (c: SupplierCreditNote) => c.settlement !== 'credit_balance' && c.bankId === bankId;
  const deposits = book.supplierDeposits ?? [];
  const bankDeposit = (d: SupplierDeposit) => d.method !== 'cash' && d.bankId === bankId;

  const opening =
    (bank?.openingBalance ?? 0) +
    book.receipts.filter((r) => mine(r) && before(r.date)).reduce((t, r) => t + r.amount, 0) -
    book.payments.filter((p) => mine(p) && before(p.date)).reduce((t, p) => t + p.amount, 0) -
    book.expenses.filter((e) => mine(e) && before(e.date)).reduce((t, e) => t + e.amount, 0) -
    notes.filter((c) => bankRefund(c) && before(c.date)).reduce((t, c) => t + c.amount, 0) +
    transfers.filter((t) => bankInTransfer(t) && before(t.date)).reduce((x, t) => x + t.amount, 0) -
    transfers.filter((t) => bankOutTransfer(t) && before(t.date)).reduce((x, t) => x + t.amount, 0) +
    supplierNotes.filter((c) => bankInSupplierCredit(c) && before(c.date)).reduce((x, c) => x + c.amount, 0) -
    deposits.filter((d) => bankDeposit(d) && before(d.date)).reduce((x, d) => x + d.amount, 0);

  const receiptsIn = book.receipts.filter((r) => mine(r) && inRange(r.date));
  const paymentsOut = book.payments.filter((p) => mine(p) && inRange(p.date));
  const expensesOut = book.expenses.filter((e) => mine(e) && inRange(e.date));
  const refundsOut = notes.filter((c) => bankRefund(c) && inRange(c.date));
  const transfersIn = transfers.filter((t) => bankInTransfer(t) && inRange(t.date));
  const transfersOut = transfers.filter((t) => bankOutTransfer(t) && inRange(t.date));
  const supplierCreditsIn = supplierNotes.filter((c) => bankInSupplierCredit(c) && inRange(c.date));
  const depositsOut = deposits.filter((d) => bankDeposit(d) && inRange(d.date));

  const totalIn =
    receiptsIn.reduce((t, r) => t + r.amount, 0) +
    transfersIn.reduce((x, t) => x + t.amount, 0) +
    supplierCreditsIn.reduce((x, c) => x + c.amount, 0);
  const totalOut =
    paymentsOut.reduce((t, p) => t + p.amount, 0) +
    expensesOut.reduce((t, e) => t + e.amount, 0) +
    refundsOut.reduce((t, c) => t + c.amount, 0) +
    transfersOut.reduce((x, t) => x + t.amount, 0) +
    depositsOut.reduce((x, d) => x + d.amount, 0);

  return {
    bank, opening, receiptsIn, paymentsOut, expensesOut, refundsOut,
    transfersIn, transfersOut, supplierCreditsIn, depositsOut,
    totalIn, totalOut, closing: opening + totalIn - totalOut
  };
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
    const fx = fxOf(inv);
    for (const l of inv.lines) {
      const cur = m.get(l.serviceId) ?? { sales: 0, cost: 0, count: 0 };
      cur.sales += Math.round(l.qty * l.unitPrice * fx);
      cur.cost += Math.round(l.qty * l.supplierCost * fx);
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
    rows.push({ date: b.date, ref: b.no, detail: 'Supplier bill', debit: 0, credit: billBase(b) });
  }
  for (const p of book.payments.filter((x) => x.supplierId === supplierId)) {
    rows.push({ date: p.date, ref: p.no, detail: `Payment — ${LABEL[p.method] ?? p.method}`, debit: p.amount, credit: 0 });
  }
  for (const c of (book.supplierCreditNotes ?? []).filter((x) => x.supplierId === supplierId)) {
    const bill = book.bills.find((b) => b.id === c.billId);
    const detail = `Supplier credit note — ${LABEL[c.reason] ?? c.reason}${bill ? ` on ${bill.no}` : ''}`;
    if (c.settlement === 'credit_balance') {
      rows.push({ date: c.date, ref: c.no, detail, debit: c.amount, credit: 0 });
    } else {
      // Credited then repaid to us: the debt comes down and the money arrives,
      // so the running balance ends where it started.
      rows.push({ date: c.date, ref: c.no, detail, debit: c.amount, credit: 0 });
      rows.push({ date: c.date, ref: c.no, detail: `Received back — ${LABEL[c.settlement] ?? c.settlement}`, debit: 0, credit: c.amount });
    }
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
  const supplierCredits = (book.supplierCreditNotes ?? []).reduce((t, c) => t + c.amount, 0);
  const purchases = book.bills.reduce((t, b) => t + billBase(b), 0) - supplierRefunds - supplierCredits;
  const opening = book.company.openingCash + book.banks.reduce((t, b) => t + b.openingBalance, 0);

  /**
   * Advances are an asset: money handed over that has not yet been consumed by
   * a bill. Cash and bank are now reduced when a deposit is placed, so this
   * debit is what keeps the two columns level.
   */
  const advances =
    (book.supplierDeposits ?? []).reduce((t, d) => t + d.amount, 0) -
    book.payments.filter((p) => p.method === 'supplier_deposit').reduce((t, p) => t + p.amount, 0);

  const debits = [
    { account: 'Cash in hand', amount: cash },
    { account: 'Bank accounts', amount: bank },
    { account: 'Advances to suppliers', amount: advances },
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
    ...(book.creditNotes ?? []).map((c) => c.date),
    ...(book.supplierCreditNotes ?? []).map((c) => c.date),
    ...(book.transfers ?? []).map((t) => t.date)
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
  for (const c of book.supplierCreditNotes ?? []) {
    rows.push({ date: c.date, type: 'Supplier credit', ref: c.no, party: sup(c.supplierId), amount: c.amount, direction: 'in' });
  }
  for (const t of book.transfers ?? []) {
    rows.push({
      date: t.date,
      type: t.direction === 'deposit' ? 'Bank deposit' : 'Bank withdrawal',
      ref: t.no,
      party: book.banks.find((b) => b.id === t.bankId)?.name ?? t.bankId,
      amount: t.amount,
      direction: t.direction === 'deposit' ? 'out' : 'in'
    });
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
  const deposits = book.supplierDeposits ?? [];

  const rows = book.suppliers.map((s) => {
    const paidIn = deposits.filter((d) => d.supplierId === s.id).reduce((t, d) => t + d.amount, 0);
    const billed = book.bills.filter((b) => b.supplierId === s.id).reduce((t, b) => t + billBase(b), 0);
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

/* ==========================================================================
   DOUBLE-ENTRY LAYER — journal, general ledger, balance sheet, cash flow
   ========================================================================== */

/**
 * Every voucher in the book, expressed as balanced journal lines.
 *
 * The rest of this file derives control-account totals directly from the
 * vouchers, which is fast and readable but cannot produce a general ledger, a
 * balance sheet or a cash flow statement — you need the individual postings for
 * those. This layer emits them.
 *
 * The two are deliberately kept as independent derivations of the same data
 * rather than one being built on the other, because that is what makes
 * `reconciliation()` below worth running: if a control total and the sum of the
 * journal lines for the same account ever disagree, one of the two has a bug,
 * and the page says so instead of quietly showing the wrong one.
 *
 * ACCOUNT CODES are stable strings, not display names, so renaming a bank or an
 * expense category cannot silently split an account in two.
 */

export type AccountGroup = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export type Account = { code: string; name: string; group: AccountGroup };

export type JournalLine = {
  date: string;
  /** Voucher number this posting came from. */
  ref: string;
  voucherType: string;
  account: string;
  debit: number;
  credit: number;
  narration: string;
  party: string;
};

export const AC = {
  CASH: 'CASH',
  AR: 'AR',
  AP: 'AP',
  VAT: 'VAT',
  ADVANCES: 'ADVANCES',
  EQUITY: 'EQUITY_OPENING',
  SALES: 'SALES',
  RETURNS: 'SALES_RETURNS',
  PURCHASES: 'PURCHASES',
  bank: (id: string) => `BANK:${id}`,
  expense: (id: string) => `EXP:${id}`
} as const;

/** The chart of accounts, built from the book so it always matches the data. */
export function chartOfAccounts(book: Book): Account[] {
  return [
    { code: AC.CASH, name: 'Cash in hand', group: 'asset' },
    ...book.banks.map((b): Account => ({ code: AC.bank(b.id), name: b.name, group: 'asset' })),
    { code: AC.AR, name: 'Accounts receivable', group: 'asset' },
    { code: AC.ADVANCES, name: 'Advances to suppliers', group: 'asset' },
    { code: AC.AP, name: 'Accounts payable', group: 'liability' },
    { code: AC.VAT, name: 'VAT payable', group: 'liability' },
    { code: AC.EQUITY, name: 'Opening balances', group: 'equity' },
    { code: AC.SALES, name: 'Sales revenue', group: 'income' },
    { code: AC.RETURNS, name: 'Credit notes and cancellations', group: 'income' },
    { code: AC.PURCHASES, name: 'Cost of sales — supplier bills', group: 'expense' },
    ...book.expenseCategories.map((c): Account => ({ code: AC.expense(c.id), name: c.name, group: 'expense' }))
  ];
}

export const accountName = (code: string, chart: Account[]) =>
  chart.find((a) => a.code === code)?.name ?? code;

export const accountGroup = (code: string, chart: Account[]): AccountGroup =>
  chart.find((a) => a.code === code)?.group ?? 'asset';

/**
 * Which asset account a voucher touched.
 *
 * `supplier_deposit` is a payment settled out of money already advanced to that
 * supplier, so no fresh cash leaves — it draws the advance down instead. That
 * is the other half of recording a deposit properly; without it, paying a bill
 * from a float you already funded would take the money out of the bank twice.
 */
function fundsAccount(method: string, bankId: string | null): string {
  if (method === 'supplier_deposit') return AC.ADVANCES;
  if (method === 'cash') return AC.CASH;
  return bankId ? AC.bank(bankId) : AC.CASH;
}

export function journal(book: Book): JournalLine[] {
  const lines: JournalLine[] = [];
  const cust = (id: string) => book.customers.find((c) => c.id === id)?.name ?? id;
  const sup = (id: string) => book.suppliers.find((s) => s.id === id)?.name ?? id;
  const notes = book.creditNotes ?? [];

  const post = (
    date: string, ref: string, voucherType: string, party: string, narration: string,
    entries: { account: string; debit?: number; credit?: number }[]
  ) => {
    for (const e of entries) {
      if (!e.debit && !e.credit) continue;
      lines.push({
        date, ref, voucherType, party, narration,
        account: e.account, debit: e.debit ?? 0, credit: e.credit ?? 0
      });
    }
  };

  /* --- opening balances ------------------------------------------------- */
  const openingDate = book.company.financialYearStart;
  const openingTotal = book.company.openingCash + book.banks.reduce((t, b) => t + b.openingBalance, 0);
  post(openingDate, 'OPENING', 'Opening', '', 'Opening balances brought forward', [
    { account: AC.CASH, debit: book.company.openingCash },
    ...book.banks.map((b) => ({ account: AC.bank(b.id), debit: b.openingBalance })),
    { account: AC.EQUITY, credit: openingTotal }
  ]);

  /* --- sales ------------------------------------------------------------ */
  for (const i of book.invoices.filter(isLive)) {
    const t = invoiceTotals(i, book.receipts);
    post(i.date, i.no, 'Invoice', cust(i.customerId), i.lines.map((l) => l.description).join(' / '), [
      { account: AC.AR, debit: t.total },
      { account: AC.SALES, credit: t.gross },
      { account: AC.VAT, credit: t.vat }
    ]);
  }

  for (const r of book.receipts) {
    post(r.date, r.no, 'Receipt', cust(r.customerId), `Received — ${LABEL[r.method] ?? r.method}`, [
      { account: fundsAccount(r.method, r.bankId), debit: r.amount },
      { account: AC.AR, credit: r.amount }
    ]);
  }

  /* --- credit notes ----------------------------------------------------- */
  for (const c of notes) {
    // Unsettled credit relieves the receivable; a refunded one takes the money
    // back out instead. Exactly one, which is the whole point of `settlement`.
    post(c.date, c.no, 'Credit note', cust(c.customerId), LABEL[c.reason] ?? c.reason, [
      { account: AC.RETURNS, debit: c.amount },
      isRefunded(c)
        ? { account: fundsAccount(c.settlement, c.bankId), credit: c.amount }
        : { account: AC.AR, credit: c.amount }
    ]);
    if (c.supplierRefund > 0) {
      post(c.date, c.no, 'Credit note', cust(c.customerId), 'Supplier refund on the cancelled booking', [
        { account: AC.AP, debit: c.supplierRefund },
        { account: AC.PURCHASES, credit: c.supplierRefund }
      ]);
    }
  }

  /* --- purchases -------------------------------------------------------- */
  for (const b of book.bills) {
    post(b.date, b.no, 'Supplier bill', sup(b.supplierId), b.notes, [
      { account: AC.PURCHASES, debit: billBase(b) },
      { account: AC.AP, credit: billBase(b) }
    ]);
  }

  for (const p of book.payments) {
    post(p.date, p.no, 'Supplier payment', sup(p.supplierId), `Paid — ${LABEL[p.method] ?? p.method}`, [
      { account: AC.AP, debit: p.amount },
      { account: fundsAccount(p.method, p.bankId), credit: p.amount }
    ]);
  }

  for (const c of book.supplierCreditNotes ?? []) {
    post(c.date, c.no, 'Supplier credit', sup(c.supplierId), LABEL[c.reason] ?? c.reason, [
      c.settlement === 'credit_balance'
        ? { account: AC.AP, debit: c.amount }
        : { account: fundsAccount(c.settlement, c.bankId), debit: c.amount },
      { account: AC.PURCHASES, credit: c.amount }
    ]);
  }

  /* --- expenses --------------------------------------------------------- */
  for (const e of book.expenses) {
    post(e.date, e.no, 'Expense', book.expenseCategories.find((c) => c.id === e.categoryId)?.name ?? '', e.description, [
      { account: AC.expense(e.categoryId), debit: e.amount },
      { account: fundsAccount(e.method, e.bankId), credit: e.amount }
    ]);
  }

  /* --- treasury --------------------------------------------------------- */
  for (const t of book.transfers ?? []) {
    const bankAc = AC.bank(t.bankId);
    const bankName = book.banks.find((b) => b.id === t.bankId)?.name ?? t.bankId;
    post(t.date, t.no, t.direction === 'deposit' ? 'Bank deposit' : 'Bank withdrawal', bankName, t.notes, [
      t.direction === 'deposit' ? { account: bankAc, debit: t.amount } : { account: AC.CASH, debit: t.amount },
      t.direction === 'deposit' ? { account: AC.CASH, credit: t.amount } : { account: bankAc, credit: t.amount }
    ]);
  }

  for (const d of book.supplierDeposits ?? []) {
    post(d.date, d.no, 'Supplier deposit', sup(d.supplierId), d.note, [
      { account: AC.ADVANCES, debit: d.amount },
      { account: fundsAccount(d.method, d.bankId), credit: d.amount }
    ]);
  }

  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
}

/** Balance of every account, with the running total for one if asked. */
export function generalLedger(book: Book, account?: string, from?: string, to?: string) {
  const chart = chartOfAccounts(book);
  const all = journal(book);
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);

  const balances = new Map<string, { debit: number; credit: number }>();
  for (const l of all.filter((x) => inRange(x.date))) {
    const cur = balances.get(l.account) ?? { debit: 0, credit: 0 };
    cur.debit += l.debit;
    cur.credit += l.credit;
    balances.set(l.account, cur);
  }

  /** Debit-natured groups carry a positive balance on the debit side. */
  const natural = (g: AccountGroup) => (g === 'asset' || g === 'expense' ? 1 : -1);

  const summary = chart
    .map((a) => {
      const b = balances.get(a.code) ?? { debit: 0, credit: 0 };
      return { account: a, debit: b.debit, credit: b.credit, balance: (b.debit - b.credit) * natural(a.group) };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);

  if (!account) return { chart, summary, rows: [], opening: 0, closing: 0, account: null };

  const sign = natural(accountGroup(account, chart));
  const opening = all
    .filter((l) => l.account === account && (from ? l.date < from : false))
    .reduce((t, l) => t + (l.debit - l.credit) * sign, 0);

  let running = opening;
  const rows = all
    .filter((l) => l.account === account && inRange(l.date))
    .map((l) => ({ ...l, balance: (running += (l.debit - l.credit) * sign) }));

  return { chart, summary, rows, opening, closing: running, account: chart.find((a) => a.code === account) ?? null };
}

/**
 * Trial balance built from the journal, as opposed to `trialBalance()` which is
 * built from the control accounts. Both must agree; `reconciliation()` checks.
 */
export function journalTrialBalance(book: Book, to?: string) {
  const { summary } = generalLedger(book, undefined, undefined, to);
  const rows = summary.map((r) => ({
    account: r.account,
    debit: Math.max(0, r.debit - r.credit),
    credit: Math.max(0, r.credit - r.debit)
  }));
  const totalDebit = rows.reduce((t, r) => t + r.debit, 0);
  const totalCredit = rows.reduce((t, r) => t + r.credit, 0);
  return { rows, totalDebit, totalCredit, difference: totalDebit - totalCredit };
}

/**
 * The two derivations, side by side.
 *
 * A difference is not cosmetic — it means a voucher is counted one way in the
 * dashboard tiles and another way in the ledger. Shown rather than assumed
 * away, on the same principle as the trial balance difference row.
 */
export function reconciliation(book: Book) {
  const gl = generalLedger(book);
  const bal = (code: string) => gl.summary.find((r) => r.account.code === code)?.balance ?? 0;
  const s = summarise(book);

  const checks = [
    { name: 'Cash in hand', control: cashBook(book).closing, ledger: bal(AC.CASH) },
    { name: 'Bank accounts', control: allBankBalances(book).total, ledger: book.banks.reduce((t, b) => t + bal(AC.bank(b.id)), 0) },
    { name: 'Accounts receivable', control: receivables(book).total, ledger: bal(AC.AR) },
    { name: 'Accounts payable', control: payables(book).total, ledger: bal(AC.AP) },
    {
      name: 'Sales revenue (net of credit notes)',
      control: s.sales,
      // RETURNS is contra-income: its natural sign already makes it negative, so
      // it is added. Subtracting took the credit notes off twice.
      ledger: bal(AC.SALES) + bal(AC.RETURNS)
    },
    { name: 'Operating expenses', control: s.expenses, ledger: book.expenseCategories.reduce((t, c) => t + bal(AC.expense(c.id)), 0) }
  ].map((c) => ({ ...c, difference: Math.round(c.control - c.ledger) }));

  return { checks, clean: checks.every((c) => c.difference === 0) };
}

/**
 * Balance sheet as at a date.
 *
 * Retained earnings is not stored anywhere; it is income less expenses out of
 * the same journal. That is what makes the two sides meet without a plug
 * figure — and if they ever do not, `difference` says so.
 */
export function balanceSheet(book: Book, asAt?: string) {
  const { summary } = generalLedger(book, undefined, undefined, asAt);
  const of = (g: AccountGroup) => summary.filter((r) => r.account.group === g);

  const assets = of('asset').map((r) => ({ name: r.account.name, amount: r.balance }));
  const liabilities = of('liability').map((r) => ({ name: r.account.name, amount: r.balance }));
  const income = of('income').reduce((t, r) => t + r.balance, 0);
  const expense = of('expense').reduce((t, r) => t + r.balance, 0);
  const retained = income - expense;
  const openingEquity = of('equity').reduce((t, r) => t + r.balance, 0);

  const equity = [
    { name: 'Opening balances', amount: openingEquity },
    { name: 'Retained earnings', amount: retained }
  ];

  const totalAssets = assets.reduce((t, r) => t + r.amount, 0);
  const totalLiabilities = liabilities.reduce((t, r) => t + r.amount, 0);
  const totalEquity = equity.reduce((t, r) => t + r.amount, 0);

  return {
    asAt: asAt ?? 'today',
    assets, liabilities, equity,
    totalAssets, totalLiabilities, totalEquity,
    difference: totalAssets - (totalLiabilities + totalEquity)
  };
}

/**
 * Cash flow, direct method, over cash and every bank account together.
 *
 * Direct rather than indirect because this book has no accruals to unwind — the
 * movements ARE the vouchers, so listing them is both simpler and more useful
 * to somebody asking where the money went.
 */
export function cashFlow(book: Book, from?: string, to?: string) {
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const funds = new Set<string>([AC.CASH, ...book.banks.map((b) => AC.bank(b.id))]);
  const all = journal(book);

  const openingBefore = all
    .filter((l) => funds.has(l.account) && (from ? l.date < from : false))
    .reduce((t, l) => t + l.debit - l.credit, 0);
  const opening = from ? openingBefore : book.company.openingCash + book.banks.reduce((t, b) => t + b.openingBalance, 0);

  const moved = all.filter((l) => funds.has(l.account) && inRange(l.date) && l.voucherType !== 'Opening');

  /**
   * A transfer moves money between two accounts that are both in this set, so
   * it nets to zero and must not appear as a flow. Banking the day's takings is
   * not cash generated.
   */
  const flows = moved.filter((l) => l.voucherType !== 'Bank deposit' && l.voucherType !== 'Bank withdrawal');

  const bucket = (types: string[]) =>
    flows.filter((l) => types.includes(l.voucherType)).reduce((t, l) => t + l.debit - l.credit, 0);

  const operating = [
    { name: 'Received from customers', amount: bucket(['Receipt']) },
    { name: 'Refunded to customers', amount: bucket(['Credit note']) },
    { name: 'Paid to suppliers', amount: bucket(['Supplier payment']) },
    { name: 'Received back from suppliers', amount: bucket(['Supplier credit']) },
    { name: 'Operating expenses paid', amount: bucket(['Expense']) }
  ];
  const investing = [{ name: 'Advances placed with suppliers', amount: bucket(['Supplier deposit']) }];

  const netOperating = operating.reduce((t, r) => t + r.amount, 0);
  const netInvesting = investing.reduce((t, r) => t + r.amount, 0);
  const movement = netOperating + netInvesting;

  return {
    opening,
    operating, netOperating,
    investing, netInvesting,
    movement,
    closing: opening + movement
  };
}

/**
 * Who to chase, in the order worth chasing them.
 *
 * Sorted by value at risk rather than by age. A 14-day-old invoice for six lakh
 * costs the agency more than a 90-day-old one for three thousand, and a chase
 * list ordered by age quietly buries the one that matters.
 *
 * Thresholds come from company.reminders so an agency can set its own terms
 * instead of arguing with a number somebody hard-coded.
 */
export function paymentReminders(book: Book, today = todayISO(book)) {
  const cfg = book.company.reminders ?? { dueAfterDays: 14, escalateAfterDays: 30, chaseFrom: 0 };
  const days = (from: string) => Math.round((Date.parse(today) - Date.parse(from)) / 86400000);

  const rows = receivables(book).rows
    .map(({ inv, t }) => {
      const age = days(inv.date);
      const stage =
        age >= cfg.escalateAfterDays ? 'escalate' : age >= cfg.dueAfterDays ? 'chase' : 'within_terms';
      const customer = book.customers.find((c) => c.id === inv.customerId);
      const lastPaid = book.receipts
        .filter((r) => r.invoiceId === inv.id)
        .map((r) => r.date)
        .sort()
        .pop();
      return { invoice: inv, totals: t, customer, age, stage, lastPaid: lastPaid ?? null };
    })
    .filter((r) => r.totals.due >= (cfg.chaseFrom ?? 0))
    .sort((a, b) => b.totals.due - a.totals.due || b.age - a.age);

  const of = (stage: string) => rows.filter((r) => r.stage === stage);

  /** Standard ageing buckets, because that is how a receivables review is run. */
  const buckets = [
    { label: 'Not yet due', min: 0, max: cfg.dueAfterDays - 1 },
    { label: `${cfg.dueAfterDays}–${cfg.escalateAfterDays - 1} days`, min: cfg.dueAfterDays, max: cfg.escalateAfterDays - 1 },
    { label: `${cfg.escalateAfterDays}–60 days`, min: cfg.escalateAfterDays, max: 60 },
    { label: '61–90 days', min: 61, max: 90 },
    { label: 'Over 90 days', min: 91, max: Number.MAX_SAFE_INTEGER }
  ].map((b) => {
    const hit = rows.filter((r) => r.age >= b.min && r.age <= b.max);
    return { ...b, count: hit.length, amount: hit.reduce((t, r) => t + r.totals.due, 0) };
  });

  return {
    rows,
    buckets,
    config: cfg,
    total: rows.reduce((t, r) => t + r.totals.due, 0),
    dueNow: of('chase').reduce((t, r) => t + r.totals.due, 0),
    overdue: of('escalate').reduce((t, r) => t + r.totals.due, 0),
    chaseCount: of('chase').length + of('escalate').length,
    escalateCount: of('escalate').length,
    /**
     * A reminder written out, ready to be copied into an email or WhatsApp.
     * Generated rather than sent: nothing on this machine is wired to a mail
     * server, and a system that claims to have sent something it did not is
     * worse than one that hands you the text.
     */
    message(row: (typeof rows)[number]) {
      const sym = book.company.currencySymbol;
      const refs = row.invoice.lines.map((l) => l.pnr).filter(Boolean).join(', ');
      const overdueBy = row.age - cfg.dueAfterDays;
      return [
        `Dear ${row.customer?.name ?? 'Customer'},`,
        '',
        `Invoice ${row.invoice.no} dated ${row.invoice.date}${refs ? ` (${refs})` : ''} shows ` +
          `${money(row.totals.due, sym)} outstanding of ${money(row.totals.total, sym)}.` +
          (row.totals.paid > 0 ? ` We have received ${money(row.totals.paid, sym)}, thank you.` : ''),
        '',
        row.stage === 'escalate'
          ? `This is now ${overdueBy} days past our ${cfg.dueAfterDays}-day terms. Please settle it or tell us when you can, so we can keep your account open.`
          : row.stage === 'chase'
            ? `Our terms are ${cfg.dueAfterDays} days, so this is now due. Please arrange payment at your convenience.`
            : `This is not yet due — it is a courtesy note ahead of the ${cfg.dueAfterDays}-day terms.`,
        '',
        `${book.company.name}`,
        `${book.company.phone} · ${book.company.email}`
      ].join('\n');
    }
  };
}
