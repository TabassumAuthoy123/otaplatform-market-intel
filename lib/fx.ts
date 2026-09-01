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
  const owed = Math.max(0, Math.round(carrying));

  /**
   * FX only when both sides name the same foreign currency.
   *
   * A settlement with no currency is base currency: the customer paid taka and the
   * agency bore no exchange movement, so a difference there is an overpayment however
   * foreign the invoice was. Reading it as a gain would invent income out of a
   * customer's arithmetic error.
   */
  const sameForeign =
    Boolean(settlement.currency) &&
    Boolean(debt.currency) &&
    settlement.currency === debt.currency;

  const settleRate = rateOf(settlement);
  const debtRate = rateOf(debt);

  if (!sameForeign || settleRate <= 0 || debtRate <= 0) {
    const relief = Math.min(cash, owed);
    return { relief, fx: 0, overpaid: cash - relief, cash };
  }

  /**
   * WHY THIS WORKS IN THE FOREIGN CURRENCY AND NOT IN TAKA
   *
   * The first version asked "is there cash left over after the debt is cleared?" and
   * split that leftover into rate movement and overpayment. That question can only be
   * answered yes when the rate moved in the agency's favour, so the function could
   * only ever produce a gain — and it was the only thing in the chain that could not
   * handle a loss. Allocation.fx is documented as "gain (positive) or loss (negative)",
   * fxGain() says "net of loss", the account is called Exchange gain / (loss), and the
   * journal has had a `fxPart < 0` debit branch the whole time. Every consumer was
   * built for losses; the one function that decides never emitted one.
   *
   * Found on real data, not by reading. SFT-INV-0121 was raised for 3,000 USD at 123
   * and carried at 369,000. FlyTrek paid all 3,000 dollars when the rate was 120, so
   * 360,000 arrived. Nothing was left over, so the old rule saw no exchange movement
   * at all and relieved receivables by the cash. The book then said FlyTrek owed 9,000
   * taka: it aged, it sat in Accounts receivable, and it appeared on the reminders
   * screen as a debt to chase from a customer who did not owe a cent. The agency had
   * taken a 9,000 exchange loss and the accounts recorded a receivable instead.
   *
   * The cross-check could not see it. Both derivations call this function, so both
   * were wrong by the same 9,000 and agreed perfectly. A shared misreading is exactly
   * the failure a two-derivation check cannot catch, which is worth remembering before
   * trusting a difference of zero.
   *
   * So ask the question the other way round. The debt is denominated in dollars, so
   * work in dollars: the dollars received clear the dollars owed, and the gap between
   * what those dollars cost in cash and what the debt was carried at IS the rate
   * movement — in whichever direction it went. Dollars beyond the debt are the
   * overpayment, and they are valued at the rate they actually arrived at.
   */
  const owedForeign = owed / debtRate;
  const paidForeign = cash / settleRate;
  const appliedForeign = Math.min(paidForeign, owedForeign);
  const excessForeign = paidForeign - appliedForeign;

  const relief = Math.min(owed, Math.round(appliedForeign * debtRate));
  const overpaid = Math.round(excessForeign * settleRate);

  /**
   * Derived last, and by subtraction, so the three parts add back to the cash to the
   * taka. Rounding each of them independently would leak a taka or two into the trial
   * balance on awkward rates, and a trial balance that is out by two is worse than
   * useless — it trains people to ignore it.
   */
  const fx = cash - relief - overpaid;

  return { relief, fx, overpaid, cash };
}

type Settled = { invoice: Invoice; receipt: Receipt; alloc: Allocation };

/**
 * Every receipt allocated against its invoice, in date order.
 *
 * Built once and used by both the journal and the reports, for the reason in the
 * header: two answers to "how much did this relieve" is what caused the defect.
 */
const byArrival = (a: Receipt, b: Receipt) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.no.localeCompare(b.no);

/**
 * What one invoice's receipts actually relieved, and what the rate did along the way.
 *
 * Exists because invoiceTotals() was the last place still answering "how much did this
 * relieve" on its own, with `total - credited - cash` floored at zero. That is the very
 * expression the header of this file describes as the original defect, and it survived the
 * fix because the floor made it look right: a receipt of 595,200 against a debt of 588,000
 * gave -7,200, the floor turned it into 0, and 0 was the correct answer for the wrong
 * reason. An exchange LOSS has nothing to hide behind. The same invoice paid at a weaker
 * rate left 9,000 sitting in receivables, aged, and on the reminders screen.
 *
 * Receipts are walked in the order the money arrived, because each one is measured against
 * what the debt was still carrying when it landed.
 */
export function reliefOn(
  invoice: { currency?: string; fxRate?: number },
  receipts: Receipt[],
  carrying: number
): { relief: number; fx: number; overpaid: number; allocations: Allocation[] } {
  let left = carrying;
  const allocations: Allocation[] = [];
  for (const r of [...receipts].sort(byArrival)) {
    const a = allocate(r, invoice, left);
    left -= a.relief;
    allocations.push(a);
  }
  return {
    relief: allocations.reduce((t, a) => t + a.relief, 0),
    fx: allocations.reduce((t, a) => t + a.fx, 0),
    overpaid: allocations.reduce((t, a) => t + a.overpaid, 0),
    allocations
  };
}

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
      .sort(byArrival);
    if (!receipts.length) continue;

    // What receivables is carrying: the invoice in base currency, less credit notes
    // that relieved it rather than refunding cash.
    // VAT is charged on the converted value, not on the document one — adding it before
    // the conversion valued a foreign invoice's VAT in dollars and called it taka. It has
    // never bitten because both foreign invoices in the book are zero-rated, which is not a
    // reason to leave it. invoiceTotals() has always done it this way round; this is the
    // copy that drifted.
    const fx = rateOf(invoice);
    const grossDoc = invoice.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
    const gross = Math.round(grossDoc * fx);
    const vat = Math.round((gross * (invoice.vatRate || 0)) / 100);
    const credited = (book.creditNotes ?? [])
      .filter((n) => n.invoiceId === invoice.id && n.settlement === 'credit_balance')
      .reduce((t, n) => t + n.amount, 0);
    const carrying = gross + vat - credited;

    const { allocations } = reliefOn(invoice, receipts, carrying);
    receipts.forEach((receipt, i) => out.push({ invoice, receipt, alloc: allocations[i] }));
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
