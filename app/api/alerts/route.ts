import path from 'node:path';
import { NextResponse } from 'next/server';
import { readJsonCached } from '@/lib/jsonStore';

/**
 * What the scheduled checks have found, for the accounts dashboard.
 *
 * The scheduler lives in the admin portal on :4001 and writes
 * content/alerts.json; this reads that file rather than calling across, so the
 * accounts pages never depend on the admin portal being up.
 *
 * `staleMinutes` is the important field. If the scheduler stops, the file simply
 * stops changing and the alert list goes quiet — which looks exactly like a
 * healthy book. Reporting how long ago the last pass finished is what makes the
 * difference visible, and it is the one thing worth being loud about.
 */
export const dynamic = 'force-dynamic';

type Alert = {
  id: string;
  job: string;
  jobLabel: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  where?: string;
  firstSeen: string;
  lastSeen: string;
};

export async function GET() {
  const dir = path.join(process.cwd(), 'content');

  const store = await readJsonCached<{ open?: Alert[]; acknowledged?: Record<string, unknown> }>(
    path.join(dir, 'alerts.json'),
    { open: [], acknowledged: {} }
  );
  const state = await readJsonCached<{ lastTickAt?: string }>(path.join(dir, 'scheduler-state.json'), {});

  const acked = store.acknowledged ?? {};
  const open = (store.open ?? []).filter((a) => !acked[a.id]);
  const staleMinutes = state.lastTickAt ? Math.round((Date.now() - Date.parse(state.lastTickAt)) / 60000) : null;

  return NextResponse.json({
    open,
    counts: {
      critical: open.filter((a) => a.severity === 'critical').length,
      warning: open.filter((a) => a.severity === 'warning').length,
      info: open.filter((a) => a.severity === 'info').length,
      acknowledged: Object.keys(acked).length
    },
    lastCheckAt: state.lastTickAt ?? null,
    staleMinutes,
    // The tick is every minute. Ten without one means it is not running.
    schedulerLooksStopped: staleMinutes === null || staleMinutes > 10
  });
}
