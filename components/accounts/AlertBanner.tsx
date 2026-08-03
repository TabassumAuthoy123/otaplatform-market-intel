import path from 'node:path';
import { readJsonCached } from '@/lib/jsonStore';

type Alert = {
  id: string; jobLabel: string; severity: 'critical' | 'warning' | 'info';
  title: string; detail: string; where?: string; firstSeen: string;
};

const ADMIN = process.env.NEXT_PUBLIC_ADMIN_URL ?? 'http://127.0.0.1:4001';

/**
 * What the scheduled checks found, at the top of the dashboard.
 *
 * Reads the file the scheduler writes rather than calling the admin portal, so
 * the dashboard renders whether or not that process is up — and says so when it
 * is not. A quiet alert list and a dead scheduler look the same from here, and
 * only one of them is good news.
 */
export async function AlertBanner() {
  const dir = path.join(process.cwd(), 'content');
  const store = await readJsonCached<{ open?: Alert[]; acknowledged?: Record<string, unknown> }>(
    path.join(dir, 'alerts.json'),
    { open: [], acknowledged: {} }
  );
  const state = await readJsonCached<{ lastTickAt?: string }>(path.join(dir, 'scheduler-state.json'), {});

  const acked = store.acknowledged ?? {};
  const open = (store.open ?? []).filter((a) => !acked[a.id]);
  const stale = state.lastTickAt ? Math.round((Date.now() - Date.parse(state.lastTickAt)) / 60000) : null;
  const stopped = stale === null || stale > 10;

  if (!stopped && open.length === 0) {
    return (
      <div className="rounded-xl2 border-l-[3px] border-teal-600 bg-teal-600/5 px-5 py-3">
        <p className="text-[12.5px] text-ink">
          <span className="font-semibold text-navy-900">Checks are running.</span> Nothing open — last pass{' '}
          {stale === 0 ? 'under a minute' : `${stale} min`} ago. Book integrity, ticketing deadlines, overdue
          receivables, inventory expiry, supplier connections and the daily backup.
        </p>
      </div>
    );
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  const sorted = [...open].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const worst = sorted[0]?.severity ?? 'warning';
  const tone =
    stopped || worst === 'critical'
      ? 'border-red-600 bg-red-50'
      : worst === 'warning'
        ? 'border-amber-700 bg-amber-700/5'
        : 'border-hair bg-panel';

  return (
    <div className={`rounded-xl2 border-l-[3px] px-5 py-4 ${tone}`}>
      {stopped && (
        <p className="mb-2 text-[13px] font-bold text-red-800">
          The scheduled checks are not running{stale === null ? '' : ` — the last pass was ${stale} minutes ago`}.
          Nothing below is current, and an empty list would mean nothing. Start the admin portal on :4001.
        </p>
      )}
      {open.length > 0 && (
        <>
          <p className="text-[13px] font-semibold text-navy-900">
            {open.length} open {open.length === 1 ? 'alert' : 'alerts'} from the scheduled checks
          </p>
          <ul className="mt-2 space-y-1.5">
            {sorted.slice(0, 4).map((a) => (
              <li key={a.id} className="text-[12.5px] leading-relaxed">
                <span
                  className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    a.severity === 'critical'
                      ? 'bg-red-600 text-white'
                      : a.severity === 'warning'
                        ? 'bg-amber-700 text-white'
                        : 'bg-panel text-muted'
                  }`}
                >
                  {a.severity}
                </span>
                <span className="font-semibold text-navy-900">{a.title}</span>
                <span className="text-muted"> — {a.detail}</span>
                {a.where && (
                  <a href={a.where} className="ml-1 font-semibold text-teal-700 hover:underline">
                    open →
                  </a>
                )}
              </li>
            ))}
          </ul>
          {open.length > 4 && (
            <p className="mt-2 text-[12px] text-muted">and {open.length - 4} more</p>
          )}
        </>
      )}
      <a
        href={`${ADMIN}/alerts`}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block text-[12.5px] font-semibold text-teal-700 hover:underline"
      >
        All checks and their schedule →
      </a>
    </div>
  );
}
