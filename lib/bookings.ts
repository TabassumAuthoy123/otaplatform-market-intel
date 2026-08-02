import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FareOffer } from '@/lib/gds';

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
  };
  /** What the agency charged on top of the GDS fare. */
  serviceCharge: number;
  grandTotal: number;
  invoiceNo: string | null;
  source: 'travelport_uapi';
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

  // find or create the customer
  let customer = customers.find((c) => String(c.name).toLowerCase() === customerName.toLowerCase());
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

  const seq = invoices.length + 1;
  const invId = `INV-${String(seq).padStart(4, '0')}`;
  const invNo = `${company.invoicePrefix ?? 'SFT-INV-'}${String(seq).padStart(4, '0')}`;
  const date = booking.createdAt.slice(0, 10);
  const pax = booking.passengers.length || 1;
  const baseAmount = Number(String(booking.fare.base).replace(/[^\d.]/g, '')) || booking.fare.total;
  const route = booking.itinerary.map((s) => `${s.origin}–${s.destination}`).join(' / ');

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
      supplierCost: Math.round(baseAmount / pax),
      supplierId: String(supplier.id)
    }],
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
    amount: Math.round(baseAmount),
    notes: `Airline fare for booking ${booking.ref}`
  });

  book.invoices = invoices;
  book.bills = bills;
  book.customers = customers;
  book.suppliers = suppliers;
  await writeAtomic(ACCOUNTING_FILE, book);
  return invNo;
}

export async function createBooking(input: {
  offer: FareOffer;
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
      base: input.offer.basePrice,
      taxes: input.offer.taxes,
      cabin: input.offer.cabin,
      bookingCode: input.offer.bookingCode,
      platingCarrier: input.offer.platingCarrier,
      refundable: input.offer.refundable
    },
    serviceCharge: input.serviceCharge,
    grandTotal: input.offer.amount * Math.max(1, input.passengers.length) + input.serviceCharge,
    invoiceNo: null,
    source: 'travelport_uapi'
  };

  const lead = input.passengers[0];
  const customerName = lead ? `${lead.firstName} ${lead.lastName}`.trim() : input.contact.name;
  booking.invoiceNo = await postToAccounts(booking, customerName || 'Walk-in customer');

  existing.unshift(booking);
  await writeAtomic(BOOKINGS_FILE, existing);
  return booking;
}

export async function findBooking(ref: string): Promise<Booking | null> {
  const all = await getBookings();
  return all.find((b) => b.ref === ref) ?? null;
}
