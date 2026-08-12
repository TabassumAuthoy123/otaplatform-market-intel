import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Book } from '@/lib/accounting';
import { CreditLimitError, wouldBreach } from '@/lib/credit';
import { travelDateOf } from '@/lib/documents';
import path from 'node:path';
import type { Offer, Supplier } from '@/lib/offers';

/**
 * Bookings taken on the storefront.
 *
 * A booking here is a HELD SALE, not a ticketed PNR. The fare comes from a live
 * Travelport LowFareSearch, but issuing a ticket needs AirCreateReservation and
 * AirTicketing against the same account, and those are not wired yet. So the
 * record carries `ticketed: false` and the confirmation screen says so — an
 * agency must never be able to tell a passenger they are ticketed when they are
 * not.
 *
 * Every booking also writes an invoice into the accounting book, so the money
 * side of the platform is populated by real activity rather than seed data:
 * selling price is the fare the customer accepted, supplier cost is the base
 * fare, and the difference is the margin the agency actually earned.
 */

const CONTENT = path.join(process.cwd(), 'content');
const BOOKINGS_FILE = path.join(CONTENT, 'bookings.json');
const ACCOUNTING_FILE = path.join(CONTENT, 'accounting.json');

export type Passenger = {
  title: string; firstName: string; lastName: string;
  dob: string; passport: string; nationality: string;
};

