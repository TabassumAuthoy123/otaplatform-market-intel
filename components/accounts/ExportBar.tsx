/**
 * Download the book in whatever shape the person on the other end needs.
 *
 * Four formats because four different people ask for this: the accountant
 * wants the Excel to work in, the owner wants a Word pack to read, a developer
 * wants the Markdown, and somebody's ancient software only imports CSV.
 * They are all built from the same derivation, so the figures cannot differ.
 */
export function ExportBar({
  section,
  from,
  to,
  label = 'Download'
}: {
  /** Narrow to one ledger — omit for the whole book. */
  section?: string;
  from?: string;
  to?: string;
  label?: string;
}) {
  const qs = (format: string) => {
    const p = new URLSearchParams({ format });
    if (section) p.set('section', section);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return `/api/accounts/export?${p.toString()}`;
  };

  const btn =
    'rounded-lg border border-hair bg-white px-3.5 py-2 text-[12.5px] font-semibold text-navy-900 transition-colors hover:border-teal-500 hover:text-teal-700';

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</span>
      <a href={qs('xlsx')} className={btn}>Excel</a>
      <a href={qs('docx')} className={btn}>Word</a>
      <a href={qs('md')} className={btn}>Markdown</a>
      <a href={qs('csv')} className={btn}>CSV</a>
      {(from || to) && (
        <span className="text-[11.5px] text-muted">
          {from || 'start'} → {to || 'today'}
        </span>
      )}
    </div>
  );
}
