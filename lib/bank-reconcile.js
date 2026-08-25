/**
 * The bank reconciliation statement: the arithmetic, and what it refuses to claim.
 *
 * THE STANDARD FORM, AND WHY IT IS TWO COLUMNS AND NOT ONE
 *
 *   Balance per the bank statement                     X
 *     + deposits in transit      (in the book, not yet on the statement)
 *     - unpresented payments     (in the book, not yet on the statement)
 *     = adjusted bank balance                          A
 *
 *   Balance per the book                               Y
 *     + statement credits not in the book   (interest, direct credits)
 *     - statement debits not in the book    (charges, direct debits)
 *     = adjusted book balance                          B
 *
 *   A must equal B.
 *
 * It is written as two columns rather than one running total because the two sides
 * answer different questions. The bank side asks "what will the bank say once the
 * in-flight items land"; the book side asks "what will the book say once we record what
 * the bank already knows". Collapsing them into one column produces the same number and
 * loses which side each adjustment belongs to — which is the only part an accountant
 * uses when something is wrong.
 *
 * WHY A === B IS NOT AUTOMATIC, AND WHY THAT MATTERS
 *
 * Work it through and the two sides are algebraically equal:
 *
 *   Y = opening + bookIn - bookOut,  X = opening + stmtIn - stmtOut
 *   bookIn  = matchedIn  + inTransit      stmtIn  = matchedIn  + unknownIn
 *   bookOut = matchedOut + unpresented    stmtOut = matchedOut + unknownOut
 *
 * so A and B both come to `opening + matchedIn - matchedOut + inTransit - unpresented
 * + unknownIn - unknownOut`. Identical — but ONLY while the two `opening` terms are the
 * same number. If the statement's opening balance and the book's opening balance for the
 * period disagree, the difference falls straight through to A - B.
 *
 * That is the property worth having. A reconciliation whose two sides always agreed
 * would be a tautology, proving nothing and reassuring everybody. This one agrees
 * exactly when last month was finished and every line this month has been classified,
 * and reports the gap when it was not.
 *
 * WHAT AN UNRESOLVED AMBIGUITY DOES TO IT
 *
 * An ambiguous line is on the statement and IS in the book — we simply do not know which
 * entry it is. Counting it as "unknown to the book" would be a lie that happens to
 * balance: it would push the arithmetic straight while asserting the bank did something
 * the book never recorded. So ambiguous lines are excluded from the adjustment columns
 * and the whole statement is marked incomplete. A reconciliation with an unresolved
 * ambiguity does not get to produce a verdict.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Build the statement from a match result.
 *
 * `bookOpening` and `bookClosing` come from `bankBook(book, bankId, from, to)` — the
 * same derivation the Bank screen shows, so this can never quietly disagree with the
 * balance printed elsewhere in the app.
 *
 * `statementOpening` and `statementClosing` come from the file when it carries a running
 * balance, and from the operator when it does not. Which of the two is in play is
 * recorded, because "the bank said so" and "somebody typed it" are different kinds of
 * fact and only one of them is evidence.
 */
