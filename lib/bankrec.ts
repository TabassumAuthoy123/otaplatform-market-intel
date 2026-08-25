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
  /**
   * Lines somebody has declared to be the bank's own — a charge, interest, a direct debit.
   *
   * Separate from `decisions` because they answer different questions. A decision says
   * "this line IS that book entry"; a classification says "no book entry corresponds to
   * this, and I am willing to say so." Only the second one lets a line into the adjustment
   * column, and only a person can make it.
   */
  classifications?: { sourceLine: number; as: 'bank_only'; by: string; at: string }[];
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


/**
 * What was outstanding when this period began.
 *
 * A cheque written on 31 July and presented on 2 August has to be matchable in August, or
 * the August reconciliation declares it a charge the book never saw and the adjustment
 * draft offers to post a payment that is already recorded. The whole point of an
 * unpresented cheque is that it clears LATER; a candidate set bounded by the period
 * cannot see the one thing reconciliation exists for.
 *
 * WHERE THE FLOOR COMES FROM, AND WHY THERE HAS TO BE ONE
 *
 * "Outstanding" is a claim about evidence, not about age. A movement is outstanding only
 * if a statement covering its date has been seen and did not show it. Before the earliest
 * imported statement there is no evidence either way — those months were reconciled on
 * paper, or not at all, and either way this system did not watch it happen.
 *
 * So the carry-forward starts at the earliest imported statement for the account. Without
 * that floor, importing a single August statement would declare every payment since the
 * book opened to be an unpresented cheque: sixty-six of them here, all of them wrong, and
 * each one a candidate the matcher could mistake an August line for.
 */
export function carriedForward(book: Book, bankId: string, from: string): BookMovement[] {
  const earlier = statements(book)
    .filter((s) => s.bankId === bankId && s.to < from)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (earlier.length === 0) return [];

  const seen = new Set<string>();
  for (const st of earlier) {
    const movements = bookMovements(book, bankId, st.from, st.to);
    const m = matchStatement({
      lines: st.lines,
      movements,
      carried: [],
      driftDays: 5,
      prefixes: bookPrefixes(book)
    });
    for (const r of m.results as { status: string; match?: { movementId: string } }[]) {
      if (r.status === 'matched' && r.match) seen.add(r.match.movementId);
    }
    // A hand-made decision counts as matched even though the automatic pass refused it.
    for (const d of st.decisions ?? []) seen.add(d.movementId);
  }

  const floor = earlier[0].from;
  const dayBefore = new Date(`${from}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  return bookMovements(book, bankId, floor, dayBefore.toISOString().slice(0, 10))
    .filter((m) => !seen.has(m.id));
}

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

  const carried = carriedForward(book, statement.bankId, statement.from);
  const match = matchStatement({
    lines: statement.lines,
    movements,
    carried,
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
  const byLine = new Map<number, string[]>();
  for (const d of statement.decisions ?? []) {
    if (!byLine.has(d.sourceLine)) byLine.set(d.sourceLine, []);
    byLine.get(d.sourceLine)!.push(d.movementId);
  }
  for (const [sourceLine, ids] of byLine) {
    const target = match.results.find((r: { line: StatementLine }) => r.line.sourceLine === sourceLine);
    if (!target || target.status === 'matched') continue;
    const picked = ids
      .filter((id) => !taken.has(id))
      .map((id) => movements.concat(carried).find((m) => m.id === id))
      .filter(Boolean) as BookMovement[];
    if (picked.length === 0) continue;

    /**
     * The group must add up EXACTLY, even though a person asked for it.
     *
     * A confirmed grouping is a judgement about which entries were banked together, not a
     * licence to close a gap. If the chosen entries do not sum to the line, accepting it
     * would put the difference inside a matched pair — the one thing this whole feature
     * exists to prevent, arrived at by consent instead of by accident.
     */
    const sum = Math.round(picked.reduce((t, m) => t + m.amount, 0) * 100) / 100;
    if (picked.length > 1 && sum !== Math.round(target.line.amount * 100) / 100) {
      target.status = 'ambiguous';
      target.why = `A grouping was confirmed for this line, but the ${picked.length} entries chosen add up to ${sum} against a line of ${target.line.amount}. The difference would have been buried inside the match, so it is refused.`;
      continue;
    }

    for (const m of picked) taken.add(m.id);
    target.status = 'matched';
    target.strength = 'by_hand';
    target.match = { movementId: picked[0].id, ref: picked.map((m) => m.ref).join(' + '), kind: picked[0].kind, drift: 0, byReference: false, wordHits: 0, carried: false };
    target.matchedGroup = picked.map((m) => ({ id: m.id, ref: m.ref, amount: m.amount }));
    target.decidedBy = (statement.decisions ?? []).find((d) => d.sourceLine === sourceLine)?.decidedBy;
    match.unmatchedMovements = match.unmatchedMovements.filter((u: { movement: BookMovement }) => !picked.some((m) => m.id === u.movement.id));
  }

  /**
   * Lines a person has called the bank's own.
   *
   * Carried on the statement alongside the match decisions, and applied here rather than
   * inside the matcher: "no book entry fits this" is a fact the matcher can establish,
   * and "therefore it is a bank charge" is a judgement only a person can make.
   */
  for (const cl of statement.classifications ?? []) {
    const target = match.results.find((r: { line: StatementLine }) => r.line.sourceLine === cl.sourceLine);
    if (!target || target.status !== 'unmatched') continue;
    target.classification = cl.as;
    target.classifiedBy = cl.by;
  }

  match.counts.matched = match.results.filter((r: { status: string }) => r.status === 'matched').length;
  match.counts.ambiguous = match.results.filter((r: { status: string }) => r.status === 'ambiguous').length;
  match.counts.unmatched = match.results.filter((r: { status: string }) => r.status === 'unmatched').length;
  match.counts.groupCandidate = match.results.filter((r: { status: string }) => r.status === 'group_candidate').length;
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
