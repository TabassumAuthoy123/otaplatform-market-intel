import path from 'node:path';
import { headers } from 'next/headers';
import { readJsonCached } from '@/lib/jsonStore';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- shared with the zero-dependency admin portal; see the note in that file
import { PANEL_MODULES as MODULES } from '@/lib/panel-modules.js';

/**
 * Which modules of OUR panel are switched on for this installation.
 *
 * WHY THIS IS NOT THE SAME AS THE STOREFRONT SECTION TOGGLES
 *
 * `site.json → sections.items` already let the admin portal show and hide the
 * nine storefront homepage sections, and `site.json → nav` does the same for the
 * public menu. Neither touched the panel an agency's own staff use: the accounts
 * header had sixteen links hard-coded in a client component, the accounts landing
 * had twelve tiles hard-coded in a page, and the market-intelligence nav was
 * inline JSX. Nothing could be turned off, so every agency got Hajj inventory,
 * competitor research and multi-currency statements whether or not they sell any
 * of it.
 *
 * TWO HALVES, AND THE SECOND ONE IS THE POINT
 *
 * The existing storefront nav toggle only hides links — `/portal/hotels` still
 * answers 200 to anyone with the URL. That is half a feature: a bookmark, a search
 * engine or a guessed path walks straight past it. Here "off" means off. The link
 * disappears AND the route answers 404, enforced once in each route group's
 * layout rather than page by page, so a page added later cannot forget to check.
 *
 * This sits ON TOP OF the role checks, not instead of them. A disabled module is
 * gone for everybody including a Super Admin; an enabled one is still subject to
 * the same capability rules as before. Two different questions — "does this
 * installation sell Hajj?" and "may this user see the ledger?" — and collapsing
 * them into one would make both harder to reason about.
 *
 * WHERE THE LIST LIVES, AND WHY IT IS SPLIT
 *
 * The modules are declared here in code because each one corresponds to a real
 * route that either exists or does not; a JSON file cannot invent
 * `/accounts/payroll`. Only the on/off state is content, and it lives in
 * `site.json` where the admin portal already has atomic writes, fingerprint
 * concurrency, audit and backups. Same split as `lib/credentials.ts`, for the same
 * reason: a declaration that drifts from the code is worse than no declaration.
 */

export type PanelGroup = 'accounts' | 'dashboard';

export type PanelModule = {
  key: string;
  group: PanelGroup;
  href: string;
  /** Short label for the nav. */
  label: string;
  /** Longer label for the landing tile, when it differs. */
  tileLabel?: string;
  /** What the operator is switching off. Shown beside the toggle. */
  note: string;
  /**
   * Cannot be switched off.
   *
   * Only the two roots. Turning off `/accounts` would leave its own sixteen
   * children reachable with no way back to them, and turning off `/` would leave
   * the whole app with no entry point — a dead end that reads as a bug rather
   * than a setting. Everything an agency might genuinely not sell is optional.
   */
  locked?: boolean;
};

export const PANEL_MODULES = MODULES as PanelModule[];



type PanelState = Record<string, Record<string, boolean>>;
type SiteShape = { panel?: PanelState };

const SITE_FILE = path.join(process.cwd(), 'content', 'site.json');

/**
 * Read the on/off state.
 *
 * Absent means ON, at every level — no `panel` key, no group, no entry. A fresh
 * install, or one whose `site.json` predates this feature, has to get the whole
 * product rather than an empty panel. Defaulting the other way would mean shipping
 * a build that hides itself, and the symptom — every link gone, every route 404 —
 * reads as a catastrophic bug rather than a missing key.
 */
async function enabledMap(): Promise<PanelState> {
  const site = await readJsonCached<SiteShape>(SITE_FILE, {});
  return site.panel ?? {};
}

/** Sync, because the map is already in hand. Only `=== false` hides. */
export function isModuleEnabled(m: PanelModule, map: PanelState): boolean {
  if (m.locked) return true;
  return map[m.group]?.[m.key] !== false;
}

/** Every module with its current state, for the admin screen. */
export async function panelModuleStates(): Promise<(PanelModule & { enabled: boolean })[]> {
  const map = await enabledMap();
  return PANEL_MODULES.map((m) => ({ ...m, enabled: isModuleEnabled(m, map) }));
}

/** The nav items a group should render, in declared order. */
export async function enabledModules(group: PanelGroup): Promise<PanelModule[]> {
  const map = await enabledMap();
  return PANEL_MODULES.filter((m) => m.group === group && isModuleEnabled(m, map));
}

/**
 * Is this request allowed through?
 *
 * Longest matching href wins, so `/accounts/credit-notes` is judged by its own
 * setting and not by `/accounts`. Without that, every child would inherit the
 * root's state and nothing below the root could ever be turned off — the same
 * class of mistake as a prefix guard that accidentally matches everything.
 */
export async function isPathEnabled(pathname: string): Promise<boolean> {
  const map = await enabledMap();
  const candidates = PANEL_MODULES.filter(
    (m) => pathname === m.href || (m.href !== '/' && pathname.startsWith(`${m.href}/`))
  ).sort((a, b) => b.href.length - a.href.length);
  const owner = candidates[0];
  // A path no module claims is not ours to block — an unrelated route stays 200.
  return owner ? isModuleEnabled(owner, map) : true;
}

/**
 * The path being served, as set by middleware.
 *
 * A server layout is not given the pathname, and it is the only place a check can
 * run once for sixteen pages instead of sixteen times. Middleware cannot read the
 * config — it runs on the Edge runtime with no filesystem — so it does the half it
 * can, stamping the path onto the request, and the layout does the half that needs
 * a file read. Neither half works alone, which is worth knowing before deleting
 * either.
 */
export function currentPath(): string | null {
  return headers().get('x-panel-path');
}
