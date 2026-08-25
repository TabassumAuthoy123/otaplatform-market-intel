import type { Account, Book } from '@/lib/accounting';
import { accountGroup, chartOfAccounts } from '@/lib/accounting';
import { isLocked } from '@/lib/period-lock.js';
// The rules themselves, shared verbatim with the admin portal. See that file's header.
import {
  controlAccountCodes, JV_PREFIX as PREFIX, nextVoucherNo, naturalSign, reversalLines, validateVoucher
} from '@/lib/journal-rules.js';

/**
 * Manual journal vouchers — the entry every other voucher type is a shortcut for.
 *
 * WHY THE BOOK COULD NOT CLOSE A MONTH WITHOUT THIS
 *
 * Every posting in the book was derived from a business document: an invoice, a
 * receipt, a bill, a payment, an expense, a credit note. That covers trading and
 * nothing else. It leaves no way to record depreciation, an accrual, a prepayment,
 * a provision, a reclassification between two accounts, a correction of a posting
 * made last month, or the opening balances of an agency migrating off TRAACS or
 * Tally. An accountant handed this book could not perform a month-end close, and
 * could not bring their existing balances in on day one — which is the same as
 * saying they could not adopt it at all.
 *
 * THE PART THAT NEEDED CARE
 *
 * This book's central safety property is that the same figures are derived TWICE by
 * independent routes — control accounts walk the vouchers, the journal builds
 * double-entry from those same vouchers — and `reconciliation()` asserts the two
 * agree. That agreement is evidence precisely BECAUSE neither derivation can see the
 * other.
 *
 * A manual voucher exists only on the journal side. Post one to Accounts receivable
 * and the ledger moves while `receivables()` does not, and reconciliation reports a
 * difference that is not a defect. There were three ways out and two of them were
 * wrong:
 *
 *   Teach the control functions about manual entries. This makes the two routes
 *   share a term, and two derivations that share a term agreeing proves nothing.
 *   It would quietly convert the book's best evidence into a tautology.
 *
 *   Forbid manual entries from touching any control account. The cross-check
 *   survives untouched, and the feature loses its two most important uses —
 *   opening balances for receivables and payables, and correcting a mis-posted
 *   customer balance.
 *
 *   State the adjustment. `reconciliation()` gains a third column: control plus
 *   manual adjustments should equal the ledger. The routes stay independent, and a
 *   difference NOT explained by a listed voucher is still exactly as loud as it was.
 *
 * The third is what is implemented. It is also what a real reconciliation looks
 * like — reconciling items are listed, not hidden, and that is the point of them.
 *
 * WHAT IT COSTS, SAID PLAINLY
 *
 * A manual voucher can be used to paper over a genuine defect: post the difference
 * to the account that disagrees and the check goes green. That risk is not removable
 * — it exists in every accounting system ever written, and it is why auditors read
 * journals first. What is controllable is visibility, so a voucher touching a
 * control account is never silent: `controlAdjustments()` lists it by number, date,
 * narration and who posted it, and the financials screen prints that list beside the
 * reconciliation rather than netting it into a total.
 */

export type JournalVoucherLine = {
  /** Account code, from `chartOfAccounts`. */
  account: string;
  debit: number;
  credit: number;
  /** Optional per-line note. The voucher narration is the one that is required. */
  memo?: string;
};

export type JournalVoucher = {
  id: string;
  no: string;
  date: string;
  /**
   * Why this entry exists, in words.
   *
   * Required, and deliberately so. An unexplained journal voucher is the single
   * thing an auditor asks about first, and "the system did not make me type one" is
   * not an answer anybody wants to give six months later.
   */
  narration: string;
  lines: JournalVoucherLine[];
  createdBy: string;
  createdAt: string;
  /** Set on the voucher this one reverses. */
  reversalOf?: string;
  /** Set on the voucher that has been reversed. */
  reversedBy?: string;
};

export const JV_PREFIX: string = PREFIX;

/** The book's manual vouchers. Absent on any book written before this existed. */
export const vouchers = (book: Book): JournalVoucher[] => book.journalEntries ?? [];

