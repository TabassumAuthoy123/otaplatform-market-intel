/**
 * The year-end close, in the portal.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * admin/server.js is six thousand lines and every screen in it is one more. This one also has
 * a property worth isolating: it is the only portal screen that derives NO accounting figure
 * of its own. Keeping it separate makes that checkable by reading one file rather than by
 * trusting a convention.
 *
 * WHAT A CLOSE IS HERE
 *
 * It records what both derivations said about the year at the moment it was filed, seals the
 * period against edits, and moves the year's name forward. IT POSTS NOTHING.
 *
 * A closing voucher — the obvious implementation — would land on SALES, on SALES_RETURNS, on
 * every EXP:* category, on AR, on AP, on CUSTOMER_CREDIT and on every bank. All of those are
 * control accounts, so every closed year would add twenty-odd permanent rows to the
 * reconciling-items list. reconciliation() would stay green, because control + adjustment −
 * ledger nets to zero either way — but that list exists so a person reads it item by item, and
 * burying it under annual housekeeping is how it stops being read. The repo says as much about
 * a different feature and the reasoning transfers whole.
 *
 * So the cut is EVIDENCE, and the rule that keeps it honest is:
 *
 *   THE CUT EXPORTS A DATE TO THE REPORTS AND A FIGURE TO NOTHING.
 *
 * balanceSheet splits retained earnings at the close date and re-derives both halves from the
 * same journal. It never reads the recorded profit, even though the two must be equal. They
 * must be equal, and closedYearDrift is where that is asserted rather than assumed.
 */

const FY = require('../lib/financial-year.js');

/* ------------------------------------------------------------------ rendering */

const money = (v, sym) =>
  `${v < 0 ? '-' : ''}${sym}${Math.abs(Math.round(Number(v) || 0)).toLocaleString('en-IN')}`;

function filedTable(deps, book, drift, session) {
  const { esc, csrfFor } = deps;
  const sym = (book.company && book.company.currencySymbol) || '৳';
  const filed = FY.closes(book);

  if (!filed.length) {
    return `<tr><td colspan="5" class="sub">No year has been closed. Every voucher in the book can
      still be edited, which means a June figure can change months after it was reported.</td></tr>`;
  }

  return filed
    .map((c) => {
      const d = (drift || []).find((x) => x.cut && x.cut.id === c.id);
      const moved = (d && d.moved) || [];
      const since = c.reopened
        ? `<span style="color:#b91c1c;font-weight:600">reopened</span>
           <br><span class="sub">${esc(c.reopened.reason || '')}</span>`
        : moved.length
          ? `<span style="color:#b91c1c;font-weight:600">${moved.length} figure(s) have moved since</span>
             <ul class="sub" style="margin:4px 0 0 16px">${moved
               .slice(0, 6)
               .map((m) => `<li>${esc(m.what)}: filed ${money(m.filed, sym)}, now ${money(m.now, sym)}</li>`)
               .join('')}</ul>`
          : '<span style="color:#047857">still derives to what was filed</span>';

      const reopen = c.reopened
        ? ''
        : `<form method="post" action="/year-end/reopen">
             <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
             <input type="hidden" name="id" value="${esc(c.id)}">
             <input type="text" name="reason" placeholder="why, in writing" required minlength="12" style="width:180px">
             <button type="submit" class="secondary">Reopen</button>
           </form>`;

      return `<tr>
        <td><strong>${esc(c.label)}</strong><br><span class="sub">through ${esc(c.closedThrough)}</span></td>
        <td class="tnum">${money(c.ledger.yearProfit, sym)}</td>
        <td>${esc(String(c.closedBy))}<br><span class="sub">${esc(String(c.closedAt).slice(0, 16).replace('T', ' '))}</span></td>
        <td>${since}</td>
        <td>${reopen}</td>
      </tr>`;
    })
    .join('');
}

