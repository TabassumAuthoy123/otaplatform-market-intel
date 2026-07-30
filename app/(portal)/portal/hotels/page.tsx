import { HotelCard } from '@/components/portal/cards';
import { Section, SectionTitle } from '@/components/portal/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function HotelsPage() {
  const c = await getContent();
  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[36px]">Hotels</h1>
          <p className="mt-3 max-w-2xl text-[14.5px] text-white/70">
            Rooms in the cities Bangladeshi travellers book most — the Gulf, Southeast Asia and domestic.
          </p>
        </div>
      </section>

      <Section tone="surface">
        <SectionTitle kicker={`${c.hotels.length} locations`} title="Sample nightly rates" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.hotels.map((h) => (
            <HotelCard key={h.name} h={h} />
          ))}
        </div>
      </Section>
    </>
  );
}
