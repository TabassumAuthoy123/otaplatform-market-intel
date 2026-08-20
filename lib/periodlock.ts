import type { Book } from '@/lib/accounting';

/**
 * Closing a period, so a filed month cannot be quietly restated.
 *
 * WHY THIS MATTERS MORE AFTER THIS WEEK'S WORK THAN BEFORE IT
 *
 * Every figure in this book is recomputed from the vouchers on every request. That
 * is the property the whole design rests on and it has been worth having — a total
 * cannot go stale and a corrected voucher corrects every report at once.
 *
 * It has an edge nobody had closed. Editing a voucher dated in March silently
 * changes March's profit, March's VAT and March's trial balance, months after the
 * return was filed. A stored total would at least have disagreed loudly; a derived
 * one just quietly reports a different past. And the more that derives from the
 * vouchers — deferred revenue, memo liabilities, branch margin, commission — the
 * more a late edit moves without anyone deciding it should.
 *
 * So: one date. On or before it, the book refuses writes.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not freeze the derivations. Reports over a locked period still recompute,
 * because the arithmetic is not what was unsafe — the inputs were. And it does not
 * prevent correcting a closed month; it prevents doing so *silently*. The correct
 * move on a closed period is a dated adjustment in the open one, which is what an
 * accountant would do on paper, and the refusal message says so.
 *
 * Absent means nothing is locked. Every book written before this existed keeps
 * behaving exactly as it did, and a lock is opted into one period at a time.
 */

export type LockVerdict = { ok: boolean; reason: string; lockedThrough: string | null };

/**
 * The guard itself lives in lib/period-lock.js, shared with the zero-dependency
 * admin portal. Two writers must refuse the same dates, and a guard written twice
 * is a guard that drifts into a hole — the admin accepting an edit the app rejects,
 * silently. Same split as lib/panel-modules.js.
 */
export { isLocked, mayWrite, datesOf } from '@/lib/period-lock.js';

export const lockedThrough = (book: Book): string | null => book.lockedThrough ?? null;

/**
 * Thrown by a write path that refuses. Its own class so an API answers 409 with the
 * reason rather than 500 with a stack trace — the same reasoning as the credit
 * limit: a refusal somebody can act on is not the server falling over.
 */
export class PeriodLockedError extends Error {
  readonly code = 'PERIOD_LOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'PeriodLockedError';
  }
}

/**
 * What sits inside the closed period, so closing one is an informed decision.
 *
 * Counting before locking matters: an operator who closes March without knowing
 * there are eleven unpaid March invoices in it has not closed a period, they have
 * hidden a chase list.
 */
export function whatIsClosed(book: Book, through: string) {
  const upTo = (d?: string | null) => Boolean(d) && String(d) <= through;
  const vouchers =
    book.invoices.filter((x) => upTo(x.date)).length +
    book.receipts.filter((x) => upTo(x.date)).length +
    book.bills.filter((x) => upTo(x.date)).length +
    book.payments.filter((x) => upTo(x.date)).length +
    book.expenses.filter((x) => upTo(x.date)).length;

  const unpaid = book.invoices.filter((x) => upTo(x.date) && x.status !== 'paid' && x.status !== 'cancelled').length;
  const drafts = book.invoices.filter((x) => upTo(x.date) && x.status === 'draft').length;

  return { through, vouchers, unpaid, drafts };
}
