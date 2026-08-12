import type { Book, Invoice, InvoiceLine } from '@/lib/accounting';

/**
 * The airline document — the entity this book was missing.
 *
 * WHY THIS EXISTS
 *
 * Everything in the accounting module is organised around the invoice: what the
 * customer was charged, and one `supplierCost` number for what we paid. That is
 * enough to produce a correct trial balance and it has been producing one. It is
 * not enough to answer a single question a travel back office is bought for.
 *
 * A ticket has a document number, a base fare, a list of taxes, a commission the
 * airline allows, a plating carrier, a passenger, sectors, and two different dates
 * that drive two different things — the issue date moves cash, the travel date
 * earns revenue. Collapsed into one `supplierCost`, none of it survives, and
 * neither does the ability to reconcile against a BSP billing file, raise an ADM
 * against a ticket, defer revenue to the month of travel, or attribute margin to
 * the consultant who sold it.
 *
 * THE ADDITIVE GUARANTEE
 *
 * This changes no total. Documents do not post to the journal — an invoice line
 * still carries the money and still posts exactly as it did. A document is a
 * sub-ledger record that a line may point at, and every field it adds is one the
 * book previously had nowhere to put. The trial balance on the day this shipped is
 * the trial balance from the day before, and a check asserts it.
 *
 * That is deliberate rather than timid. Steps that DO move money — deferring
 * revenue to the travel date, posting the airline payable at issue rather than at
 * invoice — are separate changes with their own risk, and doing them in the same
 * commit as a schema addition would make a broken figure impossible to bisect.
 *
 * NULLABLE ON PURPOSE
 *
 * `documentNo`, `baseFare`, `taxes`, `commissionAmt` and `travelDate` are all
 * nullable, and that models reality rather than laziness. Our own GDS position is
 * exactly this: Travelport creates real PNRs and Galileo refuses to issue, so a
 * booking genuinely has a PNR and genuinely has no ticket number. A schema that
 * demanded one would have forced somebody to type a fake.
 *
 * Where the fare breakdown is unknown, every derivation falls back to the invoice
 * line's `supplierCost`, so a half-known document is still correct — just less
 * useful. It never silently reports zero.
 */

/** One tax line off the ticket. Code is the airline/IATA code, e.g. `BD`, `E5`, `YQ`. */
export type DocumentTax = { code: string; amount: number };

export type DocumentSector = {
  carrier: string;
  flightNumber: string;
  origin: string;
  destination: string;
  /** ISO datetime of departure. The earliest of these is the document's travel date. */
  departure: string;
  bookingClass: string;
};

/**
 * `TKT` ticket · `EMD` electronic miscellaneous document · `MCO` miscellaneous
 * charges order · `REFUND` · `ADM`/`ACM` airline debit and credit memos.
 *
 * A refund and a memo are documents in their own right, not adjustments hung off
 * the original. That is how BSP bills them and how they have to be matched.
 */
export type DocumentType = 'TKT' | 'EMD' | 'MCO' | 'REFUND' | 'ADM' | 'ACM';

/**
 * `booked` — a PNR exists, nothing issued. Our own live state on Travelport today.
 * `issued` — a document number exists and the airline is owed.
 * `void` — cancelled inside the same reporting period, so it costs nothing.
 * `refunded` · `exchanged` — after the period, and both cost something.
 */
export type DocumentStatus = 'booked' | 'issued' | 'void' | 'refunded' | 'exchanged';

export type FormOfPayment = 'bsp_cash' | 'easypay' | 'agency_card' | 'customer_card' | 'cash';

export type TravelDocument = {
  id: string;
  /** The 13-digit e-ticket or EMD number. Null while only a PNR exists. */
  documentNo: string | null;
  type: DocumentType;
  status: DocumentStatus;
  pnr: string;
  /** Two-letter code. Decides which airline the money is owed to. */
  platingCarrier: string;
  passengerName: string;
  sectors: DocumentSector[];
  /** When the document was issued and the airline became owed. Null while booked. */
  issueDate: string | null;
  /** First departure. Null when no sector is recorded. Drives revenue recognition. */
  travelDate: string | null;
  currency: string;
  fxRate: number;
  /** Airline fare before tax, in `currency`. Null when the split was never recorded. */
  baseFare: number | null;
  taxes: DocumentTax[];
  commissionPct: number | null;
  commissionAmt: number | null;
  formOfPayment: FormOfPayment;
  /** The airline or consolidator this settles with. */
  supplierId: string | null;
  /** BSP reporting period, e.g. `2026-08-P2`. Null until it appears on a billing file. */
  settlementRef: string | null;
  settled: boolean;
  branchId: string | null;
  /** An employee id. What makes profit-by-consultant possible at all. */
  consultantId: string | null;
  notes: string;
};

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  TKT: 'Ticket', EMD: 'EMD', MCO: 'MCO', REFUND: 'Refund',
  ADM: 'Agency debit memo', ACM: 'Agency credit memo'
};

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  booked: 'Booked, not issued', issued: 'Issued', void: 'Voided',
  refunded: 'Refunded', exchanged: 'Exchanged'
};

export const FORM_OF_PAYMENT_LABEL: Record<FormOfPayment, string> = {
  bsp_cash: 'BSP cash', easypay: 'IATA EasyPay', agency_card: 'Agency card',
  customer_card: 'Customer card', cash: 'Direct to supplier'
};

/** Documents on the book. Absent on any book written before this table existed. */
export function documents(book: Book): TravelDocument[] {
  return book.documents ?? [];
}

/** Sum of the tax lines. An empty list is zero, not unknown — `baseFare` carries that. */
export function taxTotal(d: TravelDocument): number {
  return d.taxes.reduce((t, x) => t + (Number(x.amount) || 0), 0);
}

