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

        <Panel title={`Airlines (${book.airlines?.length ?? 0})`} sub="IATA and accounting codes, for ticket lines and BSP reconciliation">
          <Table head={['Airline', 'IATA', 'Accounting', 'Hub']}>
            {(book.airlines ?? []).map((a) => (
              <tr key={a.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{a.name}</Td>
                <Td mono>{a.iataCode}</Td>
                <Td mono className="text-muted">{a.accountingCode || '—'}</Td>
                <Td className="text-muted">{a.hub}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title={`Hotels (${book.hotels?.length ?? 0})`} sub="Properties that can appear on a hotel or package line">
          <Table head={['Hotel', 'City', 'Country', 'Stars', 'Segment']}>
            {(book.hotels ?? []).map((h) => (
              <tr key={h.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{h.name}</Td>
                <Td>{h.city}</Td>
                <Td className="text-muted">{h.country}</Td>
                <Td mono>{h.stars}</Td>
                <Td className="text-muted">{h.segment}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title={`Visa types (${book.visaTypes?.length ?? 0})`} sub="Category, validity, service fee and processing window">
          <Table head={['Visa', 'Category', 'Validity', 'Service fee', 'Processing']} right={[2, 3, 4]}>
            {(book.visaTypes ?? []).map((v) => (
              <tr key={v.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{v.name}</Td>
                <Td className="text-muted">{v.category}</Td>
                <Td right mono>{v.validityDays} d</Td>
                <Td right mono>{v.serviceFee ? money(Number(v.serviceFee), sym) : '—'}</Td>
                <Td right mono className="text-muted">{v.processingDays} d</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title={`Countries (${book.countries?.length ?? 0})`} sub="ISO code, local currency and dialling code">
          <Table head={['Country', 'ISO', 'Currency', 'Dial']}>
            {(book.countries ?? []).map((c) => (
              <tr key={c.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{c.name}</Td>
                <Td mono>{c.iso2}</Td>
                <Td mono className="text-muted">{c.currency}</Td>
                <Td mono className="text-muted">{c.dialCode}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel
          title={`Currencies (${book.currencies?.length ?? 0})`}
          sub="Rate to the base currency. A document copies the rate when it is raised, so changing one here never restates a past sale."
        >
          <Table head={['Currency', 'Code', 'Symbol', 'Rate to base', '']} right={[3]}>
            {(book.currencies ?? []).map((c) => (
              <tr key={c.id} className="hover:bg-surface">
                <Td className="font-semibold text-navy-900">{c.name}</Td>
                <Td mono>{c.code}</Td>
                <Td mono>{c.symbol}</Td>
                <Td right mono>{c.rateToBase.toLocaleString('en-IN')}</Td>
                <Td>{c.isBase ? <span className="chip border-teal-600/30 bg-teal-600/10 text-teal-700">Base</span> : null}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
    </div>
  );
}
