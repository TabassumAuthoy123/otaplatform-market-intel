import { NextResponse } from 'next/server';
import {
  allBankBalances, balanceSheet, billBase, billDue, billPaid, cashBook, cashFlow, creditNoteReport, expensesByCategory,
  generalLedger, getBook, inventory, invoiceTotals, isRefunded, journal, journalTrialBalance, LABEL,
  payables, profitAndLoss, receivables, reconciliation, salesByService, summarise, supplierDeposits,
  trialBalance, type Book
} from '@/lib/accounting';
import { todayIn } from '@/lib/clock';

/**
 * Downloadable exports of the accounting book.
 *
 *   /api/accounts/export?format=xlsx   Excel workbook, one sheet per ledger
 *   /api/accounts/export?format=docx   Word management accounts pack
 *   /api/accounts/export?format=md     Markdown, same figures
 *   /api/accounts/export?format=csv    one section, flat, with a UTF-8 BOM
 *
 * `from` and `to` narrow the period. They filter the vouchers and every
 * period figure derived from them; balances that are true only at a point in
 * time — receivables, payables, bank closings, the trial balance — are always
 * as at today and labelled that way, because a receivable "for March" is not a
 * thing and pretending otherwise is how a reconciliation goes wrong.
 *
 * Nothing here is stored. Every number is derived from content/accounting.json
 * at the moment of the request, so an export can never disagree with the
 * screen it was downloaded from.
 */

export const dynamic = 'force-dynamic';

type Row = (string | number)[];
type Sheet = { name: string; title: string; head: string[]; widths: number[]; rows: Row[]; note?: string };

const stamp = (book?: Book) => todayIn(book?.company.timezone).replace(/-/g, '');
const n0 = (v: number) => Math.round(v);
const pct = (v: number) => `${v.toFixed(1)}%`;

/* ---------------------------------------------------------------- sections */

/**
 * Every ledger, built once and shared by all four formats so a figure cannot
 * differ between the Excel and the Word version of the same download.
 */
