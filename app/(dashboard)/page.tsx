import Link from 'next/link';
import { CLUSTERS, SEGMENTS } from '@/data/schema';
import {
  StatCard, SectionTitle, Kicker, BarRow, Donut, Callout, Card, PriorityChip, Tag
} from '@/components/ui';
import { countBy, getDataset } from '@/lib/agencies';

// Records come from content/agencies.json, which the admin portal writes.
export const dynamic = 'force-dynamic';

const bdt = (n: number) =>
  n >= 10000000 ? `৳${(n / 10000000).toFixed(2)} cr` : n >= 100000 ? `৳${(n / 100000).toFixed(1)} lakh` : `৳${n.toLocaleString()}`;

export default async function Dashboard() {
  const {
    agencies: AGENCIES, targets: TARGETS, excluded: EXCLUDED, stats: STATS, pipeline: PIPELINE
  } = await getDataset();

  const byCluster = countBy(TARGETS, (a) => a.clusterId);
  const clusterRows = CLUSTERS.map((c) => ({ c, n: byCluster.get(c.id) ?? 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const maxCluster = Math.max(...clusterRows.map((r) => r.n), 1);

  const bySegment = SEGMENTS.map((s) => ({
    s,
    n: TARGETS.filter((a) => a.segment === s.code || a.segmentSecondary === s.code).length
  }));
  const maxSeg = Math.max(...bySegment.map((r) => r.n), 1);

  const byDistrict = Array.from(countBy(TARGETS, (a) => a.district).entries()).sort((a, b) => b[1] - a[1]);
  const maxDist = Math.max(...byDistrict.map((d) => d[1]), 1);

  const topA = TARGETS.filter((a) => a.priority === 'A')
    .sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0))
    .slice(0, 10);

  return (
    <div className="space-y-14">
      {/* ============================== HERO ============================== */}
      <section className="-mx-5 -mt-8 bg-navy-950 px-5 py-14 lg:-mx-8 lg:px-8">
        <div className="mx-auto max-w-[1340px]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-400">
            Bangladesh B2B Market · July 2026
          </p>
          <h1 className="mt-3 max-w-4xl text-[38px] font-bold leading-[1.1] tracking-tight text-white lg:text-[52px]">
            Licensed travel agencies with <span className="text-teal-400">no OTA platform</span>
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/70">
            {STATS.targets} verified agencies selling manually or as sub-agents on someone else&rsquo;s
            IATA. Every name, address and phone number captured from live public business listings.
          </p>

          {/* headline credential numbers — the two the CEO asks for */}
          <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-teal-500/40 bg-teal-600/15 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                Civil Aviation certificate holders
              </p>
              <p className="mt-2 text-5xl font-bold tabular-nums text-white">{STATS.caabHeld}</p>
              <p className="mt-2 text-xs leading-snug text-white/60">
                Ministry of Civil Aviation &amp; Tourism licence via TAMS.
                <br />
                {STATS.caabVerified} verified · {STATS.caabInferred} inferred, pending portal check
              </p>
            </div>
            <div className="rounded-lg border border-white/15 bg-white/5 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                IATA registered
              </p>
              <p className="mt-2 text-5xl font-bold tabular-nums text-white">{STATS.iataHeld}</p>
              <p className="mt-2 text-xs leading-snug text-white/60">
                {STATS.iataVerified} verified number · {STATS.iataInferred} inferred from public claims
                <br />
                {STATS.iataUnknown} unknown — ask on the qualifying call
              </p>
            </div>
            <div className="rounded-lg border border-white/15 bg-white/5 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                Hajj / Umrah licensed
              </p>
              <p className="mt-2 text-5xl font-bold tabular-nums text-white">{STATS.hajjHeld}</p>
              <p className="mt-2 text-xs leading-snug text-white/60">
                Highest-margin niche. ~750 agencies cleared nationally for the 2026 season against a
                127,198-pilgrim quota.
              </p>
            </div>
            <div className="rounded-lg border border-white/15 bg-white/5 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                Addressable MRR
              </p>
              <p className="mt-2 text-5xl font-bold tabular-nums text-white">{bdt(PIPELINE.fullMrr)}</p>
              <p className="mt-2 text-xs leading-snug text-white/60">
                If every target signed at its suggested tier.
                <br />
                Priority A alone: {bdt(PIPELINE.aMrr)} / month
              </p>
            </div>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href="/agencies?priority=A"
              className="rounded bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-500"
            >
              Open the call list ({STATS.priorityA} Priority A)
            </Link>
            <Link
              href="/agencies"
              className="rounded border border-white/25 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
            >
              Full database ({STATS.total} records)
            </Link>
            <a
              href="/api/agencies?format=csv"
              className="rounded border border-white/25 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/10"
            >
              Export CSV
            </a>
          </div>
        </div>
      </section>

      {/* ========================== COVERAGE ============================== */}
      <section>
        <Kicker>Coverage</Kicker>
        <SectionTitle sub="What is actually in the database today, and how much of it is ready to dial.">
          Database at a glance
        </SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total records" value={STATS.total} note={`${STATS.targets} targets + ${STATS.excluded} excluded`} tone="navy" />
          <StatCard label="No platform — targetable" value={STATS.noPlatform} note="The core pitch applies to every one" tone="teal" />
          <StatCard label="Clusters" value={STATS.clusters} note={`Across ${STATS.districts} districts`} />
          <StatCard label="Phone number on file" value={STATS.targets - STATS.noPhone} suffix={`/ ${STATS.targets}`} note={`${STATS.noPhone} need a Facebook or walk-in approach`} />
          <StatCard label="Priority A — call first" value={STATS.priorityA} note="Strong fit + ability to pay" />
          <StatCard label="Priority B — wave two" value={STATS.priorityB} />
          <StatCard label="Priority C — qualify first" value={STATS.priorityC} />
          <StatCard label="Open 24/7" value={STATS.open247} note="Highest manual load — automation ROI lands hardest" tone="amber" />
        </div>
      </section>

      {/* ========================= CREDENTIALS =========================== */}
      <section>
        <Kicker>Credentials</Kicker>
        <SectionTitle sub="We never present an inferred credential as a fact. Verified means the number is published by the agency or confirmed on an official portal; inferred means a strong public signal that still has to be confirmed on the call.">
          Verified vs inferred
        </SectionTitle>
        <div className="grid gap-5 lg:grid-cols-3">
          <Card>
            <p className="mb-4 text-sm font-semibold text-navy-900">Civil Aviation licence (TAMS)</p>
            <Donut
              centerLabel="Records"
              centerValue={STATS.total}
              segments={[
                { label: 'Verified', value: STATS.caabVerified, color: '#0F6F73' },
                { label: 'Inferred', value: STATS.caabInferred, color: '#1FA8AE' },
                { label: 'Unknown', value: STATS.total - STATS.caabHeld, color: '#DCE6EC' }
              ]}
            />
          </Card>
          <Card>
            <p className="mb-4 text-sm font-semibold text-navy-900">IATA accreditation</p>
            <Donut
              centerLabel="Records"
              centerValue={STATS.total}
              segments={[
                { label: 'Verified', value: STATS.iataVerified, color: '#13294B' },
                { label: 'Inferred', value: STATS.iataInferred, color: '#254F87' },
                { label: 'Unknown', value: STATS.iataUnknown, color: '#DCE6EC' }
              ]}
            />
          </Card>
          <div className="space-y-4">
            <Callout label="How to verify" tone="teal">
              <p>
                <strong>Civil Aviation licence</strong> — Ministry of Civil Aviation &amp; Tourism,
                TAMS portal: <span className="font-mono text-xs">regtravelagency.gov.bd</span>. CAAB
                issues only the NOC needed before an IATA application.
              </p>
              <p>
                <strong>IATA</strong> — per-agency lookup on the IATA customer portal. No bulk country
                export exists, so each number is confirmed one at a time.
              </p>
              <p>
                <strong>Hajj</strong> — phase lists published on{' '}
                <span className="font-mono text-xs">hajj.gov.bd</span>. Free and downloadable today.
              </p>
            </Callout>
            <Callout label="Compliance gate" tone="amber">
              <p>
                {EXCLUDED.filter((e) => e.exclusionReason === 'compliance_risk').length} records carry
                serious public allegations of misrepresentation. Flagged, never auto-onboarded —
                management signs off first.
              </p>
            </Callout>
          </div>
        </div>
      </section>

      {/* =========================== SEGMENTS ============================ */}
      <section>
        <Kicker>Segments</Kicker>
        <SectionTitle sub="S1 leads by volume. S2 leads by margin. Counts include agencies that span two segments.">
          Where the targets sit
        </SectionTitle>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <div className="space-y-3.5">
              {bySegment.map(({ s, n }) => (
                <BarRow
                  key={s.code}
                  label={`${s.code} · ${s.shortName}`}
                  value={n}
                  max={maxSeg}
                  sub={s.tierHint}
                  href={`/agencies?segment=${s.code}`}
                />
              ))}
            </div>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            {SEGMENTS.slice(0, 4).map((s) => (
              <Link
                key={s.code}
                href={`/agencies?segment=${s.code}`}
                className="group rounded-lg border border-hair bg-white p-4 transition-colors hover:border-teal-600"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded bg-navy-900 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {s.code}
                  </span>
                  <Tag tone="teal">Rank {s.priorityRank}</Tag>
                </div>
                <p className="text-sm font-semibold text-navy-900 group-hover:text-teal-600">
                  {s.shortName}
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{s.description}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ========================== GEOGRAPHY ============================ */}
      <section>
        <Kicker>Geography</Kicker>
        <SectionTitle sub="Dhaka clusters are dense enough to walk floor by floor. Outside the metros there is no vendor competition at all — offshore vendors do not sell to Cumilla, and the local vendors sit in Dhaka.">
          Clusters and districts
        </SectionTitle>
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <Card>
            <p className="mb-4 text-sm font-semibold text-navy-900">Targets by cluster</p>
            <div className="space-y-3">
              {clusterRows.map(({ c, n }) => (
                <BarRow
                  key={c.id}
                  label={c.name}
                  value={n}
                  max={maxCluster}
                  sub={`${c.district} · Phase ${c.phase} · ${c.landmarks.slice(0, 3).join(', ')}`}
                  href={`/agencies?cluster=${c.id}`}
                />
              ))}
            </div>
          </Card>
          <div className="space-y-5">
            <Card>
              <p className="mb-4 text-sm font-semibold text-navy-900">Targets by district</p>
              <div className="space-y-3">
                {byDistrict.map(([d, n]) => (
                  <BarRow key={d} label={d} value={n} max={maxDist} />
                ))}
              </div>
            </Card>
            <Callout label="Field sequencing" tone="teal">
              <p>
                <strong>Phase 1</strong> — Dhaka. Start at Sattara Centre, 15th Floor, 30/A Naya
                Paltan: ATAB head office, the ATAB Tourism Training Institute and HAAB are all in that
                one building.
              </p>
              <p>
                <strong>Phase 2</strong> — Chattogram, Sylhet, Narayanganj, Cumilla. Book meetings
                before travelling.
              </p>
              <p>
                <strong>Phase 3</strong> — Brahmanbaria, Khulna, Rajshahi, Bogura. First mover takes
                the district.
              </p>
            </Callout>
          </div>
        </div>
      </section>

      {/* ============================ TOP A ============================== */}
      <section>
        <Kicker>Start here</Kicker>
        <SectionTitle sub="Priority A targets ranked by public review volume — our only available proxy for scale.">
          Top 10 calls this week
        </SectionTitle>
        <Card className="overflow-x-auto p-0 scroll-thin">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="bg-navy-900 text-left text-xs uppercase tracking-wider text-white">
                <th className="w-8 px-4 py-3" />
                <th className="px-4 py-3">Agency</th>
                <th className="px-4 py-3">Cluster</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3 text-right">Reviews</th>
                <th className="px-4 py-3">Tier</th>
              </tr>
            </thead>
            <tbody>
              {topA.map((a, i) => (
                <tr key={a.id} className={i % 2 ? 'bg-white' : 'bg-surface'}>
                  <td className="px-4 py-3"><PriorityChip p={a.priority} /></td>
                  <td className="px-4 py-3">
                    <Link href={`/agencies?q=${encodeURIComponent(a.name)}`} className="font-semibold text-navy-900 hover:text-teal-600">
                      {a.name}
                    </Link>
                    <p className="mt-0.5 max-w-xl text-xs leading-snug text-muted">{a.signal}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{CLUSTERS.find((c) => c.id === a.clusterId)?.district}</td>
                  <td className="px-4 py-3">
                    {a.phone ? (
                      <a href={`tel:+880${a.phone.replace(/[^0-9]/g, '').replace(/^0/, '')}`} className="font-mono text-xs text-teal-600 hover:underline">
                        {a.phone}
                      </a>
                    ) : (
                      <span className="text-xs text-amber-700">visit / Facebook</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums text-navy-900">{a.reviewCount ?? '—'}</td>
                  <td className="px-4 py-3">{a.suggestedTier ? <Tag tone="teal">{a.suggestedTier}</Tag> : <span className="text-xs text-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="mt-4">
          <Link href="/agencies?priority=A" className="text-sm font-semibold text-teal-600 hover:underline">
            See all {STATS.priorityA} Priority A targets →
          </Link>
        </div>
      </section>

      {/* =========================== EXCLUDED =========================== */}
      <section>
        <Kicker>Do not call</Kicker>
        <SectionTitle sub="Agencies that already run a platform, are building one in-house, are competitors, or carry a compliance flag. Kept in the database so no time is wasted on them twice.">
          Excluded ({EXCLUDED.length})
        </SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {EXCLUDED.map((e) => (
            <div key={e.id} className="rounded-lg border border-hair border-l-4 border-l-amber-700 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-navy-900">{e.name}</p>
                <Tag tone="amber">
                  {e.exclusionReason === 'has_own_platform' && 'Has platform'}
                  {e.exclusionReason === 'building_in_house' && 'In-house build'}
                  {e.exclusionReason === 'is_competitor' && 'Competitor'}
                  {e.exclusionReason === 'compliance_risk' && 'Compliance'}
                </Tag>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">{e.signal}</p>
              {e.iataNo && (
                <p className="mt-2 font-mono text-[11px] text-teal-600">
                  IATA {e.iataNo} · ATAB {e.atabNo} · CAAB {e.caabLicenceNo}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ============================ SOURCES =========================== */}
      <section>
        <Kicker>Scale-up</Kicker>
        <SectionTitle sub={`This database covers ${STATS.total} agencies. The national market is roughly 3,500 ATAB members and about 1,500 operating at real scale. These are the five routes to the rest.`}>
          Getting from {STATS.total} to 1,500+
        </SectionTitle>
        <div className="grid gap-4 lg:grid-cols-5">
          {[
            { n: '1', t: 'hajj.gov.bd', d: 'Phase-wise 2026 approved Hajj agency lists. ~750 licensed records. Free, downloadable, today.', tag: 'Do first' },
            { n: '2', t: 'regtravelagency.gov.bd', d: 'TAMS — the definitive licence register with numbers and expiry dates. Search directly, or file an RTI request.', tag: 'Ground truth' },
            { n: '3', t: 'ATAB + HAAB', d: 'Sattara Centre, 15th Floor, 30/A Naya Paltan. ~3,500 members. Verify tool at member.atab.org.bd.', tag: 'Highest leverage' },
            { n: '4', t: 'Listing sweep by thana', d: 'Repeat the capture method used here for every Dhaka thana, then Gazipur, Savar, Feni, Noakhali, Jashore, Barishal, Mymensingh.', tag: 'Repeatable' },
            { n: '5', t: 'Training-course graduates', d: 'Newly licensed agencies coming out of travel-business courses. No platform, no incumbent vendor.', tag: 'Warmest' }
          ].map((s) => (
            <Card key={s.n}>
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded bg-teal-600 text-xs font-bold text-white">
                  {s.n}
                </span>
                <Tag tone="navy">{s.tag}</Tag>
              </div>
              <p className="font-mono text-sm font-semibold text-navy-900">{s.t}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{s.d}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* ========================= CALL WINDOW ========================== */}
      <section className="rounded-lg bg-navy-900 p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-400">Field rule</p>
        <p className="mt-3 max-w-4xl text-2xl font-bold leading-snug text-white">
          Call Sunday–Thursday, 11:00–13:00 and 15:00–17:00. Almost every agency on this list closes
          Friday. Check the Facebook page before every dial.
        </p>
        <p className="mt-3 text-sm text-white/60">
          Four qualifying questions: monthly bookings · own IATA or someone else&rsquo;s panel · own
          website or app · how sub-agents are managed today.
        </p>
      </section>
    </div>
  );
}
