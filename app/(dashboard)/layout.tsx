import Nav from '@/components/Nav';
import { CLUSTERS, SEGMENTS } from '@/data/schema';
import { getDataset } from '@/lib/agencies';

// The nav shows live per-segment and per-cluster counts, so it re-reads the
// dataset on every request like the pages do.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { targets } = await getDataset();

  const segCounts: Record<string, number> = {};
  for (const s of SEGMENTS) {
    segCounts[s.code] = targets.filter((a) => a.segment === s.code || a.segmentSecondary === s.code).length;
  }

  const clusterCounts: Record<string, number> = {};
  for (const c of CLUSTERS) {
    clusterCounts[c.id] = targets.filter((a) => a.clusterId === c.id).length;
  }

  return (
    <>
      <Nav segCounts={segCounts} clusterCounts={clusterCounts} />
      <main className="mx-auto w-full max-w-[1400px] px-5 pb-24 pt-8 lg:px-8">{children}</main>
      <footer className="border-t border-hair bg-white py-8 no-print">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-5 text-xs text-muted lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <p>
            <span className="font-semibold text-navy-900">Softifybd Limited</span> · Tower of Aakash,
            Level 18, 54 Gulshan Avenue, Dhaka 1212 · 096-12345-100
          </p>
          <p>Internal — Sales &amp; BD use only · Data captured 29 July 2026</p>
        </div>
      </footer>
    </>
  );
}
