import type { Book } from '@/lib/accounting';
import { documentGross, documents, taxTotal } from '@/lib/documents';
import type { TravelDocument } from '@/lib/documents';

/**
 * BSP reconciliation — what IATA will bill against what the book says.
 *
 * WHAT THIS IS FOR
 *
 * IATA's Billing and Settlement Plan issues a report each reporting period listing
 * every sale, refund and memo it believes the agency owes on, and takes the net at
 * the remittance date whether or not the agency checked. An agency that does not
 * reconcile pays whatever the file says — including airline errors it had the right
 * to dispute, and its own staff issuing tickets outside the system.
 *
 * This is the single feature most likely to close a sale in this market, and no
 * Bangladeshi product in the same bracket appears to do it.
 *
 * WHY CSV AND NOT THE HOT FILE
 *
 * The machine-readable BSP output is the HOT file, a fixed-width flat file laid out
 * by the IATA DISH standard. We do not have that specification, and writing a
 * fixed-width parser by inferring column positions from a sample would produce
 * something that looks finished, parses without complaint, and silently misreads a
 * tax field the day a row is one character longer.
 *
 * So the importer takes CSV with an explicit, documented column mapping — which is
 * what BSPlink exports and what an agency can produce today — and the matcher, the
 * part that carries the value, does not care which reader produced the rows. When
 * the DISH layout is in hand, a second reader feeds the same matcher.
 *
 * WHAT IT CANNOT DO YET, STATED PLAINLY
 *
 * BSP keys on the document number. No document on this book has one, because
 * Galileo answers NEED TICKET ACCOUNT for our PCC and nothing has been issued. So
 * until issuing is switched on, a real billing file would match nothing here —
 * which is a true and useful thing for the screen to say rather than something to
 * paper over. `matchToBook` therefore also reports a weaker PNR match, clearly
 * labelled as provisional.
 */

export type BspRow = {
  documentNo: string;
  /** As BSP classifies it. TKT sale, RFND refund, ADM/ACM airline memo. */
  type: 'TKT' | 'EMD' | 'RFND' | 'ADM' | 'ACM' | 'OTHER';
  carrier: string;
  issueDate: string;
  currency: string;
  baseFare: number;
  tax: number;
  commission: number;
  /** What IATA will actually take: fare plus tax less commission. */
  netRemit: number;
  formOfPayment: string;
  /** Reporting period, e.g. 2026-08-P2. */
  period: string;
  pnr: string;
  /** 1-based line in the uploaded file, so an error can be pointed at. */
  line: number;
};

/**
 * The column names accepted for each field.
 *
 * More than one spelling per field because BSPlink exports, agent billing analyses
 * and airline statements all name these differently, and an import that rejects a
 * file over a header spelling is an import nobody uses. Matched case-insensitively
 * with punctuation stripped.
 */
const COLUMNS: Record<keyof Omit<BspRow, 'line'>, string[]> = {
  documentNo: ['documentnumber', 'documentno', 'ticketnumber', 'ticketno', 'tktno', 'docno'],
  type: ['transactioncode', 'trnc', 'type', 'documenttype'],
  carrier: ['airlinecode', 'carrier', 'platingcarrier', 'airline'],
  issueDate: ['issuedate', 'dateofissue', 'transactiondate', 'date'],
  currency: ['currency', 'currencycode', 'curr'],
  baseFare: ['fareamount', 'basefare', 'fare', 'grossfare'],
  tax: ['taxamount', 'taxes', 'totaltax', 'tax'],
  commission: ['commissionamount', 'commission', 'commamount', 'comm'],
  netRemit: ['amountpayable', 'netremit', 'netamount', 'amountduetoairline', 'net'],
  formOfPayment: ['formofpayment', 'fop', 'paymenttype'],
  period: ['period', 'reportingperiod', 'billingperiod'],
  pnr: ['pnr', 'recordlocator', 'bookingreference', 'pnrreference']
};

const normalise = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * RFC 4180 CSV: quoted fields, embedded commas, doubled quotes, CRLF.
 *
 * Written out rather than split on commas, for the same reason the CRM importer
 * was: a passenger name or a fare description containing a comma silently shifts
 * every column after it, and the resulting import looks like it worked.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length));
}

const num = (v: string) => {
  // Accounting files write negatives as (1,234) as often as -1234.
  const s = String(v ?? '').replace(/[^0-9.()-]/g, '');
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, '')) || 0;
  return Math.round(neg ? -n : n);
};

const TYPE: Record<string, BspRow['type']> = {
  tkt: 'TKT', tktt: 'TKT', sale: 'TKT', emd: 'EMD', emda: 'EMD', emds: 'EMD',
  rfnd: 'RFND', refund: 'RFND', rfd: 'RFND',
  adm: 'ADM', acm: 'ACM'
};

