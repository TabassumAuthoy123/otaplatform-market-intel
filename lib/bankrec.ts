import type { Book } from '@/lib/accounting';
import { bankBook } from '@/lib/accounting';
// The rules themselves are plain CommonJS, shared verbatim with the admin portal, which
// does the importing and cannot run TypeScript. See each file's header.
import { matchStatement, bookPrefixes } from '@/lib/bank-match.js';
import { reconcile, adjustmentDraft } from '@/lib/bank-reconcile.js';

/**
 * The book's own side of a bank reconciliation, and the reconciliation itself.
 *
 * WHY bookMovements DELEGATES TO bankBook RATHER THAN WALKING THE BOOK ITSELF
 *
 * EIGHT different record types move money through a bank account: customer receipts,
 * supplier payments, expenses, refunded credit notes, transfers in, transfers out,
 * supplier credit notes received, and supplier deposits paid out. That list is not
 * obvious and it is not stable — it grew as the book grew.
 *
 * While preparing this file I counted the movements through the Dutch-Bangla account
 * twice from first principles and got it wrong both times: 188, then 192, against a true
 * 192. The four I dropped were supplier deposits, which do not look like bank movements
 * until you remember an agency wires a float to its consolidator.
 *
 * A matcher that re-derives the list reports every movement it forgot as "not in the
 * book", and the accountant goes looking for a bank error that does not exist. So the
 * list comes from `bankBook`, the same derivation the Bank screen and the balance
 * already use, and `assertComplete` fails loudly if the two ever drift apart.
 */

export type BookMovementKind =
  | 'receipt' | 'payment' | 'expense' | 'refund'
  | 'transfer_in' | 'transfer_out' | 'supplier_credit' | 'supplier_deposit';

export type BookMovement = {
  id: string;
  ref: string;
  date: string;
  /** Always positive. `direction` carries the sign. */
  amount: number;
  direction: 'in' | 'out';
  kind: BookMovementKind;
  /** Whatever the record carries that a bank narration might echo. */
  note: string;
};

/** Kinds that ADD to a bank balance. Everything else takes away. */
const INBOUND: BookMovementKind[] = ['receipt', 'transfer_in', 'supplier_credit'];

export function bookMovements(book: Book, bankId: string, from?: string, to?: string): BookMovement[] {
  const bb = bankBook(book, bankId, from, to);
  const rows: BookMovement[] = [];

  const take = (
    list: readonly { id: string; no?: string; date: string; amount: number; ref?: string; notes?: string; note?: string; description?: string }[],
    kind: BookMovementKind
  ) => {
    for (const r of list) {
      rows.push({
        id: r.id,
        ref: r.no ?? r.id,
        date: r.date,
        amount: Math.abs(r.amount),
        direction: INBOUND.includes(kind) ? 'in' : 'out',
        kind,
        // Four different field names across eight record types, and a bank narration may
        // echo any of them. Joined rather than picked: guessing which one this record
        // type uses is how a legitimate match gets missed.
        note: [r.ref, r.notes, r.note, r.description].filter(Boolean).join(' ').trim()
      });
    }
  };

  take(bb.receiptsIn, 'receipt');
  take(bb.paymentsOut, 'payment');
  take(bb.expensesOut, 'expense');
  take(bb.refundsOut, 'refund');
  take(bb.transfersIn, 'transfer_in');
  take(bb.transfersOut, 'transfer_out');
  take(bb.supplierCreditsIn, 'supplier_credit');
  take(bb.depositsOut, 'supplier_deposit');

  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
}

/**
 * The structural guard: what was flattened must add up to what the balance says.
 *
 * `bankBook` computes `totalIn`, `totalOut` and `closing` from the same eight arrays
 * this file flattens. If the two ever disagree, one of them has a movement kind the
 * other does not — precisely the failure this file exists to prevent, and precisely the
 * one that would otherwise surface months later as a reconciliation that refuses to
 * balance for no visible reason.
 */
export function assertComplete(book: Book, bankId: string, from?: string, to?: string) {
  const bb = bankBook(book, bankId, from, to);
  const rows = bookMovements(book, bankId, from, to);
  const inSum = rows.filter((r) => r.direction === 'in').reduce((t, r) => t + r.amount, 0);
  const outSum = rows.filter((r) => r.direction === 'out').reduce((t, r) => t + r.amount, 0);
  const ok = Math.round(inSum - outSum) === Math.round(bb.totalIn - bb.totalOut);
  return {
    ok,
    flattened: rows.length,
    detail: ok
      ? `${rows.length} movements, and they add to the same net as the bank column`
      : `bookMovements is missing a movement kind that bankBook knows about — flattened net ${Math.round(inSum - outSum)} against ${Math.round(bb.totalIn - bb.totalOut)}. Add the kind to bookMovements in lib/bankrec.ts.`
  };
}

/* ------------------------------------------------------------------ statements */

export type StatementLine = {
  date: string;
  description: string;
  reference: string;
  amount: number;
  direction: 'in' | 'out';
  balance: number | null;
  sourceLine: number;
};

export type BankStatement = {
  id: string;
  bankId: string;
  from: string;
  to: string;
  openingBalance: number | null;
  closingBalance: number | null;
  /** `file` when the bank printed a running balance; `entered` when a person typed it. */
  balanceSource: 'file' | 'entered';
  dateFormat: string;
  /** Kept so a re-import is reproducible and a mis-mapping is traceable. */
  mapping: Record<string, number>;
  lines: StatementLine[];
  /**
   * Matches a person made by hand, for lines the matcher refused to decide.
   *
   * Stored against the STATEMENT rather than applied to it, so the automatic result
   * stays re-derivable and a human decision is always visibly a human decision.
   */
  decisions?: { sourceLine: number; movementId: string; decidedBy: string; decidedAt: string }[];
  importedAt: string;
  importedBy: string;
  /** The file, as received. Nothing is reconstructed from a parse. */
  raw?: string;
};

