import Link from 'next/link';
import { ModuleLink } from '@/components/ModuleLink';
import { PANEL_MODULES, enabledModules } from '@/lib/panelMenus';
import { getCompetitors, getMarket } from '@/lib/market';

// Runs off content/crm-leads.json — the same 400 records the sales floor calls
// from, so the wall numbers and the queue can never disagree.
export const dynamic = 'force-dynamic';

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

function Tile({
  value, label, sub, tone = 'plain', href
}: {
  value: string; label: string; sub?: string; tone?: 'plain' | 'good' | 'warn'; href?: string;
}) {
  const accent = tone === 'good' ? 'text-teal-700' : tone === 'warn' ? 'text-amber-700' : 'text-navy-900';
  const inner = (
    <>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum mt-1.5 text-[28px] font-bold leading-none ${accent}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-snug text-muted">{sub}</div>}
    </>
  );
  const cls = 'rounded-xl2 border border-hair bg-white px-5 py-4 block';
  return href ? (
    <Link href={href} className={`${cls} transition-colors hover:border-teal-500`}>{inner}</Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function Panel({ title, sub, children, action }: { title: string; sub?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl2 border border-hair bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hair px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-bold text-navy-900">{title}</h2>
          {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Bar({ label, value, max, note, href }: { label: string; value: number; max: number; note?: string; href?: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="py-2">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        {href ? (
          <Link href={href} className="text-[13px] text-ink hover:text-teal-700">{label}</Link>
        ) : (
          <span className="text-[13px] text-ink">{label}</span>
        )}
        <span className="tnum shrink-0 text-[13px] font-semibold text-navy-900">
          {value}{note && <span className="ml-2 font-normal text-muted">{note}</span>}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-panel">
        <div className="h-full rounded-full bg-teal-600" style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

export default async function Dashboard() {
  const m = await getMarket();
  const comp = await getCompetitors();

  /**
   * Drop a drill-down when the module it drills into is switched off.
   *
   * Twelve tiles and bars on this page link into `/agencies`. With that module off
   * they were still clickable and every one of them landed on the 404 the panel
   * toggles had just created — a broken link manufactured by the feature meant to
   * tidy things up. Returning `undefined` is what makes this cheap: `Tile` and
   * `Bar` already render a plain div or span when `href` is absent, so the number
   * and its label survive and only the navigation goes.
   */
  const enabled = new Set((await enabledModules('dashboard')).map((x) => x.href));
  const off = new Set(
    PANEL_MODULES.filter((x) => x.group === 'dashboard' && !enabled.has(x.href)).map((x) => x.href)
  );
  const ok = (href: string) => (off.has(href.split('?')[0]) ? undefined : href);

  const iata = m.byCredential.find((c) => c.key === 'iata')!.count;
  const hajj = m.byCredential.find((c) => c.key === 'hajj')!.count;
  const baira = m.byCredential.find((c) => c.key === 'baira')!.count;
  const toab = m.byCredential.find((c) => c.key === 'toab')!.count;
  const noNumber = m.byCredential.find((c) => c.key === 'none')!.count;
  const noEngine = m.byEngine.find((e) => e.key === 'none_seen')!.count;
  const brochure = m.byEngine.find((e) => e.key === 'brochure')!.count;
  const liveEngine = m.byEngine.find((e) => e.key === 'live_engine')!.count;

  const maxTier = Math.max(...m.byTier.map((t) => t.count), 1);
  const maxCity = Math.max(...m.byCity.map((c) => c.count), 1);
  const maxSeg = Math.max(...m.bySegment.map((s) => s.count), 1);

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-teal-600">
          Softifybd · OTA Platform · B2B market intelligence
        </div>
        <h1 className="text-[26px] font-bold leading-tight text-navy-900 sm:text-[32px]">
          Who to sell a white-label OTA to in Bangladesh
        </h1>
        <p className="mt-2.5 max-w-3xl text-[14px] leading-relaxed text-muted">
          {m.pipeline.total} agencies compiled from the TOAB directory, the BAIRA register, the ATAB member
          directory and the Ministry of Religious Affairs Hajj register. Every figure below is counted from those
          records at page load — nothing is typed in by hand.
        </p>
      </div>

      {/* ------------------------------------------------- headline numbers */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile value={String(m.pipeline.total)} label="Prospects in the database" sub="Compiled from four public registers" href={ok('/agencies')} />
        <Tile value={String(iata)} label="IATA accredited" sub="Quoted by the agency or its register entry" tone="good" href={ok('/agencies?credential=iata')} />
        <Tile value={String(hajj)} label="Hajj licence holders" sub="MoRA register printed a licence number" tone="good" href={ok('/agencies?credential=hajj')} />
        <Tile value={String(noEngine + brochure)} label="No booking engine" sub={`${noEngine} with no website at all · ${brochure} brochure-only`} tone="good" href={ok('/agencies?engine=none_seen')} />
      </div>

      {/* -------------------------------------------- the two CEO questions */}
      <Panel
        title="The two questions you were asked"
        sub="Answered from the data, with the limits of the data stated"
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-[13px] font-bold text-navy-900">1. Who holds a Civil Aviation certificate?</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-ink">
              The credential people call a “Civil Aviation certificate” is the{' '}
              <strong>Travel Agency Registration Certificate</strong>, issued by the{' '}
              <strong>Ministry of Civil Aviation &amp; Tourism</strong> under the Travel Agency (Registration and
              Control) Act 2013 — not by CAAB. CAAB handles airports, airworthiness and aviation personnel. If an
              agency says “CAAB certified”, that is marketing language.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink">
              The register is <strong>TAMS — regtravelagency.gov.bd</strong>, and it publishes{' '}
              <strong>no bulk export</strong>. So this database cannot claim to be a licence list. What it can show
              is which register printed a number for each agency:
            </p>
            <div className="mt-3 space-y-1">
              <Bar label="TOAB membership number printed" value={toab} max={m.pipeline.total} href={ok('/agencies?credential=toab')} />
              <Bar label="BAIRA recruiting licence (RL) printed" value={baira} max={m.pipeline.total} href={ok('/agencies?credential=baira')} />
              <Bar label="Hajj licence number printed" value={hajj} max={m.pipeline.total} href={ok('/agencies?credential=hajj')} />
              <Bar label="No number printed in the source" value={noNumber} max={m.pipeline.total} href={ok('/agencies?credential=none')} />
            </div>
            <p className="mt-3 rounded-lg border-l-[3px] border-amber-700 bg-amber-700/5 px-4 py-2.5 text-[12.5px] leading-relaxed text-ink">
              “No number printed” does <strong>not</strong> mean unlicensed. It means the directory the record came
              from did not publish one. Verify on TAMS before you contract — never present this as a licence check.
            </p>
          </div>

          <div>
            <h3 className="text-[13px] font-bold text-navy-900">2. Who holds IATA?</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-ink">
              IATA publishes no bulk country export either. These <strong>{iata}</strong> are the agencies whose own
              site, trade-press entry or register line states accreditation. They are the highest-value segment:
              they already issue on their own stock, so they buy the sub-agent panel, the rules engine and the audit
              trail rather than the ticketing itself.
            </p>
            <ul className="mt-3 space-y-1.5">
              {m.iataTargets.slice(0, 10).map((l) => (
                <li key={l.lead_id} className="flex items-baseline justify-between gap-3 border-b border-hair py-1.5 last:border-0">
                  <span className="text-[13px] font-semibold text-navy-900">{l.company}</span>
                  <span className="tnum shrink-0 text-[11.5px] text-muted">{l.city || '—'}</span>
                </li>
              ))}
            </ul>
            {/* ModuleLink does its own check — ok() here would guard twice. */}
              <ModuleLink href="/agencies?credential=iata" className="mt-3 inline-block text-[13px] font-semibold text-teal-700 hover:underline">
              All {iata} IATA-accredited targets →
            </ModuleLink>
          </div>
        </div>
      </Panel>

      {/* ----------------------------------------------- the buying signal */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="The buying signal" sub="Observed by opening each agency's site — not inferred">
          <div className="space-y-1">
            {m.byEngine.map((e) => (
              <Bar
                key={e.key}
                label={e.label}
                value={e.count}
                max={m.pipeline.total}
                note={`${pct(e.count, m.pipeline.total)}%`}
                href={ok(`/agencies?engine=${e.key}`)}
              />
            ))}
          </div>
          <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
            {liveEngine === 0
              ? 'Not one agency checked so far runs a live booking engine of its own. Every site opened was a brochure or nothing at all.'
              : `${liveEngine} already run a live engine — those are displacement conversations, not greenfield.`}
          </p>
        </Panel>

        <Panel title="Can a caller actually reach them?" sub="A prospect you cannot dial is not a prospect">
          <div className="space-y-1">
            <Bar label="Has a mobile number" value={m.reach.withMobile} max={m.pipeline.total} note={`${pct(m.reach.withMobile, m.pipeline.total)}%`} href={ok('/agencies?hasMobile=yes')} />
            <Bar label="Has a landline" value={m.reach.withPhone} max={m.pipeline.total} note={`${pct(m.reach.withPhone, m.pipeline.total)}%`} />
            <Bar label="Has an email" value={m.reach.withEmail} max={m.pipeline.total} note={`${pct(m.reach.withEmail, m.pipeline.total)}%`} />
            <Bar label="Decision maker named" value={m.reach.withDecisionMaker} max={m.pipeline.total} note={`${pct(m.reach.withDecisionMaker, m.pipeline.total)}%`} />
            <Bar label="Has a website" value={m.reach.withWebsite} max={m.pipeline.total} note={`${pct(m.reach.withWebsite, m.pipeline.total)}%`} />
          </div>
          {m.reach.noContactAtAll > 0 && (
            <p className="mt-4 text-[12.5px] text-amber-700">
              {m.reach.noContactAtAll} records carry no phone and no email — field visit or drop them.
            </p>
          )}
        </Panel>
      </div>

      {/* ------------------------------------------------------ segmentation */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By tier" sub="How the research graded each agency">
          <div className="space-y-1">
            {m.byTier.map((t) => (
              <Bar key={t.tier} label={t.tier} value={t.count} max={maxTier} note={t.worked ? `${t.worked} worked` : undefined} />
            ))}
          </div>
        </Panel>

        <Panel title="By city" sub="Where the calling happens">
          <div className="space-y-1">
            {m.byCity.slice(0, 10).map((c) => (
              <Bar key={c.city} label={c.city} value={c.count} max={maxCity} href={ok(`/agencies?city=${encodeURIComponent(c.city)}`)} />
            ))}
          </div>
          <p className="mt-3 text-[12.5px] text-muted">{m.byCity.length} cities in total.</p>
        </Panel>
      </div>

      <Panel title="By business segment" sub="What they actually sell — drives which module you demo first">
        <div className="grid gap-x-8 sm:grid-cols-2">
          {m.bySegment.slice(0, 16).map((s) => (
            <Bar key={s.segment} label={s.segment} value={s.count} max={maxSeg} />
          ))}
        </div>
      </Panel>

      {/* ------------------------------------------------------- competitors */}
      <Panel
        title="Who you are up against"
        sub={`${comp.headline.vendorsProfiled} vendors profiled · only ${comp.headline.publishPricing} publish a price · ${comp.headline.foreignVendorsWithNamedBdClient} foreign vendors have a named Bangladeshi client`}
        action={
          <ModuleLink href="/competitors" className="text-[13px] font-semibold text-teal-700 hover:underline">
            Full battlecards →
          </ModuleLink>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {comp.groups[0].vendors.map((v) => (
            <div key={v.name} className="rounded-lg border border-hair bg-surface p-4">
              <div className="text-[13.5px] font-bold text-navy-900">{v.name}</div>
              <div className="mt-0.5 text-[11.5px] text-muted">{v.tag}</div>
              <div className="mt-2.5">
                <span className={`chip ${v.pricingPublished ? 'border-teal-600/30 bg-teal-600/10 text-teal-700' : 'border-hair bg-panel text-muted'}`}>
                  {v.pricingPublished ? 'Publishes price' : 'No public price'}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-lg border-l-[3px] border-teal-600 bg-teal-600/5 px-4 py-3">
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>The widest gap:</strong> {comp.gaps[0]}
          </p>
        </div>
      </Panel>

      {/* ------------------------------------------------------- call status */}
      <Panel
        title="Calling progress"
        sub="Updated live from the CRM in the admin portal"
        action={
          <span className="text-[12.5px] text-muted">
            Work the queue at <span className="font-semibold text-navy-900">localhost:4001/crm</span>
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Tile value={String(m.pipeline.worked)} label="Worked at least once" sub={`${pct(m.pipeline.worked, m.pipeline.total)}% coverage`} tone={m.pipeline.worked ? 'good' : 'warn'} />
          <Tile value={String(m.pipeline.contacted)} label="Reached a human" />
          <Tile value={String(m.pipeline.demos)} label="Demos scheduled" />
          <Tile value={String(m.pipeline.won)} label="Won" tone="good" />
          <Tile value={String(m.pipeline.total - m.pipeline.assigned)} label="Nobody owns these" tone={m.pipeline.assigned < m.pipeline.total ? 'warn' : 'good'} />
        </div>
      </Panel>

      <div className="rounded-xl2 border border-hair bg-panel px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-muted">
          <strong className="text-navy-900">Provenance.</strong> Sources:{' '}
          {m.bySource.map((s) => `${s.source} (${s.count})`).join(' · ')}. Phone numbers, emails and addresses are
          reproduced exactly as printed in those registers, including legacy Dhaka landlines and known typographic
          artefacts. Open the source URL on a lead before disputing any field.
        </p>
      </div>
    </div>
  );
}
