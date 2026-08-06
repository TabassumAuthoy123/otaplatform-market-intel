import { ModuleLink } from '@/components/ModuleLink';
import { ExportBar } from '@/components/accounts/ExportBar';
import { PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { customerLedger, getBook, money, supplierLedger, todayISO } from '@/lib/accounting';

/**
 * The periods a statement is normally asked for.
 *
 * Anchored on the book's own latest transaction rather than the wall clock, so
 * "this month" still means something on a demo whose data ends in July.
 */
const PERIODS = [
  { key: '', label: 'All time' },
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'custom', label: 'Custom range' }
];

function rangeFor(period: string, anchor: string): { from?: string; to?: string } {
  if (!period || period === 'custom') return {};
  const d = new Date(anchor + 'T00:00:00Z');
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();

  if (period === 'day') return { from: anchor, to: anchor };
  if (period === 'week') {
    const back = (d.getUTCDay() + 6) % 7; // weeks start Monday
    const start = new Date(Date.UTC(y, m, d.getUTCDate() - back));
    return { from: iso(start), to: anchor };
  }
  if (period === 'month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: anchor };
  if (period === 'quarter') return { from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))), to: anchor };
  if (period === 'year') return { from: iso(new Date(Date.UTC(y, 0, 1))), to: anchor };
  return {};
}

export const dynamic = 'force-dynamic';

export default async function StatementsPage({
  searchParams
}: {
  searchParams: { kind?: string; party?: string; period?: string; from?: string; to?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const kind = searchParams.kind === 'supplier' ? 'supplier' : 'customer';
  const list = kind === 'customer' ? book.customers : book.suppliers;
  const partyId = searchParams.party ?? list[0]?.id ?? '';
  const party = list.find((p) => p.id === partyId);

  const period = searchParams.period ?? '';
  const preset = rangeFor(period, todayISO(book));
  const from = period === 'custom' ? searchParams.from || undefined : preset.from;
  const to = period === 'custom' ? searchParams.to || undefined : preset.to;

  const full = kind === 'customer' ? customerLedger(book, partyId) : supplierLedger(book, partyId);

  /**
   * A narrowed statement still has to open where the full one left off, or the
   * running balance is meaningless. The brought-forward figure is the balance
   * on the last entry before the window.
   */
  const before = full.filter((r) => (from ? r.date < from : false));
  const broughtForward = before.length ? before[before.length - 1].balance : 0;
  const rows = full.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));

  const closing = rows.length ? rows[rows.length - 1].balance : broughtForward;
  const totalDebit = rows.reduce((t, r) => t + r.debit, 0);
  const totalCredit = rows.reduce((t, r) => t + r.credit, 0);
  const periodLabel = from || to ? `${from ?? 'start'} to ${to ?? 'today'}` : 'All time';

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 8 · Statements"
        title="Party statement"
        sub="Running ledger for one customer or supplier. A positive customer balance is money owed to us; a positive supplier balance is money we owe them."
      />

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Statement of</span>
          <select name="kind" defaultValue={kind} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="customer">Customer</option>
            <option value="supplier">Supplier</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Party</span>
          <select name="party" defaultValue={partyId} className="w-64 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            {list.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Period</span>
          <select name="period" defaultValue={period} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">From</span>
          <input type="date" name="from" defaultValue={searchParams.from ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">To</span>
          <input type="date" name="to" defaultValue={searchParams.to ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Show statement</button>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ModuleLink
            href="/accounts/financials"
            className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900 hover:border-teal-500"
          >
            Company financial statement →
          </ModuleLink>
          <ExportBar section={kind === 'customer' ? 'receivables' : 'payables'} from={from} to={to} label="Download" />
        </div>
      </form>
      <p className="text-[12px] text-muted">
        The dates only apply when Period is set to Custom. Everything else is worked out from the book&rsquo;s own
        latest transaction, so &ldquo;this month&rdquo; still means something on data that ends in the past.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Party" value={party?.name ?? '—'} sub={kind === 'customer' ? 'Customer' : 'Supplier'} />
        <Tile label="Entries" value={String(rows.length)} sub="Invoices, bills, receipts, payments" />
        <Tile label={kind === 'customer' ? 'Invoiced' : 'Paid to supplier'} value={money(totalDebit, sym)} />
        <Tile
          label="Closing balance"
          value={money(closing, sym)}
          sub={kind === 'customer' ? (closing > 0 ? 'Owed to us' : 'Settled') : closing > 0 ? 'We owe them' : 'Settled'}
          tone={closing > 0 ? 'warn' : 'good'}
        />
      </div>

      <Panel title={`${party?.name ?? ''} — statement`} sub={`${periodLabel} · oldest first, with the running balance`}>
        <Table head={['Date', 'Reference', 'Detail', 'Debit', 'Credit', 'Balance']} right={[3, 4, 5]}>
          {from && (
            <tr className="bg-panel">
              <Td mono>{from}</Td>
              <Td>—</Td>
              <Td className="font-semibold">Brought forward</Td>
              <Td right>—</Td>
              <Td right>—</Td>
              <Td right mono className="font-bold">{money(broughtForward, sym)}</Td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.ref + r.date} className="hover:bg-surface">
              <Td mono>{r.date}</Td>
              <Td mono className="font-semibold text-navy-900">{r.ref}</Td>
              <Td>{r.detail}</Td>
              <Td right mono className={r.debit ? '' : 'text-muted'}>{r.debit ? money(r.debit, sym) : '—'}</Td>
              <Td right mono className={r.credit ? 'text-teal-700' : 'text-muted'}>{r.credit ? money(r.credit, sym) : '—'}</Td>
              <Td right mono className="font-semibold">{money(r.balance, sym)}</Td>
            </tr>
          ))}
          <tr className="bg-panel">
            <Td>—</Td>
            <Td>—</Td>
            <Td className="font-semibold">Totals</Td>
            <Td right mono className="font-bold">{money(totalDebit, sym)}</Td>
            <Td right mono className="font-bold">{money(totalCredit, sym)}</Td>
            <Td right mono className="font-bold">{money(closing, sym)}</Td>
          </tr>
        </Table>
      </Panel>
    </div>
  );
}
