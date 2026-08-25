import Link from 'next/link';
import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { accountName, chartOfAccounts, getBook, money } from '@/lib/accounting';
import { reconcileStatement, statements } from '@/lib/bankrec';

export const dynamic = 'force-dynamic';

const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL || process.env.ADMIN_URL || 'http://localhost:4001';

/**
 * Bank reconciliation: the bank's record of the month against the book's.
 *
 * Read-only, like every other screen in this panel — importing a statement, deciding an
 * ambiguous line and signing a period off all happen in the admin portal on :4001. The
 * split is the same one the whole app keeps: one place writes, one place renders, so
 * there is exactly one set of validations and one audit trail.
 *
 * WHAT THIS SCREEN IS TRYING NOT TO BE
 *
 * The tempting version shows a big green tick and a number. This one leads with the two
 * columns and the items in them, because the number is never the useful part — an
 * accountant opening this at the end of the month wants to know which cheques have not
 * cleared and what the bank charged without telling anybody, and both of those are lists.
 *
 * A tick appears only when the arithmetic agrees AND nothing is unresolved AND nothing is
 * waiting to be posted. See `reconciled` versus `settled` in lib/bank-reconcile.js: a
 * statement can agree perfectly while carrying four charges the book has never recorded,
 * and a screen that called that "done" would let an agency close twelve months in a row
 * without ever recording a bank fee.
 */