function reconcile({
  match,
  bookOpening,
  bookClosing,
  statementOpening,
  statementClosing,
  statementBalanceSource = 'file',
  from,
  to,
  bankId,
  bankName
}) {
  const results = match.results || [];
  const outstanding = match.unmatchedMovements || [];

  const ambiguous = results.filter((r) => r.status === 'ambiguous');
  const unknown = results.filter((r) => r.status === 'unknown_to_book');
  const matched = results.filter((r) => r.status === 'matched');

  /* --------------------------------------------------- the four adjustment sets */

  const inTransit = outstanding.filter((u) => u.movement.direction === 'in').map((u) => u.movement);
  const unpresented = outstanding.filter((u) => u.movement.direction === 'out').map((u) => u.movement);
  const bankCredits = unknown.filter((r) => r.line.direction === 'in').map((r) => r.line);
  const bankDebits = unknown.filter((r) => r.line.direction === 'out').map((r) => r.line);

  const sum = (rows) => round2(rows.reduce((t, r) => t + Math.abs(r.amount), 0));

  const inTransitTotal = sum(inTransit);
  const unpresentedTotal = sum(unpresented);
  const bankCreditsTotal = sum(bankCredits);
  const bankDebitsTotal = sum(bankDebits);

  /* ------------------------------------------------------------- the two columns */

  const adjustedBank = round2(round2(statementClosing) + inTransitTotal - unpresentedTotal);
  const adjustedBook = round2(round2(bookClosing) + bankCreditsTotal - bankDebitsTotal);
  const difference = round2(adjustedBank - adjustedBook);

  /**
   * Where a difference came from, when there is one.
   *
   * Almost always the opening: if last month was never finished, its unfinished business
   * arrives here as a number nobody can place. Saying so is worth far more than the
   * number itself, because "your opening balances differ by 4,300" is actionable and
   * "the reconciliation is out by 4,300" is not.
   */
  const openingGap = statementOpening === null || statementOpening === undefined
    ? null
    : round2(round2(statementOpening) - round2(bookOpening));

  const blockers = [];
  if (ambiguous.length) {
    blockers.push(
      `${ambiguous.length} statement line(s) fit more than one entry in the book. They are in the book — we do not know which entry — so they are left out of the arithmetic rather than counted as something the bank did alone. Resolve them and this becomes a real answer.`
    );
  }
  if (openingGap !== null && openingGap !== 0) {
    blockers.push(
      `The statement opens at ${round2(statementOpening)} and the book opens at ${round2(bookOpening)}, a gap of ${openingGap}. That is last period's unfinished business, and it will show up below as a difference no line in this period can explain.`
    );
  }
  if (statementOpening === null || statementOpening === undefined) {
    blockers.push(
      'The statement carries no opening balance, so the one thing that would prove last period was finished is missing. The two columns can still be compared; they just cannot rule out a difference that predates this period.'
    );
  }

  return {
    bankId,
    bankName,
    from,
    to,
    statementBalanceSource,

    bank: {
      closing: round2(statementClosing),
      inTransit,
      inTransitTotal,
      unpresented,
      unpresentedTotal,
      adjusted: adjustedBank
    },
    book: {
      closing: round2(bookClosing),
      credits: bankCredits,
      creditsTotal: bankCreditsTotal,
      debits: bankDebits,
      debitsTotal: bankDebitsTotal,
      adjusted: adjustedBook
    },

    difference,
    openingGap,
    /**
     * Reconciled means: the two adjusted balances agree AND nothing is unresolved.
     *
     * Both halves are load-bearing. Agreement with an open ambiguity is agreement by
     * omission, and this book has spent too much effort on making its figures earn their
     * agreement to start accepting it for free here.
     */
    reconciled: difference === 0 && blockers.length === 0,
    /**
     * Reconciled is not the same as finished, and conflating them would be the most
     * misleading thing on the screen.
     *
     * A statement can reconcile perfectly while carrying four items the book has never
     * recorded - a fee, excise duty, interest, an unexplained ATM debit. The arithmetic
     * agrees precisely BECAUSE those are sitting in the adjustment column; that is what
     * the column is for. But nothing has been posted, the P&L is still missing the
     * charges, and next month they will still be here.
     *
     * So a green tick states agreement and this states the work. A reconciliation that
     * showed only the first would let an agency close twelve months in a row without
     * ever recording a bank charge.
     */
    requiresPosting: bankCredits.length + bankDebits.length,
    /** Genuinely nothing left: agreed, explained, and no entry outstanding. */
    settled: difference === 0 && blockers.length === 0 && bankCredits.length + bankDebits.length === 0,
    blockers,

    counts: {
      statementLines: results.length,
      matched: matched.length,
      ambiguous: ambiguous.length,
      bankOnly: unknown.length,
      bookOnly: outstanding.length
    }
  };
}

/**
 * The adjustments the BOOK has to make, as a journal voucher draft.
 *
 * Bank charges, excise duty and interest are real transactions that happened; the book
 * simply has not been told. Recording them is not part of reconciling — it is the
 * ordinary bookkeeping that reconciling revealed. So this hands back a DRAFT for the
 * journal screen rather than posting anything: the accountant picks the expense or
 * income account, because only they know whether a 3,000 debit is excise duty, a
 * transfer fee or a standing order nobody cancelled.
 *
 * Deliberately does NOT include anything for the bank side. Deposits in transit and
 * unpresented cheques need no entry at all — the book is already right and the bank is
 * merely behind. Posting an adjustment for those is the classic way a reconciliation
 * ends up double-counting, and it is why they live in a different column.
 */
function adjustmentDraft(rec, bankAccountCode) {
  const lines = [];
  for (const c of rec.book.credits) {
    lines.push({
      account: bankAccountCode,
      debit: Math.abs(c.amount),
      credit: 0,
      memo: `${c.date} ${c.description}`.trim(),
      // Left blank on purpose. See above: the counter-account is the accountant's call.
      counterAccount: null
    });
  }
  for (const d of rec.book.debits) {
    lines.push({
      account: bankAccountCode,
      debit: 0,
      credit: Math.abs(d.amount),
      memo: `${d.date} ${d.description}`.trim(),
      counterAccount: null
    });
  }
  return {
    date: rec.to,
    narration: `Bank items on the ${rec.bankName} statement to ${rec.to} that the book had not recorded`,
    lines,
    /**
     * Stated rather than assumed, because this voucher will touch a BANK: account and
     * every one of those is cross-checked by reconciliation() in lib/accounting.ts. It
     * will therefore appear as a reconciling item on the Financials screen with this
     * narration against it — which is correct and is the point, not a side effect.
     */
    touchesControlAccount: true,
    note: 'Each line needs a counter-account before it can be posted. The bank side is deliberately absent: money in transit needs no entry, only time.'
  };
}

module.exports = { reconcile, adjustmentDraft, round2 };
