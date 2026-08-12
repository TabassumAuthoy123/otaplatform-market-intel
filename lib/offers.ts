import { parseLowFareSearch, searchConfigStatus, searchFlights, type GdsAttempt } from '@/lib/gds';
import { parseSabreOffers, sabreSearch, sabreStatus, type SabreAttempt } from '@/lib/sabre';

/**
 * One offer shape for both suppliers.
 *
 * Travelport and Sabre answer with completely different structures, and the
 * booking flow must not care which one a fare came from. Everything downstream —
 * the fare cards, the passenger page, the re-price on confirm — speaks this type
 * and only this type.
 *
 * `supplier` travels with the offer because a booking has to be re-priced
 * against the supplier that quoted it. Re-pricing a Sabre fare on Travelport
 * would either fail or, worse, silently match a different fare at a different
 * price.
 */

export type Supplier = 'travelport' | 'sabre';

export const SUPPLIER_LABEL: Record<Supplier, string> = {
  travelport: 'Travelport',
  sabre: 'Sabre'
};

export type Segment = {
  carrier: string; flightNumber: string; origin: string; destination: string;
  departure: string; arrival: string; minutes: number; equipment: string;
};

export type Offer = {
  supplier: Supplier;
  /** Stable across searches — carrier, flight, departure and price. */
  sig: string;
  currency: string;
  amount: number;
  baseLabel: string;
  taxLabel: string;
  /**
   * The taxes itemised by code, from whichever supplier quoted the fare.
   *
   * Both of them send this and both of them were being reduced to one summed
   * number before it reached anything. It is carried here so a booking can record
   * it on the document, which is what BSP reconciliation matches against and what
   * makes a rule like the Hajj excise-duty exemption expressible per code.
   *
   * `description` is Sabre's — Travelport sends only the code, so it is empty
   * there rather than filled in with a guess at what the code means.
   */
  taxBreakdown: { code: string; amount: number; description: string }[];
  cabin: string;
  bookingCode: string;
  platingCarrier: string;
  refundable: boolean;
  latestTicketing: string;
  segments: Segment[];
  /** Connections, so a card can say "1 stop" honestly. */
  stops: number;
};

export type SupplierResult = {
  supplier: Supplier;
  configured: boolean;
  missing: string[];
  attempted: boolean;
  ok: boolean;
  status?: number;
  elapsedMs?: number;
  host?: string;
  /** Why nothing came back, in words a non-integrator can act on. */
  problem?: string;
  offerCount: number;
};

export type Query = { from: string; to: string; date: string; adults: string };

/* --------------------------------------------------------------- normalisers */

function fromTravelport(a: GdsAttempt): Offer[] {
  return parseLowFareSearch(a.data).map((o) => ({
    supplier: 'travelport' as Supplier,
    // namespace the signature so two suppliers can never collide on one string
    sig: `tp:${o.sig}`,
    currency: o.currency,
    amount: o.amount,
    baseLabel: o.basePrice,
    taxLabel: o.taxes,
    taxBreakdown: (o.taxBreakdown ?? []).map((t) => ({ ...t, description: '' })),
    cabin: o.cabin,
    bookingCode: o.bookingCode,
    platingCarrier: o.platingCarrier,
    refundable: o.refundable,
    latestTicketing: o.latestTicketing,
    segments: o.segments,
    stops: Math.max(0, o.segments.length - 1)
  }));
}