export default async function ReconcilePage({
  searchParams
}: {
  searchParams: { bank?: string; statement?: string; show?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const chart = chartOfAccounts(book);
  const all = statements(book);

  const bankId = searchParams.bank ?? book.banks[0]?.id ?? '';
  const mine = all.filter((s) => s.bankId === bankId).sort((a, b) => b.to.localeCompare(a.to));
  const statement = searchParams.statement
    ? mine.find((s) => s.id === searchParams.statement)
    : mine[0];

  const bankTabs = (
    <div className="no-print flex flex-wrap gap-2">
      {book.banks.map((b) => (
        <Link
          key={b.id}
          href={`/accounts/reconcile?bank=${encodeURIComponent(b.id)}`}
          className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
            b.id === bankId
              ? 'bg-navy-900 text-white'
              : 'border border-hair bg-white text-navy-900 hover:border-teal-500 hover:text-teal-700'
          }`}
        >
          {b.name}
          <span className={`ml-1.5 ${b.id === bankId ? 'text-white/60' : 'text-muted'}`}>
            {all.filter((s) => s.bankId === b.id).length}
          </span>
        </Link>
      ))}
    </div>
  );

  /* ------------------------------------------------------- nothing imported yet */

  if (!statement) {
    return (
      <div className="flex flex-col gap-5">
        <PageHead
          title="Bank reconciliation"
          sub="The bank's record of the month against the book's, item by item."
        />
        {bankTabs}
        <Panel title="No statement imported for this account">
          <Empty>
            <p className="mx-auto max-w-2xl text-left leading-relaxed">
              Import one from the admin portal — <strong>Accounting → Bank statements</strong>. Paste or upload the
              CSV your bank exports; the columns are mapped once per account and remembered.
              <br />
              <br />
              There is deliberately no built-in layout for Dutch-Bangla, BRAC, City Bank or bKash. A layout guessed
              at rather than seen would put money in the wrong column while looking like it knew what it was doing,
              which is worse than asking. The import shows you what it read before anything is saved, and checks
              its reading against the running balance the bank printed.
            </p>
            <p className="mt-5">
              <a
                href={`${ADMIN_URL}/bank-statements`}
                className="inline-block rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700"
              >
                Import a statement ↗
              </a>
            </p>
          </Empty>
        </Panel>
      </div>
    );
  }

  const rec = reconcileStatement(book, statement);
  const showMatched = searchParams.show === 'matched';

  const bankAccountName = accountName(`BANK:${statement.bankId}`, chart);

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Bank reconciliation"
        sub={`${rec.bankName} · ${statement.from} to ${statement.to} · statement imported ${statement.importedAt.slice(0, 10)} by ${statement.importedBy}`}
      />

      {bankTabs}

      {mine.length > 1 && (
        <div className="no-print flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Period</span>
          {mine.map((s) => (
            <Link
              key={s.id}
              href={`/accounts/reconcile?bank=${encodeURIComponent(bankId)}&statement=${encodeURIComponent(s.id)}`}
              className={`rounded px-3 py-1.5 text-[12.5px] ${
                s.id === statement.id ? 'bg-navy-900 font-semibold text-white' : 'border border-hair bg-white text-navy-900 hover:border-teal-500'
              }`}
            >
              {s.from} → {s.to}
            </Link>
          ))}
        </div>
      )}

      {/* -------------------------------------------------------------- verdict */}
      <div
        className={`rounded-xl2 border-l-[3px] px-5 py-3.5 text-[13px] font-semibold ${
          rec.settled
            ? 'border-teal-600 bg-teal-600/5 text-teal-800'
            : rec.reconciled
              ? 'border-amber-600 bg-amber-600/5 text-amber-800'
              : 'border-red-600 bg-red-50 text-red-800'
        }`}
      >
        {rec.settled
          ? 'Both sides agree, every line is accounted for, and there is nothing left to post. This period is done.'
          : rec.reconciled
            ? `Both sides agree — but ${rec.requiresPosting} item(s) on the statement have never been recorded in the book. The arithmetic works because they are sitting in the adjustment column below; it is not finished until they are posted.`
            : `The two sides do not agree. The difference is ${money(rec.difference, sym)}, and it is not explained by anything in this period's lists.`}
      </div>

      {rec.blockers.length > 0 && (
        <div className="rounded-xl2 border border-amber-300 bg-amber-50 px-5 py-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-amber-800">Before this means anything</p>
          <ul className="mt-2 flex flex-col gap-2">
            {rec.blockers.map((b) => (
              <li key={b} className="text-[13px] leading-relaxed text-amber-900">{b}</li>
            ))}
          </ul>
        </div>
      )}

      {rec.stale && (
        <div className="rounded-xl2 border-l-[3px] border-red-600 bg-red-50 px-5 py-3.5 text-[13px] leading-relaxed text-red-800">
          <strong>This period was signed off, and the book has changed since.</strong> {rec.staleDetail}
        </div>
      )}

      {!rec.completeness.ok && (
        <div className="rounded-xl2 border-l-[3px] border-red-600 bg-red-50 px-5 py-3.5 text-[13px] leading-relaxed text-red-800">
          <strong>Do not rely on this reconciliation.</strong> {rec.completeness.detail}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Statement lines" value={String(rec.counts.statementLines)} sub={`${rec.counts.matched} matched to the book`} />
        <Tile
          label="Needs a decision"
          value={String(rec.counts.ambiguous)}
          sub={rec.counts.ambiguous ? 'more than one entry fits' : 'nothing ambiguous'}
          tone={rec.counts.ambiguous ? 'warn' : 'good'}
        />
{/*
          Two tiles where there was one, because "no book entry fits" and "the bank did
          this alone" are different claims and only a person may make the second.

          Before they were separated, a cheque from an unreconciled month and a deposit
          the bank had aggregated both counted as bank charges, the adjustment draft
          offered to post them, and the money would have been recorded twice — while the
          difference stayed at zero because the matching book entries were sitting
          outstanding in the other column.
        */}
        <Tile
          label="Classified as the bank's own"
          value={String(rec.counts.bankOnly)}
          sub={rec.counts.bankOnly ? 'charges, interest, direct debits — post these' : 'none'}
          tone={rec.counts.bankOnly ? 'warn' : 'good'}
        />
        <Tile
          label="Unclassified"
          value={String(rec.counts.unclassified + rec.counts.groupCandidate)}
          sub={
            rec.counts.unclassified + rec.counts.groupCandidate
              ? 'left OUT of the arithmetic until somebody says what they are'
              : 'every line accounted for'
          }
          tone={rec.counts.unclassified + rec.counts.groupCandidate ? 'bad' : 'good'}
        />
        <Tile
          label="Book knows, bank does not"
          value={String(rec.counts.bookOnly)}
          sub="in transit or unpresented — no entry needed, only time"
        />
      </div>

      {/* ------------------------------------------------- the statement itself */}
      <Panel
        title="Reconciliation statement"
        sub="Two columns rather than one running total, because the two sides answer different questions: what the bank will say once the in-flight items land, and what the book will say once it records what the bank already knows."
      >
        <div className="grid gap-0 lg:grid-cols-2">
          <div className="border-b border-hair p-5 lg:border-b-0 lg:border-r">
            <h3 className="text-[13px] font-bold text-navy-900">Per the bank</h3>
            <dl className="mt-3 flex flex-col gap-2 text-[13px]">
              <Row label={`Balance per the statement${statement.balanceSource === 'entered' ? ' (entered by hand)' : ''}`} value={money(rec.bank.closing, sym)} />
              <Row label={`Add: deposits in transit (${rec.bank.inTransit.length})`} value={money(rec.bank.inTransitTotal, sym)} />
              <Row label={`Less: unpresented payments (${rec.bank.unpresented.length})`} value={money(-rec.bank.unpresentedTotal, sym)} />
              <Row label="Adjusted bank balance" value={money(rec.bank.adjusted, sym)} strong />
            </dl>
          </div>
          <div className="p-5">
            <h3 className="text-[13px] font-bold text-navy-900">Per the book</h3>
            <dl className="mt-3 flex flex-col gap-2 text-[13px]">
              <Row label="Balance per the book" value={money(rec.book.closing, sym)} />
              <Row label={`Add: credits not in the book (${rec.book.credits.length})`} value={money(rec.book.creditsTotal, sym)} />
              <Row label={`Less: debits not in the book (${rec.book.debits.length})`} value={money(-rec.book.debitsTotal, sym)} />
              <Row label="Adjusted book balance" value={money(rec.book.adjusted, sym)} strong />
            </dl>
          </div>
        </div>
        <div
          className={`flex items-center justify-between border-t border-hair px-5 py-3 text-[13px] font-bold ${
            rec.difference === 0 ? 'text-teal-700' : 'text-red-700'
          }`}
        >
          <span>Difference — must be zero</span>
          <span className="tnum">{money(rec.difference, sym)}</span>
        </div>
        {rec.openingGap !== null && rec.openingGap !== 0 && (
          <div className="border-t border-hair bg-red-50 px-5 py-2.5 text-[12.5px] text-red-800">
            The opening balances differ by {money(rec.openingGap, sym)}. That is last period&rsquo;s unfinished
            business arriving here — no line in this period can explain it, and closing this one will not clear it.
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------ needs a decision */}
      {rec.counts.ambiguous > 0 && (
        <Panel
          title="More than one entry fits"
          sub="Left unmatched on purpose. Matching one of these would be a coin toss, and a wrong match hides a real difference inside a matched pair — the one thing a reconciliation exists to prevent."
        >
          <Table head={['Date', 'On the statement', 'Amount', 'Could be', 'Decide']} right={[2]}>
            {rec.match.results
              .filter((r: { status: string }) => r.status === 'ambiguous')
              .map((r: { line: { sourceLine: number; date: string; description: string; amount: number }; candidates: { ref: string; kind: string }[] }) => (
                <tr key={r.line.sourceLine} className="hover:bg-surface">
                  <Td mono>{r.line.date}</Td>
                  <Td>{r.line.description}</Td>
                  <Td right mono>{money(r.line.amount, sym)}</Td>
                  <Td className="text-muted">{r.candidates.map((c) => c.ref).join(' or ')}</Td>
                  <Td>
                    <a
                      href={`${ADMIN_URL}/bank-statements/decide?statement=${encodeURIComponent(statement.id)}&line=${r.line.sourceLine}`}
                      className="font-semibold text-teal-700 hover:underline"
                    >
                      choose ↗
                    </a>
                  </Td>
                </tr>
              ))}
          </Table>
        </Panel>
      )}

      {/* ------------------------------------------------------ unclassified */}
      {(rec.counts.unclassified > 0 || rec.counts.groupCandidate > 0) && (
        <Panel
          title="Matching nothing in the book, and not yet explained"
          sub={`Worth ${money(rec.unclassifiedTotal, sym)}, and deliberately left out of the arithmetic above — which is why the difference is not zero. "Nothing fits" is not the same as "the bank did this alone": it could be a cheque from a month nobody has reconciled, or several entries the bank banked together.`}
          actions={
            <a
              href={`${ADMIN_URL}/bank-statements`}
              className="rounded-lg border border-hair bg-white px-3.5 py-2 text-[12.5px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700"
            >
              Explain them in the portal ↗
            </a>
          }
        >
          <Table head={['Date', 'Narration', 'Direction', 'Amount', 'What it might be']} right={[3]}>
            {rec.match.results
              .filter((r: { status: string; classification?: string }) => (r.status === 'unmatched' && !r.classification) || r.status === 'group_candidate')
              .map((r: { line: { sourceLine: number; date: string; description: string; amount: number; direction: string }; status: string; why: string; groups?: { ref: string }[][] }) => (
                <tr key={r.line.sourceLine} className="hover:bg-surface">
                  <Td mono>{r.line.date}</Td>
                  <Td>{r.line.description}</Td>
                  <Td>{r.line.direction === 'in' ? 'Money in' : 'Money out'}</Td>
                  <Td right mono className="font-semibold text-red-700">{money(r.line.amount, sym)}</Td>
                  <Td className="text-muted">
                    {r.status === 'group_candidate' && r.groups && r.groups.length
                      ? `possibly ${r.groups[0].map((g) => g.ref).join(' + ')}`
                      : r.why}
                  </Td>
                </tr>
              ))}
          </Table>
        </Panel>
      )}

      {/* -------------------------------------------------- bank knows, book does not */}
      {rec.counts.bankOnly > 0 && (
        <Panel
          title="On the statement, never recorded in the book"
          sub="Somebody has looked at each of these and said it is the bank's own — a charge, excise duty, interest, a direct debit. Real transactions that happened; the book has simply not been told. These need a journal voucher, and the counter-account is yours to choose, because only you know whether a 3,000 debit is excise duty or a standing order nobody cancelled."
          actions={
            <a
              href={`${ADMIN_URL}/journal`}
              className="rounded-lg border border-hair bg-white px-3.5 py-2 text-[12.5px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700"
            >
              Post a journal voucher ↗
            </a>
          }
        >
          <Table head={['Date', 'Narration on the statement', 'Reference', 'Direction', 'Amount', 'Posts to']} right={[4]}>
            {[...rec.book.credits, ...rec.book.debits]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((l) => (
                <tr key={`${l.sourceLine}`} className="hover:bg-surface">
                  <Td mono>{l.date}</Td>
                  <Td>{l.description}</Td>
                  <Td mono className="text-muted">{l.reference}</Td>
                  <Td>{l.direction === 'in' ? 'Money in' : 'Money out'}</Td>
                  <Td right mono className={l.direction === 'in' ? 'text-teal-700' : 'text-amber-700'}>
                    {money(l.amount, sym)}
                  </Td>
                  <Td className="text-muted">
                    {l.direction === 'in' ? 'Dr' : 'Cr'} {bankAccountName}
                  </Td>
                </tr>
              ))}
          </Table>
        </Panel>
      )}

      {/* -------------------------------------------------- book knows, bank does not */}
      {rec.counts.bookOnly > 0 && (
        <Panel
          title="In the book, not yet on the statement"
          sub="These need no entry at all — the book is already right and the bank is behind. Posting an adjustment for them is the classic way a reconciliation ends up double-counting, which is why they sit in the other column."
        >
          <Table head={['Date', 'Voucher', 'Type', 'Direction', 'Amount', 'Days outstanding']} right={[4, 5]}>
            {[...rec.bank.inTransit, ...rec.bank.unpresented]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((mv) => {
                const days = Math.round(
                  (new Date(`${statement.to}T00:00:00Z`).getTime() - new Date(`${mv.date}T00:00:00Z`).getTime()) / 86400000
                );
                return (
                  <tr key={mv.id} className="hover:bg-surface">
                    <Td mono>{mv.date}</Td>
                    <Td mono>{mv.ref}</Td>
                    <Td className="text-muted">
                    {mv.kind.replace(/_/g, ' ')}
                    {/*
                      A carried item is one an earlier statement already failed to show.
                      Worth marking, because a cheque outstanding across two statements is
                      a different conversation from one written last week.
                    */}
                    {mv.date < statement.from && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                        from an earlier period
                      </span>
                    )}
                  </Td>
                    <Td>{mv.direction === 'in' ? 'Deposit in transit' : 'Unpresented'}</Td>
                    <Td right mono>{money(mv.amount, sym)}</Td>
                    {/*
                      Shown because it is the number that turns a routine item into a
                      question. A cheque outstanding for four days is the post; one
                      outstanding for ninety was probably never banked.
                    */}
                    <Td right mono className={days > 30 ? 'font-semibold text-amber-700' : 'text-muted'}>
                      {days}
                    </Td>
                  </tr>
                );
              })}
          </Table>
        </Panel>
      )}

      {/* --------------------------------------------------------------- matched */}
      <Panel
        title={`Matched — ${rec.counts.matched} of ${rec.counts.statementLines} lines`}
        sub={`${rec.match.counts.byReference} matched because the bank's narration named the voucher. The rest matched on an exact amount and direction within five days; amounts are never approximated, because a fifty-taka gap is a charge or an error and both need seeing.`}
        actions={
          <Link
            href={`/accounts/reconcile?bank=${encodeURIComponent(bankId)}&statement=${encodeURIComponent(statement.id)}${showMatched ? '' : '&show=matched'}`}
            className="rounded-lg border border-hair bg-white px-3.5 py-2 text-[12.5px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700"
          >
            {showMatched ? 'Hide the list' : 'Show every matched line'}
          </Link>
        }
      >
        {showMatched ? (
          <Table head={['Statement date', 'Narration', 'Voucher', 'Matched on', 'Drift', 'Amount']} right={[4, 5]}>
            {rec.match.results
              .filter((r: { status: string }) => r.status === 'matched')
              .map((r: { line: { sourceLine: number; date: string; description: string; amount: number }; strength: string; match: { ref: string; drift: number }; decidedBy?: string }) => (
                <tr key={r.line.sourceLine} className="hover:bg-surface">
                  <Td mono>{r.line.date}</Td>
                  <Td className="text-muted">{r.line.description}</Td>
                  <Td mono>{r.match.ref}</Td>
                  <Td>
                    {r.strength === 'reference'
                      ? 'the narration named it'
                      : r.strength === 'exact_date'
                        ? 'same day, same amount'
                        : r.strength === 'by_hand'
                          ? `chosen by ${r.decidedBy ?? 'a person'}`
                          : 'same amount, within the window'}
                  </Td>
                  <Td right mono className={r.match.drift > 0 ? 'text-amber-700' : 'text-muted'}>
                    {r.match.drift === 0 ? '—' : `${r.match.drift}d`}
                  </Td>
                  <Td right mono>{money(r.line.amount, sym)}</Td>
                </tr>
              ))}
          </Table>
        ) : (
          <Empty>
            {rec.counts.matched} lines agree between the bank and the book. The interesting rows are the ones above.
          </Empty>
        )}
      </Panel>

      {/* ------------------------------------------------------------- sign-off */}
      <Panel
        title="Sign-off"
        sub="A signed period records the difference that was true when it was signed, so a later edit dated inside it can be noticed rather than silently accepted."
      >
        <div className="px-5 py-4 text-[13px] leading-relaxed text-muted">
          {rec.signed ? (
            <>
              Signed off by <strong className="text-navy-900">{rec.signed.closedBy}</strong> on{' '}
              {rec.signed.closedAt.slice(0, 10)} with a difference of {money(rec.signed.differenceAtClose, sym)}.
              {rec.stale ? ' It no longer holds — see above.' : ' It still holds.'}
            </>
          ) : rec.settled ? (
            <>
              Nothing is outstanding, so this period can be signed off in the portal.{' '}
              <a href={`${ADMIN_URL}/bank-statements`} className="font-semibold text-teal-700 hover:underline">
                Sign it off ↗
              </a>
            </>
          ) : (
            <>
              Not ready to sign off. {rec.counts.ambiguous > 0 && `${rec.counts.ambiguous} line(s) need a decision. `}
              {rec.requiresPosting > 0 && `${rec.requiresPosting} item(s) need posting to the book. `}
              {rec.difference !== 0 && `The two sides differ by ${money(rec.difference, sym)}.`}
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** One line of a reconciliation column. */
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? 'border-t border-hair pt-2 font-bold text-navy-900' : 'text-muted'}`}>
      <dt className="leading-snug">{label}</dt>
      <dd className="tnum whitespace-nowrap">{value}</dd>
    </div>
  );
}