export type Booking = {
  ref: string;
  createdAt: string;
  status: 'held' | 'cancelled';
  ticketed: false;
  contact: { name: string; email: string; phone: string };
  passengers: Passenger[];
  itinerary: {
    carrier: string; flightNumber: string; origin: string; destination: string;
    departure: string; arrival: string; minutes: number;
  }[];
  fare: {
    currency: string; total: number; base: string; taxes: string;
    cabin: string; bookingCode: string; platingCarrier: string; refundable: boolean;
    /**
     * The supplier's ticketing deadline, as it was quoted.
     *
     * This was shown on the fare card and then thrown away when the booking was
     * written. A held booking therefore lost the one date that decides whether
     * it is still worth anything: past this, the fare is gone and the hold is
     * an empty record. Stored so something can act on it.
     */
    latestTicketing: string;
    /**
     * Taxes by IATA code, as the supplier itemised them.
     *
     * Optional so every booking written before this existed still parses. Empty
     * means the supplier sent none — never that they were not asked for.
     */
    taxBreakdown?: { code: string; amount: number; description: string }[];
  };
  /** What the agency charged on top of the GDS fare. */
  serviceCharge: number;
  grandTotal: number;
  invoiceNo: string | null;
  supplier: Supplier;
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeAtomic(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

export const getBookings = () => readJson<Booking[]>(BOOKINGS_FILE, []);

/** OTA-2608-0001 — year-month prefix so references sort and read sensibly. */
function nextRef(existing: Booking[]): string {
  const now = new Date();
  const prefix = `OTA-${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const mine = existing.filter((b) => b.ref.startsWith(prefix));
  return `${prefix}-${String(mine.length + 1).padStart(4, '0')}`;
}

/**
 * Adds the sale to content/accounting.json as a confirmed invoice plus the
 * matching supplier bill, so it lands in the cash book, the receivables list
 * and the margin report without anyone re-keying it.
 */
async function postToAccounts(booking: Booking, customerName: string): Promise<string | null> {
  const book = await readJson<Record<string, unknown> | null>(ACCOUNTING_FILE, null);
  if (!book) return null;

  const invoices = (book.invoices as Record<string, unknown>[]) ?? [];
  const bills = (book.bills as Record<string, unknown>[]) ?? [];
  const customers = (book.customers as Record<string, unknown>[]) ?? [];
  const suppliers = (book.suppliers as Record<string, unknown>[]) ?? [];
  const company = (book.company as Record<string, string>) ?? {};

  /**
   * A storefront sale belongs to the storefront.
   *
   * Not an invention — it is where the sale was actually made, and "how much comes
   * from the website" is the first thing an owner asks once branches exist. Found
   * by `kind`, not by a hard-coded id, so an installation that names its online
   * channel something else still gets it, and one with no online branch simply
   * leaves the sale unattributed rather than being assigned somewhere untrue.
   */
  const onlineBranchId =
    ((book.branches as { id: string; kind: string }[]) ?? []).find((b) => b.kind === 'online')?.id ?? null;

  // find or create the customer
  let customer = customers.find((c) => String(c.name).toLowerCase() === customerName.toLowerCase());

  /**
   * Credit control, checked before the sale rather than discovered at month end.
   *
   * This is the ONE place a limit refuses rather than warns. Everywhere else in the
   * accounting module a breach is reported and the save goes through, because an
   * agency deciding to extend credit past its own limit for a good reason should
   * not have to edit a master record first. Here there is nobody exercising that
   * judgement — it is a self-service form on a public storefront, and the failure
   * it prevents is a corporate client quietly running up months of tickets the
   * agency has already remitted to the airline.
   *
   * A customer with no limit set is unaffected, which is every customer on the book
   * today. The limit is opted into one customer at a time.
   *
   * Checked on the customer as they exist BEFORE this sale is written. A brand-new
   * customer has no history and no limit, so a first-time buyer is never blocked.
   */
  if (customer) {
    const verdict = wouldBreach(book as unknown as Book, String(customer.id), booking.grandTotal);
    if (!verdict.ok) throw new CreditLimitError(verdict.reason);
  }
  if (!customer) {
    customer = {
      id: `CUS-${String(customers.length + 1).padStart(3, '0')}`,
      name: customerName, type: 'walk_in',
      phone: booking.contact.phone, email: booking.contact.email,
      address: '', openingBalance: 0
    };
    customers.push(customer);
  }

  // find or create the plating carrier as a supplier
  const carrierName = booking.fare.platingCarrier || booking.itinerary[0]?.carrier || 'Airline';
  let supplier = suppliers.find((s) => String(s.name) === carrierName);
  if (!supplier) {
    supplier = {
      id: `SUP-${String(suppliers.length + 1).padStart(3, '0')}`,
      name: carrierName, type: 'airline', phone: '', email: '', openingBalance: 0
    };
    suppliers.push(supplier);
  }

  /**
   * The airline document, built from what the supplier actually quoted.
   *
   * This is the point of the whole exercise. The GDS hands over a base fare,
   * itemised taxes with IATA codes, the plating carrier, every sector with its
   * departure time and the passenger names — and until now all of it was reduced
   * to one `supplierCost` number on an invoice line, which is why the book could
   * not reconcile against BSP, defer revenue to the travel date, or attribute an
   * ADM to a ticket.
   *
   * `documentNo` stays null and the status is `booked`, because that is the truth:
   * Travelport creates the PNR and Galileo refuses to issue, so there is no ticket
   * number to record. It becomes `issued` when there is one.
   *
   * Nothing here posts. The invoice line below still carries the money and still
   * posts exactly as before, and the trial balance is unchanged by any of this.
   */
  const docs = Array.isArray(book.documents) ? book.documents : [];
  const docSeq = docs.length + 1;
  const docId = `DOC-${String(docSeq).padStart(4, '0')}`;
  const paxName = booking.passengers[0]
    ? `${booking.passengers[0].lastName}/${booking.passengers[0].firstName} ${booking.passengers[0].title}`.trim()
    : '';
  // Fare figures are per passenger, the way the supplier quotes them.
  const baseNum = Math.round(Number(String(booking.fare.base).replace(/[^\d.]/g, '')) || 0);
  const quotedTaxes = booking.fare.taxBreakdown ?? [];

  docs.push({
    id: docId,
    documentNo: null,
    type: 'TKT',
    status: 'booked',
    pnr: booking.ref,
    platingCarrier: booking.fare.platingCarrier || booking.itinerary[0]?.carrier || '',
    passengerName: paxName,
    sectors: booking.itinerary.map((s) => ({
      carrier: s.carrier, flightNumber: s.flightNumber,
      origin: s.origin, destination: s.destination,
      departure: s.departure, bookingClass: booking.fare.bookingCode || ''
    })),
    issueDate: null,
    // The earliest departure. This is what revenue recognition will key on, and it
    // is the field the migrated documents could not have.
    travelDate: travelDateOf(booking.itinerary.map((s) => ({ departure: s.departure }))),
    currency: booking.fare.currency,
    fxRate: 1,
    // Null only when the supplier quoted no base at all; 0 would claim a free fare.
    baseFare: baseNum > 0 ? baseNum : null,
    taxes: quotedTaxes.map((t) => ({ code: t.code, amount: t.amount })),
    // The GDS quote carries no commission for these fares. Recorded as unknown
    // rather than as zero — zero is a claim that the airline allowed nothing.
    commissionPct: null,
    commissionAmt: null,
    formOfPayment: 'bsp_cash',
    supplierId: String(supplier.id),
    settlementRef: null,
    settled: false,
    branchId: onlineBranchId,
    consultantId: null,
    notes: `Created from storefront booking ${booking.ref}. Fare and taxes as quoted by ${booking.supplier}.`
  });

  const seq = invoices.length + 1;
  const invId = `INV-${String(seq).padStart(4, '0')}`;
  const invNo = `${company.invoicePrefix ?? 'SFT-INV-'}${String(seq).padStart(4, '0')}`;
  const date = booking.createdAt.slice(0, 10);
  const pax = booking.passengers.length || 1;
  const route = booking.itinerary.map((s) => `${s.origin}–${s.destination}`).join(' / ');

  /**
   * Supplier cost is the WHOLE fare, not the base.
   *
   * The agency remits base plus taxes to the airline and keeps its service
   * charge. Booking the base as cost and the full price as revenue would report
   * the tax as margin — on one DAC–DXB ticket that produced a 35,657 "profit"
   * on a 35,800 sale, which is obviously fiction and would flow straight into
   * the P&L. Margin here is exactly what the agency added.
   */
  const supplierCostTotal = booking.fare.total * pax;

  invoices.push({
    id: invId,
    no: invNo,
    date,
    customerId: customer.id,
    status: 'confirmed',
    vatRate: 0,
    lines: [{
      serviceId: 'SRV-001',
      description: `${route} ${booking.itinerary.map((s) => `${s.carrier}${s.flightNumber}`).join('/')} — booking ${booking.ref}`,
      pnr: booking.ref,
      pax,
      qty: pax,
      unitPrice: Math.round(booking.grandTotal / pax),
      supplierCost: Math.round(supplierCostTotal / pax),
      supplierId: String(supplier.id),
      // The link that makes the fare breakdown reachable from the money.
      documentId: docId
    }],
    branchId: onlineBranchId,
    // No consultant: nobody sold this one, which is the point of the online branch.
    consultantId: null,
    notes: `Created from storefront booking ${booking.ref}. Held, not ticketed.`
  });

  const billSeq = bills.length + 1;
  bills.push({
    id: `BIL-${String(billSeq).padStart(4, '0')}`,
    no: `${company.billPrefix ?? 'SFT-BIL-'}${String(billSeq).padStart(4, '0')}`,
    date,
    supplierId: String(supplier.id),
    invoiceRef: invId,
    status: 'unpaid',
    amount: Math.round(supplierCostTotal),
    notes: `Airline fare for booking ${booking.ref}`
  });

  book.documents = docs;
  book.invoices = invoices;
  book.bills = bills;
  book.customers = customers;
  book.suppliers = suppliers;
  await writeAtomic(ACCOUNTING_FILE, book);
  return invNo;
}

export async function createBooking(input: {
  offer: Offer;
  contact: Booking['contact'];
  passengers: Passenger[];
  serviceCharge: number;
}): Promise<Booking> {
  await mkdir(CONTENT, { recursive: true });
  const existing = await getBookings();

  const booking: Booking = {
    ref: nextRef(existing),
    createdAt: new Date().toISOString(),
    status: 'held',
    ticketed: false,
    contact: input.contact,
    passengers: input.passengers,
    itinerary: input.offer.segments.map((s) => ({
      carrier: s.carrier, flightNumber: s.flightNumber,
      origin: s.origin, destination: s.destination,
      departure: s.departure, arrival: s.arrival, minutes: s.minutes
    })),
    fare: {
      currency: input.offer.currency,
      total: input.offer.amount,
      base: input.offer.baseLabel,
      taxes: input.offer.taxLabel,
      cabin: input.offer.cabin,
      bookingCode: input.offer.bookingCode,
      platingCarrier: input.offer.platingCarrier,
      refundable: input.offer.refundable,
      latestTicketing: input.offer.latestTicketing || '',
      /**
       * The itemised taxes, kept instead of thrown away.
       *
       * Both suppliers send them — Travelport as `<air:TaxInfo Category="BD"
       * Amount="BDT500"/>`, Sabre as refs into a `taxDescs` dictionary with human
       * descriptions — and a DAC–DXB search returns eight or more codes. Until now
       * the booking recorded only their sum, so the fare breakdown was gone by the
       * time it reached the book.
       *
       * These are the Bangladesh rules as line items: OW2 the excise duty, BD the
       * embarkation fee, E5 the VAT. A rule such as the Hajj excise-duty waiver
       * applies to a code, and cannot be applied to a total.
       */
      taxBreakdown: input.offer.taxBreakdown ?? []
    },
    serviceCharge: input.serviceCharge,
    grandTotal: input.offer.amount * Math.max(1, input.passengers.length) + input.serviceCharge,
    invoiceNo: null,
    supplier: input.offer.supplier
  };

  const lead = input.passengers[0];
  const customerName = lead ? `${lead.firstName} ${lead.lastName}`.trim() : input.contact.name;
  booking.invoiceNo = await postToAccounts(booking, customerName || 'Walk-in customer');

  existing.unshift(booking);
  await writeAtomic(BOOKINGS_FILE, existing);
  return booking;
}

/**
 * How urgent a held booking is, as at `today`.
 *
 * Derived rather than stored: a stored status would be wrong the next morning
 * and nobody would notice. `unknown` is its own state and is not treated as
 * safe — a supplier that quoted no deadline is a booking somebody still has to
 * look at, not one that is fine forever.
 */
export type BookingUrgency = {
  state: 'ticketed' | 'cancelled' | 'expired' | 'due_today' | 'due_soon' | 'ok' | 'unknown';
  deadline: string | null;
  daysLeft: number | null;
  note: string;
};

export function bookingUrgency(b: Booking, today: string): BookingUrgency {
  if (b.status === 'cancelled') return { state: 'cancelled', deadline: null, daysLeft: null, note: 'Cancelled.' };
  if (b.ticketed) return { state: 'ticketed', deadline: null, daysLeft: null, note: 'Ticketed.' };

  const raw = b.fare.latestTicketing || '';
  const deadline = raw ? raw.slice(0, 10) : null;
  if (!deadline) {
    return {
      state: 'unknown',
      deadline: null,
      daysLeft: null,
      note: 'The supplier quoted no ticketing deadline. Check the fare before promising it.'
    };
  }

  const days = Math.round((Date.parse(deadline) - Date.parse(today)) / 86400000);
  if (days < 0) {
    return {
      state: 'expired',
      deadline,
      daysLeft: days,
      note: `Ticketing deadline passed ${Math.abs(days)} day(s) ago. The fare is gone — re-price before quoting it again.`
    };
  }
  if (days === 0) return { state: 'due_today', deadline, daysLeft: 0, note: 'Ticketing deadline is today.' };
  if (days <= 2) return { state: 'due_soon', deadline, daysLeft: days, note: `Ticketing deadline in ${days} day(s).` };
  return { state: 'ok', deadline, daysLeft: days, note: `Ticketing deadline in ${days} days.` };
}

export async function findBooking(ref: string): Promise<Booking | null> {
  const all = await getBookings();
  return all.find((b) => b.ref === ref) ?? null;
}
