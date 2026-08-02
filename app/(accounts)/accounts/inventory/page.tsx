import { PageHead, Panel, StatusChip, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, inventory, INVENTORY_KIND, money, moneyShort, supplierDeposits } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const inv = inventory(book);
  const dep = supplierDeposits(book);

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Stock control"
        title="Inventory & supplier float"
        sub="Blocks bought up front — Hajj seats, room nights, group fares, visa quota — and the money sitting with each supplier. Unsold stock is cash on a shelf with an expiry date on it."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Committed to stock" value={moneyShort(inv.totalCommitted, sym)} sub={`${inv.rows.length} blocks`} />
        <Tile label="Unsold at cost" value={moneyShort(inv.totalAtRisk, sym)} sub="Money not yet recovered" tone={inv.totalAtRisk > 0 ? 'warn' : 'good'} />
        <Tile label="Margin realised" value={moneyShort(inv.realised, sym)} sub="On units already sold" tone="good" />
        <Tile label="Margin still on the shelf" value={moneyShort(inv.potential, sym)} sub="If every remaining unit sells" />
      </div>

      {(inv.expiringSoon > 0 || inv.expired > 0) && (
        <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
          <p className="text-[13.5px] font-semibold text-navy-900">
            {inv.expired > 0 && `${inv.expired} block${inv.expired > 1 ? 's have' : ' has'} expired with stock left. `}
            {inv.expiringSoon > 0 && `${inv.expiringSoon} expiring within 30 days and more than a third unsold.`}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
            Discount it, move it to another departure, or negotiate the block back with the supplier — an expired
            seat is a total loss, not a markdown.
          </p>
        </div>
      )}

      <Panel title="Stock blocks" sub="Sorted by how much cash is still tied up in them">
        <Table
          head={['Block', 'Supplier', 'Bought', 'Sold', 'Left', 'Sell-through', 'Unit cost', 'Unit sell', 'Cash at risk', 'Expires', 'Status']}
          right={[2, 3, 4, 6, 7, 8]}
        >
          {inv.rows.map((r) => (
            <tr key={r.item.id} className="hover:bg-surface">
              <Td>
                <div className="font-semibold text-navy-900">{r.item.name}</div>
                <div className="mt-0.5 text-[11.5px] text-muted">{INVENTORY_KIND[r.item.kind] ?? r.item.kind}</div>
              </Td>
              <Td>{r.supplier}</Td>
              <Td right mono>{r.item.purchased}</Td>
              <Td right mono className="text-teal-700">{r.item.sold}</Td>
              <Td right mono className={r.remaining ? 'font-semibold text-amber-700' : 'text-muted'}>{r.remaining}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 rounded-full bg-panel">
                    <div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.max(2, r.soldPct)}%` }} />
                  </div>
                  <span className="tnum text-[11.5px] text-muted">{r.soldPct.toFixed(0)}%</span>
                </div>
              </Td>
              <Td right mono className="text-muted">{money(r.item.unitCost, sym)}</Td>
              <Td right mono>{money(r.item.unitSell, sym)}</Td>
              <Td right mono className={r.valueAtRisk ? 'font-semibold text-amber-700' : 'text-muted'}>{money(r.valueAtRisk, sym)}</Td>
              <Td mono className="whitespace-nowrap">
                {r.item.expiresOn}
                <div className={`text-[11px] ${r.daysLeft < 0 ? 'text-amber-700' : 'text-muted'}`}>
                  {r.daysLeft < 0 ? `${-r.daysLeft}d ago` : `${r.daysLeft}d left`}
                </div>
              </Td>
              <Td>
                <StatusChip value={r.expired ? 'cancelled' : r.atRisk ? 'partially_paid' : r.remaining === 0 ? 'paid' : 'confirmed'} />
              </Td>
            </tr>
          ))}
        </Table>
      </Panel>

      {/* ------------------------------------------------- supplier float */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Deposited with suppliers" value={money(dep.totalDeposited, sym)} sub={`${dep.deposits.length} advances`} />
        <Tile label="Unsettled bills against it" value={money(dep.totalOutstanding, sym)} sub="Drawn but not paid down" tone="warn" />
        <Tile label="Float still available" value={money(dep.totalAvailable, sym)} sub="What you can issue against tomorrow" tone={dep.totalAvailable >= 0 ? 'good' : 'bad'} />
      </div>

      <Panel
        title="Supplier float"
        sub="In travel this decides whether you can ticket tomorrow — the payable does not"
      >
        <Table head={['Supplier', 'Type', 'Deposited', 'Billed', 'Settled', 'Unsettled', 'Available float']} right={[2, 3, 4, 5, 6]}>
          {dep.rows.map((r) => (
            <tr key={r.supplier.id} className="hover:bg-surface">
              <Td className="font-semibold text-navy-900">{r.supplier.name}</Td>
              <Td className="text-muted">{r.supplier.type}</Td>
              <Td right mono>{money(r.deposited, sym)}</Td>
              <Td right mono className="text-muted">{money(r.billed, sym)}</Td>
              <Td right mono>{money(r.settled, sym)}</Td>
              <Td right mono className={r.outstandingBills ? 'text-amber-700' : 'text-muted'}>{money(r.outstandingBills, sym)}</Td>
              <Td right mono className={`font-semibold ${r.available >= 0 ? 'text-teal-700' : 'text-amber-700'}`}>
                {money(r.available, sym)}
              </Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel title="Deposit vouchers" sub="Every advance paid to a supplier, newest first">
        <Table head={['Voucher', 'Date', 'Supplier', 'Method', 'Reference', 'Amount']} right={[5]}>
          {dep.deposits.map((d) => (
            <tr key={d.id} className="hover:bg-surface">
              <Td mono className="font-semibold text-navy-900">{d.no}</Td>
              <Td mono>{d.date}</Td>
              <Td>{book.suppliers.find((s) => s.id === d.supplierId)?.name ?? d.supplierId}</Td>
              <Td>{d.method === 'cash' ? 'Cash' : 'Bank transfer'}</Td>
              <Td mono className="text-muted">{d.reference}</Td>
              <Td right mono className="font-semibold">{money(d.amount, sym)}</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <div className="rounded-xl2 border-l-[3px] border-teal-600 bg-teal-600/5 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink">
          <strong>Why a travel agency needs stock control.</strong> The inventory here is not boxes — it is seats,
          room nights and visa slots bought before anyone has paid for them. Sell-through and expiry are the two
          numbers that decide whether a Hajj block made money or lost it, and neither shows up anywhere in a normal
          profit and loss.
        </p>
      </div>
    </div>
  );
}
