import { RouteCard } from '@/components/cards';
import { SearchWidget } from '@/components/SearchWidget';
import { Chip, Section, SectionTitle } from '@/components/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function FlightsPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string; depart?: string; pax?: string };
}) {
  const c = await getContent();
  const q = (searchParams.to ?? '').trim().toLowerCase();
  const qf = (searchParams.from ?? '').trim().toLowerCase();

  const matches = c.routes.filter((r) => {
    const toOk = !q || r.to.toLowerCase().includes(q) || r.toCode.toLowerCase().includes(q);
    const fromOk = !qf || qf.includes(r.from.toLowerCase()) || r.fromCode.toLowerCase().includes(qf);
    return toOk && fromOk;
  });

  const shown = matches.length > 0 ? matches : c.routes;
  const filtered = q.length > 0;

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

      <Section tone="surface">
        <div className="mb-7 flex flex-wrap items-center gap-3">
          <SectionTitle
            title={filtered ? `Fares to “${searchParams.to}”` : 'All sample routes'}
            sub={
              filtered && matches.length === 0
                ? 'No sample route matches that destination — showing everything instead.'
                : undefined
            }
          />
        </div>

        {searchParams.depart || searchParams.pax ? (
          <div className="mb-6 flex flex-wrap gap-2">
            {searchParams.depart && <Chip tone="navy">Departing {searchParams.depart}</Chip>}
            {searchParams.pax && <Chip tone="navy">{searchParams.pax} travellers</Chip>}
            <Chip tone="amber">Indicative sample data</Chip>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <RouteCard key={r.fromCode + r.toCode + r.airline} r={r} />
          ))}
        </div>
      </Section>
    </>
  );
}
