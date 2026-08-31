/**
 * What is left of an advance placed with a supplier.
 *
 * WHY THIS IS ONE SHARED FILE AND NOT TWO IMPLEMENTATIONS
 *
 * It was two, and they disagreed. The Inventory screen computed
 * `deposited - max(0, billed - settled)`; the portal's drawdown validator computed
 * `placed - drawn`, counting only payments whose method is `supplier_deposit`. Measured
 * on the live book they were 3,179,600 apart, and per supplier the disagreement was not
 * subtle:
 *
 *   Biman   deposited 650,000    screen said -174,100   portal would allow 650,000
 *   Qatar   deposited 1,800,000  screen said -158,500   portal would allow 1,800,000
 *
 * The screen showed the float exhausted and overdrawn while the portal stood ready to
 * authorise the whole advance against it.
 *
 * WORSE THAN A SECOND OPINION: THE OLD SCREEN FIGURE MOVED THE WRONG WAY
 *
 * `settled` counted EVERY payment to that supplier, including a drawdown against the
 * deposit itself. So spending the float raised `settled`, which lowered
 * `outstandingBills`, which RAISED the reported available float. A number that goes up
 * when you spend it is not a second definition of the float; it is wrong under any
 * definition.
 *
 * It survived because zero of the book's 150 payments used the `supplier_deposit` method,
 * so the two were never put side by side. The rest of the codebase already knew better —
 * admin/server.js and verify-srs.mjs both exclude that method from bank movements
 * precisely because no fresh money moves. One place forgot.
 *
 * THE DEFINITION, AND THE THING IT IS NOT
 *
 * The float is what was advanced, less what has been drawn against it. That is the
 * question "what can I issue against tomorrow" actually asks, and it is the one the
 * validator has to answer before it permits a drawdown.
 *
 * What the agency still OWES that supplier is a different and also useful number, and it
 * is reported separately rather than netted in. Netting them was the original error: an
 * unpaid bill does not consume an advance, it sits beside it.
 */

/** Total placed with a supplier, and total already drawn against it. */
function floatFor(book, supplierId, excludePaymentId) {
  const num = (v) => Number(v || 0);

  const placed = (book.supplierDeposits || [])
    .filter((d) => d.supplierId === supplierId)
    .reduce((t, d) => t + num(d.amount), 0);

  /**
   * Only drawdowns. A payment made from cash or a bank account settles a bill with fresh
   * money and leaves the advance untouched — counting it here is what made the old screen
   * figure rise as the float was spent.
   */
  const drawn = (book.payments || [])
    .filter((p) =>
      p.supplierId === supplierId &&
      p.method === 'supplier_deposit' &&
      (excludePaymentId === undefined || p.id !== excludePaymentId))
    .reduce((t, p) => t + num(p.amount), 0);

  return { placed, drawn, available: placed - drawn };
}

/**
 * The float for every supplier who has one, plus what each is separately owed.
 *
 * `fx` converts a bill to book currency and is passed in rather than imported, because
 * the rate logic lives in lib/accounting.ts which this file cannot require — the admin
 * portal loads this and cannot run TypeScript.
 */
function floatRows(book, fx) {
  const num = (v) => Number(v || 0);
  const toBook = fx || ((b) => num(b.amount));

  return (book.suppliers || []).map((s) => {
    const { placed, drawn, available } = floatFor(book, s.id);
    const billed = (book.bills || [])
      .filter((b) => b.supplierId === s.id)
      .reduce((t, b) => t + toBook(b), 0);
    // Every payment, by any method — this is what has actually been paid against bills.
    const settled = (book.payments || [])
      .filter((p) => p.supplierId === s.id)
      .reduce((t, p) => t + num(p.amount), 0);

    return {
      supplier: s,
      deposited: placed,
      drawn,
      available,
      billed,
      settled,
      /** Reported beside the float, never netted into it. An unpaid bill is not a drawdown. */
      outstandingBills: Math.max(0, billed - settled),
      depositCount: (book.supplierDeposits || []).filter((d) => d.supplierId === s.id).length
    };
  }).filter((r) => r.deposited > 0 || r.billed > 0);
}

module.exports = { floatFor, floatRows };
