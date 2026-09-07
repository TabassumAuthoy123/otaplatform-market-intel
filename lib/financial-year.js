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

/**
 * The window a report should use when the caller did not name one.
 *
 * ONLY WHEN NEITHER BOUND IS GIVEN. This is the whole rule and it was got wrong first time.
 *
 * The first version substituted the open-year start whenever `from` was absent, including
 * when the caller HAD named a `to`. Ask for the closed year — "everything up to 30 June" —
 * and the window became 1 July to 30 June: inverted, empty, and silent. Measured on the demo
 * book the moment it shipped:
 *
 *   profit & loss to 2026-06-30      revenue 0        net profit 0
 *   the same year named in full      revenue 69,62,100  net profit 1,44,100
 *
 * And the bridge read Difference 0 over it, because both of its sides were empty. That is
 * this codebase's own warning about a balancing check proving nothing, arrived at by a
 * default rather than by a bug in the arithmetic — the worst kind, because every number on
 * the page is internally consistent and all of them are zero.
 *
 * A caller who names an end has said what they want: everything up to that date. A caller who
 * names nothing is asking for "now", and after a close "now" means the year that is open.
 */
function openWindow(book, from, to) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  if (has(from) || has(to)) return { from: has(from) ? from : undefined, to: has(to) ? to : undefined };
  const opens = openYearStart(book);
  return { from: opens || undefined, to: undefined };
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

/**
 * Why a reopen may be refused. Book-only, like closeRefusals, and shared for the same reason.
 *
 * YEARS REOPEN NEWEST FIRST, AND THAT IS AN INVARIANT RATHER THAN A PREFERENCE.
 *
 * A reopen puts back exactly what its own close recorded moving — including lockedThrough,
 * from cut.moved.lockedThrough.before. On the FIRST close of a book that value is null,
 * because nothing was locked before it.
 *
 * So reopening an EARLIER cut while a later one is still live sets lockedThrough to null and
 * leaves the later year filed, live, drift-checked — and completely writable. Measured by
 * replaying the mutation on a two-close book: closedThrough stayed 2027-06-30, lockedThrough
 * became null, isLocked(null, "2027-03-15") came back false, financialYearStart walked back a
 * year, and the audit line said only "Reopened FY2026".
 *
 * Refusing out-of-order is the fix that needs no arithmetic. Unwind the way it was wound: the
 * newest live year comes off first, and every cut's recorded `before` is then genuinely the
 * state it is going back to.
 */
function reopenRefusals(book, id) {
  const all = closes(book);
  const cut = all.find((c) => c.id === id);
  if (!cut) return [`There is no filed year with the id ${id}.`];
  if (cut.reopened) return [`${cut.label} was already reopened on ${String(cut.reopened.at).slice(0, 10)}.`];

  const newest = lastClose(book);
  if (newest && newest.id !== cut.id) {
    return [
      `${newest.label} was filed after ${cut.label} and is still open for reopening. Years come ` +
      `off newest first: reopening ${cut.label} now would restore the lock to where it stood ` +
      `before it was filed — ${cut.moved.lockedThrough.before === null ? "nowhere" : cut.moved.lockedThrough.before} — ` +
      `and leave ${newest.label} filed but writable. Reopen ${newest.label} first.`
    ];
  }
  return [];
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
  closes, lastClose, closedThrough, openYearStart, inClosedYear, openWindow,
  proposedClose, closeRefusals, reopenRefusals, movesFor
};
