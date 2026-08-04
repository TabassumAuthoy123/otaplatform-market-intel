import Link from 'next/link';
import { RouteCard } from '@/components/portal/cards';
import { SearchWidget } from '@/components/portal/SearchWidget';
import { Chip, Section, SectionTitle } from '@/components/portal/ui';
import { getContent } from '@/lib/content';
import { SUPPLIER_LABEL, searchAllSuppliers } from '@/lib/offers';

export const dynamic = 'force-dynamic';

const code = (s: string) => {
  const m = s.match(/\(([A-Z]{3})\)/) || s.match(/\b([A-Z]{3})\b/);
  return (m ? m[1] : s).toUpperCase();
};

export default async function FlightsPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string; depart?: string; pax?: string };
}) {
  const c = await getContent();
  const q = (searchParams.to ?? '').trim().toLowerCase();
  const qf = (searchParams.from ?? '').trim().toLowerCase();
  const searched = q.length > 0;

  const matches = c.routes.filter((r) => {
    const toOk = !q || r.to.toLowerCase().includes(q) || r.toCode.toLowerCase().includes(q);
    const fromOk = !qf || qf.includes(r.from.toLowerCase()) || r.fromCode.toLowerCase().includes(qf);
    return toOk && fromOk;
  });
  const shown = matches.length > 0 ? matches : c.routes;

  const result = searched
    ? await searchAllSuppliers({
        from: code(searchParams.from ?? ''),
        to: code(searchParams.to ?? ''),
        date: searchParams.depart ?? '',
        adults: (searchParams.pax ?? '1').replace(/\D/g, '') || '1'
      })
    : null;

  const offers = result?.offers ?? [];
  const suppliers = result?.suppliers ?? [];
  const anyConfigured = result ? result.anyConfigured : true;

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 pb-8 pt-12 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[36px]">Flights</h1>
          <p className="mt-3 max-w-2xl text-[14.5px] text-white/70">
            Sample fares across the routes Bangladeshi travellers fly most. Live availability below comes from Sabre and
            Travelport.
          </p>
          <div className="mt-8">
            <SearchWidget tabs={c.hero.searchTabs} origins={c.hero.popularFrom} />
          </div>
        </div>
      </section>

      {/* --------------------------------------------- supplier status */}
      <Section tone="surface" className="!py-8">
        <div className="grid gap-3 sm:grid-cols-2">
          {(suppliers.length ? suppliers : []).map((sp) => (
            <div
              key={sp.supplier}
              className={`rounded-xl2 border-l-[3px] bg-white px-5 py-4 shadow-card ${
                sp.offerCount > 0 ? 'border-teal-600' : 'border-amber-700'
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`chip ${
                    sp.offerCount > 0
                      ? 'border-teal-600/30 bg-teal-600/10 text-teal-700'
                      : 'border-amber-700/30 bg-amber-700/10 text-amber-700'
                  }`}
                >
                  {SUPPLIER_LABEL[sp.supplier]}
                </span>
                <span className="tnum text-[13.5px] font-semibold text-navy-900">
                  {sp.offerCount > 0 ? `${sp.offerCount} fares` : 'no fares'}
                </span>
                {sp.elapsedMs !== undefined && (
                  <span className="tnum text-[12px] text-muted">{sp.elapsedMs}ms</span>
                )}
                {sp.host && <span className="tnum text-[11.5px] text-muted">{sp.host}</span>}
              </div>
              {sp.problem && (
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{sp.problem}</p>
              )}
              {!sp.problem && sp.offerCount === 0 && (
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                  Answered normally with nothing for this route — the sandbox has no inventory on that pair, which
                  is not the same as a failure.
                </p>
              )}
            </div>
          ))}
          {!searched && (
            <div className="rounded-xl2 border-l-[3px] border-teal-600 bg-white px-5 py-4 shadow-card sm:col-span-2">
              <p className="text-[13.5px] font-semibold text-navy-900">
                Search a route to query Travelport and Sabre together.
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                Both are asked at the same time and the fares below are merged, cheapest first, each labelled with
                the supplier that quoted it.
              </p>
            </div>
          )}
        </div>
      </Section>

      {/* --------------------------------------------------- merged live fares */}
      {searched && anyConfigured && (
        <Section tone="white" className="!pt-0">
          <SectionTitle
            kicker="Live fares"
            title={offers.length ? `${offers.length} fares from ${suppliers.filter((s) => s.offerCount > 0).map((s) => SUPPLIER_LABEL[s.supplier]).join(' and ')}` : 'No live fares for this route'}
            sub={
              offers.length
                ? result?.cachedAgeMs !== undefined
                  ? `Cheapest first, across both suppliers · quoted ${Math.round(result.cachedAgeMs / 1000)}s ago and re-priced against the supplier when you confirm`
                  : 'Cheapest first, across both suppliers.'
                : undefined
            }
          />
          {offers.length > 0 ? (
            <div className="grid gap-3">
              {offers.slice(0, 20).map((o) => (
                <div key={o.sig} className="card flex flex-wrap items-center justify-between gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap gap-2">
                      <Chip tone={o.supplier === 'travelport' ? 'navy' : 'teal'}>{SUPPLIER_LABEL[o.supplier]}</Chip>
                      {o.stops === 0 ? <Chip tone="muted">Direct</Chip> : <Chip tone="muted">{o.stops} stop{o.stops > 1 ? 's' : ''}</Chip>}
                      {o.cabin && <Chip tone="muted">{o.cabin}{o.bookingCode ? ` · ${o.bookingCode}` : ''}</Chip>}
                      {o.refundable && <Chip tone="teal">Refundable</Chip>}
                    </div>
                    {o.segments.map((sg, i) => (
                      <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="tnum text-[15px] font-bold text-navy-900">
                          {sg.carrier} {sg.flightNumber}
                        </span>
                        <span className="tnum text-[14px] text-ink">
                          {sg.origin} {sg.departure.slice(11, 16)} → {sg.destination} {sg.arrival.slice(11, 16)}
                        </span>
                        <span className="tnum text-[12px] text-muted">
                          {Math.floor(sg.minutes / 60)}h {sg.minutes % 60}m
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="tnum text-[22px] font-bold text-navy-900">
                      ৳{o.amount.toLocaleString('en-IN')}
                    </div>
                    <div className="tnum text-[11.5px] text-muted">base {o.baseLabel} · tax {o.taxLabel}</div>
                    {o.latestTicketing && (
                      <div className="tnum mt-0.5 text-[11px] text-amber-700">
                        ticket by {o.latestTicketing.slice(0, 10)}
                      </div>
                    )}
                    <Link
                      href={`/portal/book?from=${encodeURIComponent(code(searchParams.from ?? ''))}&to=${encodeURIComponent(code(searchParams.to ?? ''))}&date=${encodeURIComponent(searchParams.depart ?? '')}&sig=${encodeURIComponent(o.sig)}`}
                      className="mt-2.5 inline-block rounded-lg bg-teal-600 px-5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-teal-700"
                    >
                      Select
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-muted">
              Neither supplier returned a priced itinerary for this route and date. The status panels above say what
              each of them answered.
            </p>
          )}
        </Section>
      )}

      {/* ----------------------------------------------------- sample fares */}
      <Section tone="surface" className={searched ? '' : '!pt-0'}>
        <div className="mb-7">
          <SectionTitle
            title={searched ? `Sample fares to “${searchParams.to}”` : 'All sample routes'}
            sub={
              searched && matches.length === 0
                ? 'No sample route matches that destination — showing everything instead.'
                : undefined
            }
          />
        </div>

        <div className="mb-6 flex flex-wrap gap-2">
          <Chip tone="amber">Indicative sample data</Chip>
          {searchParams.depart && <Chip tone="navy">Departing {searchParams.depart}</Chip>}
          {searchParams.pax && <Chip tone="navy">{searchParams.pax} travellers</Chip>}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <RouteCard key={r.fromCode + r.toCode + r.airline} r={r} />
          ))}
        </div>

        <p className="mt-8 max-w-3xl text-[12.5px] leading-relaxed text-muted">
          These prices are invented for the demo. On the production platform this grid is filled from the live
          Sabre and Travelport search above. Never quote a figure from this page to a customer.{' '}
          <Link href="/accounts/gds" className="font-semibold text-teal-700 hover:underline">
            The PNR side of the same connection is on the accounts screen →
          </Link>
        </p>
      </Section>
    </>
  );
}
