import Link from 'next/link';
import { PackageCard, RouteCard } from '@/components/cards';
import { SearchWidget } from '@/components/SearchWidget';
import { Button, Chip, Icon, Section, SectionTitle, Stat } from '@/components/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const c = await getContent();
  const topRoutes = c.routes.slice(0, 6);
  const topPackages = c.packages.slice(0, 3);

  return (
    <>
      {/* ---------------------------------------------------------------- hero */}
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 pb-8 pt-16 sm:px-8 sm:pt-20">
          <div className="max-w-3xl">
            <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-300">{c.hero.kicker}</div>
            <h1 className="mt-4 text-[32px] font-bold leading-[1.12] sm:text-[46px]">{c.hero.title}</h1>
            <p className="mt-5 max-w-2xl text-[15.5px] leading-relaxed text-white/75">{c.hero.subtitle}</p>

            <div className="mt-7 flex flex-wrap gap-3">
              <Button href={c.hero.primaryCta.href}>{c.hero.primaryCta.label}</Button>
              <Button href={c.hero.secondaryCta.href} variant="onNavy">
                {c.hero.secondaryCta.label}
              </Button>
            </div>

            <div className="mt-8 flex flex-wrap gap-2">
              {c.hero.badges.map((b) => (
                <span
                  key={b}
                  className="rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-[11.5px] font-semibold text-white/85"
                >
                  {b}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-12">
            <SearchWidget tabs={c.hero.searchTabs} origins={c.hero.popularFrom} />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- trust numbers */}
      <Section tone="white" className="!py-11">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {c.trustStats.map((s) => (
            <Stat key={s.label} value={s.value} label={s.label} sub={s.sub} />
          ))}
        </div>
      </Section>

      {/* ----------------------------------------------------------- services */}
      <Section tone="surface">
        <SectionTitle kicker="What you can book" title="Everything a Bangladeshi traveller actually needs" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.services.map((s) => (
            <div key={s.title} className="card p-6">
              <div className="grid h-11 w-11 place-items-center rounded-lg bg-teal-600/10 text-teal-700">
                <Icon name={s.icon} className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-[16px] font-bold text-navy-900">{s.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{s.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- routes */}
      <Section tone="white">
        <div className="mb-9 flex flex-wrap items-end justify-between gap-4">
          <SectionTitle kicker="Popular right now" title="Fares from Dhaka" />
          <Link href="/flights" className="mb-2 text-[13.5px] font-semibold text-teal-700 hover:underline">
            All routes →
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {topRoutes.map((r) => (
            <RouteCard key={r.fromCode + r.toCode + r.airline} r={r} />
          ))}
        </div>
      </Section>

      {/* ----------------------------------------------------------- packages */}
      <Section tone="surface">
        <div className="mb-9 flex flex-wrap items-end justify-between gap-4">
          <SectionTitle
            kicker="Hajj · Umrah · Tours"
            title="Packages with the inclusion list printed on the front"
            sub="No surprise add-ons at the counter. What is listed is what is in the price."
          />
          <Link href="/packages" className="mb-2 text-[13.5px] font-semibold text-teal-700 hover:underline">
            All packages →
          </Link>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {topPackages.map((p) => (
            <PackageCard key={p.title} p={p} />
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------- why */}
      <Section tone="white">
        <SectionTitle kicker="Why this platform" title="Built for agencies that want to own their own customers" />
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {c.why.map((w, i) => (
            <div key={w.title}>
              <div className="tnum text-[12px] font-bold text-teal-600">{String(i + 1).padStart(2, '0')}</div>
              <h3 className="mt-2 text-[15.5px] font-bold text-navy-900">{w.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{w.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* -------------------------------------------------------- credentials */}
      <Section tone="panel" className="!py-12">
        <div className="mb-7 flex items-center gap-3">
          <Icon name="shield" className="h-5 w-5 text-teal-700" />
          <h2 className="text-[15px] font-bold uppercase tracking-[0.1em] text-navy-900">Verifiable credentials</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {c.credentials.map((cr) => (
            <div key={cr.label} className="flex items-baseline gap-3 rounded-lg border border-hair bg-white px-4 py-3.5">
              <span className="text-[13.5px] font-bold text-navy-900">{cr.label}</span>
              <span className="text-[12px] text-muted">{cr.note}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* -------------------------------------------------------- testimonials */}
      {c.testimonials.items.length > 0 && (
        <Section tone="white">
          <SectionTitle kicker="Clients" title="What agencies say" />
          <div className="grid gap-4 lg:grid-cols-3">
            {c.testimonials.items.map((t) => (
              <figure key={t.name + t.city} className="card p-6">
                <div className="tnum text-[12px] text-amber-700">{'★'.repeat(Math.max(0, Math.min(5, t.rating)))}</div>
                <blockquote className="mt-3 text-[14px] leading-relaxed text-ink">“{t.quote}”</blockquote>
                <figcaption className="mt-4 text-[12.5px] font-semibold text-navy-900">
                  {t.name} <span className="font-normal text-muted">· {t.city}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </Section>
      )}

      {/* ----------------------------------------------------------- agent CTA */}
      <Section tone="navy">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-300">{c.agentCta.kicker}</div>
            <h2 className="mt-4 text-[26px] font-bold leading-tight sm:text-[32px]">{c.agentCta.title}</h2>
            <p className="mt-5 text-[15px] leading-relaxed text-white/70">{c.agentCta.body}</p>
            <div className="mt-7">
              <Button href={c.agentCta.cta.href}>{c.agentCta.cta.label}</Button>
            </div>
          </div>
          <ul className="grid gap-3 self-start sm:grid-cols-2 lg:grid-cols-1">
            {c.agentCta.bullets.map((b) => (
              <li key={b} className="flex gap-3 rounded-lg border border-white/12 bg-white/5 px-4 py-3">
                <Icon name="check" className="mt-[3px] h-4 w-4 shrink-0 text-teal-300" />
                <span className="text-[13.5px] leading-snug text-white/85">{b}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </>
  );
}
