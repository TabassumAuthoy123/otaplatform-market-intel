import type { Book, Customer } from '@/lib/accounting';
import { invoiceTotals, todayISO } from '@/lib/accounting';

/**
 * Credit control — what a customer owes now, against what they are allowed to owe.
 *
 * WHY THIS IS WORTH BUILDING AND WHY IT IS CHEAP
 *
 * TRAACS sells "real-time credit control" and it is one of the few things on their
 * list an agency owner asks about unprompted, because the failure it prevents is
 * the one that actually kills small agencies: a corporate client quietly runs up
 * six months of tickets, stops paying, and the agency has already remitted every
 * one of those fares to the airline.
 *
 * The expensive part of that feature is having a receivables figure that is
 * correct at the moment you ask. This book recomputes receivables from the
 * vouchers on every request already, so the exposure is a group-by and the limit
 * is one new field. What was missing was not the arithmetic — it was somewhere to
 * put the limit and somewhere to check it.
 *
 * WHAT "EXPOSURE" MEANS HERE, PRECISELY
 *
 * The unpaid balance of every live invoice for that customer. Not the invoice
 * totals — the balance after receipts and credit notes, which is the number the
 * agency is actually out of pocket for.
 *
 * A held booking that has not been invoiced is NOT counted, and that is a real
 * limitation rather than an oversight: a document is linked to an invoice line,
 * so a document with no invoice has no customer to attribute to. Today the
 * storefront invoices every booking as it is made, so the gap is theoretical; it
 * stops being theoretical the day quotations are held without invoicing, and the
 * fix then is a customerId on the document.
 *
 * ADVISORY, NOT A LOCK
 *
 * `check()` reports a breach. It does not stop a save anywhere in the accounting
 * module, because an agency that has decided to extend credit past its own limit
 * for a good reason should not have to edit a master record to do it. The one
 * place it does refuse is the self-service storefront booking, where nobody is
 * exercising judgement — see lib/bookings.ts.
 */

/**
 * Thrown when a sale would take a customer past their credit limit.
 *
 * Its own class rather than a plain Error so the API route can answer 409 with the
 * reason instead of 500 with a stack trace. A refusal a customer can act on —
 * "settle an invoice or ask us to raise the limit" — is a different thing from the
 * server having fallen over, and collapsing the two would make a working control
 * look like an outage.
 */
export class CreditLimitError extends Error {
  readonly code = 'CREDIT_LIMIT';
  constructor(message: string) {
    super(message);
    this.name = 'CreditLimitError';
  }
}

export type CreditPosition = {
  customer: Customer;
  /** Unpaid balance across every live invoice, after receipts and credit notes. */
  exposure: number;
  /** 0 means no limit is enforced. */
  limit: number;
  /** Undefined when no limit is set — not 0, which would read as "none left". */
  headroom: number | undefined;
  breached: boolean;
  /** How many invoices make up the exposure. */
  openInvoices: number;
  /** The oldest unpaid invoice date, which is what makes a breach urgent or not. */
  oldest: string | null;
};

export function creditPositions(book: Book): CreditPosition[] {
  const notes = book.creditNotes ?? [];

  const byCustomer = new Map<string, { due: number; count: number; oldest: string | null }>();
  for (const i of book.invoices) {
    if (i.status === 'draft') continue;
    const t = invoiceTotals(i, book.receipts, notes);
    if (t.cancelled || t.due <= 0) continue;
    const hit = byCustomer.get(i.customerId) ?? { due: 0, count: 0, oldest: null };
    hit.due += t.due;
    hit.count += 1;
    hit.oldest = hit.oldest === null || i.date < hit.oldest ? i.date : hit.oldest;
    byCustomer.set(i.customerId, hit);
  }

  return book.customers
    .map((customer): CreditPosition => {
      const hit = byCustomer.get(customer.id);
      const exposure = Math.round(hit?.due ?? 0);
      const limit = Math.max(0, Math.round(Number(customer.creditLimit) || 0));
      return {
        customer,
        exposure,
        limit,
        headroom: limit > 0 ? limit - exposure : undefined,
        breached: limit > 0 && exposure > limit,
        openInvoices: hit?.count ?? 0,
        oldest: hit?.oldest ?? null
      };
    })
    .sort((a, b) => {
      // Breaches first, then the largest exposure — the order somebody chasing
      // money would want, not alphabetical.
      if (a.breached !== b.breached) return a.breached ? -1 : 1;
      return b.exposure - a.exposure;
    });
}

export function creditPosition(book: Book, customerId: string): CreditPosition | undefined {
  return creditPositions(book).find((p) => p.customer.id === customerId);
}

export type CreditVerdict = {
  ok: boolean;
  reason: string;
  exposure: number;
  limit: number;
  /** What the exposure would become if this sale went ahead. */
  wouldBe: number;
};

/**
 * Would this sale take the customer past their limit?
 *
 * The question credit control actually answers — not "are they over" but "would
 * this put them over", asked before the sale rather than discovered at month end.
 *
 * A customer with no limit set always passes. A customer with a limit who is
 * already over it fails even for a small sale, which is the intended behaviour: the
 * point at which somebody has to make a decision is the next order, not the one
 * that crossed the line.
 */
export function wouldBreach(book: Book, customerId: string, saleValue: number): CreditVerdict {
  const pos = creditPosition(book, customerId);
  const exposure = pos?.exposure ?? 0;
  const limit = pos?.limit ?? 0;
  const wouldBe = exposure + Math.max(0, Math.round(saleValue));

  if (!pos) return { ok: true, reason: 'No such customer on the book yet, so nothing is owed.', exposure: 0, limit: 0, wouldBe };
  if (limit <= 0) {
    return { ok: true, reason: 'No credit limit is set for this customer.', exposure, limit, wouldBe };
  }
  if (wouldBe > limit) {
    return {
      ok: false,
      reason:
        `${pos.customer.name} owes ${exposure.toLocaleString('en-IN')} against a limit of ` +
        `${limit.toLocaleString('en-IN')}. This sale would take them to ${wouldBe.toLocaleString('en-IN')}. ` +
        `Take payment against the open invoices, or raise the limit in Masters.`,
      exposure, limit, wouldBe
    };
  }
  return {
    ok: true,
    reason: `Within limit — ${(limit - wouldBe).toLocaleString('en-IN')} of headroom would remain.`,
    exposure, limit, wouldBe
  };
}

/** The whole book's credit position, for a dashboard tile or an alert. */
export function creditSummary(book: Book) {
  const positions = creditPositions(book);
  const withLimit = positions.filter((p) => p.limit > 0);
  const breached = withLimit.filter((p) => p.breached);
  return {
    positions,
    withLimit: withLimit.length,
    breached,
    overBy: breached.reduce((t, p) => t + (p.exposure - p.limit), 0),
    totalExposure: positions.reduce((t, p) => t + p.exposure, 0),
    today: todayISO(book)
  };
}
