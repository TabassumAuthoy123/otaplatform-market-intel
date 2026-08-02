import Link from 'next/link';
import { BookingForm } from '@/components/portal/BookingForm';
import { Chip, Section, SectionTitle } from '@/components/portal/ui';
import { SUPPLIER_LABEL, repriceOffer } from '@/lib/offers';

export const dynamic = 'force-dynamic';

export default async function BookPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string; date?: string; sig?: string };
}) {
  const from = (searchParams.from ?? '').toUpperCase();
  const to = (searchParams.to ?? '').toUpperCase();
  const date = searchParams.date ?? '';
  const sig = searchParams.sig ?? '';

  const priced = from && to && sig ? await repriceOffer(sig, { from, to, date, adults: '1' }) : null;
  const offer = priced && priced.ok ? priced.offer : undefined;
  const problem = priced && !priced.ok ? priced.reason : null;

  const notice = (title: string, body: string) => (
    <Section tone="surface">
      <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-white px-5 py-5 shadow-card">
        <h2 className="text-[15px] font-bold text-navy-900">{title}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink">{body}</p>
        <Link href="/portal/flights" className="mt-4 inline-block rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">
          Back to search
        </Link>
      </div>
    </Section>
  );

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-300">Step 2 of 3 · Passenger details</div>
          <h1 className="mt-3 text-[28px] font-bold sm:text-[34px]">Complete your booking</h1>
          {offer && (
            <p className="mt-3 text-[14.5px] text-white/75">
              {offer.segments.map((s) => `${s.carrier}${s.flightNumber} ${s.origin}→${s.destination}`).join(' · ')}
            </p>
          )}
        </div>
      </section>

      {!offer
        ? notice(
            'That fare could not be confirmed',
            problem ?? 'The link was incomplete. Run the search again and pick a current fare — nothing has been charged or held.'
          )
        : (
            <Section tone="surface">
              <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
                <div>
                  <SectionTitle kicker="Who is travelling" title="Passenger details" sub="Names must match the passport exactly — airlines reject mismatches at check-in." />
                  <BookingForm
                    from={from} to={to} date={date} fareSig={offer.sig}
                    unitPrice={offer.amount} currency={offer.currency}
                  />
                </div>

                <aside className="lg:sticky lg:top-28 lg:self-start">
                  <div className="rounded-xl2 border border-hair bg-white p-5 shadow-card">
                    <h2 className="text-[15px] font-bold text-navy-900">Your itinerary</h2>
                    <div className="mt-4 space-y-4">
                      {offer.segments.map((s, i) => (
                        <div key={i} className="border-l-[3px] border-teal-600 pl-3.5">
                          <div className="tnum text-[15px] font-bold text-navy-900">{s.carrier} {s.flightNumber}</div>
                          <div className="tnum mt-1 text-[13px] text-ink">
                            {s.origin} {s.departure.slice(11, 16)} → {s.destination} {s.arrival.slice(11, 16)}
                          </div>
                          <div className="tnum mt-0.5 text-[12px] text-muted">
                            {s.departure.slice(0, 10)} · {Math.floor(s.minutes / 60)}h {s.minutes % 60}m
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-5 flex flex-wrap gap-2">
                      <Chip tone={offer.supplier === 'travelport' ? 'navy' : 'teal'}>{SUPPLIER_LABEL[offer.supplier]}</Chip>
                      {offer.cabin && <Chip tone="muted">{offer.cabin}{offer.bookingCode ? ` · ${offer.bookingCode}` : ''}</Chip>}
                      {offer.refundable && <Chip tone="teal">Refundable</Chip>}
                    </div>

                    <div className="mt-5 space-y-1.5 border-t border-hair pt-4 text-[13px]">
                      <div className="flex justify-between"><span className="text-muted">Base fare</span><span className="tnum font-semibold">{offer.baseLabel}</span></div>
                      <div className="flex justify-between"><span className="text-muted">Taxes</span><span className="tnum font-semibold">{offer.taxLabel}</span></div>
                      <div className="flex justify-between border-t border-hair pt-2 text-[15px]">
                        <span className="font-bold text-navy-900">Per passenger</span>
                        <span className="tnum font-bold text-navy-900">{offer.currency} {offer.amount.toLocaleString('en-IN')}</span>
                      </div>
                    </div>

                    {offer.latestTicketing && (
                      <p className="tnum mt-4 rounded-lg bg-amber-700/5 px-3.5 py-2.5 text-[12px] text-amber-700">
                        Ticket by {offer.latestTicketing.slice(0, 10)} or the fare is released
                      </p>
                    )}
                    <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
                      Live {SUPPLIER_LABEL[offer.supplier]} fare, re-priced against {SUPPLIER_LABEL[offer.supplier]}
                      when you confirm.
                    </p>
                  </div>
                </aside>
              </div>
            </Section>
          )}
    </>
  );
}
