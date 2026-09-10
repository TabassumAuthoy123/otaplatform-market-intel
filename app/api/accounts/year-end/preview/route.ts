import { NextResponse } from 'next/server';
import {
  balanceSheet, cashBook, generalLedger, getBookUnguarded, journalTrialBalance,
  plAgreesWithLedger, profitAndLoss, reconciliation, summarise
} from '@/lib/accounting';
import type { AccountGroup } from '@/lib/accounting';
import { todayIn } from '@/lib/clock';
import * as FY from '@/lib/financial-year.js';
import { openingDate } from '@/lib/journal-rules.js';

export const dynamic = 'force-dynamic';

/**
 * What closing a financial year at this date would record — and every reason it would be
 * refused.
 *
 * THE ONLY PLACE THE FIGURES ARE DERIVED.
 *
 * The admin portal is what actually closes a year, and the portal has no TypeScript and no
 * build step: it cannot run the ledger. It must not grow its own copy of one either, because a
 * second implementation of "what did this year make" is the exact shape of defect this book's
 * two-derivation cross-check exists to catch — and a copy inside the thing doing the closing
 * would be a copy nothing checks.
 *
 * So the portal asks. It renders what comes back, posts nothing of its own, and — this is the
 * part that matters — asks AGAIN server-side at the moment of the close and records THAT answer,
 * never the numbers that were sitting on the confirmation screen. A figure that made a round
 * trip through a form is a figure somebody could have edited.
 *
 * `bookRevision` is returned so the close can refuse when the book moved between the preview
 * and the click. Two people closing the same year from two screens is not a hypothetical in a
 * product with two writing processes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const book = await getBookUnguarded();
  const today = todayIn(book.company.timezone);
  const through = (url.searchParams.get('through') || FY.proposedClose(book, today) || '').trim();

  if (!FY.ISO.test(through)) {
    return NextResponse.json(
      { ok: false, error: `"${through}" is not a date. Use YYYY-MM-DD.`, proposed: FY.proposedClose(book, today) },
      { status: 422 }
    );
  }

  /* --------------------------------------------- what the book alone can refuse */
  const refusals = FY.closeRefusals(book, through, { today, openingDate: openingDate(book) });

  /* ------------------------------------------------------ what the journal says */
  const summary = generalLedger(book, undefined, undefined, through).summary;
  const group = (g: AccountGroup) =>
    summary.filter((r) => r.account.group === g).reduce((t, r) => t + r.balance, 0);

  const income = Math.round(group('income'));
  const expense = Math.round(group('expense'));
  const cumulativeProfit = income - expense;

  /**
   * The year's own result, not the book's. Everything before the previous close already
   * belongs to a year somebody filed, so subtracting it is what makes this figure the thing an
   * owner would call "what we made this year".
   */
  const previous = FY.lastClose(book);
  const yearProfit = cumulativeProfit - (previous ? previous.ledger.cumulativeProfit : 0);

  /**
   * The dates that belong to the year being filed. Both derivations are bounded to THIS, and
   * `from` is null on a first close, meaning the book's own beginning.
   */
  const win = FY.closingWindow(book, through);
  const opens: string | undefined = win.from ?? undefined;

  /**
   * THE YEAR, DERIVED DIRECTLY, BESIDE THE YEAR DERIVED BY SUBTRACTION.
   *
   * yearProfit above is this cut's cumulative profit less the figure FILED on the previous
   * cut — a stored number, deliberately, because that is what makes it the year an owner
   * filed rather than the year the book currently thinks it filed. Bounding the ledger to
   * the same dates answers the same question without reading anything stored.
   *
   * They differ by exactly the drift in the previously filed year. Without this the gap
   * surfaced through the agreement gate instead, as "the journal and the vouchers disagree"
   * — which would be a lie about which two things disagreed, shown to somebody trying to
   * file a year and given nowhere to look. closedYearDrift() reports the same fact on every
   * accounts screen; the close refuses on it by name.
   */
  const yearSummary = generalLedger(book, undefined, opens, through).summary;
  const yearGroup = (g: AccountGroup) =>
    yearSummary.filter((r) => r.account.group === g).reduce((t, r) => t + r.balance, 0);
  const yearIncome = Math.round(yearGroup('income'));
  const yearExpense = Math.round(yearGroup('expense'));
  const yearProfitDerived = yearIncome - yearExpense;

  if (previous && yearProfitDerived !== yearProfit) {
    refusals.push(
      `The year filed to ${previous.closedThrough} no longer derives to what was filed, so this ` +
        `year cannot be measured. It made ${previous.ledger.cumulativeProfit} cumulative on the cut and ` +
        `derives to ${cumulativeProfit - yearProfitDerived} now, which moves this year by ` +
        `${yearProfitDerived - yearProfit}. Look at the drift on the accounts screen first.`
    );
  }

  /**
   * EVERY INCOME AND EXPENSE ACCOUNT AT THE CUT, BY CODE.
   *
   * positions below holds the accounts that CARRY a balance across the boundary, because
   * those are what the next year opens with. Nominals do not carry, so for a long while
   * nothing recorded them and drift compared income and expense as two group totals.
   *
   * WHICH MADE A WHOLE CLASS OF RESTATEMENT INVISIBLE. Measured on the demo book by moving
   * one expense inside the filed year from one category to another — a miscoding correction,
   * the most ordinary restatement there is:
   *
   *   28,500 moved between two expense accounts inside the year filed to 2026-06-30
   *
   *   total assets            2,39,24,824  ->  2,39,24,824
   *   balance sheet diff      0            ->  0
   *   drift                   clean        ->  clean, moved []
   *
   * Nothing in the product noticed, because the expense GROUP total did not move and
   * positions holds no expense account to compare. The filed P&L by account — which is what
   * an auditor reads — had changed, and the panel whose whole job is saying so said nothing.
   *
   * Rounded to whole taka and filtered to non-zero, the same way positions is, so the two
   * lists are read by one comparison.
   */
  const nominal = (g: AccountGroup) => g === 'income' || g === 'expense';
  const nominals = summary
    .filter((r) => nominal(r.account.group) && Math.round(r.balance) !== 0)
    .map((r) => ({
      code: r.account.code,
      name: r.account.name,
      group: r.account.group,
      balance: Math.round(r.balance)
    }));

  const carries = (g: AccountGroup) => g === 'asset' || g === 'liability' || g === 'equity';
  const positions = summary
    .filter((r) => carries(r.account.group) && Math.round(r.balance) !== 0)
    .map((r) => ({
      code: r.account.code,
      name: r.account.name,
      group: r.account.group,
      balance: Math.round(r.balance)
    }));

  /* ----------------------------------------------------- what the vouchers say */
  /**
   * The control side, bounded to THE SAME YEAR and expressed on THE SAME TERMS.
   *
   * Recorded beside the ledger for the same reason reconciliation() exists: one number is a
   * claim, two independently derived numbers that agree are evidence — and if they ever stop
   * agreeing inside a filed year, the drift check is what says so.
   *
   * TWO SEPARATE WRONGNESSES LIVED IN ONE COMPARISON, AND BOTH READ GREEN.
   *
   * The close refuses to file a year the two sides disagree about. It compared yearProfit —
   * this cut less the previous one, so a YEAR — against summarise(book, undefined, through),
   * which is bounded at the top only and sees vouchers only. Measured on the demo book for a
   * second close at 2027-06-30:
   *
   *   the journal, this year                                        597,136
   *   what the gate compared it to  (whole book, trading only)      812,360   gap -215,224
   *   bounding the window and nothing else (this year, trading)     668,260   gap  -71,124
   *   this year, and journal vouchers counted the way the ledger
   *   counts them                                                  597,136   gap        0
   *
   * The window was one error and the origin was another. Fixing either alone still refuses,
   * so a fix that looked right would have stayed broken: the 71,124 is journal adjustments
   * dated inside the year, which the ledger side counts and summarise() has never seen.
   *
   * profitAndLoss is the function that already reconciles those two origins — netProfit is
   * the trading figure plus manual postings, split by ORIGIN rather than by account — and
   * plAgreesWithLedger already asserts that its bottom line equals income less expense in
   * the journal over the same window. Deriving the control side any other way here would be
   * a third implementation of a question the product answers twice already.
   *
   * Only figures that genuinely take a date bound are here. receivables(), payables(),
   * memoPayable(), fxGain() and customerCredit() do not, and a figure the product cannot
   * re-derive AT A DATE cannot be drift-checked later. Recording one would be recording
   * something with no check attached.
   */
  const s = summarise(book, opens, through);
  const pl = profitAndLoss(book, opens, through);
  const bridge = plAgreesWithLedger(book, opens, through);
  /**
   * Cash stays CUMULATIVE, deliberately. It is a position, not a flow: the closing balance of
   * a bank account on 30 June is the whole book up to that date, and bounding it at the start
   * of the year would record a movement under a name that says balance.
   */
  const cash = cashBook(book, undefined, through);
  const control = {
    /** The window these were derived over. Null means the book's beginning. */
    from: win.from,
    to: through,
    sales: Math.round(s.sales),
    cost: Math.round(s.cost),
    expenses: Math.round(s.expenses),
    memoCost: Math.round(s.memoCost),
    /** The voucher side alone, kept because the gap between the two is the journal side. */
    netProfitBeforeJournal: Math.round(pl.netProfitBeforeJournal),
    journalNet: Math.round(pl.journalNet),
    netProfit: Math.round(pl.netProfit),
    cashClosing: Math.round(cash.closing)
  };
  /* -------------------------------------------------- what the close would seal */
  const dated = (rows: { date?: string }[] | undefined) =>
    (rows || []).filter((r) => r.date && r.date <= through).length;
  const counted = {
    vouchers:
      dated(book.invoices) + dated(book.receipts) + dated(book.bills) +
      dated(book.payments) + dated(book.expenses) +
      dated(book.supplierDeposits) + dated(book.transfers) +
      dated(book.creditNotes) + dated(book.supplierCreditNotes),
    drafts: (book.invoices || []).filter((i) => i.status === 'draft' && i.date && i.date <= through).length,
    journalEntries: (book.journalEntries || []).filter((v) => v.date && v.date <= through).length
  };

  /* --------------------------- what the statements say about the year being sealed */
  const bs = balanceSheet(book, through);
  const jtb = journalTrialBalance(book, through);
  const rec = reconciliation(book);

  /**
   * A half-finished entry inside the year being closed. Sealing one means sealing an account
   * that can only hold its balance because a matching entry was never made — so the close asks
   * for it to be acknowledged in writing rather than refusing outright. It is a real state of a
   * real book, and refusing would only teach people to close a year they had not looked at.
   */
  const halfEntries = bs.halfEntries;

  return NextResponse.json({
    ok: refusals.length === 0,
    through,
    opensOn: FY.nextDay(through),
    label: previous ? `FY to ${through}` : `FY${through.slice(0, 4)} to ${through}`,
    today,
    bookRevision: (book as unknown as { _meta?: { revision?: number } })._meta?.revision ?? null,
    refusals,
    ledger: {
      income, expense, cumulativeProfit, yearProfit, positions, nominals,
      /** The same year bounded straight off the journal, never by subtracting a stored figure. */
      yearIncome, yearExpense, yearProfitDerived
    },
    control,
    counted,
    halfEntries,
    statements: {
      reconciliationClean: rec.clean,
      /** The two origins agree over the year being closed — the gate's own question, reported. */
      bridgeDifference: bridge.difference,
      bridgeDetail: bridge.detail,
      journalTrialBalanceDifference: Math.round(jtb.difference),
      balanceSheetDifference: Math.round(bs.difference),
      totalAssets: Math.round(bs.totalAssets),
      totalLiabilities: Math.round(bs.totalLiabilities),
      totalEquity: Math.round(bs.totalEquity)
    },
    moved: FY.movesFor(book, through)
  });
}
