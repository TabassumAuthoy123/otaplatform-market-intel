import Nav from '@/components/Nav';
import { getMarket } from '@/lib/market';

// The nav shows live credential and city counts, so it re-reads the dataset on
// every request like the pages do.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const m = await getMarket();

  const credentialCounts: Record<string, number> = {};
  for (const c of m.byCredential) credentialCounts[c.key] = c.count;

  const cityCounts: Record<string, number> = {};
  for (const c of m.byCity) cityCounts[c.city] = c.count;

  return (
    <>
      <Nav credentialCounts={credentialCounts} cityCounts={cityCounts} total={m.pipeline.total} />
      <main className="mx-auto w-full max-w-[1400px] px-5 pb-24 pt-8 lg:px-8">{children}</main>
      <footer className="border-t border-hair bg-white py-8 no-print">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-5 text-xs text-muted lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <p>
            <span className="font-semibold text-navy-900">Softifybd Limited</span> · Tower of Aakash,
            Level 18, 54 Gulshan Avenue, Dhaka 1212 · 096-12345-100
          </p>
          <p>Internal — Sales &amp; BD use only · {m.pipeline.total} prospects from TOAB · BAIRA · ATAB · MoRA</p>
        </div>
      </footer>
    </>
  );
}
