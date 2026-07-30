import { EnquiryForm } from '@/components/EnquiryForm';
import { Chip, Icon, Section, SectionTitle } from '@/components/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const c = await getContent();

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-300">{c.agentCta.kicker}</div>
          <h1 className="mt-4 max-w-3xl text-[28px] font-bold leading-tight sm:text-[38px]">{c.agentCta.title}</h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/70">{c.agentCta.body}</p>
        </div>
      </section>

      <Section tone="surface">
        <div className="grid gap-10 lg:grid-cols-[1fr_420px]">
          <div>
            <SectionTitle kicker="What you get" title="The platform, in six lines" />
            <ul className="grid gap-3 sm:grid-cols-2">
              {c.agentCta.bullets.map((b) => (
                <li key={b} className="flex gap-3 rounded-lg border border-hair bg-white px-4 py-3.5">
                  <Icon name="check" className="mt-[3px] h-4 w-4 shrink-0 text-teal-600" />
                  <span className="text-[13.5px] leading-snug text-ink">{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-12">
              <SectionTitle kicker="Tiers" title="Pick by booking volume, not by feature list" />
              <div className="grid gap-4 sm:grid-cols-2">
                {c.agentTiers.map((t) => (
                  <div
                    key={t.name}
                    className={`rounded-xl2 border bg-white p-5 ${
                      t.featured ? 'border-teal-600 shadow-card' : 'border-hair'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-[16px] font-bold text-navy-900">{t.name}</h3>
                      {t.featured && <Chip tone="teal">Recommended</Chip>}
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted">{t.for}</p>
                    <ul className="mt-4 space-y-2">
                      {t.features.map((f) => (
                        <li key={f} className="flex gap-2.5 text-[13px] leading-snug text-ink">
                          <Icon name="check" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-teal-600" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="mt-5 rounded-lg border-l-[3px] border-teal-600 bg-teal-600/5 px-5 py-4">
                <p className="text-[13px] leading-relaxed text-ink">{c.pricingNote}</p>
              </div>
            </div>
          </div>

          <div className="lg:sticky lg:top-28 lg:self-start">
            <EnquiryForm />
            <div className="mt-4 rounded-lg border border-hair bg-white px-5 py-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted">Or call</div>
              <a
                href={`tel:${c.brand.hotline.replace(/[^0-9+]/g, '')}`}
                className="tnum mt-1 block text-[18px] font-bold text-navy-900 hover:text-teal-700"
              >
                {c.brand.hotline}
              </a>
              <div className="mt-1 text-[12.5px] text-muted">{c.contact.body}</div>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
