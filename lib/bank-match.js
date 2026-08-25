/**
 * Matching statement lines against the book, without ever guessing.
 *
 * Shared CommonJS for the same reason as lib/journal-rules.js: the portal imports and
 * matches, the app renders the result, and only one of them can run TypeScript. Two
 * implementations of "these two are the same transaction" would be two different
 * reconciliations.
 *
 * THE RULE THE WHOLE FILE IS BUILT AROUND
 *
 * A match is automatic only when it is UNIQUE. Everything else is a candidate for a
 * person to decide, and an undecided line stays undecided.
 *
 * That rule is not caution for its own sake, and this book's own data is why. Cheques
 * clear late, so a matcher has to tolerate a few days of drift — and the moment it does,
 * the twenty-nine amounts that repeat on different days through the Dutch-Bangla account
 * become genuinely confusable. Two payments of exactly 30,500 sit one day apart in July.
 * A matcher that picks the nearest is right about half the time and silent about it
 * either way, and the accountant finds out when a supplier calls about an unpaid bill
 * that the book says is settled.
 *
 * WHAT A WRONG MATCH COSTS, VERSUS A MISSED ONE
 *
 * A missed match leaves a line on a list a person reads. A wrong match takes a real
 * difference and hides it inside a matched pair — which is the one outcome a
 * reconciliation exists to prevent. The two errors are not symmetric, so this does not
 * trade them off evenly: it prefers the visible failure every time.
 */

/* ---------------------------------------------------------------- narration */

/**
 * A narration reduced to something comparable.
 *
 * Banks pad, abbreviate and shout. "TFR TO  AKASH TRAVELS & TOURS." and
 * "tfr to akash travels and tours" are the same words; the comparison should not care.
 * Punctuation goes, `&` becomes `and` because the two are used interchangeably in
 * Bangladeshi agency names, and runs of space collapse.
 */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Voucher numbers a narration mentions.
 *
 * The strongest signal available, and the only one that is unambiguous on its own: a
 * bank narration reading "CHQ SFT-PAY-0048" is telling you exactly which payment this
 * is. It is also the rarest — in this book's own statements roughly one narration in
 * four carries the reference and the rest say "TFR TO BENEFICIARY".
 *
 * Prefixes are taken from the book rather than hard-coded, because they are configurable
 * per company: an agency that sets its invoice prefix to `ABC/INV/` gets that matched
 * too. A hard-coded `SFT-` would work perfectly on the demo book and on nobody else's.
 */
function referencesIn(text, prefixes) {
  const found = new Set();
  const hay = String(text || '').toUpperCase();
  for (const p of prefixes) {
    const prefix = String(p || '').toUpperCase();
    if (!prefix) continue;
    // Escape it: prefixes legitimately contain / and - and could contain anything.
    const safe = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe + '[0-9]+', 'g');
    let m;
    while ((m = re.exec(hay)) !== null) found.add(m[0]);
  }
  return Array.from(found);
}

/** Every voucher prefix this book issues, for referencesIn. */
function bookPrefixes(book) {
  const c = book.company || {};
  return [
    c.invoicePrefix, c.receiptPrefix, c.billPrefix, c.paymentPrefix,
    c.expensePrefix, c.creditNotePrefix, c.transferPrefix, c.supplierCreditPrefix,
    'SFT-JV-'
  ].filter(Boolean);
}

/**
 * Whole words of the movement's note that the narration also contains.
 *
 * Words of three characters or fewer are dropped: "to", "of" and "ltd" appear in
 * everything and would make every line look a little bit like every other line. This
 * returns a count rather than a score, because the caller decides what a count is worth
 * and a number between zero and one invites treating a weak signal as a strong one.
 */
function sharedWords(narration, note) {
  const a = new Set(normalise(narration).split(' ').filter((w) => w.length > 3));
  const b = normalise(note).split(' ').filter((w) => w.length > 3);
  let hits = 0;
  for (const w of new Set(b)) if (a.has(w)) hits++;
  return hits;
}

/* ------------------------------------------------------------------ matching */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/**
 * How this pair could be the same transaction, or null if it could not.
 *
 * Amount and direction must be EXACT. There is no near-amount matching and no tolerance
 * band, because a bank does not round: if the book says 30,500 and the statement says
 * 30,450, that fifty is either a charge, a fee or an error, and every one of those is
 * something the accountant needs to see rather than have absorbed. A "close enough"
 * match would silently swallow exactly the differences this is for.
 *
 * The date may drift. `driftDays` is how far a cheque may take to present; outside it
 * the pair is not a candidate at all.
 */
