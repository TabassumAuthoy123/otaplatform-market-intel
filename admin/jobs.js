'use strict';

/**
 * The checks that used to happen only when somebody remembered to look.
 *
 * Nothing in this platform ran on a timer. Every figure is derived at request
 * time, which is the right design for correctness and a bad one for noticing:
 * if the trial balance broke at 2am, or a supplier credential expired, or an
 * inventory block ran out with stock still on it, the first anyone knew was the
 * next time a human opened the right screen. On a quiet week that is days.
 *
 * TWO RULES THESE JOBS FOLLOW
 *
 * 1. A job DERIVES the problem and only STORES the fact that it was first seen.
 *    Storing "the trial balance is broken" would go stale the moment somebody
 *    fixed it. Each job returns the alerts that are true right now; the store
 *    keeps `firstSeen` and any acknowledgement, and anything no longer returned
 *    is closed automatically.
 *
 * 2. A job that throws is itself an alert. A silent scheduler is worse than no
 *    scheduler, because the screen looks calm either way.
 */

const path = require('node:path');
const clock = require('./clock.js');

const money = (n, sym = '৳') => `${n < 0 ? '-' : ''}${sym}${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/**
 * Every job. `key` is stable and is what an alert is grouped under, so re-running
 * a job replaces its own alerts and never touches another job's.
 */
function jobs(ctx) {
  const { readJson, contentDir, appUrl } = ctx;
  const book = () => readJson(path.join(contentDir, 'accounting.json'), {});
  const zone = () => (book().company && book().company.timezone) || clock.DEFAULT_ZONE;
  const today = () => clock.todayIn(zone());

  return [
    /* ------------------------------------------------------------ integrity */
    {
      key: 'integrity',
      label: 'Book integrity',
      everyMinutes: 30,
      why: 'A trial balance that stops balancing is the single most important thing to know early, and it was only visible to whoever next opened the financials page.',
      async run() {
        // Asks the app, so the check uses exactly the derivations the screens
        // use rather than a second implementation that could disagree.
        const res = await fetch(`${appUrl}/api/accounts/export?format=csv&section=reconciliation`);
        if (!res.ok) throw new Error(`the app answered HTTP ${res.status} — cannot verify the book`);
        const rows = (await res.text()).split(/\r?\n/).slice(1).filter((l) => l.includes(','));
        if (rows.length === 0) throw new Error('the reconciliation report came back empty');

        const out = [];
        for (const line of rows) {
          const c = line.replace(/"/g, '').split(',');
          const name = c[0];
          const diff = Number(c[3]);
          if (!name || !Number.isFinite(diff) || diff === 0) continue;
          out.push({
            id: `integrity:${name}`,
            severity: 'critical',
            title: `${name} does not reconcile`,
            detail:
              `The control-account total and the journal disagree by ${money(diff)}. Two independent derivations of ` +
              `the same vouchers should never differ. Do not file anything from these accounts until it is explained.`,
            where: '/accounts/financials'
          });
        }
        return out;
      }
    },

    /* ---------------------------------------------------- ticketing deadline */
    {
      key: 'ticketing_deadline',
      label: 'Held bookings past ticketing',
      everyMinutes: 60,
      why: 'A held booking is only worth something until the supplier ticketing deadline. Nothing was watching it, and the deadline was not even being stored.',
      async run() {
        const bookings = readJson(path.join(contentDir, 'bookings.json'), []);
        const t = today();
        const out = [];
        for (const b of bookings) {
          if (b.status === 'cancelled' || b.ticketed) continue;
          const raw = (b.fare && b.fare.latestTicketing) || '';
          const deadline = raw ? String(raw).slice(0, 10) : null;

          if (!deadline) {
            out.push({
              id: `ticketing:unknown:${b.ref}`,
              severity: 'info',
              title: `${b.ref} has no ticketing deadline on file`,
              detail:
                `The supplier quoted no latest-ticketing date, or this hold was taken before the date was being ` +
                `stored. Re-price it before promising the fare.`,
              where: `/portal/booking?ref=${encodeURIComponent(b.ref)}`
            });
            continue;
          }
          const days = Math.round((Date.parse(deadline) - Date.parse(t)) / 86400000);
          if (days < 0) {
            out.push({
              id: `ticketing:expired:${b.ref}`,
              severity: 'critical',
              title: `${b.ref} passed its ticketing deadline ${Math.abs(days)} day(s) ago`,
              detail:
                `Deadline was ${deadline}. The fare is gone, so the hold and its invoice describe a price that no ` +
                `longer exists. Re-price or raise a credit note.`,
              where: `/portal/booking?ref=${encodeURIComponent(b.ref)}`
            });
          } else if (days <= 2) {
            out.push({
              id: `ticketing:soon:${b.ref}`,
              severity: 'warning',
              title: `${b.ref} must be ticketed ${days === 0 ? 'today' : `within ${days} day(s)`}`,
              detail: `Deadline ${deadline}. After it the fare is gone.`,
              where: `/portal/booking?ref=${encodeURIComponent(b.ref)}`
            });
          }
        }
        return out;
      }
    },

    /* -------------------------------------------------------- receivables */
    {
      key: 'overdue',
      label: 'Overdue receivables',
      everyMinutes: 12 * 60,
      why: 'The chase list only existed while somebody had the page open. An invoice past terms needs to arrive at the manager rather than wait to be found.',
      async run() {
        const b = book();
        const cfg = (b.company && b.company.reminders) || { dueAfterDays: 14, escalateAfterDays: 30, chaseFrom: 0 };
        const t = today();
        const sym = (b.company && b.company.currencySymbol) || '৳';

        const paidOn = {};
        for (const r of b.receipts || []) paidOn[r.invoiceId] = (paidOn[r.invoiceId] || 0) + r.amount;
        const creditOn = {};
        for (const c of b.creditNotes || []) {
          if (c.settlement === 'credit_balance') creditOn[c.invoiceId] = (creditOn[c.invoiceId] || 0) + c.amount;
        }

        let worst = null;
        let total = 0;
        let count = 0;
        for (const inv of b.invoices || []) {
          if (inv.status === 'draft' || inv.status === 'cancelled') continue;
          const gross = (inv.lines || []).reduce((x, l) => x + l.qty * l.unitPrice, 0);
          const tot = gross + Math.round((gross * (inv.vatRate || 0)) / 100);
          const due = Math.max(0, tot - (paidOn[inv.id] || 0) - (creditOn[inv.id] || 0));
          if (due <= (cfg.chaseFrom || 0)) continue;
          const age = Math.round((Date.parse(t) - Date.parse(inv.date)) / 86400000);
          if (age < cfg.escalateAfterDays) continue;
          count += 1;
          total += due;
          if (!worst || due > worst.due) worst = { no: inv.no, due, age };
        }

        if (count === 0) return [];
        return [{
          id: 'overdue:escalate',
          severity: 'warning',
          title: `${count} invoice(s) past ${cfg.escalateAfterDays} days — ${money(total, sym)} outstanding`,
          detail:
            `Largest is ${worst.no} at ${money(worst.due, sym)}, ${worst.age} days old. The reminders screen composes ` +
            `the message; nothing sends it, so somebody has to.`,
          where: '/accounts/reminders'
        }];
      }
    },

    /* --------------------------------------------------------- inventory */
    {
      key: 'inventory',
      label: 'Inventory expiry',
      everyMinutes: 12 * 60,
      why: 'Unsold stock with an expiry date is cash on a shelf. The screen showed it; nothing warned before the date passed.',
      async run() {
        const b = book();
        const t = today();
        const sym = (b.company && b.company.currencySymbol) || '৳';
        const out = [];
        for (const item of b.inventory || []) {
          const remaining = Number(item.purchased || 0) - Number(item.sold || 0);
          if (remaining <= 0) continue;
          const atRisk = remaining * Number(item.unitCost || 0);
          const days = item.expiresOn
            ? Math.round((Date.parse(item.expiresOn) - Date.parse(t)) / 86400000)
            : null;
          if (days === null) continue;
          if (days < 0) {
            out.push({
              id: `inventory:expired:${item.id}`,
              severity: 'critical',
              title: `${item.name} expired with ${remaining} unsold`,
              detail: `Expired ${item.expiresOn}. ${money(atRisk, sym)} at cost is now unsellable unless the supplier extends it.`,
              where: '/accounts/inventory'
            });
          } else if (days <= 14) {
            out.push({
              id: `inventory:soon:${item.id}`,
              severity: 'warning',
              title: `${item.name} expires in ${days} day(s) with ${remaining} unsold`,
              detail: `${money(atRisk, sym)} at cost still on the shelf. Discount it or hand it back.`,
              where: '/accounts/inventory'
            });
          }
        }
        return out;
      }
    },

    /* --------------------------------------------------------- GDS health */
    {
      key: 'gds',
      label: 'Supplier connections',
      everyMinutes: 60,
      why: 'A GDS credential that stops working looks identical to a route with no inventory until somebody reads the panel. The storefront would simply show fewer fares.',
      async run() {
        const depart = (() => {
          const d = new Date(Date.parse(today()) + 45 * 86400000);
          return d.toISOString().slice(0, 10);
        })();
        const res = await fetch(`${appUrl}/portal/flights?from=DAC&to=DXB&depart=${depart}&pax=1`);
        if (!res.ok) throw new Error(`the storefront answered HTTP ${res.status}`);
        const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, '');

        const out = [];
        for (const label of ['Travelport', 'Sabre']) {
          const m = new RegExp(
            `border-l-\\[3px\\][\\s\\S]{0,400}?>${label}</span><span class="tnum text-\\[13\\.5px\\][^>]*>([^<]+)<`
          ).exec(html);
          const said = m ? m[1].trim() : null;
          if (!said) {
            out.push({
              id: `gds:missing:${label}`,
              severity: 'warning',
              title: `${label} did not report a status`,
              detail: 'The supplier panel was not rendered at all, which usually means the credentials are unset.',
              where: '/accounts/gds'
            });
            continue;
          }
          const fares = /(\d+)\s+fares/.exec(said);
          if (!fares || Number(fares[1]) === 0) {
            out.push({
              id: `gds:zero:${label}`,
              severity: 'warning',
              title: `${label} returned no fares on DAC–DXB`,
              detail:
                `The panel said "${said}". This route normally returns fares from both suppliers, so zero here is ` +
                `more likely a credential or entitlement change than missing inventory.`,
              where: '/accounts/gds'
            });
          }
        }
        return out;
      }
    },

    /* ------------------------------------------------------------- backup */
    {
      key: 'backup',
      label: 'Daily backup',
      everyMinutes: 24 * 60,
      why: 'The only backup was a button somebody had to press. A backup nobody takes is not a backup.',
      async run() {
        // Writing the file is the job's real work; the alert is only raised when
        // it could not be written, because a silent backup failure is the whole
        // problem this job exists to avoid.
        const written = await ctx.writeDailyBackup();
        if (!written.ok) {
          return [{
            id: 'backup:failed',
            severity: 'critical',
            title: 'The daily backup could not be written',
            detail: `${written.error} Nothing else on this list matters if the book cannot be restored.`,
            where: '/backup'
          }];
        }
        return [];
      }
    }
  ];
}

module.exports = { jobs };
