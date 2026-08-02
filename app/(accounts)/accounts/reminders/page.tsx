import { ExportBar } from '@/components/accounts/ExportBar';
import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, money, paymentReminders } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

const STAGE_LABEL: Record<string, string> = {
  within_terms: 'Within terms',
  chase: 'Due — chase',
  escalate: 'Overdue — escalate'
};

export default async function RemindersPage({
  searchParams
}: {
  searchParams: { stage?: string; customer?: string; show?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const r = paymentReminders(book);

  let rows = r.rows;
  if (searchParams.stage) rows = rows.filter((x) => x.stage === searchParams.stage);
  if (searchParams.customer) rows = rows.filter((x) => x.invoice.customerId === searchParams.customer);

  const drafting = searchParams.show ? r.rows.find((x) => x.invoice.id === searchParams.show) : null;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 9 · Receivables"
        title="Payment reminders"
        sub={`Ordered by money at risk, not by age — a two-week-old invoice for six lakh costs more than a three-month-old one for three thousand. Terms: ${r.config.dueAfterDays} days, escalate at ${r.config.escalateAfterDays}.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Total outstanding" value={money(r.total, sym)} sub={`${r.rows.length} invoices`} />
        <Tile label="Due — chase now" value={money(r.dueNow, sym)} sub={`Past ${r.config.dueAfterDays} days`} tone="warn" />
        <Tile label="Overdue — escalate" value={money(r.overdue, sym)} sub={`${r.escalateCount} invoices past ${r.config.escalateAfterDays} days`} tone={r.overdue > 0 ? 'warn' : 'good'} />
        <Tile label="On the chase list" value={String(r.chaseCount)} sub="Needing a call or an email today" />
      </div>

      <Panel title="Ageing" sub="Where the outstanding money actually sits">
        <Table head={['Bucket', 'Invoices', 'Amount', 'Share']} right={[1, 2, 3]}>
          {r.buckets.map((b) => (
            <tr key={b.label} className="hover:bg-surface">
              <Td>{b.label}</Td>
              <Td right mono>{b.count}</Td>
              <Td right mono className="font-semibold">{money(b.amount, sym)}</Td>
              <Td right mono className="text-muted">
                {r.total > 0 ? `${((b.amount / r.total) * 100).toFixed(1)}%` : '—'}
              </Td>
            </tr>
          ))}
          <tr className="border-t-2 border-navy-900 bg-panel">
            <Td className="font-bold">Total</Td>
            <Td right mono className="font-bold">{r.rows.length}</Td>
            <Td right mono className="font-bold">{money(r.total, sym)}</Td>
            <Td />
          </tr>
        </Table>
      </Panel>

      {drafting && (
        <Panel
          title={`Reminder for ${drafting.customer?.name ?? 'customer'} — ${drafting.invoice.no}`}
          sub="Generated, not sent. Nothing here is wired to a mail server, and a system that claims to have sent something it did not is worse than one that hands you the text."
        >
          <div className="space-y-3 p-5">
            <textarea
              readOnly
              rows={12}
              defaultValue={r.message(drafting)}
              className="w-full rounded-lg border border-hair bg-surface p-4 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
            />
            <div className="flex flex-wrap gap-3 text-[12.5px]">
              {drafting.customer?.email && (
                <a
                  href={`mailto:${drafting.customer.email}?subject=${encodeURIComponent(`${book.company.name} — invoice ${drafting.invoice.no}`)}&body=${encodeURIComponent(r.message(drafting))}`}
                  className="rounded-lg bg-teal-600 px-5 py-2.5 font-semibold text-white hover:bg-teal-700"
                >
                  Open in email
                </a>
              )}
              {drafting.customer?.phone && (
                <a
                  href={`https://wa.me/${drafting.customer.phone.replace(/\D/g, '')}?text=${encodeURIComponent(r.message(drafting))}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-hair px-5 py-2.5 font-semibold text-navy-900 hover:border-teal-500"
                >
                  Open in WhatsApp
                </a>
              )}
              <a href="/accounts/reminders" className="rounded-lg border border-hair px-5 py-2.5 font-semibold text-navy-900">
                Close
              </a>
            </div>
          </div>
        </Panel>
      )}

      <form className="no-print flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Stage</span>
          <select name="stage" defaultValue={searchParams.stage ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All</option>
            {Object.entries(STAGE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Customer</span>
          <select name="customer" defaultValue={searchParams.customer ?? ''} className="w-56 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All</option>
            {book.customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Filter</button>
        <a href="/accounts/reminders" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Reset</a>
        <div className="ml-auto">
          <ExportBar section="receivables" label="Receivables" />
        </div>
      </form>

      <Panel title={`${rows.length} to chase`} sub="Highest value first">
        {rows.length === 0 ? (
          <Empty>Nothing outstanding matches that filter.</Empty>
        ) : (
          <Table head={['Invoice', 'Date', 'Age', 'Customer', 'Contact', 'Total', 'Paid', 'Due', 'Stage', '']} right={[2, 5, 6, 7]}>
            {rows.map((x) => (
              <tr key={x.invoice.id} className="hover:bg-surface">
                <Td mono className="font-semibold text-navy-900">{x.invoice.no}</Td>
                <Td mono>{x.invoice.date}</Td>
                <Td right mono className={x.stage === 'escalate' ? 'font-bold text-red-700' : ''}>{x.age}d</Td>
                <Td>{x.customer?.name ?? x.invoice.customerId}</Td>
                <Td className="text-[12px] text-muted">
                  {x.customer?.phone}
                  {x.customer?.email && <div>{x.customer.email}</div>}
                </Td>
                <Td right mono>{money(x.totals.total, sym)}</Td>
                <Td right mono className="text-muted">
                  {money(x.totals.paid, sym)}
                  {x.lastPaid && <div className="text-[11px]">last {x.lastPaid}</div>}
                </Td>
                <Td right mono className="font-bold text-amber-700">{money(x.totals.due, sym)}</Td>
                <Td>
                  <span
                    className={`chip ${
                      x.stage === 'escalate'
                        ? 'border-red-600/30 bg-red-50 text-red-700'
                        : x.stage === 'chase'
                          ? 'border-amber-700/30 bg-amber-700/10 text-amber-700'
                          : 'border-hair bg-panel text-muted'
                    }`}
                  >
                    {STAGE_LABEL[x.stage]}
                  </span>
                </Td>
                <Td>
                  <a
                    href={`/accounts/reminders?show=${encodeURIComponent(x.invoice.id)}`}
                    className="whitespace-nowrap text-[12.5px] font-semibold text-teal-700 hover:underline"
                  >
                    Draft reminder →
                  </a>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
