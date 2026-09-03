/**
 * The financial year, its boundaries, and what a year-end close may refuse.
 *
 * WHY THIS IS PLAIN COMMONJS
 *
 * Same reason as lib/journal-rules.js and lib/period-lock.js: two processes need it and only
 * one of them can run TypeScript. The Next app on :3002 renders the year and derives the
 * figures; the zero-dependency admin portal on :4001 is what actually closes it. If each held
 * its own idea of where a year ends they would agree the day they were written and not for
 * long after — and the failure would be the portal sealing 30 June while the app believed the
 * year opened on 30 June too.
 *
 * WHAT A CLOSE IS HERE, AND WHAT IT IS NOT
 *
 * It records what was true at a date, seals the period, and advances the year's name. It
 * POSTS NOTHING. Everything in this product is derived from vouchers, and a closing voucher
 * would land on SALES, on every EXP:*, on AR, on AP and on every bank — all of them control
 * accounts — which would put twenty-odd permanent rows into the reconciling-items list per
 * closed year. That list exists so a person reads it item by item; burying it under annual
 * housekeeping is how it stops being read.
 *
 * So the cut is EVIDENCE, not a source of truth. The rule that keeps it honest:
 *
 *   THE CUT EXPORTS A DATE TO THE REPORTS AND A FIGURE TO NOTHING.
 *
 * closedThrough() and openYearStart() return dates. A date is an input both derivations may
 * take independently. A figure would be a term they share, and two derivations that share a
 * term agreeing is not evidence — which is the property this whole codebase is built on.
 * The stored figures are read by exactly one thing, the drift check, whose output feeds no
 * other calculation.
 *
 * THE OFF-BY-ONE, WRITTEN DOWN ONCE
 *
 * The lock is INCLUSIVE: isLocked(lockedThrough, d) is `d <= lockedThrough`. So closing the
 * year that ends on 30 June sets lockedThrough to '2026-06-30' — not to '2026-07-01'. Get it
 * wrong one way and 30 June stays writable after it was filed; the other way and 1 July, the
 * first day of the open year, is sealed. openYearStart() is DEFINED as nextDay(closedThrough)
 * so the two conventions can never be written down separately again.
 */

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The day after. */
const nextDay = (iso) => shift(iso, 1);
/** The day before. */
const prevDay = (iso) => shift(iso, -1);

const maxISO = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** Every close on the book, oldest first. Never mutated, never deleted — see reopen(). */
function closes(book) {
  return [...((book && book.closes) || [])].sort((a, b) =>
    String(a.closedThrough).localeCompare(String(b.closedThrough))
  );
}

/** The most recent close, or null. */
function lastClose(book) {
  const all = closes(book).filter((c) => !c.reopened);
  return all.length ? all[all.length - 1] : null;
}

/** The last day of the most recently closed year, or null if nothing is closed. */
function closedThrough(book) {
  const c = lastClose(book);
  return c ? c.closedThrough : null;
}

/**
 * The first day of the year that is currently open.
 *
 * Null when nothing has been closed, which is NOT the same as the financial year start: a book
 * whose first voucher predates the year it is named for is trading in an unclosed prior year,
 * and bounding its reports at the year's name would hide that rather than report it.
 */
function openYearStart(book) {
  const through = closedThrough(book);
  return through ? nextDay(through) : null;
}

/** Is this date inside a year that has been closed? */
function inClosedYear(book, date) {
  const through = closedThrough(book);
  return Boolean(through && date && String(date) <= String(through));
}

/**
 * The close this book would propose next.
 *
 * The day before the next anniversary of the financial year start, on or after whatever is
 * already closed. On a book closed through nothing, with the year starting 1 July, that is
 * 30 June — the year that has already been traded in and never closed.
 */
