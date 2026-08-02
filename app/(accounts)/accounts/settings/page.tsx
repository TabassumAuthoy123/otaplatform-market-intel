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
    ['Credit note prefix', c.creditNotePrefix],
    ['Supplier bill prefix', c.billPrefix],
    ['Supplier credit prefix', c.supplierCreditPrefix],
    ['Payment voucher prefix', c.paymentPrefix],
    ['Expense voucher prefix', c.expensePrefix],
    ['Transfer voucher prefix', c.transferPrefix]
  ];

  const onOff = (v: number) => (v ? 'On' : 'Off');

  const tax: [string, string][] = [
    ['VAT applied to new invoices', onOff(c.vat?.enabled ?? 0)],
    ['Default rate', `${c.vat?.defaultRate ?? 0}%`],
    ['VAT registration number', c.vat?.registrationNo || '— not set —'],
    ['Existing invoices', 'Keep the rate stored on them. Changing the default never restates a past sale.']
  ];

  const currency: [string, string][] = [
    ['Base currency', `${c.currencySettings?.baseCurrency ?? c.currency} (${c.currencySettings?.symbol ?? c.currencySymbol})`],
    ['Decimals shown', String(c.currencySettings?.decimals ?? 0)],
    ['Currencies configured', `${book.currencies?.length ?? 0} in the Currencies master`],
    ['How rates are used', 'Copied onto a document when it is raised, so a later rate change cannot restate it.']
  ];

  const email: [string, string][] = [
    ['Sending', onOff(c.smtp?.enabled ?? 0)],
    ['From', `${c.smtp?.fromName ?? ''} ${c.smtp?.fromAddress ? `<${c.smtp.fromAddress}>` : '— not set —'}`],
    ['SMTP host', c.smtp?.smtpHost || '— not set —'],
    ['SMTP port', String(c.smtp?.smtpPort ?? '')],
    ['SMTP user', c.smtp?.smtpUser || '— not set —'],
    ['Password', 'Never stored in this file. It lives in the SMTP_PASSWORD environment variable.']
  ];

  const messaging: [string, string][] = [
    ['SMS', onOff(c.messaging?.smsEnabled ?? 0)],
    ['SMS sender id', c.messaging?.smsSenderId || '— not set —'],
    ['SMS provider', c.messaging?.smsProvider || '— not set —'],
    ['WhatsApp', onOff(c.messaging?.whatsappEnabled ?? 0)],
    ['WhatsApp number', c.messaging?.whatsappNumber || '— not set —'],
    ['API keys', 'In the environment: SMS_API_KEY and WHATSAPP_TOKEN. Not in this file — it is committed to git.']
  ];

  const reminders: [string, string][] = [
    ['Payment terms', `${c.reminders?.dueAfterDays ?? 14} days`],
    ['Escalate after', `${c.reminders?.escalateAfterDays ?? 30} days`],
    ['Only chase from', `${c.currencySymbol}${(c.reminders?.chaseFrom ?? 0).toLocaleString('en-IN')}`]
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

        <Panel title="Tax & VAT" sub="Applies to invoices raised from now on">
          <Table head={['Setting', 'Value']}>
            {tax.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title="Currency" sub="What the book is kept in, and how foreign documents are converted">
          <Table head={['Setting', 'Value']}>
            {currency.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title="Email" sub="Used for statements and reminders once a mail server is configured">
          <Table head={['Setting', 'Value']}>
            {email.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title="SMS & WhatsApp" sub="Channels for payment reminders">
          <Table head={['Setting', 'Value']}>
            {messaging.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title="Payment reminders" sub="The terms the chase list on /accounts/reminders works to">
          <Table head={['Setting', 'Value']}>
            {reminders.map(([k, v]) => (
              <tr key={k}>
                <Td className="font-semibold text-navy-900">{k}</Td>
                <Td>{v}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>

      <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
        <p className="text-[13px] font-semibold text-navy-900">Nothing here sends anything yet</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
          The email and messaging blocks are configuration, not a working transport. No mail server or SMS gateway
          is wired up on this machine, so <span className="font-semibold">no reminder is ever delivered
          automatically</span>. The reminders screen generates the message text and hands it to you to send. That is
          deliberate: a system that reports having chased a customer it never contacted is worse than one that
          admits it did nothing.
        </p>
      </div>

      <Panel title="User roles" sub="Six roles, checked on every admin request before any handler runs">
        <Table head={['Role', 'Intended access']}>
          {book.roles.map((r) => (
            <tr key={r.name}>
              <Td className="font-semibold text-navy-900">{r.name}</Td>
              <Td>{r.can}</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <div className="rounded-lg border-l-[3px] border-teal-600 bg-teal-600/5 px-5 py-4">
        <p className="text-[13px] font-semibold text-navy-900">Roles are enforced, and managed from the admin portal</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
          Each of the six roles above maps to a set of capabilities in the admin portal, checked on every request
          before any handler runs — so hiding a menu item is a convenience and the route guard is the actual control.
          A Sales Executive can raise an invoice and a receipt but is refused on a supplier bill; Read Only can open
          every screen and is refused on every write. Add users and set roles at{' '}
          <span className="font-semibold text-navy-900">localhost:4001/users</span>. The last Super Admin cannot be
          demoted or deleted, so the portal can never lock everyone out.
        </p>
      </div>
    </div>
  );
}
