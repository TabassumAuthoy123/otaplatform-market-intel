import { PageHead, Panel, Table, Td } from '@/components/accounts/ui';
import { customerLedger, getBook, LABEL, money, supplierLedger } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function MastersPage() {
  const book = await getBook();
  const sym = book.company.currencySymbol;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 10 · Masters"
        title="Master data"
        sub="Read-only here. Add and edit these from the admin portal on :4001 — Accounting → Masters."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Customers (${book.customers.length})`} sub="Balance is the live ledger closing figure">
          <Table head={['Name', 'Type', 'Phone', 'Balance']} right={[3]}>
            {book.customers.map((c) => {
              const l = customerLedger(book, c.id);
              const bal = l.length ? l[l.length - 1].balance : c.openingBalance;
              return (
                <tr key={c.id} className="hover:bg-surface">
                  <Td className="font-semibold text-navy-900">{c.name}</Td>
                  <Td>{LABEL[c.type] ?? c.type}</Td>
                  <Td mono className="text-muted">{c.phone || '—'}</Td>
                  <Td right mono className={bal > 0 ? 'font-semibold text-amber-700' : 'text-muted'}>{money(bal, sym)}</Td>
                </tr>
              );
            })}
          </Table>
        </Panel>

        <Panel title={`Suppliers (${book.suppliers.length})`} sub="Positive balance means we still owe them">
          <Table head={['Name', 'Type', 'Balance']} right={[2]}>
            {book.suppliers.map((s) => {
              const l = supplierLedger(book, s.id);
              const bal = l.length ? l[l.length - 1].balance : s.openingBalance;
              return (
                <tr key={s.id} className="hover:bg-surface">
                  <Td className="font-semibold text-navy-900">{s.name}</Td>
                  <Td>{LABEL[s.type] ?? s.type}</Td>
                  <Td right mono className={bal > 0 ? 'font-semibold text-amber-700' : 'text-muted'}>{money(bal, sym)}</Td>
                </tr>
              );
            })}
          </Table>
        </Panel>

        <Panel title={`Services (${book.services.length})`} sub="What can appear on an invoice line">
          <Table head={['Service', 'Category']}>
            {book.services.map((s) => (
              <tr key={s.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{s.name}</Td>
                <Td>{LABEL[s.category] ?? s.category}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title={`Banks (${book.banks.length})`} sub="MFS wallets are modelled as bank accounts">
          <Table head={['Account', 'Number', 'Branch', 'Opening']} right={[3]}>
            {book.banks.map((b) => (
              <tr key={b.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{b.name}</Td>
                <Td mono className="text-muted">{b.accountNo}</Td>
                <Td>{b.branch}</Td>
                <Td right mono>{money(b.openingBalance, sym)}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title={`Expense categories (${book.expenseCategories.length})`}>
          <Table head={['Category']}>
            {book.expenseCategories.map((c) => (
              <tr key={c.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{c.name}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title={`Employees (${book.employees.length})`}>
          <Table head={['Name', 'Role']}>
            {book.employees.map((e) => (
              <tr key={e.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{e.name}</Td>
                <Td>{e.role}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
    </div>
  );
}
