import { NextResponse } from 'next/server';
import { createBooking, type Passenger } from '@/lib/bookings';
import { parseLowFareSearch, searchFlights } from '@/lib/gds';

/**
 * Takes a booking against a live Travelport fare.
 *
 * The fare is re-fetched and re-matched by offer key rather than trusted from
 * the browser, so a client cannot post a price it invented. If the offer has
 * gone — and GDS fares do go — the caller gets 409 and has to search again,
 * which is the honest outcome.
 */

export const dynamic = 'force-dynamic';

const clean = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const from = clean(body.from, 8).toUpperCase();
  const to = clean(body.to, 8).toUpperCase();
  const date = clean(body.date, 12);
  const sig = clean(body.sig, 400);

  if (!from || !to || !sig) {
    return NextResponse.json({ ok: false, error: 'from, to and the fare signature are required.' }, { status: 422 });
  }

  const contact = {
    name: clean((body.contact as Record<string, unknown>)?.name),
    email: clean((body.contact as Record<string, unknown>)?.email, 160),
    phone: clean((body.contact as Record<string, unknown>)?.phone, 40)
  };
  if (!contact.name || !contact.phone) {
    return NextResponse.json({ ok: false, error: 'Contact name and phone are required.' }, { status: 422 });
  }

  const passengers: Passenger[] = Array.isArray(body.passengers)
    ? (body.passengers as Record<string, unknown>[]).map((p) => ({
        title: clean(p.title, 8),
        firstName: clean(p.firstName, 60),
        lastName: clean(p.lastName, 60),
        dob: clean(p.dob, 12),
        passport: clean(p.passport, 30),
        nationality: clean(p.nationality, 40)
      })).filter((p) => p.firstName && p.lastName)
    : [];

  if (!passengers.length) {
    return NextResponse.json({ ok: false, error: 'At least one passenger with a first and last name is required.' }, { status: 422 });
  }

  // re-price against the GDS — never trust a price from the browser
  const live = await searchFlights({ from, to, date, adults: String(passengers.length) });
  if (!live.configured) {
    return NextResponse.json({ ok: false, error: 'The GDS is not configured, so no booking can be taken.' }, { status: 503 });
  }
  if (live.fault || !live.upstreamOk) {
    return NextResponse.json(
      { ok: false, error: `Travelport did not return fares: ${live.fault?.faultString ?? live.error ?? 'unknown'}` },
      { status: 502 }
    );
  }

  const offer = parseLowFareSearch(live.data).find((o) => o.sig === sig);
  if (!offer) {
    return NextResponse.json(
      { ok: false, error: 'That fare is no longer available. Search again and pick a current one.' },
      { status: 409 }
    );
  }

  const serviceCharge = Math.max(0, Math.min(50000, Number(body.serviceCharge) || 0));
  const booking = await createBooking({ offer, contact, passengers, serviceCharge });

  return NextResponse.json({ ok: true, ref: booking.ref, invoiceNo: booking.invoiceNo, grandTotal: booking.grandTotal });
}
