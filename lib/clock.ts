/**
 * Dates in the company's own timezone, not the server's.
 *
 * Everything used to call `new Date().toISOString().slice(0, 10)`, which is UTC.
 * Bangladesh is UTC+6, so between midnight and 6am Dhaka time that returns
 * YESTERDAY. A receipt entered at 2am landed in the previous day's cash book,
 * and on the first of the month it landed in the previous month's P&L — a
 * closed, reported month.
 *
 * `Intl` is used rather than adding six hours by hand because it reads the real
 * zone database. Dhaka has no DST today, but it did run one in 2009, and a
 * hard-coded offset is a bug waiting for a policy change.
 *
 * admin/clock.js is the same logic for the admin portal, which is plain
 * CommonJS and cannot import this file. The two must agree; scripts/verify-srs
 * asserts that they do.
 */

export const DEFAULT_ZONE = 'Asia/Dhaka';

/** Calendar date in `zone`, as YYYY-MM-DD. */
export function todayIn(zone: string = DEFAULT_ZONE, at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is what every date field in this app uses.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(at);
}

/** Local wall-clock stamp, as YYYY-MM-DD HH:MM:SS — for "last edited" lines. */
export function stampIn(zone: string = DEFAULT_ZONE, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}:${p('second')}`;
}

/**
 * An ISO instant is still the right thing to store for a moment in time —
 * `createdAt` on a booking, `at` on an audit row. Only calendar DATES needed
 * fixing. This exists so the difference is explicit at the call site rather
 * than being a judgement call each time.
 */
export const nowInstant = (at: Date = new Date()): string => at.toISOString();