export type BspParse = {
  rows: BspRow[];
  /** Header names we could not place, so a mapping problem is visible. */
  unmapped: string[];
  /** Fields the file does not carry at all. */
  missing: string[];
  errors: string[];
};

export function parseBspCsv(text: string): BspParse {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], unmapped: [], missing: Object.keys(COLUMNS), errors: ['The file is empty.'] };

  const header = table[0].map(normalise);
  const index: Partial<Record<keyof BspRow, number>> = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const at = header.findIndex((h) => names.includes(h));
    if (at >= 0) index[field as keyof BspRow] = at;
  }

  const claimed = new Set(Object.values(index));
  const unmapped = table[0].filter((_, i) => !claimed.has(i)).filter((h) => h.trim().length);
  const missing = (Object.keys(COLUMNS) as (keyof BspRow)[]).filter((f) => index[f] === undefined);

  const errors: string[] = [];
  if (index.documentNo === undefined) {
    errors.push('No document-number column. BSP is keyed on the document number and nothing can be matched without it.');
  }

  const cell = (r: string[], f: keyof BspRow) => {
    const at = index[f];
    return at === undefined ? '' : (r[at] ?? '').trim();
  };

  const rows: BspRow[] = table.slice(1).map((r, i) => {
    const base = num(cell(r, 'baseFare'));
    const tax = num(cell(r, 'tax'));
    const comm = num(cell(r, 'commission'));
    const netCell = cell(r, 'netRemit');
    return {
      line: i + 2,
      documentNo: cell(r, 'documentNo').replace(/[\s-]/g, ''),
      type: TYPE[cell(r, 'type').toLowerCase()] ?? 'OTHER',
      carrier: cell(r, 'carrier').toUpperCase(),
      issueDate: cell(r, 'issueDate'),
      currency: cell(r, 'currency').toUpperCase(),
      baseFare: base,
      tax,
      commission: comm,
      // Derived when the file does not state it, which several exports do not.
      netRemit: netCell ? num(netCell) : base + tax - comm,
      formOfPayment: cell(r, 'formOfPayment'),
      period: cell(r, 'period'),
      pnr: cell(r, 'pnr').toUpperCase()
    };
  }).filter((r) => r.documentNo);

  if (!rows.length && !errors.length) errors.push('No rows carried a document number.');
  return { rows, unmapped, missing, errors };
}

/* ------------------------------------------------------------------- matching */

export type MatchKind = 'exact' | 'provisional' | 'disputed' | 'onlyInBsp' | 'onlyInBook';

export type MatchRow = {
  kind: MatchKind;
  bsp?: BspRow;
  doc?: TravelDocument;
  /** What our book says the airline is owed, when we know. */
  bookNet: number | null;
  bspNet: number | null;
  difference: number | null;
  note: string;
};

/**
 * The three-way match, at document level.
 *
 * Three sources: what the GDS sold, what our book recorded, and what IATA will
 * bill. Our document table already IS the second, and it was built from the first
 * — a document is created from the supplier's own quote at the moment of booking —
 * so the remaining join is against the billing file.
 *
 * Every row lands in exactly one bucket, and each bucket is a different action:
 *
 *   exact        nothing to do
 *   disputed     the amounts differ — raise it before the remittance date or pay it
 *   onlyInBsp    IATA is billing something the book has never seen: somebody issued
 *                outside the system, or the document number was mistyped
 *   onlyInBook   we recorded a sale IATA has not billed: unbilled, or it fell into
 *                a different reporting period
 *   provisional  matched on PNR because our document has no ticket number yet. A
 *                PNR is not a document number — two tickets on one booking both
 *                match it — so this is a hint, never a settlement.
 */
