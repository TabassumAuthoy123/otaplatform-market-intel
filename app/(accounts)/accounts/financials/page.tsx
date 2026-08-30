import { ExportBar } from '@/components/accounts/ExportBar';
import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import {
  balanceSheet, cashFlow, getBook, journalTrialBalance, money, profitAndLoss,
  plAgreesWithLedger, reconciliation, trialBalance
} from '@/lib/accounting';

export const dynamic = 'force-dynamic';

/**
 * The four statements a company gets asked for, plus the check that says
 * whether to believe them.
 *
 * The reconciliation panel is the reason this page is worth reading. Every
 * figure above it is derived twice from the same vouchers by two independent
 * routes — control accounts for the dashboards, journal postings for the
 * ledger — and the panel puts them side by side. If they ever disagree the
 * page says so in red rather than quietly showing whichever one loaded first.
 */
export default async function FinancialsPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string };
}) {
  const from = searchParams.from || undefined;
  const to = searchParams.to || undefined;

  const book = await getBook();
  const sym = book.company.currencySymbol;

  const bs = balanceSheet(book, to);
  const cf = cashFlow(book, from, to);
  const pl = profitAndLoss(book, from, to);
  const tb = trialBalance(book);
  const jtb = journalTrialBalance(book, to);
  const recon = reconciliation(book);
  const bridge = plAgreesWithLedger(book, from, to);

  const period = from || to ? `${from ?? 'start'} to ${to ?? 'today'}` : 'Whole book';

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 9 · Statements"
        title="Financial statements"
        sub="Balance sheet, cash flow and profit & loss, built from the journal. Nothing here is stored — the postings are re-derived from the vouchers on every page load."
      />

      <form className="no-print flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">From</span>
          <input type="date" name="from" defaultValue={from ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">To</span>
          <input type="date" name="to" defaultValue={to ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Apply</button>
        <a href="/accounts/financials" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Whole book</a>
        <div className="ml-auto">
          <ExportBar from={from} to={to} label="Download" />
        </div>
      </form>

      {/* --------------------------------------------------- the integrity check */}
      <Panel
        title={recon.clean ? 'Reconciliation — clean' : 'Reconciliation — MISMATCH'}
        sub="Control accounts and journal postings are two independent derivations of the same vouchers. Every difference must be zero."
      >
        <div
          className={`border-l-[3px] px-5 py-3 text-[13px] font-semibold ${
            recon.clean ? 'border-teal-600 bg-teal-600/5 text-teal-800' : 'border-red-600 bg-red-50 text-red-800'
          }`}
        >
          {recon.clean
            ? 'Every control account agrees with the ledger once manual vouchers are allowed for, and both trial balances balance. The statements below can be relied on.'
            : 'At least one control account disagrees with the ledger. A figure on this page contradicts a figure elsewhere in the app — do not file anything from it until the row below is explained.'}
        </div>
        <Table head={['Account', 'Control total', 'Manual adj.', 'Ledger balance', 'Difference']} right={[1, 2, 3, 4]}>
          {recon.checks.map((c) => (
            <tr key={c.name} className="hover:bg-surface">
              <Td>{c.name}</Td>
              <Td right mono>{money(c.control, sym)}</Td>
              {/*
                Muted at zero so the eye skips it, coloured when it is not — a manual
                adjustment is the one figure here that moved because somebody decided
                it should, and it should read differently from the derived ones.
              */}
              <Td right mono className={c.adjustment === 0 ? 'text-muted' : 'font-semibold text-amber-700'}>
                {money(c.adjustment, sym)}
              </Td>
              <Td right mono>{money(c.ledger, sym)}</Td>
              <Td right mono className={c.difference === 0 ? 'text-muted' : 'font-bold text-red-700'}>
                {money(c.difference, sym)}
              </Td>
            </tr>
          ))}
          <tr className="border-t border-hair bg-panel">
            <Td className="font-semibold">Trial balance — control basis</Td>
            <Td right mono>{money(tb.totalDebit, sym)}</Td>
            <Td />
            <Td right mono>{money(tb.totalCredit, sym)}</Td>
            <Td right mono className={tb.difference === 0 ? 'text-muted' : 'font-bold text-red-700'}>
              {money(tb.difference, sym)}
            </Td>
          </tr>
          <tr className="bg-panel">
            <Td className="font-semibold">Trial balance — journal basis</Td>
            <Td right mono>{money(jtb.totalDebit, sym)}</Td>
            <Td />
            <Td right mono>{money(jtb.totalCredit, sym)}</Td>
            <Td right mono className={jtb.difference === 0 ? 'text-muted' : 'font-bold text-red-700'}>
              {money(jtb.difference, sym)}
            </Td>
          </tr>
        </Table>
      </Panel>

      {/* -------------------------------------------------- the reconciling items */}

      {/*
        Rendered only when there are any, but never summarised away when there are.

        The adjustment column above is the one figure on this page that moved because
        a person decided it should rather than because a document exists. Netting it
        into a total and leaving it there would make the single number an auditor most
        wants itemised the only one that is not.
      */}
      {recon.adjustments.length > 0 && (
        <Panel
          title="Manual vouchers behind the adjustment column"
          sub={`${recon.adjustments.length} posting(s) on accounts the reconciliation cross-checks — these are the reconciling items, not a separate ledger`}
        >
          <Table head={['Voucher', 'Date', 'Account', 'Effect on balance', 'Posted by', 'Narration']} right={[3]}>
            {recon.adjustments.map((a, i) => (
              <tr key={`${a.no}-${a.account}-${i}`} className="hover:bg-surface">
                {/*
                  Plain text, not a ModuleLink. ModuleLink renders nothing when its
                  target is switched off, which is right for a "Full battlecards →"
                  call to action and wrong here: the voucher number is the identifier
                  of the row. An installation without the journal module would get a
                  blank first column and no way to say which voucher this is.
                */}
                <Td mono>{a.no}</Td>
                <Td mono>{a.date}</Td>
                <Td>{a.accountName}</Td>
                <Td right mono className="font-semibold text-amber-700">{money(a.amount, sym)}</Td>
                <Td className="text-muted">{a.createdBy}</Td>
                <Td>{a.narration}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      {/* ------------------------------------- the P&L against the ledger */}

      {/*
        A third cross-check, and it is on the page because the first version of it was
        not — an uncalled check is not a check, and this one carried an arithmetic error
        for a day precisely because nothing rendered its answer.

        It asks what reconciliation() above cannot: does the bottom line of the P&L match
        income less expense in the journal the balance sheet is built from? Those two
        statements disagreed by ৳67,700 for a while, both looking perfectly healthy,
        because no check compared them.
      */}
      <Panel
        title="The P&L against the ledger"
        sub="The reconciliation above compares ten control accounts. This compares the bottom line of the profit and loss with income less expense in the journal — which is what the balance sheet's retained earnings is built from."
      >
        <div className="px-5 py-4 text-[13px] leading-relaxed">
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Fig label="P&L net profit" value={money(bridge.plNetProfit, sym)} />
            <Fig label="Ledger income less expense" value={money(bridge.ledgerProfit, sym)} />
            <Fig label="Difference" value={money(bridge.difference, sym)} tone={bridge.difference === 0 ? 'good' : 'bad'} />
            {/*
              Reported, never subtracted. It used to be an explanatory bucket the
              difference was netted against, and a bucket is somewhere a real misstatement
              can sit and still read clean — so the check answered a weaker question than
              its own name. Supplier bills on unissued invoices are capitalised at source
              now, so there is nothing legitimate left to explain and `difference` IS the
              answer.
            */}
            <Fig
              label="Capitalised — invoices still in draft"
              value={money(bridge.wipTotal, sym)}
              tone="plain"
            />
            <Fig
              label="In cost of sales but unrecognised"
              value={money(bridge.unbilledOnPurchases, sym)}
              tone={bridge.unbilledOnPurchases === 0 ? 'good' : 'bad'}
            />
          </div>
          <p className={`mt-4 ${bridge.unexplained === 0 ? 'text-muted' : 'font-semibold text-red-700'}`}>
            {bridge.detail}
          </p>
          {bridge.wipBills.length > 0 && (
            <div className="mt-4">
              <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
                What is capitalised — {bridge.wipBills.length} bills against invoices still in draft
              </p>
              <Table head={['Bill', 'Against invoice', 'Amount']} right={[2]}>
                {bridge.wipBills.map((b: { no: string; invoiceRef: string; amount: number }) => (
                  <tr key={b.no} className="hover:bg-surface">
                    <Td mono>{b.no}</Td>
                    <Td mono className="text-muted">{b.invoiceRef}</Td>
                    <Td right mono>{money(b.amount, sym)}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </div>
      </Panel>

      {/* ---------------------------------------------------------- balance sheet */}
      <Panel
        title="Balance sheet"
        sub={`As at ${to ?? 'today'} — retained earnings is income less expenses out of the same journal, not a stored figure, which is why the two sides meet without a plug`}
      >
        <div className="grid gap-0 lg:grid-cols-2">
          <div className="border-b border-hair p-5 lg:border-b-0 lg:border-r">
            <h3 className="mb-3 text-[12px] font-bold uppercase tracking-wide text-muted">Assets</h3>
            {bs.assets.map((r) => (
              <Line key={r.name} label={r.name} value={money(r.amount, sym)} negative={r.amount < 0} />
            ))}
            <div className="my-3 border-t-2 border-navy-900" />
            <Line label="Total assets" value={money(bs.totalAssets, sym)} bold />
          </div>
          <div className="p-5">
            <h3 className="mb-3 text-[12px] font-bold uppercase tracking-wide text-muted">Liabilities</h3>
            {bs.liabilities.map((r) => (
              <Line key={r.name} label={r.name} value={money(r.amount, sym)} />
            ))}
            <Line label="Total liabilities" value={money(bs.totalLiabilities, sym)} bold />

            <h3 className="mb-3 mt-6 text-[12px] font-bold uppercase tracking-wide text-muted">Equity</h3>
            {bs.equity.map((r) => (
              <Line key={r.name} label={r.name} value={money(r.amount, sym)} negative={r.amount < 0} />
            ))}
            <Line label="Total equity" value={money(bs.totalEquity, sym)} bold />

            <div className="my-3 border-t-2 border-navy-900" />
            <Line label="Liabilities and equity" value={money(bs.totalLiabilities + bs.totalEquity, sym)} bold />
            <Line
              label="Difference — must be zero"
              value={money(bs.difference, sym)}
              bold
              negative={bs.difference !== 0}
            />
          </div>
        </div>
      </Panel>

      {/* --------------------------------------------------------------- cash flow */}
      <Panel title="Cash flow" sub={`${period} · direct method, cash and every bank account together. Transfers between them are excluded — banking the day's takings is not cash generated.`}>
        <div className="grid gap-3 border-b border-hair p-5 sm:grid-cols-4">
          <Tile label="Funds at start" value={money(cf.opening, sym)} />
          <Tile label="From operations" value={money(cf.netOperating, sym)} tone={cf.netOperating >= 0 ? 'good' : 'warn'} />
          <Tile label="From investing" value={money(cf.netInvesting, sym)} tone={cf.netInvesting >= 0 ? 'good' : 'warn'} />
          <Tile label="Funds at close" value={money(cf.closing, sym)} tone={cf.closing >= 0 ? 'good' : 'warn'} />
        </div>
        <Table head={['Section', 'Line', 'Amount']} right={[2]}>
          {cf.operating.map((r) => (
            <tr key={r.name} className="hover:bg-surface">
              <Td className="text-muted">Operating</Td>
              <Td>{r.name}</Td>
              <Td right mono className={r.amount < 0 ? 'text-amber-700' : 'text-teal-700'}>{money(r.amount, sym)}</Td>
            </tr>
          ))}
          <tr className="bg-panel">
            <Td className="text-muted">Operating</Td>
            <Td className="font-semibold">Net cash from operations</Td>
            <Td right mono className="font-bold">{money(cf.netOperating, sym)}</Td>
          </tr>
          {cf.investing.map((r) => (
            <tr key={r.name} className="hover:bg-surface">
              <Td className="text-muted">Investing</Td>
              <Td>{r.name}</Td>
              <Td right mono className={r.amount < 0 ? 'text-amber-700' : 'text-teal-700'}>{money(r.amount, sym)}</Td>
            </tr>
          ))}
          <tr className="bg-panel">
            <Td className="text-muted">Investing</Td>
            <Td className="font-semibold">Net cash from investing</Td>
            <Td right mono className="font-bold">{money(cf.netInvesting, sym)}</Td>
          </tr>
          <tr className="border-t-2 border-navy-900">
            <Td />
            <Td className="font-bold text-navy-900">Net movement</Td>
            <Td right mono className="font-bold">{money(cf.movement, sym)}</Td>
          </tr>
        </Table>
      </Panel>

      {/* ---------------------------------------------------------- profit & loss */}
      <Panel title="Profit & loss" sub={period}>
        <div className="p-5">
          <Line label="Gross sales" value={money(pl.grossRevenue, sym)} />
          <Line label="Less: credit notes and cancellations" value={`− ${money(pl.creditNotes, sym)}`} muted />
          <div className="my-2 border-t border-hair" />
          <Line label="Net revenue" value={money(pl.revenue, sym)} bold />
          <Line label="Less: cost of sales" value={`− ${money(pl.costOfSales, sym)}`} muted />
          {pl.supplierRefunds > 0 && (
            <Line label="  of which recovered from suppliers" value={money(pl.supplierRefunds, sym)} muted />
          )}
          <div className="my-3 border-t border-hair" />
          <Line label="Gross profit" value={money(pl.grossProfit, sym)} bold accent />
          <Line label="Gross margin" value={`${pl.grossMarginPct.toFixed(2)}%`} muted />
          <div className="my-3 border-t border-hair" />
          {pl.expenseRows.map((r) => (
            <Line key={r.category.id} label={r.category.name} value={`− ${money(r.amount, sym)}`} muted />
          ))}
          <Line label="Total operating expenses" value={`− ${money(pl.totalExpenses, sym)}`} />
          {/*
            Journal-only income and expense, listed rather than merged into the categories
            above.

            An expense voucher was raised against a document; a journal line exists because
            somebody decided it should. They are different kinds of fact and an accountant
            reading this should be able to tell them apart without opening the ledger.

            Before this existed the P&L simply ignored them — depreciation, an accrued
            rent and a counter shortage totalling ৳67,700 were in the ledger and nowhere on
            this page, while the balance sheet below derived retained earnings from the
            same journal and therefore disagreed about profit by exactly that much.
          */}
          {pl.journalRows.length > 0 && (
            <>
              <div className="my-3 border-t border-hair" />
              {pl.journalRows.map((r) => (
                <Line
                  key={r.account.code}
                  label={`Journal — ${r.account.name}`}
                  value={r.account.group === 'income' ? money(r.balance, sym) : `− ${money(r.balance, sym)}`}
                  muted
                />
              ))}
              <Line label="Net of journal adjustments" value={money(pl.journalNet, sym)} />
            </>
          )}
          {/*
            Airline memos on their own line rather than inside operating expenses.
            An ADM measures the agency's own error rate — a fare underpriced, a
            commission claimed that was not earned — and burying it beside the
            electricity bill hides the one cost worth watching. Shown only when
            there is one, so a clean book does not carry a permanent zero.
          */}
          {pl.memoCost !== 0 && (
            <Line
              label="Airline debit memos, net of credits"
              value={`− ${money(pl.memoCost, sym)}`}
            />
          )}
          <div className="my-3 border-t-2 border-navy-900" />
          <Line label="Net profit" value={money(pl.netProfit, sym)} bold accent />
          <Line label="Net margin" value={`${pl.netMarginPct.toFixed(2)}%`} muted />
        </div>
      </Panel>

      {bs.assets.length === 0 && <Empty>No postings yet.</Empty>}
    </div>
  );
}

function Line({
  label, value, bold, muted, accent, negative
}: {
  label: string; value: string; bold?: boolean; muted?: boolean; accent?: boolean; negative?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className={`text-[13.5px] ${muted ? 'text-muted' : 'text-ink'} ${bold ? 'font-semibold text-navy-900' : ''}`}>
        {label}
      </span>
      <span
        className={`tnum text-[13.5px] ${bold ? 'font-bold' : ''} ${
          negative ? 'text-red-700' : accent ? 'text-teal-700' : bold ? 'text-navy-900' : 'text-ink'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** One labelled figure in the bridge panel. */
function Fig({ label, value, tone = 'plain' }: { label: string; value: string; tone?: 'plain' | 'good' | 'warn' | 'bad' }) {
  const colour =
    tone === 'good' ? 'text-teal-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-navy-900';
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum text-[15px] font-semibold ${colour}`}>{value}</div>
    </div>
  );
}
