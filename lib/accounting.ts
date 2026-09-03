// eslint-disable-next-line @typescript-eslint/no-var-requires -- shared with the zero-dependency admin portal
import { floatRows } from '@/lib/supplier-float.js';
import type { BankReconciliation, BankStatement } from '@/lib/bankrec';
import { chartAccounts, openingDate } from '@/lib/journal-rules.js';
import * as FY from '@/lib/financial-year.js';
import { adjustmentFor, controlAdjustments } from '@/lib/journals';
// Type-only, so the cycle with lib/journals.ts is erased at compile time rather than
// existing at runtime. The voucher type lives with its rules, not with the engine.
import type { JournalVoucher } from '@/lib/journals';
import { requireRead } from '@/lib/auth';
import path from 'node:path';
import { todayIn } from '@/lib/clock';
// Type only: the document sub-ledger derives FROM the book, so the runtime
// dependency runs one way and this import cannot become a cycle.
import { deferredIncome, memoPayable } from '@/lib/documents';
import { customerCredit, fxGain, reliefOn, settlements } from '@/lib/fx';
import type { CarrierContract } from '@/lib/contracts';
import type { TaxRule } from '@/lib/taxrules';
import type { TravelDocument } from '@/lib/documents';
import { readJsonRequired } from '@/lib/jsonStore';

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

export type Customer = {
  id: string; name: string; type: string; phone: string; email: string; address: string;
  openingBalance: number;
  /**
   * How much this customer may owe at once, in the book's currency.
   *
   * Absent or 0 means **no limit is enforced**, which is what every customer
   * written before this field existed has to mean — a default of "no credit"
   * would have stopped every agency on the book from buying anything on the day
   * it shipped. A limit is opted into per customer.
   */
  creditLimit?: number;
};
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
export type Currency = {
  id: string; name: string; code: string; symbol: string; rateToBase: number; isBase: number;
  /**
   * When a human last confirmed this rate. Blank means never.
   *
   * Documents freeze their own rate, so a stale master cannot restate anything
   * already raised — it can only misprice the NEXT foreign invoice, which is
   * exactly the failure the scheduled check watches for.
   */
  checkedOn?: string;
};
export type Employee = { id: string; name: string; role: string; phone: string };
/**
 * A counter, a desk, or the website. Where a sale was made.
 *
 * `kind` separates a physical office from the storefront, because "how much comes
 * from the website" is a different question from "how is Uttara doing", and an
 * owner asks both.
 */
export type Branch = { id: string; name: string; city: string; kind: 'office' | 'online'; note: string };

export type InvoiceLine = {
  serviceId: string; description: string; pnr: string; pax: number;
  qty: number; unitPrice: number; supplierCost: number; supplierId: string;
  /**
   * The airline document this line sells, when one has been recorded.
   *
   * Optional, and deliberately so. Every line written before the document table
   * existed has no id, every non-air line never will, and the money stays on the
   * line either way — `supplierCost` is still what posts. See lib/documents.ts for
   * why the link points this direction and what it unlocks.
   */
  documentId?: string | null;
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
  /**
   * Which branch sold it, and which consultant.
   *
   * On the INVOICE rather than only on the document, because margin is revenue less
   * cost and both live on the invoice line. Attribution that only reached air
   * tickets would leave a visa or a hotel sale belonging to nobody, and an agency's
   * counter staff sell all three.
   *
   * Both nullable and both silent when absent. Every invoice written before this
   * existed is unattributed, and the report says so rather than quietly assigning
   * them to whichever branch sorts first.
   */
  branchId?: string | null;
  consultantId?: string | null;
  attachments?: Attachment[];
};

export type Receipt = {
  id: string; no: string; date: string; customerId: string; invoiceId: string;
  method: PayMethod; bankId: string | null; amount: number; ref: string;
  /**
   * The currency and rate the settlement was made at.
   *
   * Both optional and both meaning "base currency" when absent, which is every
   * receipt written before this existed. They exist so an exchange gain can be told
   * apart from an overpayment at all — without the settlement rate, a receipt that
   * exceeds what its invoice was carrying is indistinguishable from a customer who
   * simply paid too much, and reading it as a gain would invent income. See lib/fx.ts.
   */
  currency?: string;
  fxRate?: number;
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
    /** IANA zone every calendar date in this book is stamped in. */
    timezone: string;
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
  /**
   * Airline documents — tickets, EMDs, memos.
   *
   * Optional because every book written before this table existed has no key, and
   * a missing key has to mean "none recorded" rather than crash a page. Nothing in
   * this collection posts to the journal; it is a sub-ledger the invoice lines
   * point at. See lib/documents.ts.
   */
  /** Offices and the storefront. Absent on a book written before attribution. */
  branches?: Branch[];
  /**
   * Carrier commission contracts. Empty until real ones are loaded — no rate is
   * ever invented, because a fabricated one puts money into the P&L.
   */
  contracts?: CarrierContract[];
  /**
   * Manual journal vouchers. See lib/journals.ts — including why they are allowed to
   * touch a control account and what that costs.
   */
  journalEntries?: JournalVoucher[];
  /**
   * Imported bank statements, one per account per period. See lib/bankrec.ts.
   *
   * The file as received is kept alongside the parsed lines. A parse can be wrong - a
   * column mapped the wrong way round, a date format guessed - and without the original
   * there is nothing to re-read it from. Storing only the parse would make a mis-import
   * permanent.
   */
  bankStatements?: BankStatement[];
  /**
   * Periods somebody signed off, with the difference that was true at the time.
   *
   * Everything else in this book is derived so it cannot go stale. A sign-off is the one
   * exception on purpose: it is a claim made at a moment, and keeping the number that was
   * true then is what lets the app notice a later edit silently invalidating it.
   */
  bankReconciliations?: BankReconciliation[];
  /**
   * Ledger accounts an accountant defines, on top of the ones derived from the data.
   *
   * The chart used to be derived in full: cash, one per bank, receivables, payables,
   * sales, purchases, one per expense category. That is complete for trading and has
   * nothing at all for accruals, prepayments, provisions, depreciation, retained
   * earnings or a suspense account — so a manual voucher would have had nowhere to
   * post. A derived chart cannot invent those, because only the accountant knows
   * which ones this agency keeps.
   */
  ledgerAccounts?: LedgerAccount[];
  /**
   * Tax rules with effective dates, replacing a single `vatRate`. Empty until real
   * ones are loaded — a stale rate baked into a shipped product is a wrong invoice
   * that looks authoritative.
   */
  taxRules?: TaxRule[];
  /**
   * Everything on or before this date is closed and refuses edits.
   *
   * Null or absent means nothing is locked, which is every book written before this
   * existed. A lock is opted into, one period at a time.
   */
  lockedThrough?: string | null;
  /**
   * Every year end that has been filed, oldest first, and never deleted.
   *
   * A close records what both derivations said at the moment it was filed, seals the period
   * and advances the year's name. It posts nothing. Reopening stamps the cut rather than
   * removing it, so "who reopened June, and what has moved since" is answerable from the book
   * itself — not only from audit-log.json, which a backup restore can overwrite.
   */
  closes?: YearEndClose[];
  documents?: TravelDocument[];
  inventory: InventoryItem[];
  airlines: Airline[];
  hotels: Hotel[];
  visaTypes: VisaType[];
  countries: Country[];
  currencies: Currency[];
};

const BOOK_FILE = path.join(process.cwd(), 'content', 'accounting.json');

/**
 * The book, or a clear error.
 *
 * This used to be a bare JSON.parse: a truncated file gave a raw parse error
 * with a stack trace and no hint at what to do about it. There is deliberately
 * no empty-book fallback — a dashboard of zeroes reads as "no trading yet",
 * which is the most misleading thing a set of accounts can say.
 */
export async function getBook(): Promise<Book> {
  requireRead();
  return getBookUnguarded();
}

/**
 * The same read with no session check. Only for callers that have authorised
 * themselves another way — today that is the /api routes, which middleware holds to
 * loopback. Named to be conspicuous in a diff. See requireRead in lib/auth.ts.
 */
