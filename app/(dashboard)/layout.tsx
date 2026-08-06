import { notFound } from 'next/navigation';
import Nav from '@/components/Nav';
import { getMarket } from '@/lib/market';
import { PANEL_MODULES, currentPath, enabledModules, isPathEnabled } from '@/lib/panelMenus';

// The nav shows live credential and city counts, so it re-reads the dataset on
// every request like the pages do.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Same one-place guard as the accounts group. See lib/panelMenus.ts.
  const path = currentPath();
  if (path && !(await isPathEnabled(path))) notFound();

  const m = await getMarket();
  // The disabled ones, not the enabled ones — see the note on Nav's `hidden` prop.
  const enabled = new Set((await enabledModules('dashboard')).map((x) => x.href));
  const hidden = PANEL_MODULES.filter((x) => x.group === 'dashboard' && !enabled.has(x.href)).map((x) => x.href);

  const credentialCounts: Record<string, number> = {};
  for (const c of m.byCredential) credentialCounts[c.key] = c.count;

  const cityCounts: Record<string, number> = {};
  for (const c of m.byCity) cityCounts[c.city] = c.count;

  return (
    <>
      <Nav
        credentialCounts={credentialCounts}
        cityCounts={cityCounts}
        total={m.pipeline.total}
        hidden={hidden}
      />
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