export function matchToBook(book: Book, rows: BspRow[]): { rows: MatchRow[]; summary: Record<string, number> } {
  const docs = documents(book);
  const byNumber = new Map<string, TravelDocument>();
  const byPnr = new Map<string, TravelDocument[]>();
  for (const d of docs) {
    if (d.documentNo) byNumber.set(d.documentNo.replace(/[\s-]/g, ''), d);
    if (d.pnr) byPnr.set(d.pnr.toUpperCase(), [...(byPnr.get(d.pnr.toUpperCase()) ?? []), d]);
  }

  const bookNetOf = (d: TravelDocument): number | null => {
    const gross = documentGross(d);
    if (gross === null) return null;
    return Math.round(gross - (d.commissionAmt ?? 0));
  };

  const out: MatchRow[] = [];
  const usedDocs = new Set<string>();

  for (const r of rows) {
    const exact = byNumber.get(r.documentNo);
    if (exact) {
      usedDocs.add(exact.id);
      const bookNet = bookNetOf(exact);
      const diff = bookNet === null ? null : r.netRemit - bookNet;
      out.push(
        diff !== null && diff !== 0
          ? { kind: 'disputed', bsp: r, doc: exact, bookNet, bspNet: r.netRemit, difference: diff,
              note: `IATA will take ${r.netRemit.toLocaleString('en-IN')}; the book says ${bookNet!.toLocaleString('en-IN')}.` }
          : { kind: 'exact', bsp: r, doc: exact, bookNet, bspNet: r.netRemit, difference: diff,
              note: bookNet === null ? 'Matched on document number; the book has no fare split to compare.' : 'Matched, amounts agree.' }
      );
      continue;
    }

    /**
     * Three constraints on the PNR fallback, every one of them found by running a
     * test file through it rather than by reading the code.
     *
     * A MEMO MUST NOT MATCH A TICKET. An ADM is a claim raised AGAINST a ticket, not
     * the ticket itself. The first version matched an ADM to a document by PNR and
     * reported the difference between a 2,500 memo and a 36,599 fare as if it were
     * a pricing dispute. Memos get their own documents in step 5; until then they
     * are correctly unmatched.
     *
     * A DOCUMENT MUST NOT MATCH TWICE. Two BSP rows sharing a PNR both matched the
     * same document, so one sale looked like two. The used set now guards the PNR
     * pass, not only the leftovers sweep.
     *
     * And still only when exactly one candidate exists, because a PNR can carry
     * several tickets and a guess here becomes a settlement.
     */
    const isSale = r.type === 'TKT' || r.type === 'EMD';
    const candidates = (byPnr.get(r.pnr) ?? []).filter((d) => !d.documentNo && !usedDocs.has(d.id));
    if (isSale && r.pnr && candidates.length === 1) {
      usedDocs.add(candidates[0].id);
      const bookNet = bookNetOf(candidates[0]);
      out.push({
        kind: 'provisional', bsp: r, doc: candidates[0], bookNet, bspNet: r.netRemit,
        difference: bookNet === null ? null : r.netRemit - bookNet,
        note: `Matched on PNR ${r.pnr} because the book has no ticket number for it. Confirm before settling.`
      });
      continue;
    }

    out.push({
      kind: 'onlyInBsp', bsp: r, bookNet: null, bspNet: r.netRemit, difference: null,
      note: !isSale
        ? `A ${r.type} is a memo raised against a ticket, not a ticket. It needs its own document before it can be matched.`
        : r.pnr && candidates.length > 1
          ? `PNR ${r.pnr} matches ${candidates.length} documents, so it cannot be matched safely.`
          : 'IATA is billing a document this book has never seen. Issued outside the system, or a wrong number.'
    });
  }

  for (const d of docs) {
    if (usedDocs.has(d.id)) continue;
    if (d.status === 'void' || d.status === 'booked') continue;
    out.push({
      kind: 'onlyInBook', doc: d, bookNet: bookNetOf(d), bspNet: null, difference: null,
      note: 'Recorded as issued here but not on this billing. Unbilled, or a different reporting period.'
    });
  }

  const summary: Record<string, number> = { exact: 0, provisional: 0, disputed: 0, onlyInBsp: 0, onlyInBook: 0 };
  for (const r of out) summary[r.kind] += 1;
  summary.bspNetTotal = rows.reduce((t, r) => t + r.netRemit, 0);
  summary.disputedBy = out.filter((r) => r.kind === 'disputed').reduce((t, r) => t + Math.abs(r.difference ?? 0), 0);
  summary.unmatchedValue = out.filter((r) => r.kind === 'onlyInBsp').reduce((t, r) => t + (r.bspNet ?? 0), 0);
  /**
   * Differences on provisional matches, counted separately.
   *
   * They are not disputes — the join is a PNR and might be wrong, so calling them
   * disputes would send somebody to argue with an airline over a match this code
   * already says not to trust. But a screen showing "in dispute: 0" beside a row
   * with a 1,200 gap reads as a bug, which is what the first run of this looked
   * like. Surfaced under its own name instead.
   */
  summary.provisionalDiff = out
    .filter((r) => r.kind === 'provisional')
    .reduce((t, r) => t + Math.abs(r.difference ?? 0), 0);

  const order: MatchKind[] = ['disputed', 'onlyInBsp', 'provisional', 'onlyInBook', 'exact'];
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { rows: out, summary };
}

/** Only a taxTotal re-export away from being useful in a per-tax comparison later. */
export { taxTotal };
