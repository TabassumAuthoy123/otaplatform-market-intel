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
 * Every subset of `pool` that sums exactly to `target`, bounded.
 *
 * WHY THIS EXISTS
 *
 * A bank does not always show what the book shows one-for-one. The commonest case in a
 * travel agency is three customer cheques taken to the branch together and credited as a
 * single inward-clearing line. Before this, that line matched nothing, was declared
 * "unknown to the book", and the adjustment draft offered to post the whole amount — while
 * the three receipts sat outstanding. Both sides moved by the same amount so the
 * reconciliation still read zero, and the money would have been recorded twice.
 *
 * Bounded hard, because subset-sum is exponential: at most `maxPool` candidates and at
 * most `maxSize` per group. Beyond that the search is abandoned and the line simply stays
 * unmatched, which is the safe direction. A reconciliation that takes a minute to load is
 * a reconciliation nobody runs.
 */
function subsetsSummingTo(pool, target, maxSize, maxPool, maxResults) {
  maxSize = maxSize || 5;
  maxPool = maxPool || 14;
  maxResults = maxResults || 3;
  if (pool.length > maxPool) return { found: [], abandoned: true };

  const found = [];
  const chosen = [];
  const walk = (i, remaining) => {
    if (found.length >= maxResults) return;
    if (round2(remaining) === 0 && chosen.length >= 2) {
      found.push(chosen.slice());
      return;
    }
    if (i >= pool.length || chosen.length >= maxSize || remaining < 0) return;
    chosen.push(pool[i]);
    walk(i + 1, round2(remaining - pool[i].amount));
    chosen.pop();
    walk(i + 1, remaining);
  };
  walk(0, round2(target));
  return { found, abandoned: false };
}

/**
 * Match one statement's lines against the book.
 *
 * Runs in three passes, strongest first, and a movement consumed by an earlier pass is
 * gone. Order matters: if the weak pass ran first it would spend a movement that the
 * reference pass could have claimed unambiguously, and both lines would end up wrong.
 * The BSP matcher learned this the hard way — a single document matched twice, and an
 * ADM that PNR-matched a ticket and reported a 2,500-against-36,599 gap as a dispute.
 *
 * CARRIED-FORWARD ITEMS
 *
 * `carried` is book movements from BEFORE this period that no earlier statement matched —
 * last month's unpresented cheques. They belong in the candidate pool and the first
 * version of this left them out, because the candidate set was simply "movements dated
 * inside the period". A cheque written on 31 July and presented on 2 August then matched
 * nothing in August, was declared a charge the book had never seen, and the adjustment
 * draft offered to post it a second time. The whole point of an unpresented cheque is
 * that it clears LATER; a matcher that cannot see across the boundary cannot reconcile
 * the one thing reconciliation exists for.
 *
 * Returns every line with a verdict, never a mutated input.
 */
