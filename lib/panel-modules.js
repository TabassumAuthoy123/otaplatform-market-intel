/**
 * The one list of panel modules, shared by the Next app and the admin portal.
 *
 * WHY THIS IS PLAIN COMMONJS AND NOT TYPESCRIPT
 *
 * Two processes need this list and they cannot import the same TypeScript. The
 * Next app compiles TS with path aliases; the admin portal is deliberately
 * zero-dependency plain Node with no build step, so it can neither resolve `@/lib`
 * nor read a `.ts` file. The obvious answer is to write the list twice, and this
 * project already has one such pair (`lib/clock.ts` / `admin/clock.js`) so it would
 * not even look out of place.
 *
 * It is the wrong answer here. The screen that renders these toggles and the code
 * that enforces them would be two lists, and the failure mode of a drifted list is
 * a module that appears switchable but is not, or is enforced but never shown. The
 * exact same class of bug as the `/accounts/gds` table that listed seven
 * environment variables while the code read thirty-six, and omitted the one that
 * mattered.
 *
 * So: CommonJS, which `require()` reads directly and which `allowJs` lets the TS
 * side import with types inferred. One file, no build step, no drift possible.
 *
 * `lib/panelMenus.ts` adds the types, the state lookup and the route guard.
 */

/**
 * @typedef {Object} PanelModule
 * @property {string} key
 * @property {'accounts'|'dashboard'} group
 * @property {string} href
 * @property {string} label            short label, for the nav
 * @property {string} [tileLabel]      longer label, for the landing tiles
 * @property {string} note             what the operator is switching off
 * @property {boolean} [locked]        cannot be switched off
 */

/** @type {PanelModule[]} */
const PANEL_MODULES = [
  /* ------------------------------------------------------- accounts module */
  { key: 'accounts', group: 'accounts', href: '/accounts', label: 'Dashboard', note: 'The accounts home. Always on — its sixteen children would be orphaned without it.', locked: true },
  { key: 'invoices', group: 'accounts', href: '/accounts/invoices', label: 'Sales', tileLabel: 'Sales & invoices', note: 'Quotations, invoices, receipts. Off means the agency cannot bill.' },
  { key: 'credit-notes', group: 'accounts', href: '/accounts/credit-notes', label: 'Credit notes', note: 'Customer refunds, cancellations and adjustments.' },
  { key: 'bills', group: 'accounts', href: '/accounts/bills', label: 'Purchases', tileLabel: 'Supplier bills', note: 'Supplier bookings, invoices and payments.' },
  { key: 'cash', group: 'accounts', href: '/accounts/cash', label: 'Cash', tileLabel: 'Cash book', note: 'Daily cash receipts and payments with opening and closing balances.' },
  { key: 'bank', group: 'accounts', href: '/accounts/bank', label: 'Bank', tileLabel: 'Bank book', note: 'Bank receipts, payments, deposits and withdrawals.' },
  { key: 'expenses', group: 'accounts', href: '/accounts/expenses', label: 'Expenses', tileLabel: 'Record expenses', note: 'Office expenses across the eight categories.' },
  { key: 'inventory', group: 'accounts', href: '/accounts/inventory', label: 'Inventory', tileLabel: 'Inventory & float', note: 'Hajj seat blocks and pre-purchased stock. An agency that only sells air tickets has no use for it.' },
  { key: 'documents', group: 'accounts', href: '/accounts/documents', label: 'Documents', tileLabel: 'Tickets & documents', note: 'Airline documents — tickets, EMDs, memos — with the fare, tax and commission breakdown an invoice line cannot hold. Off for an agency that sells no air.' },
  { key: 'reports', group: 'accounts', href: '/accounts/reports', label: 'Reports', note: 'Sales, profit, expense, supplier, customer, commission and outstanding reports.' },
  { key: 'ledger', group: 'accounts', href: '/accounts/ledger', label: 'Ledger', tileLabel: 'General ledger', note: 'Double-entry ledger and trial balance. Off for an agency whose accountant works outside the system.' },
  { key: 'financials', group: 'accounts', href: '/accounts/financials', label: 'Financials', tileLabel: 'Financial statements', note: 'Profit and loss, balance sheet, cash flow, and the two-derivation reconciliation.' },
  { key: 'reminders', group: 'accounts', href: '/accounts/reminders', label: 'Reminders', tileLabel: 'Payment reminders', note: 'Overdue chasing. Nothing is sent automatically — the screen composes the message.' },
  { key: 'statements', group: 'accounts', href: '/accounts/statements', label: 'Statements', note: 'Customer, supplier, cash, bank and company statements over any date range.' },
  { key: 'masters', group: 'accounts', href: '/accounts/masters', label: 'Masters', note: 'Customers, suppliers, services, airlines, hotels, visa types, countries, currencies, banks.' },
  { key: 'gds', group: 'accounts', href: '/accounts/gds', label: 'GDS check', tileLabel: 'GDS & PNR check', note: 'Live supplier status, the credential inventory and the PNR lookup. Off for an agency with no GDS of its own.' },
  { key: 'settings', group: 'accounts', href: '/accounts/settings', label: 'Settings', tileLabel: 'Company settings', note: 'Company details, voucher prefixes, VAT and currency.' },

  /* --------------------------------------------- market intelligence module */
  { key: 'home', group: 'dashboard', href: '/', label: 'Dashboard', note: 'The market-intelligence home. Always on — it is the entry point to everything else.', locked: true },
  { key: 'agencies', group: 'dashboard', href: '/agencies', label: 'Agencies', note: 'The researched agency dataset and the CRM pipeline over it. Switching it off also removes the Credentials and Cities menus, which are filters over this one page.' },
  { key: 'competitors', group: 'dashboard', href: '/competitors', label: 'Competitors', note: 'Competitor profiles. Sales research rather than day-to-day operations.' },
  { key: 'segments', group: 'dashboard', href: '/segments', label: 'Segments', note: 'Market segmentation of the dataset.' }
];

const PANEL_GROUP_LABEL = {
  accounts: 'Travel Accounts',
  dashboard: 'Market Intelligence'
};

/**
 * Is a module on?
 *
 * `!== false` at every level, so an absent key means ON. A fresh install, or a
 * `site.json` written before this feature existed, has to get the whole product —
 * defaulting the other way ships a build that hides itself, and "every link gone,
 * every route 404" reads as a catastrophic bug rather than a missing key.
 */
function isModuleOn(m, panelState) {
  if (m.locked) return true;
  const group = (panelState || {})[m.group];
  return !group || group[m.key] !== false;
}

module.exports = { PANEL_MODULES, PANEL_GROUP_LABEL, isModuleOn };
