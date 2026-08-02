import { Bar, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { expensesByCategory, getBook, LABEL, money } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function ExpensesPage({ searchParams }: { searchParams: { category?: string } }) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const byCat = expensesByCategory(book);
  const max = Math.max(...byCat.map((r) => r.amount), 1);
  const total = byCat.reduce((t, r) => t + r.amount, 0);

  let rows = [...book.expenses];
  if (searchParams.category) rows = rows.filter((e) => e.categoryId === searchParams.category);
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no));

  const cat = (id: string) => book.expenseCategories.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 6 · Expenses"
        title="Operating expenses"
        sub="Eight categories from the specification. Expenses reduce net profit but never touch gross margin — that stays a pure sale-minus-supplier-cost figure."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Total expenses" value={money(total, sym)} sub={`${book.expenses.length} entries`} tone="warn" />
        <Tile label="Categories in use" value={String(byCat.length)} sub={`of ${book.expenseCategories.length}`} />
        <Tile label="Largest category" value={byCat[0]?.category.name ?? '—'} sub={byCat[0] ? money(byCat[0].amount, sym) : ''} />
        <Tile label="Paid in cash" value={money(book.expenses.filter((e) => e.method === 'cash').reduce((t, e) => t + e.amount, 0), sym)} sub="Rest through bank" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By category" sub="Whole book">
          <div className="px-5 py-3">
            {byCat.map((r) => (
              <Bar key={r.category.id} value={r.amount} max={max} label={r.category.name} amount={money(r.amount, sym)} />
            ))}
          </div>
        </Panel>

        <Panel title="Filter" sub="Narrow the register below">
          <form className="flex flex-wrap items-end gap-3 px-5 py-5">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Category</span>
              <select name="category" defaultValue={searchParams.category ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
                <option value="">All categories</option>
                {book.expenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Apply</button>
            <a href="/accounts/expenses" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Reset</a>
          </form>
        </Panel>
      </div>

      <Panel title={`${rows.length} expense entries`} sub="Newest first">
        <Table head={['Voucher', 'Date', 'Category', 'Description', 'Method', 'Amount']} right={[5]}>
          {rows.slice(0, 60).map((e) => (
            <tr key={e.id} className="hover:bg-surface">
              <Td mono className="font-semibold text-navy-900">{e.no}</Td>
              <Td mono>{e.date}</Td>
              <Td>{cat(e.categoryId)}</Td>
              <Td className="text-muted">{e.description}</Td>
              <Td>
                {LABEL[e.method] ?? e.method}
                {e.bankId && <span className="ml-1 text-[11px] text-muted">· {book.banks.find((b) => b.id === e.bankId)?.name}</span>}
              </Td>
              <Td right mono className="font-semibold text-amber-700">{money(e.amount, sym)}</Td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