function matchStatement({ lines, movements, carried = [], driftDays = 5, prefixes = [] }) {
  const withPrefixes = movements
    .map((m) => Object.assign({}, m, { prefixes, carried: false }))
    .concat(carried.map((m) => Object.assign({}, m, { prefixes, carried: true })));
  const takenMovement = new Set();
  const verdicts = new Map();

  const candidatesFor = (line, drift) =>
    withPrefixes
      .filter((m) => !takenMovement.has(m.id))
      .map((m) => {
        const c = candidate(line, m, drift);
        return c ? Object.assign(c, { carried: m.carried }) : null;
      })
      .filter(Boolean);

  const pass = (want) => {
    /**
     * A carried-forward item gets a wider window than a current-period one.
     *
     * It is already known to be outstanding, so the question is no longer "did this
     * happen" but "has it finally cleared" — and a cheque can sit for weeks. The window
     * is still finite: past ninety days it is not an unpresented cheque, it is a cheque
     * nobody banked, and matching it to a look-alike would bury that.
     */
    const claims = [];
    for (const line of lines) {
      if (verdicts.has(line)) continue;
      const here = candidatesFor(line, 90).filter((c) => (c.carried ? true : c.drift <= driftDays))
        .filter((c) => strengthOf(c) === want)
        .filter((c) => c.carried || c.drift <= driftDays);
      if (here.length === 0) continue;
      claims.push({ line, here });
    }

    // A movement wanted by two lines at the same strength is ambiguous from the
    // movement's side too, and neither line may have it.
    const wantedBy = new Map();
    for (const { here } of claims) {
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
   * One statement line against SEVERAL book entries.
   *
   * Offered as a candidate group and never applied. Three receipts summing to a deposit
   * is usually right and occasionally a coincidence, and a coincidence applied silently
   * consumes three real entries against the wrong line. So this only ever produces a
   * decision for a person — the same rule the rest of the file follows.
   */
  const groupsFor = (line) => {
    const pool = withPrefixes.filter(
      (m) => !takenMovement.has(m.id) &&
        m.direction === line.direction &&
        daysBetween(m.date, line.date) >= -1 &&
        daysBetween(m.date, line.date) <= (m.carried ? 90 : driftDays)
    );
    const { found, abandoned } = subsetsSummingTo(pool, line.amount, 5, 14, 3);
    return { found, abandoned, pool: pool.length };
  };

  /**
   * Anything still undecided.
   *
   * `unmatched`, NOT "unknown to the book" — the earlier name was a claim the matcher is
   * not entitled to make. All it knows is that nothing in the candidate pool fits. The
   * line may genuinely be the bank's own charge, or it may be a book entry the pool could
   * not see: an aggregated deposit, an item from a period nobody has reconciled yet, an
   * amount the bank rounded. Deciding which is a person's job, and treating "no match" as
   * "the bank did this alone" is exactly how an adjustment gets posted for money already
   * in the book.
   */
  const results = lines.map((line) => {
    const v = verdicts.get(line);
    if (v) return Object.assign({ line }, v);
    const g = groupsFor(line);
    if (g.found.length === 1) {
      return {
        line,
        status: 'group_candidate',
        strength: null,
        candidates: [],
        groups: g.found,
        why: `${g.found[0].length} outstanding book entries add up to exactly this line — probably banked together. Confirm it and all ${g.found[0].length} are matched at once.`
      };
    }
    if (g.found.length > 1) {
      return {
        line,
        status: 'group_candidate',
        strength: null,
        candidates: [],
        groups: g.found,
        why: `${g.found.length} different sets of book entries add up to exactly this line. Only one of them is what actually happened.`
      };
    }
    return {
      line,
      status: 'unmatched',
      strength: null,
      candidates: [],
      groups: [],
      searchAbandoned: g.abandoned,
      why: g.abandoned
        ? 'No single entry fits, and there were too many outstanding entries to check every combination. Match it by hand or narrow the period.'
        : 'Nothing in the book fits this line, on its own or in combination. It may be the bank\'s own charge or interest — say which before it is treated as one.'
    };
  });

  const unmatchedMovements = withPrefixes
    .filter((m) => !takenMovement.has(m.id))
    .map((m) => ({
      movement: m,
      carried: m.carried,
      why: m.carried
        ? 'Outstanding since an earlier period, and the bank still has not shown it.'
        : 'In the book, and the bank has not shown it in this period.'
    }));

  return {
    results,
    unmatchedMovements,
    counts: {
      matched: results.filter((r) => r.status === 'matched').length,
      byReference: results.filter((r) => r.status === 'matched' && r.strength === 'reference').length,
      carried: results.filter((r) => r.status === 'matched' && r.match && r.match.carried).length,
      ambiguous: results.filter((r) => r.status === 'ambiguous').length,
      groupCandidate: results.filter((r) => r.status === 'group_candidate').length,
      unmatched: results.filter((r) => r.status === 'unmatched').length,
      unpresented: unmatchedMovements.length
    }
  };
}

/**
 * Apply a person's hand decisions and classifications to a match, and recount.
 *
 * WHY THIS IS HERE AND NOT IN ITS TWO CALLERS
 *
 * It used to be in both. lib/bankrec.ts had a copy for the screen and admin/server.js had
 * a copy for the portal — about thirty lines of judgement about somebody's money, written
 * twice. They had already drifted: the screen recounted `unmatched` and `groupCandidate`
 * after applying decisions and the portal did not, so a line a person had decided still
 * counted as one that "looks grouped" in the portal's summary while the screen had moved
 * on. The portal recounted `unknownToBook` and the screen did not.
 *
 * Nothing was wrong with either copy on its own. That is what makes the shape dangerous:
 * the portal is where a period is signed off, so the two pieces of code that decide what
 * has been matched must be one piece of code.
 *
 * Applied AFTER the automatic pass rather than fed into it, deliberately, so the screen can
 * still say which lines the system matched and which a person did, and so a decision can be
 * undone without re-running anything. A decision naming a movement the automatic pass has
 * already consumed is ignored rather than allowed to double-book it.
 */
function applyDecisions(match, statement, pool) {
  const taken = new Set(match.results.filter((r) => r.status === "matched").map((r) => r.match.movementId));
  const byLine = new Map();
  for (const d of statement.decisions || []) {
    if (!byLine.has(d.sourceLine)) byLine.set(d.sourceLine, []);
    byLine.get(d.sourceLine).push(d.movementId);
  }

  for (const [sourceLine, ids] of byLine) {
    const target = match.results.find((r) => r.line.sourceLine === sourceLine);
    if (!target || target.status === "matched") continue;
    const picked = ids.filter((id) => !taken.has(id)).map((id) => pool.find((x) => x.id === id)).filter(Boolean);
    if (!picked.length) continue;

    /**
     * The group must add up EXACTLY, even though a person asked for it.
     *
     * A confirmed grouping is a judgement about which entries were banked together, not a
     * licence to close a gap. If the chosen entries do not sum to the line, accepting it
     * would put the difference inside a matched pair — the one thing this whole feature
     * exists to prevent, arrived at by consent instead of by accident.
     */
    const sum = Math.round(picked.reduce((t, x) => t + x.amount, 0) * 100) / 100;
    if (picked.length > 1 && sum !== Math.round(target.line.amount * 100) / 100) {
      target.status = "ambiguous";
      target.why = "A grouping was confirmed for this line, but the " + picked.length +
        " entries chosen add up to " + sum + " against a line of " + target.line.amount +
        ". The difference would have been buried inside the match, so it is refused.";
      continue;
    }

    for (const x of picked) taken.add(x.id);
    target.status = "matched";
    target.strength = "by_hand";
    target.match = {
      movementId: picked[0].id, ref: picked.map((x) => x.ref).join(" + "), kind: picked[0].kind,
      drift: 0, byReference: false, wordHits: 0, carried: false
    };
    target.matchedGroup = picked.map((x) => ({ id: x.id, ref: x.ref, amount: x.amount }));
    const first = (statement.decisions || []).find((d) => d.sourceLine === sourceLine);
    target.decidedBy = first ? first.decidedBy : null;
    match.unmatchedMovements = match.unmatchedMovements.filter((u) => !picked.some((x) => x.id === u.movement.id));
  }

  /**
   * Lines a person has called the bank's own. "No book entry fits this" is a fact the
   * matcher can establish; "therefore it is a bank charge" is a judgement only a person
   * can make, which is why it arrives here rather than inside the matcher.
   */
  for (const cl of statement.classifications || []) {
    const target = match.results.find((r) => r.line.sourceLine === cl.sourceLine);
    if (!target || target.status !== "unmatched") continue;
    target.classification = cl.as;
    target.classifiedBy = cl.by;
  }

  // Every count, not the subset each caller happened to remember.
  const n = (status) => match.results.filter((r) => r.status === status).length;
  match.counts.matched = n("matched");
  match.counts.ambiguous = n("ambiguous");
  match.counts.unmatched = n("unmatched");
  match.counts.groupCandidate = n("group_candidate");
  match.counts.unknownToBook = n("unknown_to_book");
  match.counts.byReference = match.results.filter((r) => r.status === "matched" && r.strength === "reference").length;
  match.counts.carried = match.results.filter((r) => r.status === "matched" && r.match && r.match.carried).length;
  match.counts.byHand = match.results.filter((r) => r.status === "matched" && r.strength === "by_hand").length;
  match.counts.unpresented = match.unmatchedMovements.length;
  return match;
}

module.exports = {
  normalise, referencesIn, bookPrefixes, sharedWords,
  candidate, strengthOf, matchStatement, subsetsSummingTo, daysBetween, round2
, applyDecisions };
