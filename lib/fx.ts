import type { Book, Invoice, Receipt } from '@/lib/accounting';

/**
 * Splitting a settlement into what it relieves, what the rate moved, and what is
 * simply too much.
 *
 * THIS CLOSED A LATENT DEFECT, NOT A FEATURE REQUEST
 *
 * The book carried a hole that nothing had stepped in yet. A receipt posted
 * `Dr bank / Cr receivables` for the whole cash amount, while the control side
 * computed the amount due as `max(0, total − paid)` — floored at zero. Those two
 * agree only while no receipt ever exceeds what its invoice is carrying.
 *
 * Proven rather than argued: recording one receipt of 595,200 against an invoice
 * receivables was carrying at 588,000 put the accounts receivable row out by
 * exactly 7,200 and the control-basis trial balance with it. The two-derivation
 * check caught it, which is what it is for — but nothing in the code handled it, so
 * the first foreign settlement or the first overpayment would have broken the book
 * and left somebody hunting.
 *
 * THE TWO CAUSES ARE DIFFERENT AND MUST NOT BE CONFLATED
 *
 * A receipt can exceed the carrying value for two unrelated reasons:
 *
 *   The rate moved. A 4,800 USD invoice raised at 122.5 is carried at 588,000. Paid
 *   in USD when the rate is 124, the bank receives 595,200. Nobody overpaid — the
 *   agency made 7,200 on the rate, which is an exchange GAIN.
 *
 *   The customer paid too much. They owed 588,000 taka and sent 595,200 taka. The
 *   agency owes them 7,200 back. That is a LIABILITY, not income, and booking it as
 *   a gain would report profit the agency does not have.
 *
 * Telling them apart needs the settlement rate, which is why `receipt.currency` and
 * `receipt.fxRate` had to exist. Without them every excess is an overpayment, which
 * is the safer of the two readings — it never invents income.
 *
 * ONE ALLOCATION, TWO CALLERS
 *
 * `allocate` is called by the journal builder and by the control-side derivations.
 * That is deliberate and is the whole point: the defect above existed because two
 * pieces of code answered "how much did this relieve" differently. One function
 * cannot disagree with itself.
 */

export type Allocation = {
  /** What receivables should actually be relieved by. Never more than it carries. */
  relief: number;
  /** Gain (positive) or loss (negative) because the rate moved. */
  fx: number;
  /** Received beyond the debt, and owed back. */
  overpaid: number;
  /** The full cash that arrived, for the funds side of the entry. */
  cash: number;
};

/** Foreign amount and rate on a voucher, defaulting to base currency. */
const rateOf = (v: { currency?: string; fxRate?: number }) =>
  v.currency && Number(v.fxRate) > 0 ? Number(v.fxRate) : 1;

/**
 * Split one settlement.
 *
 * `carrying` is what the debt is still worth in base currency before this
 * settlement, so a caller walking several receipts against one invoice passes the
 * running remainder. Order matters and the caller owns it — the journal and the
 * control side both walk in date order, which is the order the money arrived.
 */
export function allocate(
  settlement: { amount: number; currency?: string; fxRate?: number },
  debt: { currency?: string; fxRate?: number },
  carrying: number
): Allocation {
  const cash = Math.round(settlement.amount);
  const relief = Math.min(cash, Math.max(0, Math.round(carrying)));
  let excess = cash - relief;

  /**
   * FX only when both sides name the same foreign currency and the rates differ.
   *
   * A settlement with no currency is base currency: the customer paid taka and the
   * agency bore no exchange movement, so an excess there is an overpayment however
   * foreign the invoice was. Reading it as a gain would invent income out of a
   * customer's arithmetic error.
   */
  const sameForeign =
    Boolean(settlement.currency) &&
    Boolean(debt.currency) &&
    settlement.currency === debt.currency;

  let fx = 0;
  if (sameForeign && excess > 0) {
    const settleRate = rateOf(settlement);
    const debtRate = rateOf(debt);
    if (settleRate !== debtRate) {
      // The foreign amount implied by the cash at the settlement rate, revalued at
      // the rate the debt was carried at. Capped by the excess, so a customer who
      // both overpays AND settles at a better rate has each part named correctly.
      const foreign = settleRate > 0 ? cash / settleRate : 0;
      fx = Math.min(excess, Math.round(foreign * (settleRate - debtRate)));
      excess -= fx;
    }
  }

  return { relief, fx, overpaid: excess, cash };
}

type Settled = { invoice: Invoice; receipt: Receipt; alloc: Allocation };

/**
 * Every receipt allocated against its invoice, in date order.
 *
 * Built once and used by both the journal and the reports, for the reason in the
 * header: two answers to "how much did this relieve" is what caused the defect.
 */
export function settlements(book: Book): Settled[] {
  const byInvoice = new Map<string, Receipt[]>();
  for (const r of book.receipts) {
    if (!r.invoiceId) continue;
    byInvoice.set(r.invoiceId, [...(byInvoice.get(r.invoiceId) ?? []), r]);
  }

  const out: Settled[] = [];
  for (const invoice of book.invoices) {
    const receipts = (byInvoice.get(invoice.id) ?? [])
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.no.localeCompare(b.no)));
    if (!receipts.length) continue;

    // What receivables is carrying: the invoice in base currency, less credit notes
    // that relieved it rather than refunding cash.
    const fx = rateOf(invoice);
    const gross = invoice.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
    const vat = Math.round((gross * (invoice.vatRate || 0)) / 100);
    const credited = (book.creditNotes ?? [])
      .filter((n) => n.invoiceId === invoice.id && n.settlement === 'credit_balance')
      .reduce((t, n) => t + n.amount, 0);
    let carrying = Math.round(gross * fx) + vat - credited;

    for (const receipt of receipts) {
      const alloc = allocate(receipt, invoice, carrying);
      carrying -= alloc.relief;
      out.push({ invoice, receipt, alloc });
    }
  }
  return out;
}

/** Exchange gain, net of loss, over the whole book — the control-side figure. */
export function fxGain(book: Book): { rows: Settled[]; total: number } {
  const rows = settlements(book).filter((s) => s.alloc.fx !== 0);
  return { rows, total: Math.round(rows.reduce((t, s) => t + s.alloc.fx, 0)) };
}

/** Money held for customers who paid more than they owed. */
export function customerCredit(book: Book): { rows: Settled[]; total: number } {
  const rows = settlements(book).filter((s) => s.alloc.overpaid !== 0);
  return { rows, total: Math.round(rows.reduce((t, s) => t + s.alloc.overpaid, 0)) };
}
