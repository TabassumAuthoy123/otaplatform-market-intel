import { NextResponse } from 'next/server';
import {
  balanceSheet, cashBook, generalLedger, getBookUnguarded, journalTrialBalance,
  reconciliation, summarise
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
   * The control side, bounded to the same date. Recorded beside the ledger for the same reason
   * reconciliation() exists: one number is a claim, two independently derived numbers that
   * agree are evidence — and if they ever stop agreeing inside a filed year, the drift check is
   * what says so.
   *
   * Only figures that genuinely take a date bound are here. receivables(), payables(),
   * memoPayable(), fxGain() and customerCredit() do not, and a figure the product cannot
   * re-derive AT A DATE cannot be drift-checked later. Recording one would be recording
   * something with no check attached.
   */
  const s = summarise(book, undefined, through);
  const cash = cashBook(book, undefined, through);
  const control = {
    sales: Math.round(s.sales),
    cost: Math.round(s.cost),
    expenses: Math.round(s.expenses),
    memoCost: Math.round(s.memoCost),
    netProfit: Math.round(s.netProfit),
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
    ledger: { income, expense, cumulativeProfit, yearProfit, positions },
    control,
    counted,
    halfEntries,
    statements: {
      reconciliationClean: rec.clean,
      journalTrialBalanceDifference: Math.round(jtb.difference),
      balanceSheetDifference: Math.round(bs.difference),
      totalAssets: Math.round(bs.totalAssets),
      totalLiabilities: Math.round(bs.totalLiabilities),
      totalEquity: Math.round(bs.totalEquity)
    },
    moved: FY.movesFor(book, through)
  });
}
