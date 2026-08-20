/**
 * The period-lock guard, shared by the Next app and the admin portal.
 *
 * Two processes write to the book and both must refuse the same dates. Written
 * twice, a guard drifts, and a drifted guard is a hole — the admin would accept an
 * edit the app rejects, or the reverse, and the failure is silent either way.
 *
 * Same reasoning and same mechanism as lib/panel-modules.js: plain CommonJS, which
 * `require()` reads directly and which `allowJs` lets the TypeScript side import.
 * `lib/periodlock.ts` adds the types and the reporting helpers on top.
 */

/** Is this date inside a closed period? */
function isLocked(lockedThrough, dateISO) {
  return Boolean(lockedThrough && dateISO && String(dateISO) <= String(lockedThrough));
}

/**
 * May a record carrying these dates be written?
 *
 * Takes a list so one call guards a create, an edit and a delete — and so the OLD
 * date is checked too. Moving a voucher out of a locked month is the same
 * restatement as editing it there, and a guard that only looked at the incoming
 * value would wave it through.
 */
function mayWrite(lockedThrough, dates) {
  if (!lockedThrough) return { ok: true, reason: 'No period is closed.', lockedThrough: null };

  const offending = (dates || []).filter((d) => d && String(d) <= String(lockedThrough));
  if (!offending.length) {
    return { ok: true, reason: `Open period — everything on or before ${lockedThrough} is closed.`, lockedThrough };
  }

  return {
    ok: false,
    reason:
      `${offending[0]} falls in a closed period. Everything on or before ${lockedThrough} is locked, because those ` +
      `figures have been reported. To correct it, raise a dated adjustment in the open period — a credit note, a ` +
      `journal or a reversing voucher — which is what leaves an audit trail. Reopening the period is a deliberate ` +
      `act in Settings and should be a decision, not a side effect of an edit.`,
    lockedThrough
  };
}

/** Every date field a book record might carry, so a caller cannot forget one. */
function datesOf(rec) {
  if (!rec || typeof rec !== 'object') return [];
  return ['date', 'issueDate', 'travelDate', 'effectiveFrom']
    .map((k) => rec[k])
    .filter((v) => typeof v === 'string' && v.length >= 10);
}

module.exports = { isLocked, mayWrite, datesOf };