export async function getBookUnguarded(): Promise<Book> {
  return readJsonRequired<Book>(BOOK_FILE, 'The accounting book');
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
  /** Cash received against this invoice. */
  paid: number;
  /**
   * What that cash relieved. Differs from paid whenever the settlement rate differs from
   * the rate the invoice was raised at — the gap is the exchange gain or loss, not a debt.
   */
  relieved: number;
  due: number;
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
  const mine = receipts.filter((r) => r.invoiceId === inv.id);
  /** Cash that arrived. This is what a customer is told we received, so it stays the cash. */
  const paid = mine.reduce((t, r) => t + r.amount, 0);
  const credited = creditOnInvoice(inv.id, creditNotes);
  const creditedAll = creditedTotal(inv.id, creditNotes);
  /**
   * What those receipts relieved, which stops being the cash the moment a rate moves.
   *
   * SFT-INV-0121: 3,000 USD raised at 123, carried at 369,000. FlyTrek paid all 3,000
   * dollars at 120, so 360,000 arrived and the debt was gone. Subtracting the cash left
   * 9,000 owing by a customer who owed nothing — it aged, it sat in Accounts receivable,
   * and it went on the reminders screen. The 9,000 was an exchange loss the agency had
   * taken, recorded as a receivable.
   *
   * The mirror case hid for the opposite reason. Paid at 124 the cash was 595,200 against
   * 588,000 carried, `total - credited - paid` came to -7,200, and Math.max(0, ...) turned
   * it into the right answer for the wrong reason. That floor is why nobody found this by
   * reading the code, and why the two-derivation check stayed silent: it compares two
   * numbers, and only one of them was being computed here.
   */
  const relieved = reliefOn(inv, mine, total - credited).relief;
  /**
   * The floor is kept for over-crediting, which is a real and separate case. It can no
   * longer swallow an exchange movement: allocate() caps relief at what the debt carries,
   * so this subtraction cannot go negative on a settlement however the rate moved.
   */
  const due = Math.max(0, total - credited - relieved);
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
    paid, relieved, due, credited, creditedAll, net, cancelled, effectiveStatus,
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
  if (!from && !to) return oncePerBook(book, 'summarise', () => summariseRange(book));
  return summariseRange(book, from, to);
}

function summariseRange(book: Book, from?: string, to?: string) {
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

  /**
   * Airline memos as a cost of the period they were raised in.
   *
   * Without this the memo posted to the ledger and never reached the profit
   * figure: a liability would appear on the balance sheet with no matching cost in
   * the P&L, and the two screens would quietly disagree. The balance sheet is
   * built from the ledger so it picked the memo up on its own; the P&L is derived
   * from vouchers, and a memo is not a voucher.
   *
   * Its own line rather than folded into operating expenses, for the same reason
   * it has its own liability account — it measures the agency's error rate, not
   * its office costs, and burying it beside the electricity bill hides exactly the
   * number worth watching. Keeping it out of `spent` also leaves the operating
   * expenses reconciliation row comparing the same two things it always did.
   */
  const memos = (book.documents ?? []).filter(
    (d) => (d.type === 'ADM' || d.type === 'ACM') && d.status !== 'void'
      && inRange(d.issueDate ?? d.travelDate ?? '')
  );
  const memoCost = Math.round(memos.reduce((t, d) => {
    const gross = d.baseFare === null ? 0 : d.baseFare + d.taxes.reduce((x, y) => x + y.amount, 0);
    return t + (d.type === 'ADM' ? gross : -gross);
  }, 0));

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
    memoCost,
    netProfit: sales - cost - spent - memoCost,
    billed: bills.reduce((t, b) => t + billBase(b), 0)
  };
}

/** Money customers still owe us, across the whole book. */
export function receivables(book: Book) {
  return oncePerBook(book, 'receivables', () => receivablesNow(book));
}

function receivablesNow(book: Book) {
  const rows = book.invoices
    .filter((i) => i.status !== 'draft')
    .map((i) => ({ inv: i, t: invoiceTotals(i, book.receipts, book.creditNotes ?? []) }))
    .filter((r) => !r.t.cancelled && r.t.due > 0);
  return { rows, total: rows.reduce((t, r) => t + r.t.due, 0) };
}

/** Money we still owe suppliers. */
export function payables(book: Book) {
  return oncePerBook(book, 'payables', () => payablesNow(book));
}

function payablesNow(book: Book) {
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
  if (!from && !to) return oncePerBook(book, 'cashBook', () => cashBookRange(book));
  return cashBookRange(book, from, to);
}

