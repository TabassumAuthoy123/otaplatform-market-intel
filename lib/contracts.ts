import type { Book } from '@/lib/accounting';
import { documentGross, documents, isMemo, taxTotal } from '@/lib/documents';
import type { TravelDocument } from '@/lib/documents';

/**
 * Carrier commission contracts — what an airline actually allows the agency.
 *
 * WHY MARGIN HAS BEEN WRONG-BY-OMISSION UNTIL NOW
 *
 * Every fare the GDS quotes comes back with no commission on it, so `commissionAmt`
 * on a document is recorded as null — unknown, not zero, because zero is a claim
 * that the airline allowed nothing. The consequence is that margin has only ever
 * been the service charge the agency added itself. For an agency on a 3% front-end
 * deal with its main carrier that understates the margin on every ticket it sells.
 *
 * The commission is not in the fare quote because it is in a contract, negotiated
 * per carrier and revised. This is that contract, as data.
 *
 * WHAT COMMISSION ACTUALLY DOES TO THE MONEY
 *
 * It is not income arriving separately. Under BSP the agency remits fare plus tax
 * LESS commission, so commission reduces what is owed. That means it belongs in the
 * supplier cost rather than in a revenue account, and margin then falls out of the
 * arithmetic already in the book: selling price − (fare + tax − commission), which
 * is the service charge plus the commission.
 *
 * So there is no new account and no new posting rule. The booking flow writes the
 * bill net of commission and everything downstream — cost of sales, gross profit,
 * margin by branch — is correct without being told about commission at all.
 *
 * EFFECTIVE DATES, FOR THE SAME REASON THE TAX RULES NEED THEM
 *
 * A contract resolves against the document's ISSUE date, not against today. A rate
 * renegotiated in September must not restate August's tickets — a book that quietly
 * reprices closed months is a book whose reported figures stop matching what was
 * filed. Resolution happens at read time so a corrected contract flows through
 * immediately, and the date bound is what keeps that safe.
 *
 * NOTHING IS SEEDED
 *
 * There are no contracts on this book and none are invented. A fabricated rate
 * would put money into the margin report, the P&L and every commission figure built
 * on them — worse than a fabricated ticket number, which at least only fails to
 * reconcile. Load the real ones and the arithmetic starts working; until then
 * `commissionFor` returns null and margin is the service charge alone, exactly as
 * it is today.
 */

export type RouteBand = 'any' | 'domestic' | 'saarc' | 'international';

export type CarrierContract = {
  id: string;
  /** Two-letter plating carrier. `*` matches any, for a consolidator-wide deal. */
  carrier: string;
  name: string;
  /** Percentage of the BASE fare. Airlines commission the fare, not the taxes. */
  commissionPct: number;
  /**
   * A flat amount per document, on top of or instead of the percentage.
   *
   * Some Bangladeshi carriers pay a fixed sum per sector rather than a rate, and a
   * table that could only express percentages would force somebody to convert one
   * into the other and then maintain the fiction.
   */
  flatAmount: number;
  /** `base` is standard. `gross` exists because a few contracts really do say it. */
  basis: 'base' | 'gross';
  /** Scope. `any` unless the deal is banded. */
  band: RouteBand;
  /** Cabin restriction, e.g. `Y`. Empty means any. */
  cabin: string;
  /** Inclusive. A contract with no end date runs until one is set. */
  effectiveFrom: string;
  effectiveTo: string;
  /** Caps the commission on one document. 0 means uncapped. */
  capPerDocument: number;
  /**
   * Volume bonus, recorded but NOT applied per ticket.
   *
   * A PLB is settled quarterly against total production, so attributing a slice of
   * it to each ticket would report money that has not been earned and may never be.
   * Held here so the rate is not lost, and left out of the arithmetic.
   */
  incentivePct: number;
  active: boolean;
  note: string;
};

export const contracts = (book: Book): CarrierContract[] => book.contracts ?? [];

/** SAARC neighbours, for the band a Bangladeshi contract is most likely to name. */
const SAARC = new Set(['IN', 'PK', 'LK', 'NP', 'BT', 'MV', 'AF']);
const BD_AIRPORTS = new Set(['DAC', 'CGP', 'ZYL', 'CXB', 'JSR', 'RJH', 'SPD', 'BZL']);

/**
 * Which band a document flies in, from its own sectors.
 *
 * Derived rather than stored: a sector list already says where the aircraft goes,
 * and a stored band is a second copy that drifts the first time somebody edits the
 * route. Falls back to `international`, because that is the band with the lowest
 * commission in every contract seen — guessing in the agency's favour would
 * overstate margin.
 */