function fromSabre(a: SabreAttempt, date: string): Offer[] {
  return parseSabreOffers(a.data).map((o) => ({
    supplier: 'sabre' as Supplier,
    sig: `sb:${o.sig}`,
    currency: o.currency,
    amount: o.amount,
    baseLabel: `${o.currency}${Math.round(o.base)}`,
    taxLabel: `${o.currency}${Math.round(o.taxes)}`,
    taxBreakdown: o.taxBreakdown ?? [],
    cabin: o.cabin || 'Economy',
    bookingCode: '',
    platingCarrier: o.segments[0]?.carrier ?? '',
    refundable: false,
    latestTicketing: '',
    // Sabre sends a time with an offset but no date; the searched date is the date
    segments: o.segments.map((s) => ({
      ...s,
      departure: s.departure.includes('T') ? s.departure : `${date}T${s.departure}`,
      arrival: s.arrival.includes('T') ? s.arrival : `${date}T${s.arrival}`
    })),
    stops: Math.max(0, o.segments.length - 1)
  }));
}

/* -------------------------------------------------------------- fare cache */

/**
 * A short-lived cache of merged search results.
 *
 * Every render of /portal/flights asked both suppliers again — around 1.5 to 3
 * seconds each, on a page a customer reloads while comparing. That is slow for
 * them and it burns certification quota and rate limit for us, for an answer
 * that had not changed in the intervening two seconds.
 *
 * THE TTL IS SHORT ON PURPOSE. A GDS fare is a live quote; the whole reason
 * `repriceOffer` exists is that a fare can vanish between seeing it and booking
 * it. Caching for minutes would put stale prices in front of people. Ninety
 * seconds is long enough to absorb a reload and a back-button, and short enough
 * that nothing on screen is meaningfully older than the search that produced it.
 *
 * RE-PRICING NEVER READS THIS. `repriceOffer` asks the supplier every time, so
 * confirming a booking always checks the live price no matter what the list
 * showed. A cache that fed the confirmation step would be a way to sell a fare
 * that no longer exists.
 */
const CACHE_TTL_MS = Number(process.env.GDS_CACHE_TTL_MS ?? 90_000);
const CACHE_MAX = 60;

type CacheEntry = { at: number; value: SearchResult };
const searchCache = new Map<string, CacheEntry>();

const cacheKey = (q: Query) => `${q.from}|${q.to}|${q.date}|${q.adults}`;

function readCache(q: Query): SearchResult | null {
  if (CACHE_TTL_MS <= 0) return null;
  const hit = searchCache.get(cacheKey(q));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(cacheKey(q));
    return null;
  }
  return { ...hit.value, cachedAgeMs: Date.now() - hit.at };
}

function writeCache(q: Query, value: SearchResult) {
  if (CACHE_TTL_MS <= 0) return;
  // A search that returned nothing is not worth remembering — the next attempt
  // may well be a transient supplier problem clearing.
  if (value.offers.length === 0) return;
  searchCache.set(cacheKey(q), { at: Date.now(), value });
  // Bounded so a busy day cannot grow this without limit.
  while (searchCache.size > CACHE_MAX) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    searchCache.delete(oldest[0]);
  }
}

export type SearchResult = {
  offers: Offer[];
  suppliers: SupplierResult[];
  anyConfigured: boolean;
  /** Set when this answer came from the cache, so the page can say so. */
  cachedAgeMs?: number;
};

/* ------------------------------------------------------------------- search */

function tpProblem(a: GdsAttempt): string | undefined {
  if (!a.configured) return `Not configured — missing ${a.missing.join(', ')}`;
  if (a.fault) {
    return `Travelport fault ${a.fault.code ?? ''}: ${a.fault.faultString ?? a.fault.description ?? 'rejected'}`.trim();
  }
  if (a.error) return a.error;
  if (!a.upstreamOk) return `Travelport answered HTTP ${a.upstreamStatus}`;
  return undefined;
}

function sabreProblem(a: SabreAttempt): string | undefined {
  if (!a.configured) return `Not configured — missing ${a.missing.join(', ')}`;
  if (a.fault) return `Sabre ${a.fault.code ?? ''}: ${a.fault.message ?? 'rejected'}`.trim();
  if (a.error) return a.error;
  if (!a.upstreamOk) return `Sabre answered HTTP ${a.upstreamStatus}`;
  return undefined;
}

