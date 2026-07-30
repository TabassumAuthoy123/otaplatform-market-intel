import Link from 'next/link';
import { SEGMENTS } from '@/data/schema';
import { TARGETS } from '@/data/agencies';
import { Kicker, SectionTitle, Card, Tag, StatCard } from '@/components/ui';

export default function SegmentsPage() {
  return (
    <div className="space-y-8">
      <div>
        <Kicker>Segments</Kicker>
        <SectionTitle sub="Six segments ranked on the three things that decide whether a cold call becomes a contract: how much pain they feel, how fast they can decide, and how much they can pay.">
          Who we sell to
        </SectionTitle>
      </div>

      <div className="space-y-4">
        {SEGMENTS.map((s) => {
          const rows = TARGETS.filter((a) => a.segment === s.code || a.segmentSecondary === s.code);
          const withPhone = rows.filter((a) => a.phone).length;
          const aCount = rows.filter((a) => a.priority === 'A').length;
          return (
            <Card key={s.code}>
              <div className="flex flex-wrap items-start gap-5">
                <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg bg-navy-900 text-white">
                  <span className="text-lg font-bold">{s.code}</span>
                  <span className="text-[9px] uppercase tracking-wider opacity-70">Rank {s.priorityRank}</span>
                </div>
                <div className="min-w-[280px] flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-bold text-navy-900">{s.shortName}</h3>
                    <Tag tone="teal">{s.tierHint}</Tag>
                  </div>
                  <p className="text-sm font-medium text-ink">{s.name}</p>
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{s.description}</p>
                  <Link href={`/agencies?segment=${s.code}`} className="mt-3 inline-block text-sm font-semibold text-teal-600 hover:underline">
                    Open {rows.length} targets in this segment &rarr;
                  </Link>
                </div>
                <div className="grid w-full shrink-0 grid-cols-3 gap-3 sm:w-[300px]">
                  <StatCard label="Targets" value={rows.length} />
                  <StatCard label="Priority A" value={aCount} />
                  <StatCard label="With phone" value={withPhone} />
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="border-l-4 border-l-amber-700">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">Disqualify fast</p>
        <ul className="space-y-1.5 text-sm leading-relaxed text-ink">
          <li>&bull; Under 20&ndash;30 bookings a month &mdash; the fee will not clear their unit economics.</li>
          <li>&bull; No valid Ministry travel-agency licence &mdash; regulatory risk to Softifybd.</li>
          <li>&bull; Wants source-code ownership rather than SaaS &mdash; hand to the custom software team.</li>
          <li>&bull; Signed with another platform in the last six months &mdash; log the renewal date, set a month-ten reminder.</li>
          <li>&bull; Will not put the owner on a call within two contacts &mdash; not a real opportunity yet.</li>
        </ul>
      </Card>
    </div>
  );
}
