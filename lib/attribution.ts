import type { Book, Branch, Employee, Invoice } from '@/lib/accounting';
import { invoiceTotals, isLive } from '@/lib/accounting';
import { documents, isMemo } from '@/lib/documents';

/**
 * Margin by branch and by consultant.
 *
 * WHY THIS IS SMALLER THAN IT LOOKS AND MATTERS MORE THAN IT LOOKS
 *
 * Two nullable foreign keys and a group-by. It is the cheapest thing left on the
 * list, and it is what an owner with three offices asks about in the first ten
 * minutes — not "what did we sell" but "which counter is actually making money,
 * and which of my staff is discounting to hit a number".
 *
 * TRAACS sells it as "Profit by Branch, Team or Product". We had the product half
 * already, through `salesByService`. This is the other two.
 *
 * WHAT IS ATTRIBUTED, AND WHAT IS NOT
 *
 * The invoice carries the attribution, so margin — revenue less supplier cost —
 * groups cleanly. Documents carry their own `branchId` and `consultantId` too, and
 * those are used for one thing the invoice cannot answer: whose ADM is it. A memo
 * has no invoice, and the consultant who mispriced a fare is the person the memo
 * belongs to.
 *
 * UNATTRIBUTED IS A ROW, NOT A GAP
 *
 * Every invoice written before this existed has no branch. They appear as their own
 * row rather than being dropped or quietly folded into the first branch, because a
 * report whose totals do not add back to the whole book is a report that gets
 * argued with rather than used.
 */

export type AttributionRow = {
  id: string | null;
  name: string;
  /** Only set for branches. */
  kind?: Branch['kind'];
  invoices: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number;
  /** Debit memos raised against this branch or consultant, net of credit memos. */
  memoCost: number;
};

function blank(id: string | null, name: string, kind?: Branch['kind']): AttributionRow {
  return { id, name, kind, invoices: 0, revenue: 0, cost: 0, margin: 0, marginPct: 0, memoCost: 0 };
}

export const branches = (book: Book): Branch[] => book.branches ?? [];

/**
 * Group live invoices by one of the two attribution keys.
 *
 * `key` picks which. Cancelled and draft invoices are excluded the same way every
 * other margin report excludes them — attributing a sale that never happened would
 * flatter whichever branch cancelled the most.
 */
function group(
  book: Book,
  key: 'branchId' | 'consultantId',
  label: (id: string) => { name: string; kind?: Branch['kind'] } | undefined
): AttributionRow[] {
  const rows = new Map<string | null, AttributionRow>();

  const take = (id: string | null) => {
    if (!rows.has(id)) {
      const meta = id ? label(id) : undefined;
      rows.set(id, blank(id, meta?.name ?? (id ? `${id} — not on the master list` : 'Unattributed'), meta?.kind));
    }
    return rows.get(id)!;
  };

  for (const inv of book.invoices) {
    if (!isLive(inv)) continue;
    const t = invoiceTotals(inv, book.receipts, book.creditNotes ?? []);
    if (t.cancelled) continue;
    const row = take((inv[key] as string | null | undefined) ?? null);
    row.invoices += 1;
    row.revenue += t.total;
    row.cost += t.cost;
  }

  // Memos attach through the document, which is the only place they can attach:
  // a memo has no invoice, and it belongs to whoever caused it.
  for (const d of documents(book)) {
    if (!isMemo(d) || d.status === 'void') continue;
    const gross = d.baseFare === null ? 0 : d.baseFare + d.taxes.reduce((t, x) => t + x.amount, 0);
    if (gross <= 0) continue;
    const row = take((d[key] as string | null | undefined) ?? null);
    row.memoCost += d.type === 'ADM' ? gross : -gross;
  }

  return [...rows.values()]
    .map((r) => {
      const margin = Math.round(r.revenue - r.cost - r.memoCost);
      return {
        ...r,
        revenue: Math.round(r.revenue),
        cost: Math.round(r.cost),
        memoCost: Math.round(r.memoCost),
        margin,
        marginPct: r.revenue > 0 ? (margin / r.revenue) * 100 : 0
      };
    })
    .sort((a, b) => {
      // Unattributed last however large it is — it is a backlog, not a performer.
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return b.margin - a.margin;
    });
}

export function marginByBranch(book: Book): AttributionRow[] {
  const byId = new Map(branches(book).map((b) => [b.id, b]));
  return group(book, 'branchId', (id) => {
    const b = byId.get(id);
    return b ? { name: b.name, kind: b.kind } : undefined;
  });
}

export function marginByConsultant(book: Book): AttributionRow[] {
  const byId = new Map((book.employees ?? []).map((e: Employee) => [e.id, e]));
  return group(book, 'consultantId', (id) => {
    const e = byId.get(id);
    return e ? { name: `${e.name} — ${e.role}` } : undefined;
  });
}

/**
 * How much of the book can be attributed at all.
 *
 * Stated as a proportion because that is the number that decides whether the
 * report below it is worth reading. A branch table built on 2% of the sales is a
 * table that will be quoted as if it were the whole picture.
 */
export function attributionCoverage(book: Book): { attributed: number; total: number; pct: number } {
  const live = book.invoices.filter((i) => isLive(i));
  const attributed = live.filter((i) => i.branchId).length;
  return {
    attributed,
    total: live.length,
    pct: live.length ? (attributed / live.length) * 100 : 0
  };
}

/** The branch a storefront sale belongs to, when the book has one. */
export function onlineBranch(book: Book): Branch | undefined {
  return branches(book).find((b) => b.kind === 'online');
}

export type { Invoice };