function candidate(line, movement, driftDays) {
  if (line.direction !== movement.direction) return null;
  if (round2(line.amount) !== round2(movement.amount)) return null;
  const drift = daysBetween(movement.date, line.date);
  // A statement line dated BEFORE the book entry by more than a day is a different
  // transaction, not an early presentation. One day of slack absorbs a value-date
  // convention; more would start matching next month's cheque to last month's bill.
  if (drift < -1 || drift > driftDays) return null;

  const refs = referencesIn(line.description + ' ' + line.reference, movement.prefixes || []);
  const byReference = refs.includes(String(movement.ref).toUpperCase());
  return {
    movementId: movement.id,
    ref: movement.ref,
    kind: movement.kind,
    drift,
    byReference,
    wordHits: sharedWords(`${line.description} ${line.reference}`, movement.note)
  };
}

/**
 * The strength of a candidate, as a label rather than a number.
 *
 * Deliberately not a score. A number invites a threshold, a threshold invites tuning,
 * and a tuned threshold is a decision about somebody's money buried in a constant.
 * Three named strengths, and only one of them is allowed to match on its own.
 */
function strengthOf(c) {
  if (c.byReference) return 'reference';          // the bank named the voucher
  if (c.drift === 0) return 'exact_date';         // same day, same amount, same direction
  return 'within_window';                         // same amount, a few days apart
}

/**
 * Match one statement's lines against the book's movements.
 *
 * Runs in three passes, strongest first, and a movement consumed by an earlier pass is
 * gone. Order matters: if the weak pass ran first it would spend a movement that the
 * reference pass could have claimed unambiguously, and both lines would end up wrong.
 * The BSP matcher learned this the hard way — a single document matched twice, and an
 * ADM that PNR-matched a ticket and reported a 2,500-against-36,599 gap as a dispute.
 *
 * Returns every line with a verdict, never a mutated input.
 */
function matchStatement({ lines, movements, driftDays = 5, prefixes = [] }) {
  const withPrefixes = movements.map((m) => Object.assign({}, m, { prefixes }));
  const takenMovement = new Set();
  const verdicts = new Map();

  const candidatesFor = (line) =>
    withPrefixes
      .filter((m) => !takenMovement.has(m.id))
      .map((m) => candidate(line, m, driftDays))
      .filter(Boolean);

  const pass = (want) => {
    // Collected first, applied after, so that within one pass no line can consume a
    // movement another line of the same strength had an equal claim to.
    const claims = [];
    for (const line of lines) {
      if (verdicts.has(line)) continue;
      const here = candidatesFor(line).filter((c) => strengthOf(c) === want);
      if (here.length === 0) continue;
      claims.push({ line, here });
    }

    // A movement wanted by two lines at the same strength is ambiguous from the
    // movement's side too, and neither line may have it.
    const wantedBy = new Map();
    for (const { line, here } of claims) {
      if (here.length !== 1) continue;
      const id = here[0].movementId;
      wantedBy.set(id, (wantedBy.get(id) || 0) + 1);
    }

    for (const { line, here } of claims) {
      if (here.length > 1) {
        verdicts.set(line, {
          status: 'ambiguous',
          strength: want,
          candidates: here,
          why: `${here.length} book entries fit this line equally well at this strength. Matching one would be a coin toss, so neither is matched.`
        });
        continue;
      }
      const only = here[0];
      if (wantedBy.get(only.movementId) > 1) {
        verdicts.set(line, {
          status: 'ambiguous',
          strength: want,
          candidates: here,
          why: 'Another statement line fits the same book entry just as well, so neither takes it.'
        });
        continue;
      }
      takenMovement.add(only.movementId);
      verdicts.set(line, { status: 'matched', strength: want, match: only, candidates: here });
    }
  };

  pass('reference');
  pass('exact_date');
  pass('within_window');

  /**
   * Anything still undecided, with whatever partial evidence exists.
   *
   * A line with no candidate at all is `unknown_to_book` — a bank charge, interest, or
   * something nobody expected. A line whose ambiguity was recorded above keeps that
   * verdict. Nothing is quietly dropped.
   */
  const results = lines.map((line) => {
    const v = verdicts.get(line);
    if (v) return Object.assign({ line }, v);
    return {
      line,
      status: 'unknown_to_book',
      strength: null,
      candidates: [],
      why: 'No entry in the book has this amount and direction within the window. It is the bank\'s own charge, interest, or something that has not been recorded.'
    };
  });

  const unmatchedMovements = withPrefixes
    .filter((m) => !takenMovement.has(m.id))
    .map((m) => ({ movement: m, why: 'In the book, and the bank has not shown it in this period.' }));

  return {
    results,
    unmatchedMovements,
    counts: {
      matched: results.filter((r) => r.status === 'matched').length,
      byReference: results.filter((r) => r.status === 'matched' && r.strength === 'reference').length,
      ambiguous: results.filter((r) => r.status === 'ambiguous').length,
      unknownToBook: results.filter((r) => r.status === 'unknown_to_book').length,
      unpresented: unmatchedMovements.length
    }
  };
}

module.exports = {
  normalise, referencesIn, bookPrefixes, sharedWords,
  candidate, strengthOf, matchStatement, daysBetween, round2
};
