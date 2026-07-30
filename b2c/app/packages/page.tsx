import { PackageCard } from '@/components/cards';
import { Section, SectionTitle } from '@/components/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function PackagesPage() {
  const c = await getContent();
  const kinds = Array.from(new Set(c.packages.map((p) => p.kind)));

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[36px]">Hajj, Umrah & tour packages</h1>
          <p className="mt-3 max-w-2xl text-[14.5px] text-white/70">
            Every package lists what is included on the card. Instalment plans are available on Hajj packages.
          </p>
        </div>
      </section>

      {kinds.map((kind, idx) => (
        <Section key={kind} tone={idx % 2 === 0 ? 'surface' : 'white'}>
          <SectionTitle kicker={`${c.packages.filter((p) => p.kind === kind).length} packages`} title={kind} />
          <div className="grid gap-4 lg:grid-cols-3">
            {c.packages
              .filter((p) => p.kind === kind)
              .map((p) => (
                <PackageCard key={p.title} p={p} />
              ))}
          </div>
        </Section>
      ))}

      <Section tone="panel" className="!py-11">
        <p className="max-w-3xl text-[13.5px] leading-relaxed text-muted">
          Hajj packages are only sold by agencies on the Ministry of Religious Affairs approved list for the season.
          Ask any agency for its licence number before you pay a deposit — including us.
        </p>
      </Section>
    </>
  );
}
