import type { Book, Invoice, InvoiceLine } from '@/lib/accounting';
import type { RouteBand } from '@/lib/contracts';

/**
 * Tax rules as dated data, not as a number on the company record.
 *
 * WHY `company.vatRate` HAD TO GO
 *
 * A single rate is wrong in three separate ways for this market, and every one of
 * them was researched rather than assumed:
 *
 *   Excise duty on an air ticket is BANDED BY ROUTE and charged as a fixed amount,
 *   not a percentage — domestic and SAARC sit in different bands and the amounts
 *   have been revised more than once. A percentage field cannot express it at all.
 *
 *   VAT on a travel agent's COMMISSION was waived by the NBR after ATAB's
 *   representations. A product that assumes commission is VAT-able bills the
 *   agency's customers wrongly.
 *
 *   Hajj carries its own exemptions — airfare excise duty and VAT have both been
 *   waived for pilgrims. Given how much Hajj volume the agencies in this dataset
 *   carry, that is not an edge case here.
 *
 * A rate is also a thing that CHANGES. Held as one number on the company record, a
 * budget-night change silently restates every invoice ever raised, because the
 * report recomputes from the current rate. Held here with effective dates, last
 * year's invoices keep last year's treatment — which is the whole reason the
 * figures on a screen can be compared with what was filed.
 *
 * NOTHING IS SEEDED, FOR THE SAME REASON AS THE CARRIER CONTRACTS
 *
 * The bands and the amounts move, and a stale rate baked into a shipped product is
 * a wrong invoice that looks authoritative. The amounts I found in reporting are
 * recorded in the README as reference, not loaded as data. An empty table means the
 * book behaves exactly as it does today: `vatRate` on each invoice is still
 * honoured, so nothing that has been invoiced changes.
 */

/** What the rule is charged on. */
export type TaxBasis =
  | 'fare'          // the airline fare, before anything else
  | 'commission'    // what the agency earned — waived in Bangladesh, hence the flag
  | 'service_charge'// the agency's own markup
  | 'gross';        // the whole invoice line

export type TaxRule = {
  id: string;
  /** IATA or NBR code, e.g. `BD`, `E5`, `OW`, `AIT`. Printed on the document. */
  code: string;
  name: string;
  basis: TaxBasis;
  /** Percentage of the basis. Zero when the rule is a fixed amount. */
  ratePct: number;
  /**
   * A fixed amount per passenger. Excise duty is charged this way, which is why a
   * rate-only table could not express it.
   */
  fixedAmount: number;
  /** `any` unless the rule is banded. Excise duty always is. */
  band: RouteBand;
  /** Service ids this rule applies to. Empty means every service. */
  serviceIds: string[];
  /**
   * Service ids explicitly exempt, which beats `serviceIds`.
   *
   * This is how the Hajj waiver is expressed: a rule that applies to air tickets
   * generally, with the Hajj service excluded. Modelling it as an exclusion rather
   * than as a separate Hajj rule means the waiver being withdrawn is one edit.
   */
  exemptServiceIds: string[];
  /** Withheld at source and recoverable against the agency's own assessment. */
  withholding: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  active: boolean;
  note: string;
};

export const taxRules = (book: Book): TaxRule[] => book.taxRules ?? [];

export type TaxLine = { code: string; name: string; amount: number; rule: TaxRule };

/**
 * The tax a line attracts, on a given date.
 *
 * `on` is the invoice date, never today. A rule introduced in July must not appear
 * on a June invoice, and a rule withdrawn in July must still appear on one — both
 * fall out of the date bound rather than needing to be remembered.
 *
 * Returns an empty list when no rule covers the line, which on a book with no rules
 * loaded is every line. That is why introducing this table changes no figure: the
 * `vatRate` already stored on each invoice keeps doing exactly what it did.
 */
export function taxesFor(
  book: Book,
  line: InvoiceLine,
  opts: { on: string; band?: RouteBand; fare?: number; commission?: number }
): TaxLine[] {
  const band = opts.band ?? 'international';
  const gross = Math.round(line.unitPrice * line.qty);
  const fare = opts.fare ?? line.supplierCost;
  const commission = opts.commission ?? 0;
  const serviceCharge = Math.max(0, gross - fare);
  const pax = Math.max(1, Number(line.pax) || 1);

  const basisAmount: Record<TaxBasis, number> = {
    fare, commission, service_charge: serviceCharge, gross
  };

  return taxRules(book)
    .filter((r) => r.active)
    .filter((r) => r.effectiveFrom <= opts.on && (!r.effectiveTo || r.effectiveTo >= opts.on))
    .filter((r) => r.band === 'any' || r.band === band)
    .filter((r) => !r.exemptServiceIds.includes(line.serviceId))
    .filter((r) => r.serviceIds.length === 0 || r.serviceIds.includes(line.serviceId))
    .map((r) => {
      // A fixed amount is per passenger; a percentage is on the basis for the line.
      const amount = r.fixedAmount > 0
        ? Math.round(r.fixedAmount * pax)
        : Math.round((basisAmount[r.basis] * r.ratePct) / 100);
      return { code: r.code, name: r.name, amount, rule: r };
    })
    .filter((t) => t.amount !== 0);
}

/** Every tax on an invoice, line by line, on the invoice's own date. */
export function invoiceTaxes(book: Book, invoice: Invoice, bandOf?: (l: InvoiceLine) => RouteBand): TaxLine[] {
  return invoice.lines.flatMap((l) =>
    taxesFor(book, l, { on: invoice.date, band: bandOf ? bandOf(l) : 'international' })
  );
}

/**
 * What a rule change would do to what has already been invoiced.
 *
 * The same shape of tool as the commission calculator, for the same reason: a
 * budget-night change to the excise band is announced as a number, and the question
 * an agency owner has is what it costs them across the volume they already fly.
 * Reads and computes; writes nothing.
 */
export function whatIfTax(
  book: Book,
  spec: { basis: TaxBasis; ratePct: number; fixedAmount: number; band: RouteBand; serviceIds: string[] }
) {
  let lines = 0;
  let pax = 0;
  let basisTotal = 0;
  let amount = 0;

  for (const inv of book.invoices) {
    if (inv.status === 'draft' || inv.status === 'cancelled') continue;
    for (const l of inv.lines) {
      if (spec.serviceIds.length && !spec.serviceIds.includes(l.serviceId)) continue;
      const gross = Math.round(l.unitPrice * l.qty);
      const fare = l.supplierCost;
      const basisAmount = spec.basis === 'gross' ? gross
        : spec.basis === 'fare' ? fare
        : spec.basis === 'service_charge' ? Math.max(0, gross - fare)
        : 0;
      const n = Math.max(1, Number(l.pax) || 1);
      lines += 1;
      pax += n;
      basisTotal += basisAmount;
      amount += spec.fixedAmount > 0
        ? Math.round(spec.fixedAmount * n)
        : Math.round((basisAmount * spec.ratePct) / 100);
    }
  }

  return { lines, pax, basisTotal: Math.round(basisTotal), amount: Math.round(amount) };
}

export const TAX_BASIS_LABEL: Record<TaxBasis, string> = {
  fare: 'Airline fare',
  commission: 'Agency commission',
  service_charge: 'Agency service charge',
  gross: 'Whole line'
};
