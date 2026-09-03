import { NextResponse } from 'next/server';
import { closedYearDrift, getBookUnguarded } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

/**
 * Every filed year, re-derived, with anything that has moved since named.
 *
 * The period lock is a write guard on a scalar date and it has holes it cannot close without
 * becoming the journal: lib/period-lock.js reads four field names, so a date can reach a closed
 * year without being on the record that was written. A bank's openingBalance moves the opening
 * entry. Repointing an invoice line at a document whose travelDate sits inside the closed year
 * moves the deferral. Neither record carries a date the guard looks at.
 *
 * Extending the guard to catch them means asking "what dates does this record post on", which
 * means calling buildJournal from the guard — and then the guard and the journal are one
 * derivation, which is the thing this codebase is built not to do.
 *
 * So the holes are not closed. They are watched, here, and reported wherever the accounts are
 * read. A year that no longer derives to what was filed is a fact somebody needs, and it is
 * exactly the fact a lock alone can never produce.
 */
export async function GET() {
  const book = await getBookUnguarded();
  const drift = closedYearDrift(book);
  return NextResponse.json({
    ok: true,
    closes: drift.length,
    clean: drift.every((d) => d.clean),
    drift
  });
}
