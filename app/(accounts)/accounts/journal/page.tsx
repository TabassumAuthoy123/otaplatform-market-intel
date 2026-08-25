import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { accountName, chartOfAccounts, getBook, money } from '@/lib/accounting';
import { controlAccounts, vouchers } from '@/lib/journals';

export const dynamic = 'force-dynamic';

/**
 * Manual journal vouchers, read-only — writing one is the admin portal's job.
 *
 * The split is the same as every other voucher type in this panel: :3002 renders the
 * book, :4001 changes it. Keeping it means there is exactly one place a posting can
 * be created, with one set of validations, one audit trail and one period lock,
 * rather than two implementations that will disagree the first time one is edited.
 *
 * See lib/journals.ts for the design decision this screen exists to make visible:
 * a manual voucher may touch a control account, and every time it does, that is
 * stated rather than absorbed.
 */
export default async function JournalPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string; account?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const chart = chartOfAccounts(book);
  const control = controlAccounts(book);

  const from = searchParams.from || undefined;
  const to = searchParams.to || undefined;
  const account = searchParams.account || undefined;

  const all = vouchers(book);
  const rows = all
    .filter((v) => (!from || v.date >= from) && (!to || v.date <= to))
    .filter((v) => !account || v.lines.some((l) => l.account === account))
    .sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no));

  const value = (v: (typeof rows)[number]) => v.lines.reduce((t, l) => t + (l.debit || 0), 0);
  const total = rows.reduce((t, v) => t + value(v), 0);
  const touchingControl = rows.filter((v) => v.lines.some((l) => control.has(l.account)));
  const reversed = rows.filter((v) => v.reversedBy).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="Journal vouchers"
        sub="Manual double-entry — depreciation, accruals, prepayments, reclassifications, corrections and opening balances. Posted from the admin portal."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Vouchers" value={String(rows.length)} sub={all.length === rows.length ? 'whole book' : `of ${all.length} in the book`} />
        <Tile label="Value posted" value={money(total, sym)} sub="Sum of the debit side" />
        {/*
          Counted and shown rather than mentioned in a note. This is the number that
          decides whether the reconciliation on the financials page has anything
          standing between its two derivations, and somebody reading this screen
          should not have to open every voucher to find out.
        */}
        <Tile
          label="Touching a control account"
          value={String(touchingControl.length)}
          sub={touchingControl.length ? 'listed as reconciling items on Financials' : 'the two derivations agree with nothing in between'}
          tone={touchingControl.length ? 'warn' : 'good'}
        />
        <Tile label="Reversed" value={String(reversed)} sub="Corrected by a later voucher, both kept" />
      </div>

      {/* ------------------------------------------------------------- filters */}
      <Panel title="Filter" sub="Dates are inclusive. Leave blank for the whole book.">
        <form className="flex flex-wrap items-end gap-3 px-5 py-4" method="get">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            From
            <input type="date" name="from" defaultValue={from ?? ''} className="rounded border border-hair px-2 py-1.5 text-[13px] text-navy-900" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            To
            <input type="date" name="to" defaultValue={to ?? ''} className="rounded border border-hair px-2 py-1.5 text-[13px] text-navy-900" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Account
            <select name="account" defaultValue={account ?? ''} className="rounded border border-hair px-2 py-1.5 text-[13px] text-navy-900">
              <option value="">Any account</option>
              {chart.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name}
                  {control.has(a.code) ? ' — control' : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-navy-900 px-4 py-2 text-[13px] font-semibold text-white hover:bg-navy-800">
            Apply
          </button>
        </form>
      </Panel>

      {/* ------------------------------------------------------------ vouchers */}
      {rows.length === 0 ? (
        <Panel title={all.length === 0 ? 'No journal vouchers yet' : 'No vouchers match that filter'}>
          <Empty>
            {all.length === 0
              ? 'Post one from the admin portal on :4001 — Accounting → Journal vouchers. Depreciation, an accrual, a prepayment, a correction, or the opening balances of an agency moving off another system.'
              : 'Widen the dates or clear the account.'}
          </Empty>
        </Panel>
      ) : (
        rows.map((v) => {
          const hitsControl = v.lines.some((l) => control.has(l.account));
          return (
            <Panel
              key={v.id}
              title={`${v.no} · ${v.date}`}
              sub={`${v.narration} — posted by ${v.createdBy}${v.reversedBy ? ' · REVERSED' : ''}${v.reversalOf ? ' · this is a reversal' : ''}`}
            >
              {hitsControl && (
                <div className="border-l-[3px] border-amber-600 bg-amber-600/5 px-5 py-2.5 text-[12.5px] text-amber-800">
                  This voucher posts to an account the reconciliation cross-checks, so it appears as a reconciling
                  item on Financials. That is not a fault — it is how a manual entry stays visible instead of
                  looking like a difference nobody can explain.
                </div>
              )}
              <Table head={['Account', 'Memo', 'Debit', 'Credit']} right={[2, 3]}>
                {v.lines.map((l, i) => (
                  <tr key={`${v.id}-${i}`} className="hover:bg-surface">
                    <Td>
                      {accountName(l.account, chart)}
                      {control.has(l.account) && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                          control
                        </span>
                      )}
                    </Td>
                    <Td className="text-muted">{l.memo ?? ''}</Td>
                    <Td right mono>{l.debit ? money(l.debit, sym) : ''}</Td>
                    <Td right mono>{l.credit ? money(l.credit, sym) : ''}</Td>
                  </tr>
                ))}
                <tr className="border-t border-hair bg-panel">
                  <Td className="font-semibold">Total</Td>
                  <Td />
                  <Td right mono className="font-semibold">{money(v.lines.reduce((t, l) => t + (l.debit || 0), 0), sym)}</Td>
                  <Td right mono className="font-semibold">{money(v.lines.reduce((t, l) => t + (l.credit || 0), 0), sym)}</Td>
                </tr>
              </Table>
            </Panel>
          );
        })
      )}
    </div>
  );
}
