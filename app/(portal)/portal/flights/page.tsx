import Link from 'next/link';
import { RouteCard } from '@/components/portal/cards';
import { SearchWidget } from '@/components/portal/SearchWidget';
import { Chip, Section, SectionTitle } from '@/components/portal/ui';
import { getContent } from '@/lib/content';
import { searchConfigStatus, searchFlights } from '@/lib/gds';

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

  const gds = searchConfigStatus();
  // Only spend a network round trip when someone has actually searched.
  const live =
    searched && gds.configured
      ? await searchFlights({
          from: code(searchParams.from ?? ''),
          to: code(searchParams.to ?? ''),
          date: searchParams.depart ?? '',
          adults: (searchParams.pax ?? '1').replace(/\D/g, '') || '1'
        })
      : null;

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 pb-8 pt-12 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[36px]">Flights</h1>
          <p className="mt-3 max-w-2xl text-[14.5px] text-white/70">
            Sample fares across the routes Bangladeshi travellers fly most. Live availability comes from Sabre,
            Travelport and Flyhub on the production platform.
          </p>
          <div className="mt-8">
            <SearchWidget tabs={c.hero.searchTabs} origins={c.hero.popularFrom} />
          </div>
        </div>
      </section>

      {/* --------------------------------------------- what this search is */}
      <Section tone="surface" className="!py-8">
        <div
          className={`rounded-xl2 border-l-[3px] bg-white px-5 py-4 shadow-card ${
            gds.configured ? 'border-teal-600' : 'border-amber-700'
          }`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`chip ${
                gds.configured
                  ? 'border-teal-600/30 bg-teal-600/10 text-teal-700'
                  : 'border-amber-700/30 bg-amber-700/10 text-amber-700'
              }`}
            >
              {gds.configured ? 'Live GDS connected' : 'Live GDS not connected'}
            </span>
            <p className="text-[13.5px] font-semibold text-navy-900">
              {gds.configured
                ? 'Searches call the configured Travelport endpoint.'
                : 'This search filters demo data. It does not call Travelport.'}
            </p>
          </div>

          {!gds.configured && (
            <div className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-muted">
              <p>
                Nothing is broken — the connection has never been switched on. The fares below are the sample
                routes in <code className="rounded bg-panel px-1.5 py-0.5">content/site.json</code>, which is why
                the same nine routes always come back whatever you type.
              </p>
              <p>
                Missing from <code className="rounded bg-panel px-1.5 py-0.5">.env</code>:{' '}
                {gds.missing.map((m) => (
                  <span key={m} className="tnum mr-2 font-semibold text-amber-700">
                    {m}
                  </span>
                ))}
              </p>
              <p>
                Copy <code className="rounded bg-panel px-1.5 py-0.5">.env.example</code> to{' '}
                <code className="rounded bg-panel px-1.5 py-0.5">.env</code>, fill in the GDS block from your own
                Travelport API documentation, and restart the app. Full instructions in{' '}
                <span className="font-semibold text-navy-900">GETTING-STARTED.md §5</span>.
              </p>
            </div>
          )}
        </div>
      </Section>

      {/* ------------------------------------------------------ live result */}
      {live && (
        <Section tone="white" className="!pt-0">
          <SectionTitle
            kicker="Live GDS"
            title={live.upstreamOk ? `Travelport responded in ${live.elapsedMs}ms` : 'Travelport did not return fares'}
            sub={live.endpointHost ? `Endpoint ${live.endpointHost}` : undefined}
          />
          {live.error ? (
            <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
              <p className="text-[13.5px] font-semibold text-amber-700">{live.error}</p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                The call left this machine and failed. Usual causes: the path in{' '}
                <code className="rounded bg-panel px-1.5 py-0.5">GDS_SEARCH_PATH</code> is wrong for your Travelport
                product, or your public IP is not whitelisted with Travelport.
              </p>
            </div>
          ) : (
            <pre className="max-h-[460px] overflow-auto rounded-xl2 bg-navy-950 p-5 text-[12px] leading-relaxed text-teal-300">
              {typeof live.data === 'string' ? live.data : JSON.stringify(live.data, null, 2)}
            </pre>
          )}
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            Raw upstream response. Mapping it into fare cards is the next step once the endpoint is confirmed — the
            response shape differs between Travelport products, so it is not guessed here.
          </p>
        </Section>
      )}

      {/* ----------------------------------------------------- sample fares */}
      <Section tone="surface" className={live ? '' : '!pt-0'}>
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
          These prices are invented for the demo. On the production platform this grid is filled from Sabre,
          Travelport and Flyhub. Never quote a figure from this page to a customer.{' '}
          <Link href="/accounts/gds" className="font-semibold text-teal-700 hover:underline">
            The PNR side of the same connection is on the accounts screen →
          </Link>
        </p>
      </Section>
    </>
  );
}
