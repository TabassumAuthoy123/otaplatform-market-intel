import { NextResponse } from 'next/server';
import { getBookUnguarded, invoiceTotals } from '@/lib/accounting';
import { retrievePnr } from '@/lib/gds';

/**
 * PNR lookup — two halves, deliberately separate.
 *
 *  local  always works. Finds the PNR on an invoice line in
 *         content/accounting.json and returns the commercial picture:
 *         customer, sale, supplier cost, margin, payment status. Our own book,
 *         not the GDS.
 *
 *  live   calls Travelport through lib/gds.ts, which is the same transport the
 *         flight search on /portal/flights uses. Off until the environment is
 *         configured — see .env.example.
 *
 * The GDS password is read inside lib/gds.ts, sent upstream, and never logged,
 * never echoed in a response and never written to disk.
 */

export const dynamic = 'force-dynamic';

async function localLookup(locator: string) {
  const book = await getBookUnguarded();
  const hits: unknown[] = [];

  for (const inv of book.invoices) {
    const lines = inv.lines.filter((l) => l.pnr && l.pnr.toUpperCase() === locator);
    if (!lines.length) continue;
    const t = invoiceTotals(inv, book.receipts);
    hits.push({
      invoiceNo: inv.no,
      date: inv.date,
      customer: book.customers.find((c) => c.id === inv.customerId)?.name ?? inv.customerId,
      status: t.effectiveStatus,
      lines: lines.map((l) => ({
        description: l.description,
        pax: l.pax,
        sale: l.qty * l.unitPrice,
        supplierCost: l.qty * l.supplierCost,
        margin: l.qty * (l.unitPrice - l.supplierCost),
        supplier: book.suppliers.find((s) => s.id === l.supplierId)?.name ?? l.supplierId
      })),
      invoiceTotal: t.total,
      paid: t.paid,
      due: t.due,
      grossProfit: t.profit
    });
  }
  return hits;
}

export async function GET(req: Request) {
  const locator = (new URL(req.url).searchParams.get('locator') ?? '').trim().toUpperCase();

  if (!/^[A-Z0-9]{5,8}$/.test(locator)) {
    return NextResponse.json(
      { ok: false, error: 'Give a record locator of 5–8 letters or digits.' },
      { status: 422 }
    );
  }

  const [local, live] = await Promise.all([localLookup(locator), retrievePnr(locator)]);
  return NextResponse.json({ ok: true, locator, local, live });
}