/**
 * The accounts a manual voucher may not touch WITHOUT being listed.
 *
 * Not a ban — see the header. These are the codes `reconciliation()` cross-checks,
 * so a voucher touching one of them has to appear in the reconciling-items list or
 * the check would report a difference with no explanation attached.
 *
 * Built from the book because two of them are per-record: every bank account is a
 * control account, and so is every expense category.
 */
export function controlAccounts(book: Book): Set<string> {
  return controlAccountCodes(book) as Set<string>;
}

export type Validation = { ok: boolean; errors: string[]; totalDebit: number; totalCredit: number };

/**
 * Everything that must be true before a voucher may be written.
 *
 * Returns every failure rather than the first, because a form that reports one
 * problem per submission is how a five-line voucher takes five attempts.
 */
export function validate(
  book: Book,
  draft: { date?: string; narration?: string; lines?: Partial<JournalVoucherLine>[] }
): Validation {
  return validateVoucher(book, draft, isLocked) as Validation;
}

const round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Next number in the book's own series, gap-free and independent of array order. */
export function nextNumber(book: Book): string {
  return nextVoucherNo(book) as string;
}

/**
 * The reversal of a voucher, as a new voucher.
 *
 * Reversal rather than deletion, and rather than an edit. A posted entry that can be
 * silently altered is not an audit trail, it is a draft — and the correction of a
 * mistake is itself a fact about the month that somebody may need to explain. Two
 * vouchers that net to nothing tell that story; one voucher that quietly changed
 * tells nobody anything.
 */
export function reversalOf(book: Book, v: JournalVoucher, date: string, by: string): JournalVoucher {
  return {
    id: `jv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    no: nextNumber(book),
    date,
    narration: `Reversal of ${v.no} — ${v.narration}`,
    lines: reversalLines(v) as JournalVoucherLine[],
    createdBy: by,
    createdAt: new Date().toISOString(),
    reversalOf: v.id
  };
}

export type ControlAdjustment = {
  no: string;
  date: string;
  narration: string;
  createdBy: string;
  account: string;
  accountName: string;
  /**
   * The effect on the balance AS THE LEDGER REPORTS IT, not the raw debit minus
   * credit.
   *
   * The two differ by the account's natural sign, and getting that wrong is the exact
   * mistake this file's neighbours have already made once: `reconciliation()` carries
   * a comment about a row that came out at double the value with the sign inverted,
   * because a liability was negated on the assumption that the ledger presented it
   * negative. It does not — `naturalSign` in lib/accounting.ts already flips
   * liability, equity and income, so a credit to Accounts payable RAISES the reported
   * balance. Signing it here the same way is what makes `control + adjustment ===
   * ledger` hold for every account group rather than only for the debit-natured ones.
   */
  amount: number;
};

/**
 * Every manual posting that lands on an account `reconciliation()` cross-checks.
 *
 * This is the list that keeps the cross-check honest. Without it a manual voucher
 * would show up as an unexplained difference between two derivations, and the only
 * two alternatives were to make the derivations dependent on each other or to forbid
 * the entry — see the header for why both are worse.
 */
export function controlAdjustments(book: Book): ControlAdjustment[] {
  const control = controlAccounts(book);
  const chart = chartOfAccounts(book);
  const nameOf = (code: string) => chart.find((a: Account) => a.code === code)?.name ?? code;
  const out: ControlAdjustment[] = [];
  for (const v of vouchers(book)) {
    for (const l of v.lines) {
      if (!control.has(l.account)) continue;
      const amount = round(((l.debit ?? 0) - (l.credit ?? 0)) * naturalSign(accountGroup(l.account, chart)));
      if (!amount) continue;
      out.push({
        no: v.no, date: v.date, narration: v.narration, createdBy: v.createdBy,
        account: l.account, accountName: nameOf(l.account), amount
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));
}

/** The net manual movement on one account, for the reconciliation's third column. */
export function adjustmentFor(book: Book, code: string): number {
  return round(
    controlAdjustments(book)
      .filter((a) => a.account === code)
      .reduce((t, a) => t + a.amount, 0)
  );
}
