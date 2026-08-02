import { getCompetitors } from '@/lib/market';

export const dynamic = 'force-dynamic';

const THREAT: Record<string, string> = {
  high: 'border-amber-700/30 bg-amber-700/10 text-amber-700',
  medium: 'border-navy-900/20 bg-navy-900/5 text-navy-900',
  low: 'border-hair bg-panel text-muted'
};

export default async function CompetitorsPage() {
  const c = await getCompetitors();

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-teal-600">Competitive landscape</div>
        <h1 className="text-[26px] font-bold leading-tight text-navy-900 sm:text-[30px]">Who else is selling OTA software in Bangladesh</h1>
        <p className="mt-2.5 max-w-3xl text-[14px] leading-relaxed text-muted">{c._meta.note}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl2 border border-hair bg-white px-5 py-4">
          <div className="tnum text-[28px] font-bold text-navy-900">{c.headline.vendorsProfiled}</div>
          <div className="mt-1 text-[12.5px] text-muted">vendors profiled</div>
        </div>
        <div className="rounded-xl2 border border-hair bg-white px-5 py-4">
          <div className="tnum text-[28px] font-bold text-teal-700">{c.headline.publishPricing}</div>
          <div className="mt-1 text-[12.5px] text-muted">publish a price — a written quote is itself a differentiator</div>
        </div>
        <div className="rounded-xl2 border border-hair bg-white px-5 py-4">
          <div className="tnum text-[28px] font-bold text-amber-700">{c.headline.foreignVendorsWithNamedBdClient}</div>
          <div className="mt-1 text-[12.5px] text-muted">foreign vendors with a named Bangladeshi client</div>
        </div>
      </div>

      {c.groups.map((g) => (
        <section key={g.key} className="space-y-4">
          <div>
            <h2 className="rule text-[20px] font-bold text-navy-900">Group {g.key} — {g.title}</h2>
            <p className="mt-3 text-[13.5px] text-muted">{g.note}</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {g.vendors.map((v) => (
              <article key={v.name} className="rounded-xl2 border border-hair bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[16px] font-bold text-navy-900">{v.name}</h3>
                    <p className="mt-0.5 text-[12.5px] text-muted">{v.tag}</p>
                  </div>
                  <span className={`chip ${THREAT[v.threat] ?? THREAT.low}`}>{v.threat} threat</span>
                </div>

                <div className="mt-4 rounded-lg border border-hair bg-surface px-4 py-3">
                  <div className="text-[10.5px] font-bold uppercase tracking-wide text-muted">
                    {v.pricingPublished ? 'Published pricing' : 'Pricing'}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{v.pricing}</p>
                </div>

                {v.address && <p className="mt-3 text-[12px] text-muted">{v.address}</p>}

                {v.strengths.length > 0 && (
                  <div className="mt-4">
                    <div className="text-[10.5px] font-bold uppercase tracking-wide text-teal-700">Their strength</div>
                    <ul className="mt-1.5 space-y-1">
                      {v.strengths.map((s) => (
                        <li key={s} className="text-[12.5px] leading-snug text-ink">· {s}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {v.weaknesses.length > 0 && (
                  <div className="mt-3.5">
                    <div className="text-[10.5px] font-bold uppercase tracking-wide text-amber-700">Where they are soft</div>
                    <ul className="mt-1.5 space-y-1">
                      {v.weaknesses.map((s) => (
                        <li key={s} className="text-[12.5px] leading-snug text-ink">· {s}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-4 rounded-lg border-l-[3px] border-navy-900 bg-navy-900/5 px-4 py-3">
                  <div className="text-[10.5px] font-bold uppercase tracking-wide text-navy-900">How to attack</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{v.attack}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="rounded-xl2 border border-hair bg-white p-6">
        <h2 className="rule text-[18px] font-bold text-navy-900">The gaps to attack</h2>
        <ol className="mt-5 space-y-3">
          {c.gaps.map((g, i) => (
            <li key={g} className="flex gap-3">
              <span className="tnum shrink-0 text-[12px] font-bold text-teal-600">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-[13.5px] leading-relaxed text-ink">{g}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink">
          Every claim here was read off the vendor's own published page. Prices move and pages get rewritten — check
          the vendor's site before quoting a competitor's number in front of a client, and never state a competitor
          weakness you have not seen yourself that week.
        </p>
      </div>
    </div>
  );
}
