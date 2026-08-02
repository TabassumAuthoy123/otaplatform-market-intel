import Link from 'next/link';
import { Chip, Section } from '@/components/portal/ui';
import { findBooking } from '@/lib/bookings';

export const dynamic = 'force-dynamic';

export default async function BookingConfirmation({ searchParams }: { searchParams: { ref?: string } }) {
  const booking = searchParams.ref ? await findBooking(searchParams.ref) : null;

  if (!booking) {
    return (
      <Section tone="surface">
        <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-white px-5 py-5 shadow-card">
          <h1 className="text-[18px] font-bold text-navy-900">No booking with that reference</h1>
          <p className="mt-2 text-[13.5px] text-ink">Check the reference, or start a new search.</p>
          <Link href="/portal/flights" className="mt-4 inline-block rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">
            Search flights
          </Link>
        </div>
      </Section>
    );
  }

  const cur = booking.fare.currency;
  const money = (n: number) => `${cur} ${n.toLocaleString('en-IN')}`;

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-300">Step 3 of 3 · Confirmed</div>
          <h1 className="mt-3 text-[28px] font-bold sm:text-[34px]">Booking held</h1>
          <p className="tnum mt-3 text-[20px] font-bold text-teal-300">{booking.ref}</p>
          <p className="mt-2 max-w-2xl text-[14px] text-white/75">
            Keep this reference. It links the passenger, the itinerary and the invoice.
          </p>
        </div>
      </section>

      {/* the single most important thing on this page */}
      <Section tone="surface" className="!py-8">
        <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-white px-5 py-4 shadow-card">
          <div className="flex flex-wrap items-center gap-3">
            <Chip tone="amber">Held — not ticketed</Chip>
            <p className="text-[13.5px] font-semibold text-navy-900">No ticket has been issued yet.</p>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            The fare was priced live against Travelport and the sale is recorded, but issuing needs
            AirCreateReservation and AirTicketing against the same account, which is not wired yet. Do not tell a
            passenger they are ticketed until that step exists and returns a ticket number.
          </p>
        </div>
      </Section>

      <Section tone="surface" className="!pt-0">
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            <div className="rounded-xl2 border border-hair bg-white p-5">
              <h2 className="text-[15px] font-bold text-navy-900">Itinerary</h2>
              <div className="mt-4 space-y-4">
                {booking.itinerary.map((s, i) => (
                  <div key={i} className="border-l-[3px] border-teal-600 pl-3.5">
                    <div className="tnum text-[15px] font-bold text-navy-900">{s.carrier} {s.flightNumber}</div>
                    <div className="tnum mt-1 text-[13.5px] text-ink">
                      {s.origin} {s.departure.slice(11, 16)} → {s.destination} {s.arrival.slice(11, 16)}
                    </div>
                    <div className="tnum mt-0.5 text-[12px] text-muted">
                      {s.departure.slice(0, 10)} · {Math.floor(s.minutes / 60)}h {s.minutes % 60}m
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl2 border border-hair bg-white">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="border-b border-hair bg-panel">
                    {['Passenger', 'Date of birth', 'Passport', 'Nationality'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {booking.passengers.map((p, i) => (
                    <tr key={i}>
                      <td className="border-b border-hair px-4 py-3 text-[13.5px] font-semibold text-navy-900">
                        {p.title} {p.firstName} {p.lastName}
                      </td>
                      <td className="tnum border-b border-hair px-4 py-3 text-[13px]">{p.dob || '—'}</td>
                      <td className="tnum border-b border-hair px-4 py-3 text-[13px]">{p.passport || '—'}</td>
                      <td className="border-b border-hair px-4 py-3 text-[13px]">{p.nationality || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-xl2 border border-hair bg-white p-5">
              <h2 className="text-[15px] font-bold text-navy-900">Contact</h2>
              <div className="mt-3 grid gap-2 text-[13.5px] sm:grid-cols-3">
                <div><span className="block text-[11px] uppercase tracking-wide text-muted">Name</span>{booking.contact.name}</div>
                <div className="tnum"><span className="block text-[11px] uppercase tracking-wide text-muted">Mobile</span>{booking.contact.phone}</div>
                <div className="break-all"><span className="block text-[11px] uppercase tracking-wide text-muted">Email</span>{booking.contact.email || '—'}</div>
              </div>
            </div>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
            <div className="rounded-xl2 border border-hair bg-white p-5 shadow-card">
              <h2 className="text-[15px] font-bold text-navy-900">What was charged</h2>
              <div className="mt-4 space-y-1.5 text-[13px]">
                <div className="flex justify-between"><span className="text-muted">Fare × {booking.passengers.length}</span>
                  <span className="tnum font-semibold">{money(booking.fare.total * booking.passengers.length)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Service charge</span>
                  <span className="tnum font-semibold">{money(booking.serviceCharge)}</span></div>
                <div className="flex justify-between border-t border-hair pt-2 text-[16px]">
                  <span className="font-bold text-navy-900">Total</span>
                  <span className="tnum font-bold text-navy-900">{money(booking.grandTotal)}</span>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Chip tone="navy">{booking.fare.cabin} · {booking.fare.bookingCode}</Chip>
                {booking.fare.refundable && <Chip tone="teal">Refundable</Chip>}
                {booking.fare.platingCarrier && <Chip tone="muted">Plating {booking.fare.platingCarrier}</Chip>}
              </div>
            </div>

            {booking.invoiceNo && (
              <div className="rounded-xl2 border border-hair bg-white p-5">
                <h2 className="text-[14px] font-bold text-navy-900">Posted to accounts</h2>
                <p className="tnum mt-2 text-[16px] font-bold text-teal-700">{booking.invoiceNo}</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                  A confirmed invoice and the matching airline bill were written into the book, so this sale is
                  already in receivables and the margin report.
                </p>
                <Link href="/accounts/invoices" className="mt-3 inline-block text-[13px] font-semibold text-teal-700 hover:underline">
                  Open it in Accounts →
                </Link>
              </div>
            )}

            <Link href="/portal/flights" className="block rounded-lg border border-hair bg-white px-5 py-3 text-center text-[13px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700">
              Book another
            </Link>
          </aside>
        </div>
      </Section>
    </>
  );
}
