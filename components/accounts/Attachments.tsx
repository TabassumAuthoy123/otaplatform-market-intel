import type { Attachment } from '@/lib/accounting';

/**
 * Where a voucher's paperwork lives.
 *
 * These are references, not uploads. The admin portal is deliberately
 * zero-dependency plain Node, and accepting binary uploads into it would mean
 * multipart parsing, a storage path, size limits and a way to serve files back
 * — a lot of surface area for something agencies already solve by keeping the
 * scan on a shared drive. A link to the real location is honest and useful;
 * pretending to be a document store would not be.
 *
 * A `file://` path opens from the machine it points at, which is exactly what
 * an office share is. It will not open from another computer, and that is a
 * property of the link, not a bug here.
 */
export function Attachments({ items }: { items?: Attachment[] }) {
  const rows = (items ?? []).filter((a) => a && a.name && a.url);
  if (rows.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {rows.map((a, i) => (
        <a
          key={i}
          href={a.url}
          target="_blank"
          rel="noreferrer"
          title={a.note || a.url}
          className="inline-flex items-center gap-1 rounded border border-hair bg-panel px-1.5 py-0.5 text-[11px] text-navy-900 hover:border-teal-500 hover:text-teal-700"
        >
          <span aria-hidden>📎</span>
          {a.name}
        </a>
      ))}
    </div>
  );
}
