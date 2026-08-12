import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, money, moneyShort } from '@/lib/accounting';
import { carriersSold, contracts, whatIf } from '@/lib/contracts';

export const dynamic = 'force-dynamic';

/**
 * Carrier commission contracts, and what a rate would be worth.
 *
 * The list is the boring half. The calculator is the half an agency owner will
 * actually open, because the question before a negotiation is not "what is our
 * rate" but "what is 3% worth on what we already fly" — and answering that in a
 * spreadsheet is how a rate gets agreed that turns out to be worth less than the
 * volume commitment attached to it.
 *
 * It computes and writes nothing. The rate arrives as a query parameter so a
 * reload re-runs the same sum rather than saving anything, and the page says so.
 */
export default async function ContractsPage({
  searchParams
}: {
  searchParams: { carrier?: string; pct?: string; basis?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const rows = contracts(book);
  const carriers = carriersSold(book);

  const carrier = searchParams.carrier || carriers[0]?.carrier || '*';
  const pct = Math.max(0, Math.min(30, Number(searchParams.pct) || 0));
  const basis = searchParams.basis === 'gross' ? 'gross' : 'base';
  const sim = pct > 0 ? whatIf(book, carrier, pct, basis) : null;

  const live = rows.filter((c) => c.active).length;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Suppliers · commission"
        title="Carrier contracts"
        sub="What each airline allows on a fare, and what it is worth. Commission reduces what is remitted, so it lands in margin rather than in a revenue account."
      />

      {/*
        The state of the book stated before anything else, because it explains a
        margin figure people will otherwise think is broken.
      */}
      <div
        className={`rounded-lg border-l-[3px] px-5 py-4 ${
          live > 0 ? 'border-teal-600 bg-teal-600/5' : 'border-amber-700 bg-amber-700/5'
        }`}
      >
        <p className="text-[13px] font-semibold text-navy-900">
          {live > 0
            ? `${live} contract(s) in force.`
            : 'No carrier contract is loaded, so no commission is being earned in this book.'}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Every fare the GDS quotes comes back with no commission on it, because the commission lives in a contract
          rather than in the fare. Until a real one is entered, <code className="rounded bg-panel px-1 py-0.5">commissionAmt</code>{' '}
          stays <strong>null</strong> — unknown, not zero, because zero is a claim that the airline allowed nothing —
          and margin is the agency service charge alone. <strong>No rate is seeded.</strong> A fabricated one would put
          money into the margin report and the P&amp;L, which is worse than a fabricated ticket number: that one only
          fails to reconcile.
        </p>
      </div>

      <Panel
        title="Contracts"
        sub={rows.length ? `${rows.length} recorded` : 'Add them in the admin portal — Records → Carrier contracts'}
      >
        {rows.length === 0 ? (
          <Empty>
            No contracts yet. Add one per carrier with its rate and the dates it runs between — a contract resolves
            against the document&apos;s <strong>issue date</strong>, so a rate renegotiated in September will not
            restate August&apos;s tickets.
          </Empty>
        ) : (
          <Table
            head={['Carrier', 'Contract', 'Rate', 'Flat', 'Basis', 'Band', 'From', 'To', 'Cap', 'PLB', 'Live']}
            right={[2, 3, 8, 9]}
          >
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-surface">
                <Td mono>{c.carrier}</Td>
                <Td>{c.name}</Td>
                <Td right mono>{c.commissionPct ? `${c.commissionPct}%` : '—'}</Td>
                <Td right mono>{c.flatAmount ? money(c.flatAmount, sym) : '—'}</Td>
                <Td className="text-muted">{c.basis === 'gross' ? 'fare + tax' : 'base fare'}</Td>
                <Td className="text-muted">{c.band}</Td>
                <Td mono className="text-muted">{c.effectiveFrom}</Td>
                <Td mono className="text-muted">{c.effectiveTo || 'open'}</Td>
                <Td right mono className="text-muted">{c.capPerDocument ? money(c.capPerDocument, sym) : '—'}</Td>
                <Td right mono className="text-muted">{c.incentivePct ? `${c.incentivePct}%` : '—'}</Td>
                <Td className={c.active ? 'font-semibold text-teal-700' : 'text-muted'}>{c.active ? 'yes' : 'no'}</Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="border-t border-hair px-5 py-3 text-[12px] leading-relaxed text-muted">
          A <strong>PLB</strong> is recorded but never applied per ticket. It settles quarterly against total
          production, so attributing a slice of it to each sale would report money that has not been earned and may
          never be.
        </div>
      </Panel>

      {/* ------------------------------------------------------- the calculator */}
      <Panel
        title="What would a rate be worth?"
        sub="Runs against what this book has already sold. Nothing is saved."
      >
        <form className="flex flex-wrap items-end gap-3 px-5 py-5">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Carrier</span>
            <select
              name="carrier"
              defaultValue={carrier}
              className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            >
              <option value="*">Every carrier</option>
              {carriers.map((c) => (
                <option key={c.carrier} value={c.carrier}>
                  {c.carrier} — {c.documents} document(s)
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Rate %</span>
            <input
              name="pct"
              type="number"
              step="0.25"
              min="0"
              max="30"
              defaultValue={searchParams.pct ?? ''}
              placeholder="3"
              className="w-24 rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">On</span>
            <select
              name="basis"
              defaultValue={basis}
              className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            >
              <option value="base">Base fare</option>
              <option value="gross">Fare + tax</option>
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
                label={`${pct}% on ${basis === 'gross' ? 'fare + tax' : 'base fare'}`}
                value={money(sim.commission, sym)}
                sub={`across ${sim.documents} document(s)`}
                tone="good"
              />
              <Tile label="Fare volume it applies to" value={moneyShort(sim.fareBase, sym)} sub={carrier === '*' ? 'every carrier' : carrier} />
              <Tile
                label="Documents it cannot cover"
                value={String(sim.unpriced)}
                sub="no fare split recorded, so they contribute nothing"
                tone={sim.unpriced > 0 ? 'warn' : 'good'}
              />
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
              Computed from the fare breakdowns actually on the book. The {sim.unpriced} document(s) without one are
              named rather than dropped — they are the migrated ones whose split was never recorded, and a figure
              quoted at an airline should not silently exclude them.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
