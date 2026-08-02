import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Agency, CredentialState } from '@/data/schema';

/**
 * Runtime source of the agency dataset.
 *
 * content/agencies.json is authoritative — the admin portal on :4001 writes it.
 * data/agencies.ts is kept as the curated seed the JSON was generated from, and
 * as a restore path; it is no longer imported at runtime.
 *
 * Every derivation below is a straight copy of the one that used to live in
 * data/agencies.ts, so the dashboard numbers do not move.
 */

const AGENCIES_FILE = path.join(process.cwd(), 'content', 'agencies.json');

export type Dataset = {
  agencies: Agency[];
  targets: Agency[];
  excluded: Agency[];
  stats: ReturnType<typeof deriveStats>;
  pipeline: ReturnType<typeof derivePipeline>;
};

export async function getAgencies(): Promise<Agency[]> {
  const raw = await readFile(AGENCIES_FILE, 'utf8');
  return JSON.parse(raw) as Agency[];
}

export async function getDataset(): Promise<Dataset> {
  const agencies = await getAgencies();
  const targets = agencies.filter((x) => x.priority !== 'X');
  const excluded = agencies.filter((x) => x.priority === 'X');
  return {
    agencies,
    targets,
    excluded,
    stats: deriveStats(agencies, targets, excluded),
    pipeline: derivePipeline(targets)
  };
}

const isHeld = (s: CredentialState) => s === 'verified' || s === 'inferred';

export function deriveStats(agencies: Agency[], targets: Agency[], excluded: Agency[]) {
  return {
    total: agencies.length,
    targets: targets.length,
    excluded: excluded.length,

    /** "Civil Aviation certificate" holders — Ministry / TAMS travel-agency licence. */
    caabHeld: agencies.filter((x) => isHeld(x.caabLicence)).length,
    caabVerified: agencies.filter((x) => x.caabLicence === 'verified').length,
    caabInferred: agencies.filter((x) => x.caabLicence === 'inferred').length,

    iataHeld: agencies.filter((x) => isHeld(x.iata)).length,
    iataVerified: agencies.filter((x) => x.iata === 'verified').length,
    iataInferred: agencies.filter((x) => x.iata === 'inferred').length,
    iataUnknown: agencies.filter((x) => x.iata === 'unknown').length,

    hajjHeld: agencies.filter((x) => isHeld(x.hajjLicence)).length,

    noPlatform: targets.filter((x) => !x.hasOwnPlatform).length,
    open247: targets.filter((x) => x.open247).length,
    noPhone: targets.filter((x) => !x.phone).length,

    priorityA: targets.filter((x) => x.priority === 'A').length,
    priorityB: targets.filter((x) => x.priority === 'B').length,
    priorityC: targets.filter((x) => x.priority === 'C').length,

    districts: Array.from(new Set(agencies.map((x) => x.district))).length,
    clusters: Array.from(new Set(agencies.map((x) => x.clusterId))).length,

    /** Public review count as a scale proxy — total reach represented. */
    totalReviews: agencies.reduce((s, x) => s + (x.reviewCount ?? 0), 0)
  };
}

/** Indicative pipeline value from the pricing framework. Mid-point of each tier. */
const TIER_MRR: Record<string, number> = {
  Starter: 10000, Growth: 23000, Professional: 47500, Hajj: 35000, Enterprise: 60000
};

export function derivePipeline(targets: Agency[]) {
  return {
    /** Total addressable MRR if every A/B target signed at its suggested tier. */
    fullMrr: targets.reduce((s, x) => s + (x.suggestedTier ? TIER_MRR[x.suggestedTier] : 0), 0),
    aMrr: targets
      .filter((x) => x.priority === 'A')
      .reduce((s, x) => s + (x.suggestedTier ? TIER_MRR[x.suggestedTier] : 0), 0)
  };
}

export function countBy<T extends string>(rows: Agency[], key: (a: Agency) => T) {
  const m = new Map<T, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}
