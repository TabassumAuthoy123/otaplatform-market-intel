import { PageHead, Panel, Table, Td } from '@/components/accounts/ui';
import { getBook } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const book = await getBook();
  const c = book.company;

  const rows: [string, string][] = [
    ['Company name', c.name],
    ['Trading as', c.tradingAs],
    ['Address', c.address],
    ['Phone', c.phone],
    ['Email', c.email],
    ['BIN / VAT registration', c.binVat || '— not set —'],
    ['Currency', `${c.currency} (${c.currencySymbol})`],
    ['VAT rate', `${c.vatRate}%`],
    ['Financial year starts', c.financialYearStart],
    ['Opening cash', `${c.currencySymbol}${c.openingCash.toLocaleString('en-IN')}`]
  ];

  const prefixes: [string, string][] = [
    ['Invoice prefix', c.invoicePrefix],
    ['Receipt prefix', c.receiptPrefix],
    ['Supplier bill prefix', c.billPrefix],
    ['Payment voucher prefix', c.paymentPrefix],
    ['Expense voucher prefix', c.expensePrefix]
  ];

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Modules 11 & 12 · Settings"
        title="Settings & roles"
        sub="Read-only here. Change these in the admin portal on :4001 — Accounting → Company."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Company information">
          <Table head={['Setting', 'Value']}>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title="Document numbering" sub="Applied when a voucher is created">
          <Table head={['Document', 'Prefix']}>
            {prefixes.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td mono>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>

      <Panel title="User roles" sub="Defined in the book. Enforcement is not built — see the honest limitations in README.md">
        <Table head={['Role', 'Intended access']}>
          {book.roles.map((r) => (
            <tr key={r.name}>
              <Td className="font-semibold text-navy-900">{r.name}</Td>
              <Td>{r.can}</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <div className="rounded-lg border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
        <p className="text-[13px] font-semibold text-navy-900">Roles are described, not enforced</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
          The six roles above come from the specification and are stored in the book, but this build has one admin login
          and no per-role permission checks. Anyone who can reach the admin portal can edit everything. That is fine for
          a local demo and is not fine for real users — it is listed in the README as outstanding work.
        </p>
      </div>
    </div>
  );
}
