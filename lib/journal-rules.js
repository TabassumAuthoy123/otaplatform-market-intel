/**
 * The chart of accounts and the rules a manual journal voucher must satisfy.
 *
 * WHY THIS IS PLAIN COMMONJS AND NOT TYPESCRIPT
 *
 * Two processes need it and only one of them can run TypeScript. The Next app on
 * :3002 renders vouchers; the zero-dependency admin portal on :4001 writes them, and
 * it is deliberately built on `node:http` alone with no build step. If each held its
 * own copy of "what counts as a valid voucher" they would agree on the day they were
 * written and not for long after — and the failure would be the portal accepting a
 * posting the app cannot render, or offering an account the app does not know.
 *
 * Same arrangement, and the same reason, as lib/panel-modules.js and
 * lib/period-lock.js. `allowJs` lets lib/accounting.ts and lib/journals.ts import it.
 *
 * The chart lives here rather than in accounting.ts because it is the thing the
 * voucher rules validate against: an account list and a rule that says "the account
 * must be in the list" have to come from one place or the rule means nothing.
 * lib/accounting.ts calls straight into `chartAccounts` so there is exactly one
 * builder, not two that a test has to police.
 */

/** Fixed codes. Kept in one object so a typo is a crash rather than a silent miss. */
const AC = {
  CASH: 'CASH',
  AR: 'AR',
  AP: 'AP',
  VAT: 'VAT',
  DEFERRED: 'DEFERRED_INCOME',
  MEMOS: 'MEMO_PAYABLE',
  MEMO_COST: 'MEMO_COST',
  FX: 'FX_GAIN',
  CUSTOMER_CREDIT: 'CUSTOMER_CREDIT',
  ADVANCES: 'ADVANCES',
  EQUITY: 'EQUITY_OPENING',
  SALES: 'SALES',
  RETURNS: 'SALES_RETURNS',
  PURCHASES: 'PURCHASES',
  // Supplier cost on a booking whose customer invoice is still a draft. See the note on
  // AC.WIP in lib/accounting.ts — an asset, because the money bought something still
  // sellable and matching says it is not a cost of anything yet.
  WIP: 'WIP_SUPPLIER_COST',
  bank: (id) => `BANK:${id}`,
  expense: (id) => `EXP:${id}`,
  user: (code) => `GL:${code}`
};

/**
 * The chart, built from the book so it always matches the data.
 *
 * The long "why this account exists" notes stay in lib/accounting.ts beside the
 * balance-sheet code that reads them. What is here is the list itself.
 */
function chartAccounts(book) {
  return [
    { code: AC.CASH, name: 'Cash in hand', group: 'asset' },
    ...(book.banks || []).map((b) => ({ code: AC.bank(b.id), name: b.name, group: 'asset' })),
    { code: AC.AR, name: 'Accounts receivable', group: 'asset' },
    { code: AC.ADVANCES, name: 'Advances to suppliers', group: 'asset' },
    { code: AC.AP, name: 'Accounts payable', group: 'liability' },
    { code: AC.VAT, name: 'VAT payable', group: 'liability' },
    { code: AC.DEFERRED, name: 'Deferred income — sold, not yet flown', group: 'liability' },
    { code: AC.MEMOS, name: 'Airline memos payable (ADM/ACM)', group: 'liability' },
    { code: AC.MEMO_COST, name: 'Airline debit memos', group: 'expense' },
    { code: AC.FX, name: 'Exchange gain / (loss)', group: 'income' },
    { code: AC.CUSTOMER_CREDIT, name: 'Customer credit balances', group: 'liability' },
    { code: AC.EQUITY, name: 'Opening balances', group: 'equity' },
    { code: AC.SALES, name: 'Sales revenue', group: 'income' },
    { code: AC.RETURNS, name: 'Credit notes and cancellations', group: 'income' },
    { code: AC.PURCHASES, name: 'Cost of sales — supplier bills', group: 'expense' },
    { code: AC.WIP, name: 'Unbilled supplier cost — work in progress', group: 'asset' },
    ...(book.expenseCategories || []).map((c) => ({ code: AC.expense(c.id), name: c.name, group: 'expense' })),
    // The accountant's own accounts, last so a derived account always wins a clash.
    ...(book.ledgerAccounts || []).map((a) => ({ code: AC.user(a.code), name: a.name, group: a.group }))
  ];
}

