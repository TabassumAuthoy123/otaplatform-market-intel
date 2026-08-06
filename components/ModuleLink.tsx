import Link from 'next/link';
import { isPathEnabled } from '@/lib/panelMenus';

/**
 * A link that disappears when the module it points at is switched off.
 *
 * WHY THIS IS NEEDED ON TOP OF THE NAV FILTER AND THE ROUTE GUARD
 *
 * Filtering the nav and 404ing the route looked like the whole job, and it was not.
 * Switching `/competitors` off left the market-intelligence home still rendering
 * "Full battlecards →", and clicking it now landed on a 404 — a dead link created by
 * the very feature meant to tidy the panel up. A grep found fourteen cross-module
 * links like it: ten from the dashboard home into `/agencies`, the statements page
 * into `/accounts/financials`, the storefront booking page into `/accounts/invoices`,
 * and the flights page into `/accounts/gds`.
 *
 * Self-links are deliberately not wrapped. A "Reset filters" link from
 * `/accounts/cash` back to `/accounts/cash` cannot be reached while that module is
 * off, so guarding it would be noise pretending to be safety.
 *
 * It renders NOTHING when the target is off, rather than plain text. These are
 * drill-down calls to action — "Full battlecards →", "See all 400 agencies →" — and
 * an unclickable arrow is a worse answer than a card that simply has one fewer
 * link. A page whose whole purpose is the missing module should wrap the section,
 * not the anchor.
 *
 * Server component: it reads content/site.json, which a client component cannot.
 */
export async function ModuleLink({
  href,
  className,
  children
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  // Compare the path only — /agencies?credential=iata is still the agencies module.
  if (!(await isPathEnabled(href.split('?')[0]))) return null;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