/**
 * Asks both suppliers at once and merges the answers, cheapest first.
 *
 * Deliberately parallel: two sequential calls would make the page wait for the
 * slower of them twice over. A supplier that is down or unconfigured contributes
 * nothing and says why, rather than taking the whole search with it.
 */
export async function searchAllSuppliers(q: Query): Promise<SearchResult> {
  const cached = readCache(q);
  if (cached) return cached;

  const tpStatus = searchConfigStatus();
  const sbStatus = sabreStatus();

  const [tp, sb] = await Promise.all([
    tpStatus.configured ? searchFlights(q) : Promise.resolve(null),
    sbStatus.configured ? sabreSearch(q) : Promise.resolve(null)
  ]);

  const tpOffers = tp ? fromTravelport(tp) : [];
  const sbOffers = sb ? fromSabre(sb, q.date) : [];

  const suppliers: SupplierResult[] = [
    {
      supplier: 'travelport',
      configured: tpStatus.configured,
      missing: tpStatus.missing,
      attempted: Boolean(tp?.attempted),
      ok: Boolean(tp?.upstreamOk),
      status: tp?.upstreamStatus,
      elapsedMs: tp?.elapsedMs,
      host: tp?.endpointHost,
      problem: tp ? tpProblem(tp) : `Not configured — missing ${tpStatus.missing.join(', ')}`,
      offerCount: tpOffers.length
    },
    {
      supplier: 'sabre',
      configured: sbStatus.configured,
      missing: sbStatus.missing,
      attempted: Boolean(sb?.attempted),
      ok: Boolean(sb?.upstreamOk),
      status: sb?.upstreamStatus,
      elapsedMs: sb?.elapsedMs,
      host: sb?.endpointHost,
      problem: sb ? sabreProblem(sb) : `Not configured — missing ${sbStatus.missing.join(', ')}`,
      offerCount: sbOffers.length
    }
  ];

  const offers = [...tpOffers, ...sbOffers].sort((a, b) => a.amount - b.amount);
  const result: SearchResult = { offers, suppliers, anyConfigured: tpStatus.configured || sbStatus.configured };
  writeCache(q, result);
  return result;
}

/**
 * Re-price one offer and hand it back, or explain why it is gone.
 *
 * Only the supplier that quoted the fare is asked, and the match is on the
 * namespaced signature, so a browser cannot post a price it invented and a
 * Sabre fare can never be confirmed against a Travelport quote.
 */
export async function repriceOffer(sig: string, q: Query): Promise<
  { ok: true; offer: Offer } | { ok: false; reason: string; status: number }
> {
  const supplier: Supplier | null = sig.startsWith('tp:') ? 'travelport' : sig.startsWith('sb:') ? 'sabre' : null;
  if (!supplier) return { ok: false, reason: 'That fare reference is not one of ours.', status: 422 };

  if (supplier === 'travelport') {
    if (!searchConfigStatus().configured) {
      return { ok: false, reason: 'Travelport is not configured, so this fare cannot be re-priced.', status: 503 };
    }
    const a = await searchFlights(q);
    const problem = tpProblem(a);
    if (problem) return { ok: false, reason: problem, status: 502 };
    const found = fromTravelport(a).find((o) => o.sig === sig);
    return found
      ? { ok: true, offer: found }
      : { ok: false, reason: 'That Travelport fare is no longer available. Search again and pick a current one.', status: 409 };
  }

  if (!sabreStatus().configured) {
    return { ok: false, reason: 'Sabre is not configured, so this fare cannot be re-priced.', status: 503 };
  }
  const a = await sabreSearch(q);
  const problem = sabreProblem(a);
  if (problem) return { ok: false, reason: problem, status: 502 };
  const found = fromSabre(a, q.date).find((o) => o.sig === sig);
  return found
    ? { ok: true, offer: found }
    : { ok: false, reason: 'That Sabre fare is no longer available. Search again and pick a current one.', status: 409 };
}