/**
 * The accounts `reconciliation()` cross-checks.
 *
 * A voucher touching one of these is not refused — it is LISTED, as a reconciling
 * item. See the header of lib/journals.ts for why that is the least-bad of the three
 * available answers.
 *
 * Two of them are per-record: every bank account is a control account, and so is
 * every expense category.
 */
function controlAccountCodes(book) {
  return new Set([
    AC.CASH, AC.AR, AC.AP, AC.SALES, AC.RETURNS, AC.MEMOS, AC.FX, AC.CUSTOMER_CREDIT, AC.DEFERRED,
    ...(book.banks || []).map((b) => AC.bank(b.id)),
    ...(book.expenseCategories || []).map((c) => AC.expense(c.id))
  ]);
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Debit-natured groups carry a positive balance on the debit side. */
const naturalSign = (g) => (g === 'asset' || g === 'expense' ? 1 : -1);

const JV_PREFIX = 'SFT-JV-';

/**
 * Everything that must be true before a voucher may be written.
 *
 * Returns EVERY failure rather than the first, because a form that reports one
 * problem per submission is how a five-line voucher takes five attempts.
 *
 * `isLocked` is passed in rather than imported so this file stays free of its own
 * dependencies; both callers already hold it. It is called as
 * `isLocked(lockedThrough, date)` — the VALUE, not the book. Passing the book instead
 * makes it truthy on every call, and the symptom is every voucher being refused as
 * "in a closed period (locked through null)", which reads like the lock is broken
 * rather than like the caller is.
 */
/**
 * The first day this book can carry a posting.
 *
 * Every dated voucher in the book, and the financial year start, whichever is earlier. It is
 * the date the opening balances are brought in on, so it is also the earliest date on which
 * the book has any money to spend.
 *
 * SHARED, AND THAT IS THE POINT. lib/accounting.ts computes the opening entry from this and
 * this file refuses a voucher before it. Written twice they would agree on the day they were
 * written and not for long after, and the failure would be a voucher the portal accepts and
 * the journal posts before the money exists — which is the bug the opening-date comment in
 * lib/accounting.ts was written about.
 *
 * journalEntries are deliberately NOT in the scan. A manual voucher must not be able to drag
 * the opening date backwards behind itself and thereby authorise its own date.
 */
function openingDate(book) {
  const fy = (book.company && book.company.financialYearStart) || null;
  const dated = [
    book.invoices, book.receipts, book.bills, book.payments, book.expenses,
    book.supplierDeposits, book.transfers, book.creditNotes, book.supplierCreditNotes
  ];
  let earliest = null;
  for (const rows of dated) {
    for (const r of rows || []) {
      const d = r && r.date;
      if (typeof d === "string" && d && (!earliest || d < earliest)) earliest = d;
    }
  }
  if (!fy) return earliest;
  return earliest && earliest < fy ? earliest : fy;
}

function validateVoucher(book, draft, isLocked) {
  const errors = [];
  const codes = new Set(chartAccounts(book).map((a) => a.code));
  const lines = (draft.lines || []).filter(
    (l) => l && (l.account || Number(l.debit) || Number(l.credit))
  );

  const date = String(draft.date || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
    errors.push('A date is required, as YYYY-MM-DD.');
  } else {
    /**
     * The period lock applies here exactly as it does to an invoice. It would be a
     * strange lock that closed a month against the vouchers that make money and left
     * it open to the one voucher type that can post anything to anywhere.
     */
    if (isLocked && isLocked(book.lockedThrough || null, date)) {
      errors.push(`${date} is in a closed period (locked through ${book.lockedThrough}). Reopen the period, or date the voucher after it.`);
    }
    /**
     * THE FLOOR IS THE BOOK'S BEGINNING, NOT THE YEAR'S NAME.
     *
     * This refused any voucher dated before company.financialYearStart, and nothing else in
     * the product enforced that boundary at all: an invoice, a receipt, a bill, a payment, an
     * expense, a supplier deposit and a transfer could all be dated into the prior year, and
     * 176 of them are. So the one voucher type that can post anything to anywhere was the one
     * type forbidden from the period the book actively traded in.
     *
     * What it cost, concretely: a June bank statement could be imported and matched and never
     * signed off, because the bank's own charges on it could not be posted. The reconciliation
     * screen said 4 item(s) need posting to the book and there was no date on which to post
     * them.
     *
     * The financial year start is what the year is CALLED. lib/accounting.ts:1766 already says
     * so in as many words — it is not what the book begins on, and using it as though it were
     * is what dated the opening balances a fortnight late. A book straddling an unclosed year
     * end has trading on both sides of that name and the journal has to reach both.
     *
     * What genuinely must be refused is a date before the book exists, because the opening
     * balances arrive on that day and a voucher before it posts against money that has not
     * been brought in — the same defect, one step earlier. The period lock, checked directly
     * above, is what protects a year once it has actually been closed.
     */
    const opens = openingDate(book);
    if (opens && date < opens) {
      errors.push(
        `${date} is before this book opens (${opens}). The opening balances are brought in on ` +
        `that day, so a voucher dated before it would post against money the book has not been ` +
        `given yet. Date it on or after ${opens}.`
      );
    }
  }

  if (!String(draft.narration || '').trim()) {
    errors.push('A narration is required — say why this entry exists.');
  }
  if (lines.length < 2) {
    errors.push('A journal voucher needs at least two lines.');
  }

  let totalDebit = 0;
  let totalCredit = 0;
  lines.forEach((l, i) => {
    const n = i + 1;
    const debit = round(l.debit);
    const credit = round(l.credit);
    if (!l.account) errors.push(`Line ${n}: choose an account.`);
    else if (!codes.has(String(l.account))) errors.push(`Line ${n}: ${l.account} is not an account in this book.`);
    if (debit < 0 || credit < 0) errors.push(`Line ${n}: amounts cannot be negative — put it on the other side instead.`);
    if (debit > 0 && credit > 0) errors.push(`Line ${n}: a line is a debit or a credit, not both.`);
    if (debit === 0 && credit === 0) errors.push(`Line ${n}: enter an amount.`);
    totalDebit += debit;
    totalCredit += credit;
  });

  totalDebit = round(totalDebit);
  totalCredit = round(totalCredit);

  /**
   * The one rule the whole voucher type exists to keep. Compared after rounding to
   * two places: the amounts arrive as text from a form, and 0.1 + 0.2 refusing to
   * equal 0.3 is not a bookkeeping error anybody wants explained to them.
   */
  if (lines.length >= 2 && totalDebit !== totalCredit) {
    errors.push(`Debits and credits must be equal — they are ${totalDebit.toFixed(2)} and ${totalCredit.toFixed(2)}, out by ${Math.abs(totalDebit - totalCredit).toFixed(2)}.`);
  }
  if (lines.length >= 2 && totalDebit === 0) {
    errors.push('A voucher for zero posts nothing.');
  }

  return { ok: errors.length === 0, errors, totalDebit, totalCredit, lines };
}

/** Next number in the book's own series, independent of array order. */
function nextVoucherNo(book) {
  const used = (book.journalEntries || [])
    .map((v) => Number(String(v.no).replace(JV_PREFIX, '')))
    .filter((n) => Number.isFinite(n));
  return JV_PREFIX + String((used.length ? Math.max.apply(null, used) : 0) + 1).padStart(4, '0');
}

/**
 * The mirrored lines of a reversal.
 *
 * Reversal rather than deletion, and rather than an edit. A posted entry that can be
 * silently altered is not an audit trail, it is a draft — and the correction of a
 * mistake is itself a fact about the month that somebody may need to explain later.
 * Two vouchers that net to nothing tell that story; one voucher that quietly changed
 * tells nobody anything.
 */
function reversalLines(v) {
  return (v.lines || []).map((l) => ({
    account: l.account,
    debit: round(l.credit),
    credit: round(l.debit),
    memo: l.memo || ''
  }));
}

module.exports = {
  AC, chartAccounts, controlAccountCodes, validateVoucher, nextVoucherNo, reversalLines,
  naturalSign, round, JV_PREFIX,
  openingDate
};