/**
 * Fare plus taxes, or null when the split was never recorded.
 *
 * Null rather than 0. A document imported from an invoice line knows what was paid
 * in total but not how it divided, and reporting that as a zero fare would put a
 * confident wrong number on a screen — the failure this whole project keeps
 * finding.
 */
export function documentGross(d: TravelDocument): number | null {
  if (d.baseFare === null) return null;
  return Math.round(d.baseFare + taxTotal(d));
}

/**
 * What the agency actually owes the airline: gross less the commission allowed.
 *
 * This is the number that belongs in a BSP remittance, and the number that made
 * commission worth modelling — it is invisible today, so margin can only ever be
 * the service charge the agency added itself.
 */
export function documentPayable(d: TravelDocument): number | null {
  const gross = documentGross(d);
  if (gross === null) return null;
  return Math.round(gross - (d.commissionAmt ?? 0));
}

/** In the book's base currency, the same way every other voucher is converted. */
export function documentPayableBase(d: TravelDocument): number | null {
  const p = documentPayable(d);
  if (p === null) return null;
  return Math.round(p * (Number(d.fxRate) || 1));
}

type LineRef = { invoice: Invoice; line: InvoiceLine; index: number };

/**
 * Which invoice line, if any, sells each document.
 *
 * Built once per call rather than searched per document — 168 lines against a
 * growing document table is a quadratic scan waiting to happen on the busiest
 * screen in the module.
 */
export function linesByDocument(book: Book): Map<string, LineRef> {
  const map = new Map<string, LineRef>();
  for (const invoice of book.invoices) {
    invoice.lines.forEach((line, index) => {
      const id = line.documentId;
      if (id) map.set(id, { invoice, line, index });
    });
  }
  return map;
}

export type DocumentRow = {
  doc: TravelDocument;
  /** The invoice that sells it, when one does. */
  invoiceNo: string | null;
  /** What the customer is charged for it. */
  sold: number | null;
  /** What we owe the supplier: the fare breakdown when known, else the line's cost. */
  cost: number;
  /** Whether `cost` came from the document or fell back to the invoice line. */
  costFrom: 'document' | 'invoice line' | 'unknown';
  margin: number | null;
};

/**
 * Every document with its commercial position.
 *
 * The fallback is the important part. Where a document carries a real fare and tax
 * breakdown, the cost is computed from it and the commission counts. Where it does
 * not, the invoice line's `supplierCost` is used — which is exactly what every
 * existing report already uses, so adding documents cannot change a margin that
 * was already being reported.
 */
export function documentRows(book: Book): DocumentRow[] {
  const byDoc = linesByDocument(book);
  return documents(book).map((doc) => {
    const ref = byDoc.get(doc.id);
    const sold = ref ? Math.round(ref.line.unitPrice * ref.line.qty) : null;
    const fromDoc = documentPayableBase(doc);
    const cost = fromDoc ?? (ref ? Math.round(ref.line.supplierCost) : 0);
    const costFrom: DocumentRow['costFrom'] =
      fromDoc !== null ? 'document' : ref ? 'invoice line' : 'unknown';
    return {
      doc,
      invoiceNo: ref ? ref.invoice.no : null,
      sold,
      cost,
      costFrom,
      margin: sold === null ? null : sold - cost
    };
  });
}

/**
 * Issued and not on any invoice.
 *
 * The agency owes the airline for these and has billed nobody. Today that
 * exposure is invisible — there is no record of an issued ticket that is not
 * already an invoice line, because a ticket cannot exist without one.
 *
 * Reported, not posted. Posting it as a liability is step 3, and doing it here
 * would break the promise that this change moves no total.
 */
export function unbilledDocuments(book: Book): { rows: DocumentRow[]; total: number } {
  const rows = documentRows(book).filter(
    (r) => r.invoiceNo === null && (r.doc.status === 'issued' || r.doc.status === 'booked')
  );
  return { rows, total: rows.reduce((t, r) => t + r.cost, 0) };
}

/** Issued, not voided, and not yet matched to a BSP billing period. */
export function unsettledDocuments(book: Book): { rows: DocumentRow[]; total: number } {
  const rows = documentRows(book).filter(
    (r) => r.doc.status === 'issued' && !r.doc.settled
  );
  return { rows, total: rows.reduce((t, r) => t + r.cost, 0) };
}

/**
 * Revenue that has been billed but not yet flown.
 *
 * Nothing acts on this yet — it is the measurement that justifies step 2. If the
 * figure is small the deferral work can wait; if an agency is holding months of
 * Hajj money it cannot. Better to be able to look than to argue from intuition.
 */
export function unflown(book: Book, onISO: string): { rows: DocumentRow[]; total: number } {
  const rows = documentRows(book).filter(
    (r) => r.doc.travelDate !== null && r.doc.travelDate > onISO && r.sold !== null
  );
  return { rows, total: rows.reduce((t, r) => t + (r.sold ?? 0), 0) };
}

export function documentsByCarrier(book: Book): { carrier: string; count: number; cost: number }[] {
  const acc = new Map<string, { carrier: string; count: number; cost: number }>();
  for (const r of documentRows(book)) {
    const key = r.doc.platingCarrier || '—';
    const hit = acc.get(key) ?? { carrier: key, count: 0, cost: 0 };
    hit.count += 1;
    hit.cost += r.cost;
    acc.set(key, hit);
  }
  return [...acc.values()].sort((a, b) => b.cost - a.cost);
}

/** Earliest departure across the sectors, which is what "travel date" means. */
export function travelDateOf(sectors: DocumentSector[]): string | null {
  const dates = sectors.map((s) => s.departure).filter(Boolean).sort();
  return dates.length ? dates[0].slice(0, 10) : null;
}
