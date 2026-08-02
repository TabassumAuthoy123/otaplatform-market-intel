import { ExportBar } from '@/components/accounts/ExportBar';
import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { generalLedger, getBook, journal, money } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

const GROUP_LABEL: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses'
};

/**
 * The general ledger: every account balance, and every posting behind one of
 * them.
 *
 * Pick an account and you get the running balance the way a ledger card reads —
 * opening, each movement, closing — with the voucher number on every line so a
 * figure can always be traced back to the document that caused it.
 */
export default async function LedgerPage({
  searchParams
}: {
  searchParams: { account?: string; from?: string; to?: string; view?: string };
}) {
  const from = searchParams.from || undefined;
  const to = searchParams.to || undefined;
  const account = searchParams.account || undefined;
  const showJournal = searchParams.view === 'journal';

  const book = await getBook();
  const sym = book.company.currencySymbol;
  const gl = generalLedger(book, account, from, to);

  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const lines = showJournal ? journal(book).filter((l) => inRange(l.date)) : [];

  const period = from || to ? `${from ?? 'start'} to ${to ?? 'today'}` : 'whole book';
  const totalDebit = gl.summary.reduce((t, r) => t + r.debit, 0);
  const totalCredit = gl.summary.reduce((t, r) => t + r.credit, 0);

  const grouped = (['asset', 'liability', 'equity', 'income', 'expense'] as const).map((g) => ({
    group: g,
    rows: gl.summary.filter((r) => r.account.group === g)
  })).filter((x) => x.rows.length > 0);

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ account, from, to, view: searchParams.view, ...over })) {
      if (v) p.set(k, v);
    }
    const q = p.toString();
    return `/accounts/ledger${q ? `?${q}` : ''}`;
  };

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 9 · Reports"
        title="General ledger"
        sub="Every voucher posted as balanced double entries. Pick an account for its ledger card, or open the journal to see every posting in date order."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Accounts with movement" value={String(gl.summary.length)} sub={`of ${gl.chart.length} in the chart`} />
        <Tile label="Total debits" value={money(totalDebit, sym)} sub={period} />
        <Tile label="Total credits" value={money(totalCredit, sym)} sub={totalDebit === totalCredit ? 'Equal — the journal balances' : 'DOES NOT MATCH DEBITS'} tone={totalDebit === totalCredit ? 'good' : 'warn'} />
      </div>

      <form className="no-print flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Account</span>
          <select name="account" defaultValue={account ?? ''} className="w-72 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All accounts — summary</option>
            {gl.chart.map((a) => (
              <option key={a.code} value={a.code}>{a.name} · {a.code}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">From</span>
          <input type="date" name="from" defaultValue={from ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">To</span>
          <input type="date" name="to" defaultValue={to ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Show</button>
        <a href="/accounts/ledger" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Reset</a>
        <a
          href={qs({ view: showJournal ? undefined : 'journal' })}
          className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900 hover:border-teal-500"
        >
          {showJournal ? 'Hide the journal' : 'Show the journal'}
        </a>
        <div className="ml-auto">
          <ExportBar section="general_ledger" from={from} to={to} label="Ledger" />
        </div>
      </form>

      {/* ------------------------------------------------------- one ledger card */}
      {gl.account && (
        <Panel
          title={`${gl.account.name} · ${gl.account.code}`}
          sub={`${GROUP_LABEL[gl.account.group]} · ${period} · ${gl.rows.length} postings · closing ${money(gl.closing, sym)}`}
        >
          {gl.rows.length === 0 ? (
            <Empty>No postings hit this account in that period.</Empty>
          ) : (
            <Table head={['Date', 'Voucher', 'Type', 'Party', 'Narration', 'Debit', 'Credit', 'Balance']} right={[5, 6, 7]}>
              <tr className="bg-panel">
                <Td>—</Td>
                <Td>—</Td>
                <Td className="font-semibold">Opening</Td>
                <Td />
                <Td className="text-muted">Brought forward</Td>
                <Td right>—</Td>
                <Td right>—</Td>
                <Td right mono className="font-bold">{money(gl.opening, sym)}</Td>
              </tr>
              {gl.rows.map((l, i) => (
                <tr key={`${l.ref}-${i}`} className="hover:bg-surface">
                  <Td mono>{l.date}</Td>
                  <Td mono className="font-semibold text-navy-900">{l.ref}</Td>
                  <Td className="text-muted">{l.voucherType}</Td>
                  <Td>{l.party}</Td>
                  <Td className="max-w-[320px] text-[12px] text-muted">{l.narration}</Td>
                  <Td right mono className={l.debit ? 'font-semibold' : 'text-muted'}>{l.debit ? money(l.debit, sym) : '—'}</Td>
                  <Td right mono className={l.credit ? 'font-semibold' : 'text-muted'}>{l.credit ? money(l.credit, sym) : '—'}</Td>
                  <Td right mono className="font-bold text-navy-900">{money(l.balance, sym)}</Td>
                </tr>
              ))}
              <tr className="border-t-2 border-navy-900 bg-panel">
                <Td />
                <Td />
                <Td className="font-bold">Closing</Td>
                <Td />
                <Td />
                <Td right mono className="font-bold">{money(gl.rows.reduce((t, l) => t + l.debit, 0), sym)}</Td>
                <Td right mono className="font-bold">{money(gl.rows.reduce((t, l) => t + l.credit, 0), sym)}</Td>
                <Td right mono className="font-bold text-teal-700">{money(gl.closing, sym)}</Td>
              </tr>
            </Table>
          )}
        </Panel>
      )}

      {/* -------------------------------------------------------- chart summary */}
      <Panel title="Account balances" sub={`${period} · click an account for its ledger card`}>
        <Table head={['Code', 'Account', 'Group', 'Debits', 'Credits', 'Balance']} right={[3, 4, 5]}>
          {grouped.flatMap(({ group, rows }) => [
            <tr key={group} className="bg-panel">
              <Td className="text-[11px] font-bold uppercase tracking-wide text-muted">{GROUP_LABEL[group]}</Td>
              <Td /><Td /><Td /><Td /><Td />
            </tr>,
            ...rows.map((r) => (
              <tr key={r.account.code} className="hover:bg-surface">
                <Td mono className="text-muted">{r.account.code}</Td>
                <Td>
                  <a href={qs({ account: r.account.code })} className="font-semibold text-navy-900 hover:text-teal-700 hover:underline">
                    {r.account.name}
                  </a>
                </Td>
                <Td className="text-[12px] text-muted">{GROUP_LABEL[r.account.group]}</Td>
                <Td right mono className="text-muted">{money(r.debit, sym)}</Td>
                <Td right mono className="text-muted">{money(r.credit, sym)}</Td>
                <Td right mono className={`font-semibold ${r.balance < 0 ? 'text-red-700' : 'text-navy-900'}`}>
                  {money(r.balance, sym)}
                </Td>
              </tr>
            ))
          ])}
          <tr className="border-t-2 border-navy-900 bg-panel">
            <Td /><Td className="font-bold text-navy-900">Total</Td><Td />
            <Td right mono className="font-bold">{money(totalDebit, sym)}</Td>
            <Td right mono className="font-bold">{money(totalCredit, sym)}</Td>
            <Td right mono className={totalDebit === totalCredit ? 'font-bold text-teal-700' : 'font-bold text-red-700'}>
              {money(totalDebit - totalCredit, sym)}
            </Td>
          </tr>
        </Table>
      </Panel>

      {/* --------------------------------------------------------- full journal */}
      {showJournal && (
        <Panel title={`Journal — ${lines.length} postings`} sub="Every voucher, two or more lines each, always balanced">
          <Table head={['Date', 'Voucher', 'Type', 'Party', 'Account', 'Debit', 'Credit']} right={[5, 6]}>
            {lines.slice(0, 600).map((l, i) => (
              <tr key={`${l.ref}-${l.account}-${i}`} className="hover:bg-surface">
                <Td mono>{l.date}</Td>
                <Td mono className="font-semibold text-navy-900">{l.ref}</Td>
                <Td className="text-muted">{l.voucherType}</Td>
                <Td>{l.party}</Td>
                <Td mono className="text-[12px]">
                  <a href={qs({ account: l.account })} className="hover:text-teal-700 hover:underline">{l.account}</a>
                </Td>
                <Td right mono className={l.debit ? 'font-semibold' : 'text-muted'}>{l.debit ? money(l.debit, sym) : '—'}</Td>
                <Td right mono className={l.credit ? 'font-semibold' : 'text-muted'}>{l.credit ? money(l.credit, sym) : '—'}</Td>
              </tr>
            ))}
          </Table>
          {lines.length > 600 && (
            <p className="px-5 py-3 text-[12.5px] text-muted">
              Showing the first 600 of {lines.length.toLocaleString('en-IN')} postings. Narrow the dates, or download
              the Excel for the complete journal.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
