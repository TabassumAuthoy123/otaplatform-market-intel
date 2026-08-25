import Link from 'next/link';

/**
 * The named queries a person actually re-runs, as one click each.
 *
 * WHY THESE ARE NOT JUST FILTERS
 *
 * The filter row underneath can already express every one of these. That is exactly
 * why they exist: the admin portal's lead list has "P1 queue (open)", "Due today or
 * overdue", "Never touched", "Abandoned — no next action" and "Hot leads", and nobody
 * rebuilds those out of six dropdowns every morning. A saved view is a QUESTION with a
 * name on it — the filter row is the machinery for asking a new one.
 *
 * The panel's own screens had none of them. The market-intelligence dashboard had no
 * search, no filters and one export format; the accounting landing had no way to look
 * anything up at all. Both were built to be read top to bottom, which is fine on the
 * day the data arrives and useless every day after.
 *
 * Each view carries a `count` where one is cheap to compute, because a queue with a
 * number on it is a decision and a queue without one is a guess. Where counting would
 * mean a second pass over the whole book it is left off rather than faked.
 */
export type SavedView = {
  label: string;
  /** Full href including the query string, so a view can set several params at once. */
  href: string;
  active: boolean;
  /** How many rows it would return. Omitted where counting is not cheap. */
  count?: number;
  /** Shown on hover — what question this view is asking. */
  title?: string;
};

export function SavedViews({ views, label = 'Saved views' }: { views: SavedView[]; label?: string }) {
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</span>
      {views.map((v) => (
        <Link
          key={v.label}
          href={v.href}
          title={v.title}
          className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
            v.active
              ? 'bg-navy-900 text-white'
              : 'border border-hair bg-white text-navy-900 hover:border-teal-500 hover:text-teal-700'
          }`}
        >
          {v.label}
          {v.count !== undefined && (
            <span className={`ml-1.5 ${v.active ? 'text-white/60' : 'text-muted'}`}>{v.count}</span>
          )}
        </Link>
      ))}
    </div>
  );
}
