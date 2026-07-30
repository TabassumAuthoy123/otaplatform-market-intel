import { Section, SectionTitle } from '@/components/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function AboutPage() {
  const c = await getContent();
  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[38px]">{c.about.title}</h1>
          <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-white/70">{c.about.body}</p>
        </div>
      </section>

      <Section tone="surface">
        <SectionTitle kicker="Company" title="The facts a prospect will check" />
        <div className="overflow-hidden rounded-xl2 border border-hair bg-white">
          {c.about.facts.map((f, i) => (
            <div
              key={f.k}
              className={`grid gap-1 px-5 py-4 sm:grid-cols-[220px_1fr] ${i > 0 ? 'border-t border-hair' : ''}`}
            >
              <div className="text-[12px] font-bold uppercase tracking-wide text-muted">{f.k}</div>
              <div className="text-[13.5px] text-ink">{f.v}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="white">
        <SectionTitle
          kicker="Capability"
          title="What the platform actually does today"
          sub="This list is the feature boundary — nothing on it is roadmap."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {c.about.capabilities.map((cap) => (
            <div key={cap.area} className="rounded-xl2 border border-hair bg-white p-5">
              <h3 className="text-[14.5px] font-bold text-navy-900">{cap.area}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{cap.detail}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="panel" className="!py-12">
        <SectionTitle kicker="Credentials" title="Verifiable, not decorative" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {c.credentials.map((cr) => (
            <div key={cr.label} className="rounded-lg border border-hair bg-white px-4 py-3.5">
              <div className="text-[13.5px] font-bold text-navy-900">{cr.label}</div>
              <div className="mt-0.5 text-[12px] text-muted">{cr.note}</div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
