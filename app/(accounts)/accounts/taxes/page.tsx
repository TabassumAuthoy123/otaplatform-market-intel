import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, money, moneyShort } from '@/lib/accounting';
import type { RouteBand } from '@/lib/contracts';
import { TAX_BASIS_LABEL, taxRules, whatIfTax } from '@/lib/taxrules';
import type { TaxBasis } from '@/lib/taxrules';

export const dynamic = 'force-dynamic';

/**
 * Tax rules, and what a rule change costs.
 *
 * The list is the record. The calculator is the half somebody opens on budget
 * night, because an excise band is announced as a number and the question is what
 * it costs across the volume the agency already flies.
 *
 * Both halves read and neither writes. A rule is entered in the admin portal, where
 * the edit is audited and the period lock applies.
 */
export default async function TaxesPage({
  searchParams
}: {
  searchParams: { basis?: string; pct?: string; fixed?: string; band?: string; service?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const rules = taxRules(book);
  const live = rules.filter((r) => r.active).length;

  const basis = (['fare', 'commission', 'service_charge', 'gross'].includes(searchParams.basis ?? '')
    ? searchParams.basis
    : 'fare') as TaxBasis;
  const band = (['any', 'domestic', 'saarc', 'international'].includes(searchParams.band ?? '')
    ? searchParams.band
    : 'any') as RouteBand;
  const pct = Math.max(0, Math.min(100, Number(searchParams.pct) || 0));
  const fixed = Math.max(0, Number(searchParams.fixed) || 0);
  const serviceIds = searchParams.service ? [searchParams.service] : [];
  const sim =
    pct > 0 || fixed > 0
      ? whatIfTax(book, { basis, ratePct: pct, fixedAmount: fixed, band, serviceIds })
      : null;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Compliance · Bangladesh"
        title="Tax rules"
        sub="Dated rules rather than one rate, so a rule change is a data edit with a date on it and last year keeps last year's treatment."
      />

      <div
        className={`rounded-lg border-l-[3px] px-5 py-4 ${
          live > 0 ? 'border-teal-600 bg-teal-600/5' : 'border-amber-700 bg-amber-700/5'
        }`}
      >
        <p className="text-[13px] font-semibold text-navy-900">
          {live > 0
            ? `${live} rule(s) in force.`
            : 'No tax rule is loaded. Each invoice still applies its own stored rate, so nothing already invoiced changes.'}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          A single rate on the company record could not express this market.{' '}
          <strong>Excise duty on an air ticket is a fixed amount banded by route</strong>, not a percentage, and the
          bands have been revised more than once — a rate-only field cannot state it at all.{' '}
          <strong>VAT on a travel agent&apos;s commission was waived</strong> by the NBR, so a product that assumes
          commission is VAT-able bills the customer wrongly. <strong>Hajj carries its own exemptions</strong> — airfare
          excise duty and VAT have both been waived for pilgrims, which is not an edge case given the Hajj volume here.
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          <strong>No rule is seeded.</strong> The bands and the amounts move, and a stale rate shipped inside a product
          is a wrong invoice that looks authoritative. The figures reported in the press are recorded in the README as
          reference, not loaded as data.
        </p>
      </div>

      <Panel
        title="Rules"
        sub={rules.length ? `${rules.length} recorded` : 'Add them in the admin portal — Records, then Tax rules'}
      >
        {rules.length === 0 ? (
          <Empty>
            No rules yet. Each one carries a code, what it is charged on, a rate or a fixed amount, an optional route
            band, the services it applies to or is exempt from, and the dates it runs between.
          </Empty>
        ) : (
          <Table
            head={['Code', 'Name', 'On', 'Rate', 'Fixed', 'Band', 'Exempt', 'From', 'To', 'WHT', 'Live']}
            right={[3, 4]}
          >
            {rules.map((r) => (
              <tr key={r.id} className="hover:bg-surface">
                <Td mono>{r.code}</Td>
                <Td>{r.name}</Td>
                <Td className="text-muted">{TAX_BASIS_LABEL[r.basis]}</Td>
                <Td right mono>{r.ratePct ? `${r.ratePct}%` : '—'}</Td>
                <Td right mono>{r.fixedAmount ? money(r.fixedAmount, sym) : '—'}</Td>
                <Td className="text-muted">{r.band}</Td>
                <Td className="text-muted">
                  {r.exemptServiceIds.length ? `${r.exemptServiceIds.length} service(s)` : '—'}
                </Td>
                <Td mono className="text-muted">{r.effectiveFrom}</Td>
                <Td mono className="text-muted">{r.effectiveTo || 'open'}</Td>
                <Td className="text-muted">{r.withholding ? 'yes' : '—'}</Td>
                <Td className={r.active ? 'font-semibold text-teal-700' : 'text-muted'}>{r.active ? 'yes' : 'no'}</Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="border-t border-hair px-5 py-3 text-[12px] leading-relaxed text-muted">
          A rule resolves against the <strong>invoice date</strong>, never today. One introduced in July does not appear
          on a June invoice, and one withdrawn in July still does — both fall out of the dates rather than needing to be
          remembered. The Hajj waiver is modelled as an <strong>exemption on a general rule</strong> rather than as a
          separate Hajj rule, so the waiver being withdrawn is one edit.
        </div>
      </Panel>

      <Panel title="What would a rule cost?" sub="Runs against what this book has already invoiced. Nothing is saved.">
        <form className="flex flex-wrap items-end gap-3 px-5 py-5">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Charged on</span>
            <select
              name="basis"
              defaultValue={basis}
              className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            >
              {(Object.keys(TAX_BASIS_LABEL) as TaxBasis[]).map((k) => (
                <option key={k} value={k}>{TAX_BASIS_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Rate %</span>
            <input
              name="pct"
              type="number"
              step="0.5"
              min="0"
              max="100"
              defaultValue={searchParams.pct ?? ''}
              placeholder="15"
              className="w-24 rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">or fixed / pax</span>
            <input
              name="fixed"
              type="number"
              step="100"
              min="0"
              defaultValue={searchParams.fixed ?? ''}
              placeholder="1000"
              className="w-28 rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Service</span>
            <select
              name="service"
              defaultValue={searchParams.service ?? ''}
              className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            >
              <option value="">Every service</option>
              {book.services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">
            Calculate
          </button>
        </form>

        {sim && (
          <div className="border-t border-hair px-5 py-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Tile
                label={
                  fixed > 0
                    ? `${money(fixed, sym)} per passenger`
                    : `${pct}% of ${TAX_BASIS_LABEL[basis].toLowerCase()}`
                }
                value={money(sim.amount, sym)}
                sub={`across ${sim.lines} line(s), ${sim.pax} passenger(s)`}
                tone="warn"
              />
              <Tile
                label="What it is charged on"
                value={moneyShort(sim.basisTotal, sym)}
                sub={TAX_BASIS_LABEL[basis]}
              />
              <Tile
                label="Per passenger, average"
                value={money(sim.pax ? Math.round(sim.amount / sim.pax) : 0, sym)}
                sub="what the passenger sees added"
              />
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
              A fixed amount is charged <strong>per passenger</strong> and a percentage on the basis for the line. That
              distinction is exactly what a rate-only field could not express, and it is how the excise duty actually
              works.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