function buildSheets(book: Book, from?: string, to?: string): Sheet[] {
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
  const notes = book.creditNotes ?? [];
  const s = summarise(book, from, to);
  const pl = profitAndLoss(book, from, to);
  const tb = trialBalance(book);
  const ar = receivables(book);
  const ap = payables(book);
  const cash = cashBook(book, from, to);
  const banks = allBankBalances(book);
  const cn = creditNoteReport(book);
  const inv = inventory(book);
  const dep = supplierDeposits(book);
  const bs = balanceSheet(book);
  const cf = cashFlow(book, from, to);
  const gl = generalLedger(book, undefined, from, to);
  const jtb = journalTrialBalance(book);
  const recon = reconciliation(book);

  const cust = (id: string) => book.customers.find((c) => c.id === id)?.name ?? id;
  const supp = (id: string) => book.suppliers.find((x) => x.id === id)?.name ?? id;
  const bank = (id: string | null) => (id ? book.banks.find((b) => b.id === id)?.name ?? id : '');
  const invNo = (id: string) => book.invoices.find((i) => i.id === id)?.no ?? '';
  const billNo = (id: string | null) => (id ? book.bills.find((b) => b.id === id)?.no ?? id : '');

  const period = from || to ? `${from || 'start'} to ${to || 'today'}` : 'whole book';

  const sheets: Sheet[] = [];

  /* ----------------------------------------------------------- 01 summary */
  sheets.push({
    name: '01_SUMMARY',
    title: 'Summary',
    head: ['Measure', 'Value'],
    widths: [46, 22],
    note: `Period: ${period}. Balances marked "as at today" ignore the period filter by design.`,
    rows: [
      ['Company', book.company.name],
      ['Trading as', book.company.tradingAs],
      ['BIN / VAT', book.company.binVat],
      ['Currency', book.company.currency],
      ['Financial year starts', book.company.financialYearStart],
      ['Period covered', period],
      ['', ''],
      ['Live invoices in period', s.invoiceCount],
      ['Gross sales', n0(s.grossSales)],
      ['Less credit notes', -n0(s.credited)],
      ['Net revenue', n0(s.sales)],
      ['Cost of sales (net of supplier refunds)', n0(s.cost)],
      ['Gross profit', n0(s.grossProfit)],
      ['Gross margin', pct(s.marginPct)],
      ['Operating expenses', n0(s.expenses)],
      ['Net profit', n0(s.netProfit)],
      ['', ''],
      ['Collected from customers', n0(s.collected)],
      ['Refunded to customers', n0(s.refunded)],
      ['Paid to suppliers', n0(s.paidOut)],
      ['', ''],
      ['Cash in hand (as at today)', n0(cashBook(book).closing)],
      ['Bank balances combined (as at today)', n0(banks.total)],
      ['Receivable (as at today)', n0(ar.total)],
      ['Payable (as at today)', n0(ap.total)],
      ['Trial balance difference (must be 0)', n0(tb.difference)]
    ]
  });

  /* --------------------------------------------------------------- 02 P&L */
  sheets.push({
    name: '02_PROFIT_AND_LOSS',
    title: 'Profit & loss',
    head: ['Line', 'Amount'],
    widths: [46, 22],
    note: `Period: ${period}.`,
    rows: [
      ['Gross sales', n0(pl.grossRevenue)],
      ['Less credit notes and cancellations', -n0(pl.creditNotes)],
      ['Net revenue', n0(pl.revenue)],
      ['Cost of sales', -n0(pl.costOfSales + pl.supplierRefunds)],
      ['Supplier refunds recovered', n0(pl.supplierRefunds)],
      ['Gross profit', n0(pl.grossProfit)],
      ['Gross margin', pct(pl.grossMarginPct)],
      ['', ''],
      ...pl.expenseRows.map((r): Row => [`Expense — ${r.category.name}`, -n0(r.amount)]),
      ['Total operating expenses', -n0(pl.totalExpenses)],
      ['', ''],
      ['Net profit', n0(pl.netProfit)],
      ['Net margin', pct(pl.netMarginPct)]
    ]
  });

  /* ----------------------------------------------------- 03 trial balance */
  sheets.push({
    name: '03_TRIAL_BALANCE',
    title: 'Trial balance (as at today)',
    head: ['Account', 'Debit', 'Credit'],
    widths: [44, 18, 18],
    note: 'Control-account basis, derived from the vouchers. The difference row must read zero.',
    rows: [
      ...tb.debits.map((r): Row => [r.account, n0(r.amount), '']),
      ...tb.credits.map((r): Row => [r.account, '', n0(r.amount)]),
      ['Total', n0(tb.totalDebit), n0(tb.totalCredit)],
      ['Difference', n0(tb.difference), '']
    ]
  });

  /* --------------------------------------------------------- 04 invoices */
  sheets.push({
    name: '04_INVOICES',
    title: 'Customer invoices',
    head: ['Invoice', 'Date', 'Customer', 'Description', 'PNR', 'Pax', 'Total', 'Credited', 'Cost', 'Profit', 'Margin %', 'Paid', 'Due', 'Status'],
    widths: [15, 12, 26, 44, 12, 7, 14, 13, 13, 13, 10, 13, 13, 15],
    note: `Period: ${period}. Cancelled and fully credited invoices are listed but count as zero revenue.`,
    rows: book.invoices
      .filter((i) => inRange(i.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((i): Row => {
        const t = invoiceTotals(i, book.receipts, notes);
        return [
          i.no, i.date, cust(i.customerId),
          i.lines.map((l) => l.description).join(' / '),
          i.lines.map((l) => l.pnr).filter(Boolean).join(' '),
          i.lines.reduce((x, l) => x + l.pax, 0),
          n0(t.total), n0(t.creditedAll), n0(t.cost), n0(t.profit),
          Number(t.marginPct.toFixed(1)), n0(t.paid), n0(t.due),
          LABEL[t.effectiveStatus] ?? t.effectiveStatus
        ];
      })
  });

  /* --------------------------------------------------------- 05 receipts */
  sheets.push({
    name: '05_RECEIPTS',
    title: 'Customer receipts',
    head: ['Receipt', 'Date', 'Customer', 'Against invoice', 'Method', 'Bank', 'Reference', 'Amount'],
    widths: [15, 12, 26, 16, 16, 22, 22, 14],
    note: `Period: ${period}.`,
    rows: book.receipts
      .filter((r) => inRange(r.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((r): Row => [r.no, r.date, cust(r.customerId), invNo(r.invoiceId), LABEL[r.method] ?? r.method, bank(r.bankId), r.ref, n0(r.amount)])
  });

  /* ----------------------------------------------------- 06 credit notes */
  sheets.push({
    name: '06_CREDIT_NOTES',
    title: 'Credit notes & cancellations',
    head: ['Credit note', 'Date', 'Customer', 'Against invoice', 'Reason', 'Settlement', 'Bank', 'Credited', 'Supplier refund', 'Bill', 'Net cost', 'Full cancellation', 'Notes'],
    widths: [15, 12, 26, 16, 22, 26, 20, 14, 15, 14, 13, 17, 40],
    note:
      'A credit note either reduces the receivable (settlement "credit balance") or sends money back out ' +
      '(any pay method) — never both. Supplier refund comes off the payable on the named bill.',
    rows: cn.rows
      .filter((r) => inRange(r.note.date))
      .map((r): Row => [
        r.note.no, r.note.date, r.customer, r.invoice?.no ?? '',
        LABEL[r.note.reason] ?? r.note.reason,
        isRefunded(r.note) ? `Refunded — ${LABEL[r.note.settlement] ?? r.note.settlement}` : 'Credit balance',
        bank(r.note.bankId),
        n0(r.note.amount), n0(r.note.supplierRefund), billNo(r.note.billId),
        n0(r.note.amount - r.note.supplierRefund),
        r.fullCancellation ? 'Yes' : 'No',
        r.note.notes
      ])
  });

  /* ------------------------------------------------------------ 07 bills */
  sheets.push({
    name: '07_SUPPLIER_BILLS',
    title: 'Supplier bills',
    head: ['Bill', 'Date', 'Supplier', 'Against invoice', 'Amount', 'Paid', 'Refunded', 'Due', 'Status', 'Notes'],
    widths: [15, 12, 28, 16, 14, 14, 13, 14, 15, 40],
    note: `Period: ${period}.`,
    rows: book.bills
      .filter((b) => inRange(b.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((b): Row => {
        const paid = billPaid(b, book.payments);
        const refunded = notes.filter((c) => c.billId === b.id).reduce((t, c) => t + c.supplierRefund, 0);
        return [
          b.no, b.date, supp(b.supplierId), invNo(b.invoiceRef),
          n0(billBase(b)), n0(paid), n0(refunded), n0(billDue(b, book.payments, notes, book.supplierCreditNotes ?? [])),
          LABEL[b.status] ?? b.status, b.notes
        ];
      })
  });

  /* --------------------------------------------------------- 08 payments */
  sheets.push({
    name: '08_SUPPLIER_PAYMENTS',
    title: 'Supplier payments',
    head: ['Payment', 'Date', 'Supplier', 'Against bill', 'Method', 'Bank', 'Reference', 'Amount'],
    widths: [15, 12, 28, 16, 16, 22, 22, 14],
    note: `Period: ${period}.`,
    rows: book.payments
      .filter((p) => inRange(p.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((p): Row => [p.no, p.date, supp(p.supplierId), billNo(p.billId), LABEL[p.method] ?? p.method, bank(p.bankId), p.ref, n0(p.amount)])
  });

  /* --------------------------------------------------------- 09 expenses */
  sheets.push({
    name: '09_EXPENSES',
    title: 'Expenses',
    head: ['Voucher', 'Date', 'Category', 'Description', 'Employee', 'Method', 'Bank', 'Amount'],
    widths: [15, 12, 24, 40, 20, 16, 22, 14],
    note: `Period: ${period}.`,
    rows: book.expenses
      .filter((e) => inRange(e.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e): Row => [
        e.no, e.date,
        book.expenseCategories.find((c) => c.id === e.categoryId)?.name ?? e.categoryId,
        e.description,
        e.employeeId ? book.employees.find((x) => x.id === e.employeeId)?.name ?? e.employeeId : '',
        LABEL[e.method] ?? e.method, bank(e.bankId), n0(e.amount)
      ])
  });

  /* ------------------------------------------------------ 10 receivables */
  sheets.push({
    name: '10_RECEIVABLES',
    title: 'Receivables (as at today)',
    head: ['Invoice', 'Date', 'Customer', 'Total', 'Credited', 'Paid', 'Due', 'Days outstanding'],
    widths: [15, 12, 28, 14, 13, 14, 14, 17],
    note: 'A point-in-time balance — the period filter does not apply.',
    rows: ar.rows
      .sort((a, b) => a.inv.date.localeCompare(b.inv.date))
      .map(({ inv, t }): Row => [
        inv.no, inv.date, cust(inv.customerId), n0(t.total), n0(t.credited), n0(t.paid), n0(t.due),
        Math.round((Date.parse(todayIn(book.company.timezone)) - Date.parse(inv.date)) / 86400000)
      ])
  });

  /* --------------------------------------------------------- 11 payables */
  sheets.push({
    name: '11_PAYABLES',
    title: 'Payables (as at today)',
    head: ['Bill', 'Date', 'Supplier', 'Amount', 'Paid', 'Refunded', 'Due'],
    widths: [15, 12, 28, 14, 14, 13, 14],
    note: 'A point-in-time balance — the period filter does not apply.',
    rows: ap.rows
      .sort((a, b) => a.bill.date.localeCompare(b.bill.date))
      .map((r): Row => [r.bill.no, r.bill.date, supp(r.bill.supplierId), n0(billBase(r.bill)), n0(r.paid), n0(r.refunded), n0(r.due)])
  });

  /* -------------------------------------------------------- 12 cash/bank */
  sheets.push({
    name: '12_CASH_AND_BANK',
    title: 'Cash and bank',
    head: ['Account', 'Opening', 'In', 'Out', 'Closing'],
    widths: [34, 16, 16, 16, 16],
    note: `Cash movement covers ${period}. Bank closings are as at today.`,
    rows: [
      ['Cash in hand', n0(cash.opening), n0(cash.totalIn), n0(cash.totalOut), n0(cash.closing)],
      ...banks.rows.map((r): Row => [`${r.bank.name} · ${r.bank.accountNo}`, n0(r.bank.openingBalance), '', '', n0(r.closing)]),
      ['Combined bank', '', '', '', n0(banks.total)]
    ]
  });

  /* ------------------------------------------------------- 13 by service */
  sheets.push({
    name: '13_SALES_BY_SERVICE',
    title: 'Sales by service',
    head: ['Service', 'Category', 'Lines', 'Sales', 'Cost', 'Profit', 'Margin %'],
    widths: [30, 18, 10, 16, 16, 16, 11],
    note: `Period: ${period}. Cancelled invoices are excluded.`,
    rows: salesByService(book, from, to).map((r): Row => [
      r.service.name, LABEL[r.service.category] ?? r.service.category, r.count,
      n0(r.sales), n0(r.cost), n0(r.profit), Number((r.sales > 0 ? (r.profit / r.sales) * 100 : 0).toFixed(1))
    ])
  });

  /* --------------------------------------------------- 14 expense by cat */
  sheets.push({
    name: '14_EXPENSES_BY_CATEGORY',
    title: 'Expenses by category',
    head: ['Category', 'Amount', 'Share %'],
    widths: [34, 16, 12],
    note: `Period: ${period}.`,
    rows: (() => {
      const rows = expensesByCategory(book, from, to);
      const total = rows.reduce((t, r) => t + r.amount, 0) || 1;
      return rows.map((r): Row => [r.category.name, n0(r.amount), Number(((r.amount / total) * 100).toFixed(1))]);
    })()
  });

  /* -------------------------------------------------------- 15 inventory */
  sheets.push({
    name: '15_INVENTORY',
    title: 'Inventory blocks',
    head: ['Item', 'Kind', 'Supplier', 'Purchased', 'Sold', 'Sold %', 'Remaining', 'Unit cost', 'Unit sell', 'Cost committed', 'Value at risk', 'Realised margin', 'Potential margin', 'Expires', 'Days left', 'Flag'],
    widths: [28, 18, 24, 11, 9, 9, 11, 11, 11, 15, 14, 15, 16, 12, 11, 14],
    note: 'Value at risk is unsold stock at cost — cash on a shelf with an expiry date on it.',
    rows: inv.rows.map((r): Row => [
      r.item.name, LABEL[r.item.kind] ?? r.item.kind, supp(r.item.supplierId),
      r.item.purchased, r.item.sold, Number(r.soldPct.toFixed(1)), r.remaining,
      n0(r.item.unitCost), n0(r.item.unitSell),
      n0(r.costCommitted), n0(r.valueAtRisk), n0(r.realisedMargin), n0(r.potentialMargin),
      r.item.expiresOn, r.daysLeft, r.expired ? 'Expired' : r.atRisk ? 'At risk' : ''
    ])
  });

  /* ------------------------------------------------ 16 supplier deposits */
  sheets.push({
    name: '16_SUPPLIER_DEPOSITS',
    title: 'Supplier deposits',
    head: ['Supplier', 'Deposits', 'Deposited', 'Billed', 'Settled', 'Bills outstanding', 'Float available'],
    widths: [28, 11, 16, 16, 16, 18, 18],
    note: 'Money placed with consolidators and airlines up front, and how much of it is still unused.',
    rows: dep.rows.map((r): Row => [
      r.supplier.name, r.depositCount, n0(r.deposited), n0(r.billed), n0(r.settled),
      n0(r.outstandingBills), n0(r.available)
    ])
  });

  /* --------------------------------------------------- 17 balance sheet */
  sheets.push({
    name: '17_BALANCE_SHEET',
    title: 'Balance sheet (as at today)',
    head: ['Section', 'Account', 'Amount'],
    widths: [22, 40, 20],
    note:
      'Built from the journal. Retained earnings is income less expenses out of the same postings, not a ' +
      'stored figure, which is why the two sides meet without a plug. The difference row must read zero.',
    rows: [
      ...bs.assets.map((r): Row => ['Assets', r.name, n0(r.amount)]),
      ['Assets', 'Total assets', n0(bs.totalAssets)],
      ['', '', ''],
      ...bs.liabilities.map((r): Row => ['Liabilities', r.name, n0(r.amount)]),
      ['Liabilities', 'Total liabilities', n0(bs.totalLiabilities)],
      ['', '', ''],
      ...bs.equity.map((r): Row => ['Equity', r.name, n0(r.amount)]),
      ['Equity', 'Total equity', n0(bs.totalEquity)],
      ['', '', ''],
      ['Check', 'Total liabilities and equity', n0(bs.totalLiabilities + bs.totalEquity)],
      ['Check', 'Difference', n0(bs.difference)]
    ]
  });

  /* ------------------------------------------------------- 18 cash flow */
  sheets.push({
    name: '18_CASH_FLOW',
    title: 'Cash flow (direct method)',
    head: ['Section', 'Line', 'Amount'],
    widths: [20, 44, 20],
    note:
      `Period: ${period}. Cash and every bank account together. Transfers between them are excluded — ` +
      'banking the day\'s takings is not cash generated.',
    rows: [
      ['Opening', 'Funds at start', n0(cf.opening)],
      ['', '', ''],
      ...cf.operating.map((r): Row => ['Operating', r.name, n0(r.amount)]),
      ['Operating', 'Net cash from operations', n0(cf.netOperating)],
      ['', '', ''],
      ...cf.investing.map((r): Row => ['Investing', r.name, n0(r.amount)]),
      ['Investing', 'Net cash from investing', n0(cf.netInvesting)],
      ['', '', ''],
      ['Total', 'Net movement', n0(cf.movement)],
      ['Total', 'Funds at close', n0(cf.closing)]
    ]
  });

  /* -------------------------------------------------- 19 general ledger */
  sheets.push({
    name: '19_GENERAL_LEDGER',
    title: 'General ledger — account balances',
    head: ['Code', 'Account', 'Group', 'Debits', 'Credits', 'Balance'],
    widths: [16, 38, 14, 18, 18, 18],
    note: `Period: ${period}. Balance is signed by the account's natural side.`,
    rows: gl.summary.map((r): Row => [
      r.account.code, r.account.name, r.account.group, n0(r.debit), n0(r.credit), n0(r.balance)
    ])
  });

  /* -------------------------------------------------------- 20 journal */
  sheets.push({
    name: '20_JOURNAL',
    title: 'Journal — every posting',
    head: ['Date', 'Voucher', 'Type', 'Party', 'Account', 'Debit', 'Credit', 'Narration'],
    widths: [12, 16, 18, 28, 18, 15, 15, 46],
    note: 'Two or more lines per voucher, always balanced. This is what the ledger and balance sheet are built from.',
    rows: journal(book)
      .filter((l) => inRange(l.date))
      .map((l): Row => [l.date, l.ref, l.voucherType, l.party, l.account, n0(l.debit), n0(l.credit), l.narration])
  });

  /* ------------------------------------------------- 21 reconciliation */
  sheets.push({
    name: '21_RECONCILIATION',
    title: 'Control accounts vs the journal',
    head: ['Account', 'Control total', 'Ledger balance', 'Difference'],
    widths: [40, 20, 20, 18],
    note:
      'Two independent derivations of the same vouchers. Every difference must be zero; a non-zero row means ' +
      'the dashboard and the ledger disagree about a voucher.',
    rows: [
      ...recon.checks.map((c): Row => [c.name, n0(c.control), n0(c.ledger), n0(c.difference)]),
      ['Trial balance — control basis', n0(tb.totalDebit), n0(tb.totalCredit), n0(tb.difference)],
      ['Trial balance — journal basis', n0(jtb.totalDebit), n0(jtb.totalCredit), n0(jtb.difference)]
    ]
  });

  /* -------------------------------------------- 22 cancelled bookings */
  sheets.push({
    name: '22_CANCELLED_BOOKINGS',
    title: 'Cancelled bookings',
    head: ['Invoice', 'Date', 'Customer', 'PNR', 'Original value', 'Credited', 'Recovered from supplier', 'Cost to us', 'Credit note', 'Reason'],
    widths: [15, 12, 26, 14, 15, 14, 20, 14, 15, 22],
    note: 'Invoices reversed in full. These count as zero revenue everywhere in the book.',
    rows: cn.rows
      .filter((r) => r.fullCancellation && r.invoice && inRange(r.note.date))
      .map((r): Row => [
        r.invoice!.no, r.invoice!.date, r.customer,
        r.invoice!.lines.map((l) => l.pnr).filter(Boolean).join(' '),
        n0(r.invoiceTotal), n0(r.note.amount), n0(r.note.supplierRefund),
        n0(r.note.amount - r.note.supplierRefund), r.note.no,
        LABEL[r.note.reason] ?? r.note.reason
      ])
  });

  /* ---------------------------------------------------- 23 refunds out */
  sheets.push({
    name: '23_REFUNDS',
    title: 'Refunds paid out',
    head: ['Credit note', 'Date', 'Customer', 'Against invoice', 'Method', 'Bank', 'Amount', 'Reason'],
    widths: [15, 12, 26, 16, 20, 22, 15, 24],
    note: `Period: ${period}. Only credits settled in money — credit left on account is not a refund.`,
    rows: cn.rows
      .filter((r) => isRefunded(r.note) && inRange(r.note.date))
      .map((r): Row => [
        r.note.no, r.note.date, r.customer, r.invoice?.no ?? '',
        LABEL[r.note.settlement] ?? r.note.settlement, bank(r.note.bankId),
        n0(r.note.amount), LABEL[r.note.reason] ?? r.note.reason
      ])
  });

  /* ------------------------------------------- 24 supplier credit notes */
  sheets.push({
    name: '24_SUPPLIER_CREDITS',
    title: 'Supplier credit notes',
    head: ['Credit note', 'Date', 'Supplier', 'Against bill', 'Reason', 'Settlement', 'Bank', 'Amount', 'Notes'],
    widths: [15, 12, 28, 16, 22, 26, 20, 15, 40],
    note: 'The purchase-side mirror: either the bill was unpaid and we owe less, or it was paid and money came back in.',
    rows: (book.supplierCreditNotes ?? [])
      .filter((c) => inRange(c.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((c): Row => [
        c.no, c.date, supp(c.supplierId), billNo(c.billId),
        LABEL[c.reason] ?? c.reason,
        c.settlement === 'credit_balance' ? 'Credit balance' : `Received back — ${LABEL[c.settlement] ?? c.settlement}`,
        bank(c.bankId), n0(c.amount), c.notes
      ])
  });

  /* ---------------------------------------------------- 25 transfers */
  sheets.push({
    name: '25_BANK_TRANSFERS',
    title: 'Deposits and withdrawals',
    head: ['Voucher', 'Date', 'Direction', 'Bank', 'Amount', 'Reference', 'Notes'],
    widths: [15, 12, 26, 28, 15, 22, 40],
    note: 'Cash moved between the till and a bank account. Total funds never change, only where they sit.',
    rows: (book.transfers ?? [])
      .filter((t) => inRange(t.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((t): Row => [
        t.no, t.date, LABEL[t.direction] ?? t.direction,
        book.banks.find((b) => b.id === t.bankId)?.name ?? t.bankId,
        n0(t.amount), t.ref, t.notes
      ])
  });

  return sheets;
}

/* --------------------------------------------------------------- handler */

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const format = (p.get('format') ?? 'xlsx').toLowerCase();
  const from = p.get('from') || undefined;
  const to = p.get('to') || undefined;

  const book = await getBook();
  const all = buildSheets(book, from, to);

  /**
   * `section` narrows a CSV or a workbook to one ledger. The value is matched
   * loosely against the sheet name so both `creditNotes` and `06_CREDIT_NOTES`
   * work, which keeps the links on the screens short.
   */
  const want = (p.get('section') ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  const sheets = want ? all.filter((s) => s.name.replace(/[^a-z]/gi, '').toLowerCase().includes(want)) : all;
  if (sheets.length === 0) {
    return NextResponse.json(
      { ok: false, error: `no section matches "${p.get('section')}"`, sections: all.map((s) => s.name) },
      { status: 422 }
    );
  }

  const filename = `softifybd-accounts-${want || 'full'}-${stamp(book)}`;
  const period = from || to ? `${from || 'start'} to ${to || 'today'}` : 'whole book';

  if (format === 'csv') return csv(sheets, filename);
  if (format === 'md') return markdown(book, sheets, period, filename);
  if (format === 'xlsx') return xlsx(book, sheets, period, filename);
  if (format === 'docx') return wordDoc(book, sheets, period, filename);

  return NextResponse.json({ ok: false, error: 'format must be one of csv, md, xlsx, docx' }, { status: 422 });
}

/* -------------------------------------------------------------------- CSV */

function csv(sheets: Sheet[], filename: string) {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const out: string[] = [];
  for (const s of sheets) {
    if (sheets.length > 1) out.push(q(s.title));
    out.push(s.head.map(q).join(','));
    for (const r of s.rows) out.push(r.map(q).join(','));
    out.push('');
  }
  // BOM so Excel opens Bangla and the currency sign correctly
  return new NextResponse('﻿' + out.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}.csv"`
    }
  });
}

/* --------------------------------------------------------------- Markdown */

function markdown(book: Book, sheets: Sheet[], period: string, filename: string) {
  const cell = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out: string[] = [];

  out.push(`# ${book.company.name} — Accounts`);
  out.push('');
  out.push(`**${book.company.tradingAs}** · BIN/VAT ${book.company.binVat} · ${book.company.address}`);
  out.push('');
  out.push(`Period: **${period}** · generated ${todayIn(book.company.timezone)} · all figures in ${book.company.currency}`);
  out.push('');
  out.push('> Derived from the vouchers at the moment of download, not from stored totals, so these');
  out.push('> figures cannot disagree with the screens they came from. Balance-sheet items are as at');
  out.push('> today whatever period was asked for.');
  out.push('');

  for (const s of sheets) {
    out.push(`## ${s.title}`);
    out.push('');
    if (s.note) {
      out.push(`_${s.note}_`);
      out.push('');
    }
    if (s.rows.length === 0) {
      out.push('Nothing recorded.');
      out.push('');
      continue;
    }
    out.push(`| ${s.head.map(cell).join(' | ')} |`);
    out.push(`|${s.head.map(() => '---').join('|')}|`);
    for (const r of s.rows) out.push(`| ${r.map(cell).join(' | ')} |`);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('Internal management accounts. Single-entry with derived control accounts — see README.md');
  out.push('for what that basis does and does not give you before filing anything from it.');
  out.push('');

  return new NextResponse(out.join('\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}.md"`
    }
  });
}

/* ------------------------------------------------------------------- XLSX */

async function xlsx(book: Book, sheets: Sheet[], period: string, filename: string) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = `${book.company.name} — OTA Platform`;
  wb.created = new Date();

  const NAVY = 'FF13294B';
  const PANEL = 'FFEEF2F5';

  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: s.note ? 4 : 3 }] });

    ws.mergeCells(1, 1, 1, Math.max(1, s.head.length));
    const title = ws.getCell(1, 1);
    title.value = `${s.title} — ${book.company.name}`;
    title.font = { bold: true, size: 13, color: { argb: NAVY } };
    ws.getRow(1).height = 24;

    ws.mergeCells(2, 1, 2, Math.max(1, s.head.length));
    const sub = ws.getCell(2, 1);
    sub.value = `${period} · ${book.company.currency} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    sub.font = { size: 9.5, color: { argb: 'FF5A6472' } };

    let headRow = 3;
    if (s.note) {
      ws.mergeCells(3, 1, 3, Math.max(1, s.head.length));
      const note = ws.getCell(3, 1);
      note.value = s.note;
      note.font = { size: 9, italic: true, color: { argb: 'FF5A6472' } };
      note.alignment = { wrapText: true, vertical: 'top' };
      ws.getRow(3).height = 26;
      headRow = 4;
    }

    const hr = ws.getRow(headRow);
    s.head.forEach((h, i) => {
      const c = hr.getCell(i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { vertical: 'middle', wrapText: true };
    });
    hr.height = 22;

    s.widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    s.rows.forEach((r, ri) => {
      const row = ws.getRow(headRow + 1 + ri);
      r.forEach((v, ci) => {
        const c = row.getCell(ci + 1);
        c.value = v as never;
        if (typeof v === 'number') {
          c.numFmt = '#,##0';
          c.alignment = { horizontal: 'right' };
        }
      });
      // banding, and a bold rule on any Total / Difference / Net line
      const first = String(r[0] ?? '');
      if (/^(total|difference|net profit|net revenue|gross profit|combined)/i.test(first)) {
        row.font = { bold: true };
        row.eachCell((c) => {
          c.border = { top: { style: 'thin', color: { argb: 'FFDCE6EC' } } };
        });
      } else if (ri % 2 === 1) {
        row.eachCell((c) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PANEL } };
        });
      }
    });

    if (s.rows.length > 0 && s.head.length > 1) {
      ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow, column: s.head.length } };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}.xlsx"`
    }
  });
}

/* ------------------------------------------------------------------- DOCX */

async function wordDoc(book: Book, sheets: Sheet[], period: string, filename: string) {
  const {
    Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle
  } = await import('docx');

  const NAVY = '13294B';
  const MUTED = '5A6472';

  // Paragraphs and Tables both go in the section body; docx types them separately
  const kids: unknown[] = [];

  kids.push(
    new Paragraph({ text: `${book.company.name}`, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({ text: `${book.company.tradingAs} · BIN/VAT ${book.company.binVat}`, size: 20, color: MUTED }),
        new TextRun({ text: `\n${book.company.address}`, size: 20, color: MUTED, break: 1 }),
        new TextRun({ text: `Period ${period} · all figures in ${book.company.currency}`, size: 20, color: NAVY, break: 1, bold: true })
      ]
    }),
    new Paragraph({
      spacing: { before: 200, after: 200 },
      children: [
        new TextRun({
          text:
            'Management accounts, derived from the vouchers at the moment of download rather than from ' +
            'stored totals. Balance-sheet items — receivables, payables, bank and cash closings, the trial ' +
            'balance — are as at today whatever period was requested, because a balance for a past window ' +
            'is not a meaningful figure.',
          size: 19,
          italics: true,
          color: MUTED
        })
      ]
    })
  );

  const cellPara = (v: string | number, bold = false) =>
    new Paragraph({
      alignment: typeof v === 'number' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: typeof v === 'number' ? v.toLocaleString('en-IN') : String(v), size: 17, bold })]
    });

  for (const s of sheets) {
    kids.push(new Paragraph({ text: s.title, heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 80 } }));
    if (s.note) {
      kids.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: s.note, size: 17, italics: true, color: MUTED })]
        })
      );
    }
    if (s.rows.length === 0) {
      kids.push(new Paragraph({ children: [new TextRun({ text: 'Nothing recorded.', size: 18, color: MUTED })] }));
      continue;
    }

    /**
     * Word cannot scroll sideways, so a very wide ledger is dropped to its
     * first eight columns with a line saying so. Silently truncating would let
     * somebody read the document as complete when it is not.
     */
    const wide = s.head.length > 8;
    const cols = wide ? 8 : s.head.length;

    kids.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: 'DCE6EC' },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DCE6EC' },
          left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'EEF2F5' },
          insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
        },
        rows: [
          new TableRow({
            tableHeader: true,
            children: s.head.slice(0, cols).map(
              (h) =>
                new TableCell({
                  shading: { fill: NAVY },
                  children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 16, color: 'FFFFFF' })] })]
                })
            )
          }),
          ...s.rows.slice(0, 400).map((r) => {
            const bold = /^(total|difference|net profit|net revenue|gross profit|combined)/i.test(String(r[0] ?? ''));
            return new TableRow({
              children: Array.from({ length: cols }, (_, i) => new TableCell({ children: [cellPara(r[i] ?? '', bold)] }))
            });
          })
        ]
      })
    );

    const dropped: string[] = [];
    if (wide) dropped.push(`${s.head.length - cols} further columns (${s.head.slice(cols).join(', ')})`);
    if (s.rows.length > 400) dropped.push(`${s.rows.length - 400} further rows`);
    if (dropped.length) {
      kids.push(
        new Paragraph({
          spacing: { before: 80 },
          children: [
            new TextRun({
              text: `Not shown here: ${dropped.join(' and ')}. Download the Excel version for the complete ledger.`,
              size: 16,
              italics: true,
              color: '9A5B00'
            })
          ]
        })
      );
    }
  }

  const doc = new Document({
    creator: book.company.name,
    title: `${book.company.name} — accounts ${period}`,
    sections: [{ properties: {}, children: kids as never }]
  });

  const buf = await Packer.toBuffer(doc);
  return new NextResponse(buf as unknown as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="${filename}.docx"`
    }
  });
}
