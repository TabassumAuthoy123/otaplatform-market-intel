'use strict';

/**
 * The admin portal's copy of lib/clock.ts.
 *
 * Duplicated deliberately: this server is plain CommonJS with no build step and
 * cannot import a TypeScript module. Six lines of duplication beats making the
 * admin portal depend on the Next build. scripts/verify-srs.mjs asserts the two
 * return the same answer, so they cannot drift apart unnoticed.
 *
 * Why it exists at all: dates were UTC, Bangladesh is UTC+6, so anything
 * recorded between midnight and 6am Dhaka time was dated to the previous day.
 */

const DEFAULT_ZONE = 'Asia/Dhaka';

function todayIn(zone = DEFAULT_ZONE, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}

function stampIn(zone = DEFAULT_ZONE, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(at);
  const p = (t) => (parts.find((x) => x.type === t) || {}).value || '00';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}:${p('second')}`;
}

module.exports = { DEFAULT_ZONE, todayIn, stampIn };