function proposedClose(book, today) {
  const fy = book && book.company && book.company.financialYearStart;
  if (!fy || !ISO.test(fy)) return null;
  const already = closedThrough(book);
  let end = prevDay(fy);
  // Walk forward a year at a time until the proposal is after what is closed and not ahead
  // of today. A year that has not finished cannot be closed.
  for (let i = 0; i < 40; i++) {
    const afterClosed = !already || end > already;
    const finished = !today || end < today;
    if (afterClosed && finished) return end;
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    end = d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Everything a close can be refused for WITHOUT deriving a single figure.
 *
 * Deliberately book-only. The portal cannot run the ledger — it has no TypeScript — and it
 * must not grow its own copy of one, so anything needing a balance is asked of the app and
 * checked there. What is here is what can be answered by reading the book: shape, ordering,
 * and the states a close would freeze in place.
 *
 * `openingDate` is passed in rather than imported so this file keeps no dependencies of its
 * own; both callers already hold lib/journal-rules.js.
 */
function closeRefusals(book, through, opts = {}) {
  const out = [];
  const today = opts.today || null;
  const opens = opts.openingDate || null;

  if (!ISO.test(String(through || ''))) {
    return [`"${through}" is not a date. Use YYYY-MM-DD.`];
  }

  if (today && through >= today) {
    out.push(
      `${through} has not finished yet — today is ${today}. A year is closed after it ends, ` +
      `because anything dated inside it can still arrive.`
    );
  }

  if (opens && through < opens) {
    out.push(`${through} is before this book opens (${opens}). There is no year there to close.`);
  }

  const already = closedThrough(book);
  if (already && through <= already) {
    out.push(
      `Everything up to ${already} is already closed. A close moves the boundary forward; ` +
      `to change a closed year, reopen it — which is recorded — rather than closing it again.`
    );
  }

  /**
   * A year end, not an arbitrary date. The day after the close has to be the anniversary of
   * the financial year start, or "the year" being closed is a period nobody named.
   */
  const fy = book && book.company && book.company.financialYearStart;
  if (fy && ISO.test(fy)) {
    const opensOn = nextDay(through);
    if (opensOn.slice(5) !== fy.slice(5)) {
      out.push(
        `${through} is not a year end. This book's year starts on ${fy.slice(5)}, so a year ` +
        `ends on ${prevDay(fy).slice(5)}. Lock a month in Settings if that is what you meant.`
      );
    }
  }

  /**
   * A draft invoice inside the period being closed can never be confirmed afterwards — the
   * lock refuses the edit — so it becomes a sale that can only be cancelled. The Settings lock
   * panel already warns about this and then closes anyway; a year end is where it stops being
   * a warning.
   */
  const drafts = ((book && book.invoices) || []).filter(
    (i) => i.status === 'draft' && i.date && i.date <= through
  );
  if (drafts.length) {
    out.push(
      `${drafts.length} invoice(s) dated on or before ${through} are still drafts ` +
      `(${drafts.slice(0, 3).map((i) => i.no).join(', ')}${drafts.length > 3 ? ', …' : ''}). ` +
      `Once the year is closed they can never be confirmed, only cancelled. Deal with them first.`
    );
  }

  /**
   * A bank statement overlapping the period that has never been signed off. Closing over an
   * unreconciled bank is closing over the one thing nobody has checked.
   */
  const signed = new Set(((book && book.bankReconciliations) || []).map((r) => r.statementId));
  const unsigned = ((book && book.bankStatements) || []).filter(
    (s) => s.from && s.from <= through && !signed.has(s.id)
  );
  if (unsigned.length) {
    out.push(
      `${unsigned.length} bank statement(s) overlapping this year have not been signed off ` +
      `(${unsigned.slice(0, 3).map((s) => s.id).join(', ')}). Reconcile them before closing — ` +
      `after the close their adjustments cannot be posted.`
    );
  }

  return out;
}

/** What a close will move, recorded so a reopen can put it back exactly. */
function movesFor(book, through) {
  const fy = (book && book.company && book.company.financialYearStart) || null;
  return {
    lockedThrough: { before: (book && book.lockedThrough) || null, after: through },
    financialYearStart: { before: fy, after: maxISO(fy, nextDay(through)) }
  };
}

module.exports = {
  ISO, nextDay, prevDay, maxISO,
  closes, lastClose, closedThrough, openYearStart, inClosedYear,
  proposedClose, closeRefusals, movesFor
};