function cashBookRange(book: Book, from?: string, to?: string) {
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
  const build = () => {
    const rows = book.banks.map((b) => ({ bank: b, closing: bankBook(book, b.id, undefined, to).closing }));
    return { rows, total: rows.reduce((t, r) => t + r.closing, 0) };
  };
  return to ? build() : oncePerBook(book, 'allBankBalances', build);
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
    /**
     * Convert once per invoice per service, not once per line.
     *
     * invoiceTotals rounds the CONVERTED total, so rounding each line
     * separately here would let this report drift a rupee or two away from the
     * invoice it came from — two screens quoting different numbers for the same
     * sale, which is the kind of discrepancy nobody can explain later.
     */
    const fx = fxOf(inv);
    const perService = new Map<string, { salesDoc: number; costDoc: number; lines: number }>();
    for (const l of inv.lines) {
      const cur = perService.get(l.serviceId) ?? { salesDoc: 0, costDoc: 0, lines: 0 };
      cur.salesDoc += l.qty * l.unitPrice;
      cur.costDoc += l.qty * l.supplierCost;
      cur.lines += 1;
      perService.set(l.serviceId, cur);
    }
    for (const [serviceId, v] of perService) {
      const cur = m.get(serviceId) ?? { sales: 0, cost: 0, count: 0 };
      cur.sales += Math.round(v.salesDoc * fx);
      cur.cost += Math.round(v.costDoc * fx);
      cur.count += v.lines;
      m.set(serviceId, cur);
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

/**
 * Accounts whose balance the voucher-derived figures above ALREADY represent.
 *
 * Everything else in the income and expense groups is a journal-only account, and the
 * profit and loss has to pick it up separately — see the note in profitAndLoss.
 */
function voucherDerivedPl(book: Book): Set<string> {
  return new Set<string>([
    AC.SALES, AC.RETURNS, AC.PURCHASES, AC.MEMO_COST,
    ...book.expenseCategories.map((c) => AC.expense(c.id))
  ]);
}

/** Profit & loss for a window. */
export function profitAndLoss(book: Book, from?: string, to?: string) {
  /**
   * WITH NO RANGE THIS MEANS "SINCE THE LAST CLOSE", NOT "EVER".
   *
   * Until a year is closed, openYearStart() is null and this is the whole book exactly as it
   * always was. After one, a P&L with no dates that still counted last year's trading would
   * be reporting a profit the owner already took — which is the entire reason a year gets
   * closed. The screens say which period they are showing.
   *
   * Only the LOWER bound is supplied. An absent `to` still means today-and-after, because a
   * forward-dated voucher is a fact about the book and hiding it would be a different lie.
   *
   * summarise()'s memo is not range-keyed, so once a close exists this walks the vouchers
   * rather than reading the cache. That is the price of the boundary being real, and it is
   * paid once per render.
   */
  const opens = from ?? FY.openYearStart(book) ?? undefined;
  const s = summarise(book, opens, to);
  const byCat = expensesByCategory(book, opens, to);

  /**
   * Income and expense that exists ONLY in the journal.
   *
   * Every figure above this line is derived by walking vouchers — invoices, bills,
   * expense records. That was complete until manual journal vouchers arrived, and then
   * it silently stopped being: depreciation, an accrued rent, a bank charge and a cash
   * shortage all post to real expense accounts and NONE of them touch a voucher.
   *
   * The demo book showed the damage plainly. The journal carried 67,700 of such expenses
   * — 8,750 depreciation, 57,500 rent, 1,450 written off at the counter — and this
   * function reported a net profit that ignored every taka of it. Worse, the balance
   * sheet derives retained earnings FROM the journal, so the two statements disagreed
   * about profit by exactly that amount and neither said so.
   *
   * reconciliation() did not catch it either, and could not: it cross-checks ten control
   * accounts, and "does the P&L agree with the balance sheet" is a different question. It
   * is now asked directly — see plAgreesWithLedger below.
   *
   * Deliberately NOT folded into expenseRows. A journal adjustment and an expense voucher
   * are different kinds of fact — one was raised against a document, the other because
   * somebody decided it — and an accountant reading the P&L should be able to see which
   * is which without opening the ledger.
   */
  /**
   * For an account the voucher figures already cover, take ONLY its manual postings.
   *
   * The first version excluded those accounts outright, and that left a hole one layer
   * down: `expensesByCategory` walks `book.expenses`, so it represents the VOUCHER part
   * of an expense category and nothing else. A journal voucher posted to Government Fees
   * therefore reached the ledger and no part of the P&L at all — proved by planting one:
   * a 50,000 voucher moved `unexplained` on the bridge from 0 to exactly 50,000.
   *
   * So the split is by ORIGIN, not by account: voucher postings are covered by the rows
   * above, manual postings are listed here, and every income or expense account is
   * covered by exactly one of the two. Same rule applied to Sales, Credit notes,
   * Purchases and Memo cost, none of which `summarise()` sees a manual entry for either.
   */
  const derived = voucherDerivedPl(book);
  const manualOnly = (code: string) => {
    const sign = code === AC.SALES || code === AC.RETURNS ? -1 : 1;
    let net = 0;
    for (const v of book.journalEntries ?? []) {
      if (opens && v.date < opens) continue;
      if (to && v.date > to) continue;
      for (const l of v.lines) {
        if (l.account !== code) continue;
        net += (l.debit ?? 0) - (l.credit ?? 0);
      }
    }
    // Reported the way the ledger reports it: income is credit-natured, so a credit
    // RAISES its balance. Same flip as `naturalSign`.
    return Math.round(net * sign * 100) / 100;
  };

  const gl = generalLedger(book, undefined, opens, to).summary
    .filter((r) => r.account.group === 'income' || r.account.group === 'expense')
    .map((r) => ({
      account: r.account,
      balance: derived.has(r.account.code) ? manualOnly(r.account.code) : r.balance
    }))
    .filter((r) => Math.round(r.balance) !== 0);
  const journalIncome = gl.filter((r) => r.account.group === 'income').reduce((t, r) => t + r.balance, 0);
  const journalExpense = gl.filter((r) => r.account.group === 'expense').reduce((t, r) => t + r.balance, 0);
  const journalNet = journalIncome - journalExpense;

  const netProfit = s.netProfit + journalNet;

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
    /** Airline debit memos net of credit memos, shown on its own line. */
    memoCost: s.memoCost,
    /** Income and expense posted by journal voucher, listed rather than merged. */
    journalRows: gl,
    journalIncome,
    journalExpense,
    journalNet,
    /** What the voucher side alone said, kept so the two are comparable. */
    netProfitBeforeJournal: s.netProfit,
    netProfit,
    netMarginPct: s.sales > 0 ? (netProfit / s.sales) * 100 : 0
  };
}

/**
 * Does the profit and loss agree with the ledger it is supposed to summarise?
 *
 * A third cross-check, and it exists because the first two could not see this failure.
 * reconciliation() compares ten control accounts; the trial balances each prove internal
 * consistency of one derivation. None of them asks whether the P&L's bottom line matches
 * income-less-expense in the journal — and for a while it did not, by 67,700, with both
 * statements looking perfectly healthy.
 *
 * A difference here is NOT necessarily a defect: cost of sales is what was sold while
 * PURCHASES is everything billed, so unsold stock legitimately separates them until an
 * inventory asset exists to hold it. The number is reported with that stated rather than
 * asserted to be zero, because a check that fails for a known reason gets ignored, and an
 * ignored check is worse than none.
 */
export function plAgreesWithLedger(book: Book, from?: string, to?: string) {
  // The same bound the P&L just applied, or the bridge would compare a closed-year ledger
  // against an open-year P&L and report the closed year's profit as unexplained.
  const opens = from ?? FY.openYearStart(book) ?? undefined;
  const pl = profitAndLoss(book, opens, to);
  const gl = generalLedger(book, undefined, opens, to).summary;
  const bal = (g: AccountGroup) =>
    gl.filter((r) => r.account.group === g).reduce((t, r) => t + r.balance, 0);
  const ledgerProfit = bal('income') - bal('expense');
  const difference = Math.round(pl.netProfit - ledgerProfit);

  /**
   * NO LONGER AN EXPLANATORY BUCKET. See the note below.
   *
   * The part of the gap that supplier cost on unbilled work used to explain.
   *
   * WHAT THIS ACTUALLY IS, HAVING BEEN WRONG ABOUT IT ONCE
   *
   * The first version of this called the gap "supplier bills posted to PURCHASES for
   * stock not yet sold" and pointed at the inventory table. That was a guess and it was
   * wrong: `book.inventory` never touches a bill or a posting, so its 15,479,400 of
   * unsold blocks cannot contribute a taka.
   *
   * The real cause, checked against the book: a supplier bill debits PURCHASES on its own
   * date, unconditionally. `summarise()` builds cost of sales from LIVE invoices only —
   * `isLive` excludes draft and cancelled — so a booking whose customer invoice is still
   * a draft has its supplier cost in the ledger and correctly out of the P&L. Five draft
   * invoices on the demo book carry exactly 867,000 of supplier bills, which is the gap
   * to the taka.
   *
   * The P&L is the side that is right: matching says the cost of an unsold booking is not
   * yet a cost. What is missing is an ASSET to hold it until the invoice goes live —
   * work in progress, unbilled supplier cost, whatever an agency calls it. The chart has
   * no such account, so the ledger expenses it and retained earnings on the balance sheet
   * is understated by the same amount.
   *
   * Note the balance sheet still closes to a difference of zero, because the missing
   * asset and the understated equity move together. Balancing proves nothing here, which
   * is exactly why this check exists separately.
   */
  /**
   * Kept only to report, never to excuse.
   *
   * This used to be subtracted from the difference and the remainder called "unexplained",
   * which made the check answer a weaker question than the one it was named for: an
   * explanatory bucket is somewhere a real misstatement can sit and still read clean. Now
   * that supplier bills on unissued invoices are capitalised at source, there is nothing
   * legitimate left to explain, so the check asserts the difference itself is zero.
   */
  const unbilledOnPurchases = Math.round(
    (gl.find((r) => r.account.code === AC.PURCHASES)?.balance ?? 0) - summarise(book, opens, to).cost
  );

  /**
   * Which bills are behind it, by name.
   *
   * A number nobody can trace is a number nobody acts on. This lists the invoices whose
   * supplier cost is sitting in the ledger and out of the P&L, so the reader can open one
   * and either finalise it or find out why it never was.
   */
  const gl2 = generalLedger(book, undefined, opens, to).summary;
  const notLive = new Set(book.invoices.filter((i) => i.status === 'draft').map((i) => i.no.replace(/^.*?INV-/, 'INV-')));
  const stranded = book.bills.filter((b) => notLive.has(b.invoiceRef));
  const strandedTotal = Math.round(stranded.reduce((t, b) => t + billBase(b), 0));

  return {
    plNetProfit: Math.round(pl.netProfit),
    ledgerProfit: Math.round(ledgerProfit),
    difference,
    /** Supplier cost still sitting in PURCHASES that cost of sales does not recognise. Should be 0. */
    unbilledOnPurchases,
    /** What is capitalised right now, and against which drafts. */
    wipTotal: Math.round(gl2.find((r) => r.account.code === AC.WIP)?.balance ?? 0),
    wipBills: stranded.map((b) => ({ no: b.no, invoiceRef: b.invoiceRef, amount: billBase(b) })),
    /**
     * The difference IS the unexplained amount now. There is no bucket to net against it,
     * which is the point: the check answers the question it is named for.
     */
    unexplained: difference,
    ok: difference === 0,
    detail:
      difference === 0
        ? `The P&L bottom line is exactly income less expense in the ledger. ${Math.round(gl2.find((r) => r.account.code === AC.WIP)?.balance ?? 0)} of supplier cost is capitalised against invoices still in draft, and moves to cost of sales by itself when they are issued.`
        : `The P&L and the ledger differ by ${difference}, and nothing accounts for it. ${unbilledOnPurchases} of supplier cost is in PURCHASES that cost of sales does not recognise — if that figure is not zero, a bill is expensed whose invoice is not live.`
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

  /**
   * A settlement that is not a plain relief lands on the credit side.
   *
   * The bank has more in it than receivables gave up, and the difference has to be
   * somewhere or the two columns cannot level. It is an exchange gain when the rate
   * moved and a liability when the customer paid too much — and leaving both out is
   * what put this trial balance 7,200 out the first time a foreign receipt was
   * recorded, while the journal basis stayed level because it had the accounts.
   *
   * A memo is on the debit side for the same reason: MEMO_COST is a cost the journal
   * carries and the vouchers do not, so the control basis needs it stated too.
   */
  const exchange = fxGain(book).total;
  const held = customerCredit(book).total;
  const memos = memoPayable(book).total;

  const debits = [
    { account: 'Cash in hand', amount: cash },
    { account: 'Bank accounts', amount: bank },
    { account: 'Advances to suppliers', amount: advances },
    { account: 'Accounts receivable', amount: ar },
    { account: 'Purchases (supplier bills, net of refunds)', amount: purchases },
    { account: 'Operating expenses', amount: s.expenses },
    ...(memos !== 0 ? [{ account: 'Airline debit memos', amount: memos }] : [])
  ];
  const credits = [
    { account: 'Accounts payable', amount: ap },
    { account: 'Sales revenue (net of credit notes)', amount: s.sales },
    ...(exchange !== 0 ? [{ account: 'Exchange gain / (loss)', amount: exchange }] : []),
    ...(held !== 0 ? [{ account: 'Customer credit balances', amount: held }] : []),
    ...(memos !== 0 ? [{ account: 'Airline memos payable', amount: memos }] : []),
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

/**
 * Today. The actual calendar date, in the company's own timezone.
 *
 * WHAT THIS USED TO BE, AND WHY IT WAS WRONG
 *
 * It returned the LATEST date on any invoice or receipt — the newest voucher, treated as
 * "now". Nothing recorded why, and it produced two different todays inside one product:
 * this one, and `clock.todayIn(zone())` in admin/jobs.js which the scheduled alerts use.
 *
 * On the demo book at the moment of the fix, the newest voucher was 2026-08-12 and the
 * real date was 2026-08-31 — nineteen days apart — and the two halves said:
 *
 *   the Reminders screen   10 invoices past 30 days,  1,812,380 outstanding
 *   the Overdue alert job  21 invoices past 30 days,  3,466,980 outstanding
 *
 * Same book, same instant, and the screen an agency phones people from was the one
 * missing eleven customers.
 *
 * It also made the whole book's age depend on its newest row. One invoice with a mistyped
 * year moves "today" forward by months: every open invoice becomes overdue, deferred
 * income collapses to nothing because every travel date is in the past, and
 * `reconciliation()` stays clean throughout — because both sides of its as-at check are
 * bounded by the same poisoned date. A cross-check cannot catch a bad clock it shares.
 *
 * WHAT IT COSTS, SAID PLAINLY
 *
 * A demo book seeded in the past now looks its age: figures that were dated to the last
 * voucher move to real today, so more of it reads as overdue and less as deferred. That is
 * the correct answer, and the old behaviour was flattering rather than right.
 */
export const todayISO = (book: Book) => todayIn(book.company.timezone);

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

  /**
   * Delegated to the shared file, not computed here.
   *
   * This used to net unpaid bills off the advance — `deposited - max(0, billed - settled)`
   * — while the portal's drawdown validator used `placed - drawn`. The two were 3,179,600
   * apart on the live book, and the screen's version moved the WRONG WAY when the float
   * was spent, because `settled` counted the drawdown itself. See lib/supplier-float.js
   * for the whole account of it. One definition now, in one place, imported by both.
   */
  const rows = floatRows(book, billBase) as {
    supplier: Supplier; deposited: number; drawn: number; available: number;
    billed: number; settled: number; outstandingBills: number; depositCount: number;
  }[];

  return {
    rows: rows.sort((a, b) => b.deposited - a.deposited),
    deposits: [...deposits].sort((a, b) => b.date.localeCompare(a.date)),
    totalDeposited: rows.reduce((t, r) => t + r.deposited, 0),
    totalDrawn: rows.reduce((t, r) => t + r.drawn, 0),
    totalAvailable: rows.reduce((t, r) => t + r.available, 0),
    /** What is still owed on bills. Reported beside the float, never netted into it. */
    totalOutstanding: rows.reduce((t, r) => t + r.outstandingBills, 0)
  };
}

/**
 * Blocks bought up front — Hajj seats, room nights, group fares, visa quota.
 * Unsold units are cash sitting on a shelf with an expiry date on it, which is
 * the whole reason a travel agency needs stock control at all.
 */
export function inventory(book: Book, today?: string) {
  today = today ?? todayIn(book.company.timezone);
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

  /**
   * How much of the committed cost the LEDGER knows about.
   *
   * Nothing links a supplier bill to a stock block — no bill carries an inventoryId — so
   * today this is zero for the whole register, and that is the point of reporting it rather
   * than leaving it to be inferred.
   *
   * WHY IT MATTERS MORE THAN IT LOOKS
   *
   * The screen showed "Committed to stock ৳2.58 cr" and "Unsold at cost ৳1.55 cr" beside a
   * balance sheet whose total assets are ৳2.39 cr, and said nothing about the relationship.
   * An owner reading both pages would reasonably take the stock to be inside the assets. It
   * is not in them, not in Accounts payable, and not in cost of sales: the register is a
   * parallel record of the same trade, kept by hand.
   *
   * Written as a filter over a field bills do not have yet, deliberately, so the disclosure
   * shrinks on its own the day the link exists instead of having to be remembered.
   */
  const billedToStock = book.bills
    .filter((b) => Boolean((b as { inventoryId?: string }).inventoryId))
    .reduce((t, b) => t + Math.round(b.amount * (Number(b.fxRate) || 1)), 0);
  const committed = rows.reduce((t, r) => t + r.costCommitted, 0);

  return {
    rows: rows.sort((a, b) => b.valueAtRisk - a.valueAtRisk),
    totalCommitted: committed,
    /** Committed cost traceable to a supplier bill. */
    postedToLedger: billedToStock,
    /** Committed cost the accounts have never seen. */
    unpostedToLedger: Math.max(0, committed - billedToStock),
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

/**
 * An account the accountant added, as opposed to one derived from the data.
 *
 * `code` is theirs to choose so it can match the chart they already use — an agency
 * migrating off another system should not have to relearn its own account numbers.
 * It is prefixed on the way into the journal (see AC.user) so a hand-typed code can
 * never collide with a derived one such as `BANK:b1` or `AR`.
 */
export type LedgerAccount = { id: string; code: string; name: string; group: AccountGroup; note?: string };

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
  DEFERRED: 'DEFERRED_INCOME',
  MEMOS: 'MEMO_PAYABLE',
  MEMO_COST: 'MEMO_COST',
  FX: 'FX_GAIN',
  CUSTOMER_CREDIT: 'CUSTOMER_CREDIT',
  ADVANCES: 'ADVANCES',
  EQUITY: 'EQUITY_OPENING',
  SALES: 'SALES',
  RETURNS: 'SALES_RETURNS',
  PURCHASES: 'PURCHASES',
  /**
   * Supplier cost on a booking whose customer invoice has not been issued yet.
   *
   * An asset, not a cost, and the distinction is the whole point. A bill arrives when the
   * consolidator invoices us, which is often before the agency raises its own invoice to
   * the customer. Until that happens the money bought something the agency still holds —
   * a seat it will sell — and matching says it is not a cost of anything yet.
   */
  WIP: 'WIP_SUPPLIER_COST',
  bank: (id: string) => `BANK:${id}`,
  expense: (id: string) => `EXP:${id}`,
  /**
   * Namespaced, so an accountant typing `AR` or `CASH` as their own account code
   * cannot silently merge their account into a control account and take the
   * reconciliation with it.
   */
  user: (code: string) => `GL:${code}`
} as const;

/** The chart of accounts, built from the book so it always matches the data. */
export function chartOfAccounts(book: Book): Account[] {
  const hit = chartCache.get(book);
  if (hit) return hit;
  const built = buildChart(book);
  chartCache.set(book, built);
  return built;
}

function buildChart(book: Book): Account[] {
  /**
   * Delegated, not duplicated.
   *
   * The admin portal validates a journal voucher against "is this account in the
   * chart", and it cannot run TypeScript — so the list has to exist in plain JS. Two
   * copies would agree on the day they were written and not for long after, and the
   * failure mode is the portal offering an account this side does not know, which
   * renders as a raw code on the ledger and reconciles against nothing.
   *
   * The "why this account exists" notes stay here, beside the code that reads them:
   *
   *   DEFERRED   Money billed for travel that has not happened yet. A liability, not
   *              income — the agency has been paid to carry somebody in October and
   *              until October it owes them the trip. For an agency selling Hajj a
   *              year ahead, recognising it early puts most of the reported profit in
   *              the wrong year.
   *   MEMOS      Airline memos, held apart from ordinary payables. They settle through
   *              BSP alongside tickets so they could sit in AP, but the control side of
   *              AP is derived from supplier BILLS — posting memos there would break the
   *              reconciliation. An agency also wants memos visible separately, because
   *              that number measures its own error rate rather than its trading.
   *   FX         One account, not two. A gain and a loss are the same movement in
   *              opposite directions, and splitting them makes a month with both report
   *              two figures that have to be netted by hand to answer the only question
   *              anybody asks.
   *   CUSTOMER_CREDIT
   *              Money received beyond what an invoice carried. Not negative
   *              receivables: a customer who overpays is owed the difference, so it is a
   *              liability. Letting it sit as a negative asset is exactly what made the
   *              two derivations disagree, because the control side floors the amount
   *              due at zero and the ledger did not.
   */
  return chartAccounts(book) as Account[];
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

/**
 * One journal per book object, not per call.
 *
 * `journal()` walks every voucher in the book. The financials page alone used to
 * trigger it five times — balanceSheet, cashFlow, journalTrialBalance and
 * reconciliation each reach it through generalLedger — which put the accounting
 * pages at 2 to 4.3 seconds on 613 vouchers. A year of real trading is roughly
 * twelve times that.
 *
 * Keyed on the book OBJECT in a WeakMap, so there is no staleness to reason
 * about: `getBook()` re-reads and re-parses the file on every request, giving a
 * fresh object each time, and the cache only ever collapses repeated work
 * inside a single request. Nothing has to be invalidated when the file changes,
 * because the object that changed is already gone.
 */
const journalCache = new WeakMap<Book, JournalLine[]>();
const chartCache = new WeakMap<Book, Account[]>();

/**
 * The control-account derivations, cached the same way.
 *
 * Memoising the journal alone left the financials page at 1.1 seconds, because
 * `reconciliation()` also pulls the OTHER derivation — and `allBankBalances`
 * runs a full scan of every voucher once per bank account. Between them a single
 * page render walked the book more than a dozen times.
 *
 * Only the WHOLE-BOOK forms are cached. Anything with a date range is left
 * alone: caching those would need the range in the key and they are called once
 * or twice per page, so there is nothing to win and a stale-key bug to lose.
 */
const wholeBookCache = new WeakMap<Book, Map<string, unknown>>();

function oncePerBook<T>(book: Book, key: string, compute: () => T): T {
  let slot = wholeBookCache.get(book);
  if (!slot) {
    slot = new Map();
    wholeBookCache.set(book, slot);
  }
  if (slot.has(key)) return slot.get(key) as T;
  const value = compute();
  slot.set(key, value);
  return value;
}

export function journal(book: Book): JournalLine[] {
  const hit = journalCache.get(book);
  if (hit) return hit;
  const built = buildJournal(book);
  journalCache.set(book, built);
  return built;
}

function buildJournal(book: Book): JournalLine[] {
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
  /**
   * Brought forward BEFORE anything it is meant to fund.
   *
   * This was dated at the financial year start and nothing else was. The book opens on
   * 2026-07-01, and 176 of its documents — invoices, receipts, bills, payments, expenses,
   * supplier deposits and transfers — are dated in the June before it, because the data
   * straddles a year end that was never closed. The journal therefore spent a fortnight
   * spending money it had not yet been given:
   *
   *   general ledger as at 2026-06-30    Cash -81,320    Dutch-Bangla -62,23,400
   *
   * Every date-ranged report to a June cut-off showed the agency overdrawn by sixty-two
   * lakh and holding no equity. The full-book totals were right, which is why nothing
   * caught it: the opening posting was present, just late, so by 31 July everything added
   * up again and only a report that stopped in between could see it.
   *
   * The suite could not see it either. "No cash or bank account ever goes negative" walks
   * the records forward from bank.openingBalance and never reads the journal, so it was
   * checking the one derivation that was right.
   *
   * The financial year start is still what the year is called. It is not what the book
   * begins on, and using it as though it were is what put the opening balance a fortnight
   * late. A real year-end close — carrying June out and bringing it in as an opening
   * position — is still missing and is tracked as such; this makes the arithmetic honest
   * in the meantime rather than pretending the June data is not there.
   */
  // One definition, shared with the rule that refuses a voucher before it — see openingDate
  // in lib/journal-rules.js. Computed here as well, the two would agree today and drift later,
  // and the drift would be a voucher the portal accepts and the journal posts before the
  // money exists.
  const opening = openingDate(book) ?? book.company.financialYearStart;
  const openingTotal = book.company.openingCash + book.banks.reduce((t, b) => t + b.openingBalance, 0);
  post(opening, 'OPENING', 'Opening', '', 'Opening balances brought forward', [
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

  /* --- airline memos ------------------------------------------------------ */
  /**
   * ADM and ACM, the first documents that move money.
   *
   * An Agency Debit Memo is the airline reaching back into a settled sale and
   * taking more — a fare it says was underpriced, a commission it says was not
   * earned, a tax it says was short. It is a real cost and a real liability, and
   * until now it could only be typed in as an expense with a note, at which point
   * it stops being attributable to a ticket, a carrier or a route.
   *
   * Held in MEMO_PAYABLE rather than in Accounts payable. The control side of AP is
   * derived from supplier BILLS, so posting here would have required that
   * derivation to grow a second source; and an agency wants the memo total on its
   * own, because it measures the agency's own error rate rather than its trading.
   *
   * An ACM is the same movement reversed — the airline giving some back, usually
   * after a dispute — so the pair uses one account and one cost line rather than
   * two of each. A memo that was successfully disputed is `void` and posts nothing,
   * which is why the liability goes DOWN when somebody wins an argument.
   *
   * Dated on `issueDate`, falling back to the travel date, because a memo raised in
   * September against an August ticket is a September cost.
   */
  for (const d of book.documents ?? []) {
    if (d.type !== 'ADM' && d.type !== 'ACM') continue;
    if (d.status === 'void') continue;
    const gross = d.baseFare === null ? 0 : Math.round(d.baseFare + d.taxes.reduce((t, x) => t + x.amount, 0));
    if (gross <= 0) continue;
    const when = d.issueDate ?? d.travelDate ?? book.company.financialYearStart;
    const against = d.againstDocumentNo ? ` against ${d.againstDocumentNo}` : '';
    const label = d.type === 'ADM' ? 'Debit memo' : 'Credit memo';
    post(when, d.documentNo ?? d.id, label, d.platingCarrier || 'Airline',
      `${d.reason || label}${against}`,
      d.type === 'ADM'
        ? [{ account: AC.MEMO_COST, debit: gross }, { account: AC.MEMOS, credit: gross }]
        : [{ account: AC.MEMOS, debit: gross }, { account: AC.MEMO_COST, credit: gross }]);
  }

  /* --- revenue deferred to the travel date ------------------------------- */
  /**
   * A ticket sold in June for an October flight is cash in June and revenue in
   * October. Until now both landed in June, which overstated June and left
   * October looking empty — and for an agency selling Hajj a year ahead, that is
   * most of the reported profit sitting in the wrong year.
   *
   * WHY THIS IS AN EXTRA PAIR RATHER THAN A CHANGE TO THE INVOICE POSTING
   *
   * The obvious implementation is to credit DEFERRED instead of SALES above and
   * credit SALES on the travel date. It works, and it means touching the one
   * posting every other figure in the book already depends on.
   *
   * This instead leaves that posting exactly as it was and adds its own pair: the
   * revenue is moved OUT on the invoice date and back IN on the travel date. Two
   * consequences worth the slight redundancy.
   *
   *   Over the whole book the pair nets to zero, so the control-versus-ledger
   *   reconciliation is arithmetically unchanged. Step 2 cannot break the check
   *   that would catch step 2 being wrong.
   *
   *   Any view bounded to a date sees the reversal but not yet the recognition,
   *   which is the deferral — emerging from the dates themselves rather than from
   *   a conditional that has to be kept in step with a calendar.
   *
   * Only lines whose document carries a travel date later than the invoice date
   * are deferred. The 60 migrated documents have no travel date and are untouched,
   * as is every non-air sale.
   */
  const docsById = new Map((book.documents ?? []).map((d) => [d.id, d]));
  for (const i of book.invoices.filter(isLive)) {
    for (const line of i.lines) {
      const doc = line.documentId ? docsById.get(line.documentId) : undefined;
      if (!doc?.travelDate || doc.travelDate <= i.date) continue;
      const value = Math.round(line.unitPrice * line.qty);
      if (value <= 0) continue;

      post(i.date, i.no, 'Deferral', cust(i.customerId),
        `Billed for travel on ${doc.travelDate} — held until flown`, [
          { account: AC.SALES, debit: value },
          { account: AC.DEFERRED, credit: value }
        ]);

      post(doc.travelDate, i.no, 'Recognition', cust(i.customerId),
        `Flown ${doc.travelDate} — earned`, [
          { account: AC.DEFERRED, debit: value },
          { account: AC.SALES, credit: value }
        ]);
    }
  }

  /**
   * A receipt relieves receivables by what receivables is CARRYING, not by the cash
   * that arrived.
   *
   * This posted `Cr AR` for the whole receipt while the control side floored the
   * amount due at zero, so the two agreed only until a receipt exceeded its
   * invoice. It did not — until it was tested, and then accounts receivable came
   * out 7,200 apart and the control-basis trial balance with it.
   *
   * The excess splits two ways and they are not the same thing. If the rate moved,
   * it is an exchange gain and belongs in income. If the customer simply paid too
   * much, the agency owes it back and it belongs in a liability. `allocate` in
   * lib/fx.ts decides, and the control-side derivations call the same function —
   * which is the actual fix, because two answers to "how much did this relieve" is
   * what caused the defect.
   */
  const allocations = new Map(settlements(book).map((s) => [s.receipt.id, s.alloc]));
  for (const r of book.receipts) {
    const a = allocations.get(r.id);
    const relief = a ? a.relief : r.amount;
    const fxPart = a ? a.fx : 0;
    const overpaid = a ? a.overpaid : 0;
    post(r.date, r.no, 'Receipt', cust(r.customerId), `Received — ${LABEL[r.method] ?? r.method}`, [
      { account: fundsAccount(r.method, r.bankId), debit: r.amount },
      { account: AC.AR, credit: relief },
      ...(fxPart > 0 ? [{ account: AC.FX, credit: fxPart }] : []),
      ...(fxPart < 0 ? [{ account: AC.FX, debit: -fxPart }] : []),
      ...(overpaid !== 0 ? [{ account: AC.CUSTOMER_CREDIT, credit: overpaid }] : [])
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
  /**
   * Which side of the fence a supplier bill lands on, decided by the invoice it belongs to.
   *
   * WHY THIS IS DERIVED AND NOT ADJUSTED
   *
   * Every supplier bill used to debit PURCHASES unconditionally, while cost of sales is
   * built from LIVE invoices only. A booking whose customer invoice was still a draft
   * therefore had its cost in the ledger and correctly out of the P&L, and the difference
   * — 867,000 across five drafts on this book — sat nowhere. Retained earnings on the
   * balance sheet was understated by exactly that, and the balance sheet still closed to
   * zero, because the missing asset and the understated equity moved together.
   *
   * The obvious repair is a period-end journal voucher moving the balance. It was
   * considered and rejected: a voucher can be posted twice, and posting it twice takes
   * the difference to MINUS 867,000 with every check still reading clean, because the
   * credit leg lands back on PURCHASES where the P&L's journal sweep cannot see it. A
   * correction that can be applied twice is not a correction.
   *
   * Deriving it instead means there is nothing to post and nothing to post twice. When a
   * draft invoice is finalised the bill moves from the asset to cost of sales on its own,
   * on the date it should, with no entry and no chance of forgetting.
   *
   * WHAT IS DELIBERATELY NOT CAPITALISED
   *
   * Only 'draft'. A CANCELLED booking's supplier cost is a loss, not an asset — the sale
   * is off and the agency is holding nothing. A bill whose invoiceRef names no invoice, or
   * carries none at all, goes to cost of sales as well: the asset is a claim that the
   * money bought something still sellable, and an unlinked bill offers no evidence of
   * that. Both fall to the expensing side on purpose, because the failure that matters is
   * cost hidden in an asset, not an asset shown as cost.
   */
  const invoiceStatusByRef = new Map(book.invoices.map((i) => [i.no.replace(/^.*?INV-/, 'INV-'), i.status]));
  for (const b of book.bills) {
    const status = invoiceStatusByRef.get(b.invoiceRef);
    const notYetSold = status === 'draft';
    post(b.date, b.no, 'Supplier bill', sup(b.supplierId), b.notes, [
      { account: notYetSold ? AC.WIP : AC.PURCHASES, debit: billBase(b) },
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

  /* --- manual journal vouchers ------------------------------------------ */

  /**
   * Posted verbatim, and last.
   *
   * Verbatim because there is nothing to derive: unlike every voucher type above,
   * a journal voucher IS the double entry rather than a business document that
   * implies one. The only rule is the one enforced before it was written — debits
   * equal credits — and re-deriving anything here would be inventing a second
   * opinion about a number the accountant already stated.
   *
   * Last only so the sort below has a stable tie-break by reference within a date;
   * `JV` sorting after the trading vouchers keeps a day's ledger reading in the
   * order the work actually happened, with adjustments at the end of the day.
   */
  for (const v of book.journalEntries ?? []) {
    post(v.date, v.no, 'Journal', '', v.narration,
      v.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit })));
  }

  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
}

/** Balance of every account, with the running total for one if asked. */
export function generalLedger(book: Book, account?: string, from?: string, to?: string) {
  const chart = chartOfAccounts(book);
  const all = journal(book);
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);

  // The whole-book summary is asked for by four different callers on one page.
  const summaryKey = `glSummary:${from ?? ''}:${to ?? ''}`;
  const balances = oncePerBook(book, summaryKey, () => buildBalances(all, inRange, from));

  if (!account) {
    const summary = summariseBalances(chart, balances);
    return { chart, summary, rows: [], opening: 0, closing: 0, account: null };
  }
  return ledgerCard(book, chart, all, balances, account, from, to);
}

type Balances = Map<string, { debit: number; credit: number; openingDebit: number; openingCredit: number }>;

/** Debit-natured groups carry a positive balance on the debit side. */
const naturalSign = (g: AccountGroup) => (g === 'asset' || g === 'expense' ? 1 : -1);

/**
 * One pass over the postings, totalled per account — and separately, what the account had
 * already done BEFORE the window opened.
 *
 * WHY A BOUNDED LEDGER NEEDED A BROUGHT-FORWARD AT ALL
 *
 * This dropped every line before `from` and reported what was left as the account's balance.
 * For an income or expense account that is right and is the whole point: a year's sales are
 * that year's sales. For cash it is nonsense. Asked for the ledger from 2026-07-01 the book
 * said:
 *
 *   Cash                    -8,11,350
 *   Dutch-Bangla Bank      -97,76,324
 *   Opening equity          (not on the report at all)
 *
 * Those are July's MOVEMENTS wearing the word Balance. The agency did not spend ninety-seven
 * lakh it did not have; it started the window holding it. The opening entry is dated
 * 2026-06-13, so a window opening on 1 July dropped that too and the report carried no equity
 * whatsoever while still calling itself a ledger.
 *
 * The distinction is the oldest one in the subject, and it is the same distinction a year-end
 * close is built on: REAL accounts — assets, liabilities, equity — carry their position across
 * a period boundary, and NOMINAL accounts — income and expense — do not, which is what makes
 * closing them to retained earnings meaningful. So the bound is applied to both and they are
 * reported separately: `opening` for what was carried in, `movement` for what the window did,
 * and `balance` for whichever of the two that account is actually asking about.
 *
 * ledgerCard() has computed exactly this per account since it was written (see `opening`
 * below it) and cashFlow() computes it for funds. Only the summary — which is what the P&L,
 * the trial balance and every export are built from — went without.
 */
function buildBalances(all: JournalLine[], inRange: (d: string) => boolean, from?: string): Balances {
  const balances: Balances = new Map();
  const at = (code: string) => {
    let cur = balances.get(code);
    if (!cur) {
      cur = { debit: 0, credit: 0, openingDebit: 0, openingCredit: 0 };
      balances.set(code, cur);
    }
    return cur;
  };

  for (const l of all) {
    // Before the window is brought forward. After it is neither — a report to 30 June must not
    // be told about July, and an opening is a position at a moment, not everything that is not
    // in range.
    if (from && l.date < from) {
      const cur = at(l.account);
      cur.openingDebit += l.debit;
      cur.openingCredit += l.credit;
      continue;
    }
    if (!inRange(l.date)) continue;
    const cur = at(l.account);
    cur.debit += l.debit;
    cur.credit += l.credit;
  }
  return balances;
}

/** Accounts that actually moved, signed by their natural side. */
function summariseBalances(chart: Account[], balances: Balances) {
  const summary = chart
    .map((a) => {
      const b = balances.get(a.code) ?? { debit: 0, credit: 0, openingDebit: 0, openingCredit: 0 };
      const sign = naturalSign(a.group);
      const opening = (b.openingDebit - b.openingCredit) * sign;
      const movement = (b.debit - b.credit) * sign;
      /**
       * A real account carries; a nominal one does not. Unbounded, `opening` is always 0 and
       * `balance` is what it always was, so nothing that does not ask for a window changes.
       */
      const carries = a.group === 'asset' || a.group === 'liability' || a.group === 'equity';
      return {
        account: a,
        debit: b.debit,
        credit: b.credit,
        opening,
        movement,
        carries,
        balance: carries ? opening + movement : movement
      };
    })
    // An account that only moved before the window still has a position to report, and
    // dropping it is how a report loses its equity.
    .filter((r) => r.debit !== 0 || r.credit !== 0 || (r.carries && r.opening !== 0));

  /**
   * Postings whose account is no longer in the chart, kept rather than dropped.
   *
   * This walked the chart and nothing else, which was safe for as long as the chart
   * WAS the data — every account was derived from a bank, an expense category or a
   * fixed code, so a posting to a code the chart did not have could not exist.
   *
   * An accountant defining their own accounts breaks that. Delete a ledger account
   * that a journal voucher already posted to and every line of that voucher on that
   * account silently left the ledger: the balance vanished, and the journal trial
   * balance stopped balancing by exactly the amount that disappeared. Measured on a
   * book where three accounts went missing, the two sides came apart by 10,200 with
   * nothing on screen to say why.
   *
   * A trial balance that balances is the one property in this file that must not
   * depend on masters data. So an orphan is surfaced, under its raw code and a name
   * that says what happened. It is deliberately ugly to look at — the fix is to
   * restore the account or reverse the voucher, and it should not be possible to
   * live with it comfortably.
   */
  const known = new Set(chart.map((a) => a.code));
  for (const [code, b] of balances) {
    if (known.has(code)) continue;
    if (b.debit === 0 && b.credit === 0 && b.openingDebit === 0 && b.openingCredit === 0) continue;
    const account: Account = {
      code,
      name: `${code} — account no longer in the chart`,
      // Assumed debit-natured only so a balance renders; it is a fault to fix, not
      // a classification to trust.
      group: 'asset'
    };
    const opening = b.openingDebit - b.openingCredit;
    summary.push({
      account, debit: b.debit, credit: b.credit,
      opening, movement: b.debit - b.credit, carries: true,
      balance: opening + (b.debit - b.credit)
    });
  }
  return summary;
}

/** The running-balance view of one account, the way a ledger card reads. */
function ledgerCard(
  book: Book,
  chart: Account[],
  all: JournalLine[],
  balances: Balances,
  account: string,
  from?: string,
  to?: string
) {
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const sign = naturalSign(accountGroup(account, chart));

  const mine = all.filter((l) => l.account === account);
  const opening = mine
    .filter((l) => (from ? l.date < from : false))
    .reduce((t, l) => t + (l.debit - l.credit) * sign, 0);

  let running = opening;
  const rows = mine
    .filter((l) => inRange(l.date))
    .map((l) => ({ ...l, balance: (running += (l.debit - l.credit) * sign) }));

  return {
    chart,
    summary: summariseBalances(chart, balances),
    rows,
    opening,
    closing: running,
    account: chart.find((a) => a.code === account) ?? null
  };
}

/**
 * Trial balance built from the journal, as opposed to `trialBalance()` which is
 * built from the control accounts. Both must agree; `reconciliation()` checks.
 */
export function journalTrialBalance(book: Book, to?: string, from?: string) {
  /**
   * `from` IS OPTIONAL AND reconciliation() DELIBERATELY DOES NOT PASS IT.
   *
   * The cross-check compares this against the control-basis trial balance, which is built
   * from every voucher in the book with no period at all. Bounding one side and not the other
   * would make them disagree by a year's trading and the check would be reporting the bound
   * rather than the book. So the safety property keeps asking its whole-book question, and the
   * bound exists for the other caller: an accountant asking for THIS year's trial balance,
   * which after a close is the only one that means anything.
   */
  const { summary } = generalLedger(book, undefined, from, to);
  /**
   * Taken from the signed balance rather than from the raw debits and credits, because those
   * are the WINDOW's movements. Unbounded the two are identical — opening is zero, so the net
   * is (debit − credit) exactly as before. Bounded, a real account has to bring its position
   * in or the columns do not add up: a trial balance for a period that starts every asset at
   * nothing is not a trial balance, it is a movement report that happens to be laid out in
   * two columns.
   */
  const rows = summary.map((r) => {
    const net = r.balance * naturalSign(r.account.group);
    return {
      account: r.account,
      debit: Math.max(0, net),
      credit: Math.max(0, -net)
    };
  });
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

  /**
   * A second balance set bounded to today, for the accounts whose whole-book
   * balance is not the interesting number. Only deferred income needs it so far.
   *
   * No sign flip. Accounts payable two rows above is also a liability and is
   * compared directly, so this summary already presents credit-natured balances
   * as positive. I negated it on the assumption that it would not, and the row
   * came out at double the value with the sign inverted — the check catching its
   * own author, which is the entire reason it is here.
   */
  const asOf = generalLedger(book, undefined, undefined, todayISO(book));
  const asOfBalance = (code: string) => asOf.summary.find((r) => r.account.code === code)?.balance ?? 0;

  const checks = [
    { name: 'Cash in hand', control: cashBook(book).closing, ledger: bal(AC.CASH), codes: [AC.CASH] },
    { name: 'Bank accounts', control: allBankBalances(book).total, ledger: book.banks.reduce((t, b) => t + bal(AC.bank(b.id)), 0), codes: book.banks.map((b) => AC.bank(b.id)) },
    { name: 'Accounts receivable', control: receivables(book).total, ledger: bal(AC.AR), codes: [AC.AR] },
    { name: 'Accounts payable', control: payables(book).total, ledger: bal(AC.AP), codes: [AC.AP] },
    {
      name: 'Sales revenue (net of credit notes)',
      control: s.sales,
      // RETURNS is contra-income: its natural sign already makes it negative, so
      // it is added. Subtracting took the credit notes off twice.
      ledger: bal(AC.SALES) + bal(AC.RETURNS),
      codes: [AC.SALES, AC.RETURNS]
    },
    { name: 'Operating expenses', control: s.expenses, ledger: book.expenseCategories.reduce((t, c) => t + bal(AC.expense(c.id)), 0), codes: book.expenseCategories.map((c) => AC.expense(c.id)) },
    /**
     * Deferred income, checked AS AT TODAY rather than over the whole book.
     *
     * Over all time the deferral pair nets to zero on both sides, so a whole-book
     * comparison here would be trivially true and would prove nothing — it would
     * pass just as happily if the recognition leg were missing entirely.
     *
     * Bounded to the book's today it is a real check with two independent routes:
     * the control figure walks the documents and sums what is sold and not yet
     * flown, the ledger figure is the balance the journal happens to be carrying.
     * They agree only if the deferral dates, the recognition dates and the
     * travel-date boundary all line up.
     */
    /**
     * Airline memos, both routes. The control side walks the documents; the ledger
     * side is the balance the journal is carrying. Whole-book on purpose — unlike
     * deferred income, a memo does not unwind with time, so there is nothing a date
     * bound would reveal.
     */
    { name: 'Airline memos payable', control: memoPayable(book).total, ledger: bal(AC.MEMOS), codes: [AC.MEMOS] },
    /**
     * The two halves of a settlement that is not a plain relief. Both compared by
     * the same route as everything else — and both were silently landing in
     * receivables until they were given somewhere to go.
     */
    { name: 'Exchange gain / (loss)', control: fxGain(book).total, ledger: bal(AC.FX), codes: [AC.FX] },
    { name: 'Customer credit balances', control: customerCredit(book).total, ledger: bal(AC.CUSTOMER_CREDIT), codes: [AC.CUSTOMER_CREDIT] },
    {
      name: 'Deferred income (as at today)',
      control: deferredIncome(book, todayISO(book)).total,
      ledger: asOfBalance(AC.DEFERRED),
      codes: [AC.DEFERRED]
    }
  ].map((c) => {
    /**
     * The third column, and the reason the cross-check survives manual vouchers.
     *
     * A journal voucher posts to the ledger and to nothing else, so the moment one
     * touches a control account the two derivations stop agreeing — through no fault
     * of either. Rather than teach the control side about manual entries (which would
     * make the two routes share a term, and two routes that share a term agreeing is
     * not evidence) the manual movement is stated and subtracted.
     *
     * A difference that is NOT explained by a listed voucher is still exactly as loud
     * as it was before. That is the whole property being preserved.
     */
    const adjustment = c.codes.reduce((t, code) => t + adjustmentFor(book, code), 0);
    return { ...c, adjustment, difference: Math.round(c.control + adjustment - c.ledger) };
  });

  return {
    checks,
    clean: checks.every((c) => c.difference === 0),
    /** Listed, never netted away — see lib/journals.ts on what a manual voucher costs. */
    adjustments: controlAdjustments(book)
  };
}

/**
 * Balance sheet as at a date.
 *
 * Retained earnings is not stored anywhere; it is income less expenses out of
 * the same journal. That is what makes the two sides meet without a plug
 * figure — and if they ever do not, `difference` says so.
 */
/** One filed year end. See lib/financial-year.js for what a close is and is not. */
export type YearEndClose = {
  id: string;
  label: string;
  /** The last day of the closed year. The lock is inclusive, so this date is inside it. */
  closedThrough: string;
  opensOn: string;
  closedAt: string;
  closedBy: string;
  moved: { lockedThrough: Moved; financialYearStart: Moved };
  /** What the journal said at the cut. Evidence for drift, never an input to anything. */
  ledger: {
    income: number;
    expense: number;
    cumulativeProfit: number;
    yearProfit: number;
    positions: { code: string; name: string; group: AccountGroup; balance: number }[];
  };
  /** What the voucher side said at the same moment, for the same reason. */
  control: { sales: number; cost: number; expenses: number; memoCost: number; netProfit: number };
  counted: { vouchers: number; drafts: number; journalEntries: number };
  acknowledged: { account: string; amount: number; why: string; note: string }[];
  reopened?: { at: string; by: string; reason: string } | null;
};

type Moved = { before: string | null; after: string | null };

/**
 * WHAT HAS MOVED INSIDE A YEAR SOMEBODY ALREADY FILED.
 *
 * This is the only function in the product that reads the figures recorded on a close, and
 * its output feeds no other calculation. That restriction is the design, not an accident:
 *
 *   THE CUT EXPORTS A DATE TO THE REPORTS AND A FIGURE TO NOTHING.
 *
 * balanceSheet splits retained earnings at the close by re-deriving both halves from the same
 * journal; it never reads cut.ledger.cumulativeProfit, even though the two must be equal. They
 * must be equal, and THIS is where that equality is asserted rather than assumed. Reading the
 * stored figure there instead would make the balance sheet and the close share a term, and two
 * derivations that share a term agreeing is not evidence.
 *
 * WHY IT IS NEEDED AT ALL
 *
 * The period lock is a write guard on a scalar date, and it has holes it cannot close without
 * becoming the journal. lib/period-lock.js datesOf reads four field names, so a date can reach
 * a closed year without being on the record that was written: a bank's openingBalance moves the
 * opening entry, and repointing an invoice line at a document whose travelDate sits in the
 * closed year moves the deferral. Extending datesOf to catch those means asking "what dates
 * does this record post on", which means calling buildJournal from the guard — and then the
 * guard and the journal are one derivation.
 *
 * So the holes are not closed. They are WATCHED. A filed year that no longer derives to what
 * was filed is reported, with the account and both figures, wherever the accounts are read.
 */
export function closedYearDrift(book: Book) {
  const carries = (g: AccountGroup) => g === 'asset' || g === 'liability' || g === 'equity';

  return FY.closes(book).map((cut: YearEndClose) => {
    const summary = generalLedger(book, undefined, undefined, cut.closedThrough).summary;
    const group = (g: AccountGroup) =>
      summary.filter((r) => r.account.group === g).reduce((t, r) => t + r.balance, 0);

    const now = {
      income: Math.round(group('income')),
      expense: Math.round(group('expense')),
      cumulativeProfit: Math.round(group('income') - group('expense'))
    };

    const moved: { what: string; filed: number; now: number; difference: number }[] = [];
    const compare = (what: string, filed: number, current: number) => {
      if (Math.round(filed) !== Math.round(current)) {
        moved.push({ what, filed: Math.round(filed), now: Math.round(current), difference: Math.round(current - filed) });
      }
    };

    compare('Income to the cut', cut.ledger.income, now.income);
    compare('Expense to the cut', cut.ledger.expense, now.expense);
    compare('Profit carried forward', cut.ledger.cumulativeProfit, now.cumulativeProfit);

    const positionsNow = new Map(
      summary.filter((r) => carries(r.account.group)).map((r) => [r.account.code, r])
    );
    for (const filed of cut.ledger.positions) {
      const live = positionsNow.get(filed.code);
      compare(filed.name, filed.balance, live ? live.balance : 0);
      positionsNow.delete(filed.code);
    }
    // An account that did not exist at the cut and carries a balance inside it now.
    for (const [, r] of positionsNow) {
      if (Math.round(r.balance) !== 0) {
        moved.push({
          what: `${r.account.name} — no balance when the year was filed`,
          filed: 0, now: Math.round(r.balance), difference: Math.round(r.balance)
        });
      }
    }

    return { cut, moved, clean: moved.length === 0 };
  });
}

export function balanceSheet(book: Book, asAt?: string) {
  const { summary } = generalLedger(book, undefined, undefined, asAt);
  const of = (g: AccountGroup) => summary.filter((r) => r.account.group === g);

  const assets = of('asset').map((r) => ({ name: r.account.name, amount: r.balance }));
  const liabilities = of('liability').map((r) => ({ name: r.account.name, amount: r.balance }));

  /**
   * Half-finished entries, named on the statement rather than left to be noticed.
   *
   * Two of them are in the seeded book and both are the same shape — a release with nothing
   * to release, a depreciation charge on something carried at nothing:
   *
   *   Prepaid expenses            -12,500   one month of an annual IATA licence "paid in
   *                                         advance" is released every month, and the
   *                                         advance itself was never posted
   *   Accumulated depreciation      8,750   charged monthly against Office equipment — at
   *                                         cost, which carries zero
   *
   * A NEGATIVE ASSET IS NOT A SMALL PRESENTATION PROBLEM. It is the balance sheet saying the
   * agency owns minus twelve thousand taka of licence, on the screen an owner uses to decide
   * things. It cannot be netted away or floored at zero — that would hide the missing entry,
   * which is the only useful thing here.
   *
   * ACCDEP is grouped as a liability on purpose; its own note in the chart says "held as a
   * liability group so the balance sheet nets it against the cost above". It does not net it
   * — it lists it under Liabilities beside Accrued expenses — so with the cost at zero the
   * statement shows depreciation on equipment that appears nowhere. The grouping is left
   * alone because moving it is a presentation decision for whoever owns the chart; what is
   * fixed here is that the statement no longer stays quiet about it.
   *
   * The real repair is an opening-balance import — the equipment at cost and the licence
   * prepayment brought forward — which this project does not have yet and which is listed
   * among the gaps. Inventing the two vouchers here would move 465,000 through a demo book
   * on figures nobody supplied.
   */
  const negativeAssets = assets.filter((a) => a.amount < 0);
  const orphanContra = liabilities.filter((l) => /accumulated depreciation/i.test(l.name) && l.amount !== 0)
    .filter(() => (of('asset').find((r) => /at cost/i.test(r.account.name))?.balance ?? 0) === 0);
  const halfEntries = [
    ...negativeAssets.map((a) => ({
      account: a.name,
      amount: a.amount,
      why: `${a.name} is negative, which means something was taken out of it that was never put in. The entry that should have created it is missing.`
    })),
    ...orphanContra.map((l) => ({
      account: l.name,
      amount: l.amount,
      why: `${l.name} is being charged against an asset carried at zero. Either the asset was never brought forward at cost, or the depreciation is against something the book does not own.`
    }))
  ];
  const income = of('income').reduce((t, r) => t + r.balance, 0);
  const expense = of('expense').reduce((t, r) => t + r.balance, 0);
  const retained = income - expense;

  /**
   * Retained earnings, split at the close — by DATE, never by a stored figure.
   *
   * Until a year is closed this is one number covering everything the book has ever traded,
   * which is right, because nothing has been carried out. After a close it has to separate:
   * a balance sheet at 2027-06-30 that folds FY2025-26's June profit into current-year
   * retained earnings is a statement nobody can use.
   *
   * BOTH HALVES COME FROM THE SAME JOURNAL. broughtForward is income less expense up to the
   * cut, profitForPeriod is the rest, and their sum is `retained` unchanged — so the two
   * sides still meet without a plug and `difference` stays the zero identity this function's
   * header claims it is. Nothing is read from the recorded close except its DATE.
   *
   * That restriction is the whole discipline. A stored profit figure read back here would be
   * a term the balance sheet and the close share, and two derivations that share a term
   * agreeing is not evidence. The recorded figures exist so drift can be NAMED — see
   * closedYearDrift — not so anything can be built on them.
   */
  const cut = FY.closedThrough(book);
  const priorTo = cut && (!asAt || cut < asAt) ? cut : null;
  const broughtForward = priorTo
    ? (() => {
        const prior = generalLedger(book, undefined, undefined, priorTo).summary;
        const g = (grp: AccountGroup) =>
          prior.filter((r) => r.account.group === grp).reduce((t, r) => t + r.balance, 0);
        return g('income') - g('expense');
      })()
    : 0;
  const profitForPeriod = retained - broughtForward;

  /**
   * Equity rows come from the chart now rather than from a hard-coded pair. GL:RETAINED is
   * group 'equity', so anyone posting a manual voucher to it was previously swept into a row
   * labelled 'Opening balances' — the figure landed in the right total under the wrong name.
   */
  const equity = [
    ...of('equity').map((r) => ({ name: r.account.name, amount: r.balance })),
    ...(priorTo ? [{ name: `Retained earnings brought forward (to ${priorTo})`, amount: broughtForward }] : []),
    { name: priorTo ? 'Profit for the year' : 'Retained earnings', amount: profitForPeriod }
  ];

  const totalAssets = assets.reduce((t, r) => t + r.amount, 0);
  const totalLiabilities = liabilities.reduce((t, r) => t + r.amount, 0);
  const totalEquity = equity.reduce((t, r) => t + r.amount, 0);

  return {
    asAt: asAt ?? 'today',
    assets, liabilities, equity,
    totalAssets, totalLiabilities, totalEquity,
    /** The close this statement is split at, or null when nothing has been closed. */
    closedThrough: priorTo,
    broughtForward,
    profitForPeriod,
    /** Accounts whose balance can only exist because a matching entry was never made. */
    halfEntries,
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