export function bandOf(doc: TravelDocument, countryOf: (iata: string) => string | undefined): RouteBand {
  if (!doc.sectors.length) return 'international';
  const airports = doc.sectors.flatMap((s) => [s.origin, s.destination]);
  if (airports.every((a) => BD_AIRPORTS.has(a))) return 'domestic';
  const countries = airports.map((a) => (BD_AIRPORTS.has(a) ? 'BD' : countryOf(a)));
  if (countries.every((c) => c && (c === 'BD' || SAARC.has(c)))) return 'saarc';
  return 'international';
}

export type CommissionResult = {
  amount: number;
  pct: number;
  contract: CarrierContract;
  capped: boolean;
};

/**
 * The commission a document earns, or null when no contract covers it.
 *
 * Null and not zero. Zero says the airline allowed nothing; null says nobody has
 * told this book what the deal is, and those lead to different conversations.
 *
 * Most specific contract wins: a carrier-and-band deal beats a carrier-wide one,
 * which beats a `*` consolidator deal. Ties break on the later start date, so
 * re-signing a contract without ending the old one does the expected thing.
 */
export function commissionFor(
  book: Book,
  doc: TravelDocument,
  band: RouteBand = 'international'
): CommissionResult | null {
  if (isMemo(doc)) return null;
  const on = doc.issueDate ?? doc.travelDate;
  if (!on) return null;
  const base = doc.baseFare;
  if (base === null) return null;

  const candidates = contracts(book)
    .filter((c) => c.active)
    .filter((c) => c.carrier === doc.platingCarrier || c.carrier === '*')
    .filter((c) => c.effectiveFrom <= on && (!c.effectiveTo || c.effectiveTo >= on))
    .filter((c) => c.band === 'any' || c.band === band)
    .filter((c) => !c.cabin || c.cabin === (doc.sectors[0]?.bookingClass ?? ''))
    .sort((a, b) => {
      const rank = (c: CarrierContract) =>
        (c.carrier === '*' ? 0 : 2) + (c.band === 'any' ? 0 : 1) + (c.cabin ? 1 : 0);
      const d = rank(b) - rank(a);
      return d !== 0 ? d : b.effectiveFrom.localeCompare(a.effectiveFrom);
    });

  const contract = candidates[0];
  if (!contract) return null;

  const on_ = contract.basis === 'gross' ? (documentGross(doc) ?? base) : base;
  const raw = Math.round((on_ * contract.commissionPct) / 100) + Math.round(contract.flatAmount);
  const capped = contract.capPerDocument > 0 && raw > contract.capPerDocument;
  const amount = capped ? contract.capPerDocument : raw;

  return { amount, pct: on_ > 0 ? (amount / on_) * 100 : 0, contract, capped };
}

/**
 * What the book would look like if a rate applied to what it already sold.
 *
 * The tool an owner actually wants before a negotiation: "if BS gave us 3%, what is
 * that worth a year?" It reads the documents and computes; it writes nothing, and
 * the page says so. Answering that question with a spreadsheet is how a rate gets
 * agreed that turns out to be worth less than the volume commitment behind it.
 */
export function whatIf(book: Book, carrier: string, pct: number, basis: 'base' | 'gross' = 'base') {
  const rows = documents(book).filter(
    (d) => !isMemo(d) && d.baseFare !== null && (carrier === '*' || d.platingCarrier === carrier)
  );
  const on = (d: TravelDocument) => (basis === 'gross' ? (documentGross(d) ?? 0) : (d.baseFare ?? 0));
  const fareBase = rows.reduce((t, d) => t + on(d), 0);
  return {
    documents: rows.length,
    fareBase: Math.round(fareBase),
    commission: Math.round((fareBase * pct) / 100),
    /** Documents with no fare split cannot contribute and are named rather than dropped. */
    unpriced: documents(book).filter((d) => !isMemo(d) && d.baseFare === null).length
  };
}

/** Every carrier the book has actually sold, so the calculator offers real choices. */
export function carriersSold(book: Book): { carrier: string; documents: number; fareBase: number }[] {
  const acc = new Map<string, { carrier: string; documents: number; fareBase: number }>();
  for (const d of documents(book)) {
    if (isMemo(d) || !d.platingCarrier) continue;
    const hit = acc.get(d.platingCarrier) ?? { carrier: d.platingCarrier, documents: 0, fareBase: 0 };
    hit.documents += 1;
    hit.fareBase += d.baseFare ?? 0;
    acc.set(d.platingCarrier, hit);
  }
  return [...acc.values()].sort((a, b) => b.fareBase - a.fareBase);
}

export { taxTotal };