function closeForm(deps, book, p, session) {
  const { esc, csrfFor } = deps;
  const sym = (book.company && book.company.currencySymbol) || '৳';
  const m = (v) => money(v, sym);

  const refusals = (p && p.refusals) || [];
  const agree = p.ledger.yearProfit === p.control.netProfit;
  const blocked = refusals.length > 0 || !agree;

  const halfEntries = (p.halfEntries || [])
    .map(
      (h, i) => `
      <label class="row" style="margin:0 0 10px">
        <span class="lab">${esc(h.account)} ${m(h.amount)}</span>
        <input type="text" name="ack_${i}" required minlength="20"
               placeholder="what you know about this, at least 20 characters">
      </label>`
    )
    .join('');

  return `
  <form method="post" action="/year-end/close">
    <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
    <input type="hidden" name="through" value="${esc(p.through)}">
    <input type="hidden" name="revision" value="${esc(String(p.bookRevision))}">
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:14px;color:var(--navy)">Close the year ending ${esc(p.through)}</h2>
      <p class="sub" style="margin:0 0 14px">
        The next year would open on ${esc(p.opensOn)}. Everything on or before ${esc(p.through)}
        would refuse edits — the lock includes its own last day.
      </p>

      ${refusals.length
        ? `<div class="flash warn"><strong>This year cannot be closed yet:</strong>
           <ul style="margin:6px 0 0 16px">${refusals.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
        : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:14px 0">
        <div>
          <div class="sub" style="font-weight:600;color:var(--navy)">What the journal says</div>
          <table class="grid"><tbody>
            <tr><td>Income to ${esc(p.through)}</td><td class="tnum">${m(p.ledger.income)}</td></tr>
            <tr><td>Expense to ${esc(p.through)}</td><td class="tnum">${m(p.ledger.expense)}</td></tr>
            <tr><td><strong>Result for the year</strong></td><td class="tnum"><strong>${m(p.ledger.yearProfit)}</strong></td></tr>
          </tbody></table>
        </div>
        <div>
          <div class="sub" style="font-weight:600;color:var(--navy)">What the vouchers say</div>
          <table class="grid"><tbody>
            <tr><td>Sales</td><td class="tnum">${m(p.control.sales)}</td></tr>
            <tr><td>Cost, expenses and memos</td><td class="tnum">${m(p.control.cost + p.control.expenses + p.control.memoCost)}</td></tr>
            <tr><td><strong>Net profit</strong></td><td class="tnum"><strong>${m(p.control.netProfit)}</strong></td></tr>
          </tbody></table>
        </div>
      </div>

      <p class="sub" style="margin:0 0 14px">${
        agree
          ? `Both routes to the year's result agree at <strong>${m(p.ledger.yearProfit)}</strong>.
             That agreement is what is being filed: one number is a claim, two derived independently
             and landing in the same place is evidence.`
          : `<strong style="color:#b91c1c">The two derivations disagree by ${m(
              p.ledger.yearProfit - p.control.netProfit
            )}.</strong> Closing would file a year the book cannot agree with itself about, so it is refused.`
      }</p>

      <table class="grid">
        <thead><tr><th>Carried forward at ${esc(p.through)}</th><th class="tnum">Balance</th></tr></thead>
        <tbody>${p.ledger.positions
          .map((x) => `<tr><td>${esc(x.name)} <span class="sub">${esc(x.code)}</span></td><td class="tnum">${m(x.balance)}</td></tr>`)
          .join('')}</tbody>
      </table>

      <p class="sub" style="margin:12px 0 0">
        ${esc(String(p.counted.vouchers))} voucher(s) and ${esc(String(p.counted.journalEntries))}
        journal entr(ies) fall inside this year. The reconciliation
        ${p.statements.reconciliationClean ? 'is clean' : '<strong style="color:#b91c1c">does not agree</strong>'},
        the journal trial balance differs by ${m(p.statements.journalTrialBalanceDifference)},
        and the balance sheet by ${m(p.statements.balanceSheetDifference)}.
      </p>

      ${halfEntries
        ? `<div style="margin-top:14px;padding:12px 14px;border-left:3px solid var(--amber);background:var(--panel)">
             <strong style="color:var(--navy)">${p.halfEntries.length} account(s) in this year hold a
             balance only a missing entry explains.</strong>
             <p class="sub" style="margin:6px 0 10px">Sealing the year seals these too. Say in writing that
             you have seen each one — refusing outright would only teach people to close a year they had
             not looked at.</p>
             ${halfEntries}
           </div>`
        : ''}

      <div class="bar" style="margin-top:16px">
        <button class="primary" type="submit"${blocked ? ' disabled' : ''}>Close ${esc(p.through)}</button>
        <span style="margin-left:auto;font-size:12px;color:var(--muted)">
          Closing and reopening are both audited, and a filed year is never deleted.
        </span>
      </div>
    </div>
  </form>`;
}

function view(deps, session, state) {
  const { esc, page } = deps;
  const book = state.book;
  const p = state.preview;

  const body = `
    <h1>Year end</h1>
    <p class="sub" style="max-width:72ch">
      Closing a year records what both derivations said about it, seals the period against edits, and
      moves the year's name forward. <strong>It posts nothing.</strong> Every figure on every report
      stays derived from the same vouchers it always was — what changes is that retained earnings
      splits into what last year made and what this one has.
    </p>

    ${state.error ? `<div class="flash warn"><strong>Not closed:</strong> ${esc(state.error)}</div>` : ''}
    ${state.saved ? `<div class="flash"><strong>${esc(state.saved)}</strong></div>` : ''}

    <div class="card">
      <h2 style="margin:0 0 4px;font-size:14px;color:var(--navy)">Years already filed</h2>
      <p class="sub" style="margin:0 0 12px">
        A filed year is re-derived every time this page loads. If it no longer comes to what was filed,
        that is said here — the period lock guards the dates a record carries, and a date can reach a
        closed year without being on the record that was written.
      </p>
      <table class="grid">
        <thead><tr><th>Year</th><th class="tnum">Result</th><th>Filed by</th><th>Since then</th><th></th></tr></thead>
        <tbody>${filedTable(deps, book, state.drift, session)}</tbody>
      </table>
    </div>

    ${p && p.through
      ? closeForm(deps, book, p, session)
      : `<div class="card"><p class="sub">${esc(
          (p && p.error) || 'There is no finished year to close yet.'
        )}</p></div>`}
  `;

  return page({ title: 'Year end', session, active: 'year-end', body });
}

module.exports = { view, money };