/**
 * A period somebody signed off.
 *
 * `differenceAtClose` is stored deliberately, and it is the interesting field. Everything
 * else in this book is derived at request time precisely so it cannot go stale — but a
 * sign-off is a claim made at a moment, and keeping the number that was true then lets
 * the app notice when it stops being true. A voucher back-dated into a reconciled period
 * changes the recomputed difference; the stored one does not move; the screen says so.
 *
 * Without it, a reconciliation could be quietly invalidated by a later edit and go on
 * displaying a tick.
 */
export type BankReconciliation = {
  id: string;
  bankId: string;
  statementId: string;
  from: string;
  to: string;
  closedAt: string;
  closedBy: string;
  differenceAtClose: number;
  bookClosingAtClose: number;
  note?: string;
};

export const statements = (book: Book): BankStatement[] => book.bankStatements ?? [];
export const signOffs = (book: Book): BankReconciliation[] => book.bankReconciliations ?? [];

/* --------------------------------------------------------------- the whole thing */

export type ReconciliationView = ReturnType<typeof reconcileStatement>;

/**
 * Match one imported statement against the book and build the reconciliation.
 *
 * Everything here is derived at request time from the statement and the book. Nothing is
 * cached and nothing is stored, so an edit to a voucher shows up on the next refresh —
 * which is exactly what should happen, and is why a sign-off records the number it saw.
 */
export function reconcileStatement(book: Book, statement: BankStatement, driftDays = 5) {
  const bank = book.banks.find((b) => b.id === statement.bankId);
  const bb = bankBook(book, statement.bankId, statement.from, statement.to);
  const movements = bookMovements(book, statement.bankId, statement.from, statement.to);

  const match = matchStatement({
    lines: statement.lines,
    movements,
    driftDays,
    prefixes: bookPrefixes(book)
  });

  /**
   * Hand-made matches applied on top of the automatic ones.
   *
   * Applied here rather than fed into the matcher so the two stay distinguishable: the
   * screen can show which lines the system matched and which a person did, and a person's
   * decision can be undone without re-running anything. A decision naming a movement the
   * automatic pass already consumed is ignored rather than allowed to double-book it.
   */
  const taken = new Set(
    match.results.filter((r: { status: string; match?: { movementId: string } }) => r.status === 'matched').map((r: { match: { movementId: string } }) => r.match.movementId)
  );
  for (const d of statement.decisions ?? []) {
    if (taken.has(d.movementId)) continue;
    const target = match.results.find((r: { line: StatementLine }) => r.line.sourceLine === d.sourceLine);
    const movement = movements.find((m) => m.id === d.movementId);
    if (!target || !movement || target.status === 'matched') continue;
    taken.add(d.movementId);
    target.status = 'matched';
    target.strength = 'by_hand';
    target.match = { movementId: movement.id, ref: movement.ref, kind: movement.kind, drift: 0, byReference: false, wordHits: 0 };
    target.decidedBy = d.decidedBy;
    match.unmatchedMovements = match.unmatchedMovements.filter((u: { movement: BookMovement }) => u.movement.id !== d.movementId);
  }
  match.counts.matched = match.results.filter((r: { status: string }) => r.status === 'matched').length;
  match.counts.ambiguous = match.results.filter((r: { status: string }) => r.status === 'ambiguous').length;
  match.counts.unknownToBook = match.results.filter((r: { status: string }) => r.status === 'unknown_to_book').length;
  match.counts.unpresented = match.unmatchedMovements.length;

  const rec = reconcile({
    match,
    bookOpening: bb.opening,
    bookClosing: bb.closing,
    statementOpening: statement.openingBalance,
    statementClosing: statement.closingBalance,
    statementBalanceSource: statement.balanceSource,
    from: statement.from,
    to: statement.to,
    bankId: statement.bankId,
    bankName: bank?.name ?? statement.bankId
  });

  /**
   * Does a sign-off for this period still hold?
   *
   * Compared rather than trusted. A journal voucher or an edited payment dated inside a
   * closed reconciliation moves the book's closing balance, and the tick from last month
   * would otherwise stay green over a number that has since changed.
   */
  const signed = signOffs(book).find(
    (s) => s.bankId === statement.bankId && s.from === statement.from && s.to === statement.to
  );
  const stale = signed
    ? Math.round(signed.bookClosingAtClose) !== Math.round(bb.closing) || Math.round(signed.differenceAtClose) !== Math.round(rec.difference)
    : false;

  return {
    ...rec,
    statement,
    movements,
    match,
    completeness: assertComplete(book, statement.bankId, statement.from, statement.to),
    signed: signed ?? null,
    stale,
    staleDetail: stale && signed
      ? `Signed off on ${signed.closedAt.slice(0, 10)} with a book closing balance of ${Math.round(signed.bookClosingAtClose)} and a difference of ${Math.round(signed.differenceAtClose)}. Today the book closes at ${Math.round(bb.closing)} and the difference is ${Math.round(rec.difference)}. Something dated inside this period changed after it was signed.`
      : null,
    /** The journal voucher this reconciliation implies, still needing counter-accounts. */
    draft: adjustmentDraft(rec, `BANK:${statement.bankId}`)
  };
}

export { adjustmentDraft };
