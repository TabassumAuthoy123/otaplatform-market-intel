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
export async function searchAllSuppliers(q: Query): Promise<{
  offers: Offer[];
  suppliers: SupplierResult[];
  anyConfigured: boolean;
}> {
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
  return { offers, suppliers, anyConfigured: tpStatus.configured || sbStatus.configured };
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
