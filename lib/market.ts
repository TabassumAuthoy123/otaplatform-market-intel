import { requireRead } from '@/lib/auth';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CALL_STATUS, CLOSED, CONTACTED, getLeads, type Lead } from '@/lib/crm';

/**
 * Market analysis over the 400 researched prospects.
 *
 * The dashboard used to run off the older 114-record hand-built set. It now
 * runs off content/crm-leads.json — the same records the sales floor calls
 * from — so the number on the wall and the number in the queue can never
 * disagree.
 *
 * CREDENTIALS ARE READ, NOT ASSUMED. Bangladesh publishes no bulk register of
 * IATA accreditations or Ministry travel-agency licences, so every credential
 * below is derived from what the source register actually printed:
 *
 *   IATA   the tier says IATA-accredited, or a licence/prospect note quotes it
 *   Hajj   the MoRA register printed a "Hajj Lic. NNNN" number
 *   BAIRA  the BAIRA register printed an "RL NNNN" recruiting licence
 *   TOAB   the TOAB directory printed a membership number
 *
 * A record with none of those is not "unlicensed" — it means the directory it
 * came from did not print a number. That distinction is kept everywhere.
 */

const COMPETITORS_FILE = path.join(process.cwd(), 'content', 'competitors.json');

export type Credential = 'iata' | 'hajj' | 'baira' | 'toab' | 'none';

export function credentialsOf(l: Lead): Credential[] {
  const out: Credential[] = [];
  const ref = l.licence_ref || '';
  const hay = `${l.tier} ${ref} ${l.prospect_note}`;

  if (/IATA/i.test(hay)) out.push('iata');
  if (/Hajj\s*Lic/i.test(ref) || /Hajj\/Umrah/i.test(l.tier)) out.push('hajj');
  if (/\bRL\s*\d/i.test(ref) || /BAIRA/i.test(l.tier) || /BAIRA/i.test(l.data_source)) out.push('baira');
  if (/TOAB/i.test(ref) || /TOAB/i.test(l.data_source)) out.push('toab');
  return out.length ? out : ['none'];
}

/** Observed state of the prospect's own website — the core buying signal. */
export type EngineState = 'live_engine' | 'brochure' | 'none_seen' | 'not_checked';

export function engineOf(l: Lead): EngineState {
  const b = (l.booking_engine || '').toLowerCase();
  if (!b) return l.website ? 'not_checked' : 'none_seen';
  if (b.includes('live engine')) return 'live_engine';
  if (b.includes('brochure')) return 'brochure';
  return 'not_checked';
}

export const ENGINE_LABEL: Record<EngineState, string> = {
  live_engine: 'Live booking engine — already platformed',
  brochure: 'Brochure site only — no booking engine',
  none_seen: 'No website in the source — prime target',
  not_checked: 'Website exists, engine not yet checked'
};

export const CREDENTIAL_LABEL: Record<Credential, string> = {
  iata: 'IATA accredited',
  hajj: 'Hajj licence (MoRA)',
  baira: 'BAIRA recruiting licence',
  toab: 'TOAB member',
  none: 'No number printed in the source'
};

export type MarketView = Awaited<ReturnType<typeof getMarket>>;

export async function getMarket() {
  requireRead();
  const leads = await getLeads();

  const count = (fn: (l: Lead) => boolean) => leads.filter(fn).length;
  const has = (l: Lead, c: Credential) => credentialsOf(l).includes(c);

  const byCredential = (['iata', 'hajj', 'baira', 'toab', 'none'] as Credential[]).map((c) => ({
    key: c,
    label: CREDENTIAL_LABEL[c],
    count: count((l) => has(l, c))
  }));

  const byEngine = (['none_seen', 'brochure', 'not_checked', 'live_engine'] as EngineState[]).map((e) => ({
    key: e,
    label: ENGINE_LABEL[e],
    count: count((l) => engineOf(l) === e)
  }));

  const byPriority = ['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => ({
    priority: p,
    count: count((l) => l.priority === p),
    worked: count((l) => l.priority === p && l.call_status !== 'not_started')
  })).filter((r) => r.count > 0);

  const byTier = Array.from(new Set(leads.map((l) => l.tier))).map((t) => ({
    tier: t,
    count: count((l) => l.tier === t),
    worked: count((l) => l.tier === t && l.call_status !== 'not_started')
  })).sort((a, b) => b.count - a.count);

  const byCity = Array.from(new Set(leads.map((l) => l.city).filter(Boolean))).map((c) => ({
    city: c,
    count: count((l) => l.city === c)
  })).sort((a, b) => b.count - a.count);

  const bySource = Array.from(new Set(leads.map((l) => l.data_source).filter(Boolean))).map((s) => ({
    source: s,
    count: count((l) => l.data_source === s)
  })).sort((a, b) => b.count - a.count);

  const bySegment = Array.from(new Set(leads.map((l) => l.segment).filter(Boolean))).map((s) => ({
    segment: s,
    count: count((l) => l.segment === s)
  })).sort((a, b) => b.count - a.count);

  // reachability — what a caller can actually do with the record
  const reach = {
    withMobile: count((l) => !!l.mobile),
    withPhone: count((l) => !!l.phone),
    withAnyNumber: count((l) => !!(l.mobile || l.phone)),
    withEmail: count((l) => !!l.email),
    withDecisionMaker: count((l) => !!l.decision_maker),
    withWebsite: count((l) => !!l.website),
    withFacebook: count((l) => !!l.facebook),
    noContactAtAll: count((l) => !l.mobile && !l.phone && !l.email)
  };

  const pipeline = {
    total: leads.length,
    worked: count((l) => l.call_status !== 'not_started'),
    contacted: count((l) => CONTACTED.has(l.call_status)),
    closed: count((l) => CLOSED.has(l.call_status)),
    won: count((l) => l.call_status === 'won'),
    demos: count((l) => l.demo_scheduled === 'yes'),
    assigned: count((l) => !!l.assigned_to)
  };

  /** The ICP: licensed, reachable, and no booking engine of their own. */
  const idealFit = leads.filter(
    (l) => engineOf(l) !== 'live_engine' && (l.mobile || l.phone) && credentialsOf(l)[0] !== 'none'
  );

  const iataTargets = leads.filter((l) => has(l, 'iata'));

  return {
    leads,
    pipeline,
    reach,
    byCredential,
    byEngine,
    byPriority,
    byTier,
    byCity,
    bySource,
    bySegment,
    idealFit,
    iataTargets,
    statusLabel: CALL_STATUS
  };
}

/* ---------------------------------------------------------- competitors */

export type Competitor = {
  name: string; tag: string; threat: string; pricingPublished: boolean; pricing: string;
  address?: string; strengths: string[]; weaknesses: string[]; attack: string;
};

export type CompetitorFile = {
  _meta: { note: string; compiled: string };
  headline: { vendorsProfiled: number; publishPricing: number; foreignVendorsWithNamedBdClient: number };
  groups: { key: string; title: string; note: string; vendors: Competitor[] }[];
  gaps: string[];
};

export async function getCompetitors(): Promise<CompetitorFile> {
  requireRead();
  return JSON.parse(await readFile(COMPETITORS_FILE, 'utf8')) as CompetitorFile;
}
