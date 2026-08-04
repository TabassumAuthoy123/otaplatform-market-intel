'use strict';

/**
 * Role-based access control for the admin portal.
 *
 * The six roles come from the accounting specification and are the same six the
 * /accounts/settings screen lists. Until now they were described and not
 * enforced — one login could do everything. This module is the enforcement.
 *
 * TWO RULES THAT MATTER
 *
 * 1. Guarding happens at the ROUTE, not in the sidebar. Hiding a link stops a
 *    person clicking it; it does not stop them typing the URL or replaying a
 *    form post. `check()` is called for every request before any handler runs.
 *
 * 2. Anything not explicitly allowed is denied. A new route is inaccessible to
 *    every non-super-admin until somebody maps it here on purpose, which is the
 *    safe direction for a mistake to fall.
 */

/* ------------------------------------------------------------ capabilities */

const CAPS = {
  design: 'Storefront sections, theme and content',
  integrations: 'GDS credentials status and connection tests',
  crm_read: 'View the prospect list and lead detail',
  crm_write: 'Log calls and update lead fields',
  crm_assign: 'Assign and reassign leads between reps',
  crm_all: 'Edit any lead, not only the ones assigned to you',
  crm_vocab: 'Change the call status, disposition and interest lists',
  agencies_read: 'View the researched agency dataset',
  agencies_write: 'Edit the researched agency dataset',
  books_read: 'View accounting records and reports',
  books_sales: 'Create and edit invoices and customer receipts',
  books_purchase: 'Create and edit supplier bills, payments, deposits and inventory',
  books_masters: 'Edit customers, suppliers, services, banks, categories, employees',
  books_credit: 'Raise credit notes and cancel sales',
  books_delete: 'Delete accounting records',
  leads_read: 'View demo requests from the storefront',
  users: 'Add, edit and remove admin users',
  audit: 'Read the audit log — who changed what',
  alerts: 'See what the scheduled checks have found',
  alerts_ack: 'Acknowledge an alert, and run the checks on demand',
  backup: 'Download a backup and restore the book from one',
  settings: 'Company settings and raw JSON editing'
};

/**
 * Role definitions. `label` matches the wording in the accounting book so the
 * two cannot drift apart in a conversation with the client.
 */
const ROLES = {
  super_admin: {
    label: 'Super Admin',
    summary: 'Everything, including settings and user management',
    caps: Object.keys(CAPS)
  },
  accountant: {
    label: 'Accountant',
    summary: 'All vouchers, reports and statements. No settings, no user management',
    caps: ['books_read', 'books_sales', 'books_purchase', 'books_masters', 'books_credit', 'books_delete', 'leads_read', 'agencies_read', 'audit', 'alerts', 'alerts_ack']
  },
  sales_exec: {
    label: 'Sales Executive',
    summary: 'The prospect queue, quotations, invoices and customer receipts',
    caps: ['crm_read', 'crm_write', 'books_read', 'books_sales', 'leads_read', 'agencies_read', 'alerts']
  },
  operations: {
    label: 'Operations Staff',
    summary: 'Supplier bookings, bills, payments and stock only',
    caps: ['books_read', 'books_purchase', 'agencies_read', 'alerts']
  },
  manager: {
    label: 'Manager',
    summary: 'Read everything, reassign leads, approve cancellations',
    caps: ['crm_read', 'crm_assign', 'crm_all', 'crm_vocab', 'books_read', 'books_credit', 'leads_read', 'agencies_read', 'integrations', 'audit', 'alerts', 'alerts_ack']
  },
  read_only: {
    label: 'Read Only',
    summary: 'Reports and statements. Nothing editable anywhere',
    caps: ['books_read', 'crm_read', 'agencies_read', 'leads_read', 'alerts']
  }
};

/** Legacy rows created before roles existed were plain 'admin'. */
const normaliseRole = (r) => (r === 'admin' || !r ? 'super_admin' : r);

function capsOf(role) {
  const def = ROLES[normaliseRole(role)];
  return def ? def.caps : [];
}

function can(role, cap) {
  return capsOf(role).includes(cap);
}

/* ------------------------------------------------------- route → capability */

/**
 * Which accounting collections each books capability covers. A Sales Executive
 * may raise an invoice but must not be able to edit a supplier bill, and the
 * only honest place to enforce that is on the collection name in the query
 * string.
 */
const SALES_COLLECTIONS = ['invoices', 'receipts', 'customers'];
/**
 * Credit notes are deliberately not a sales capability.
 *
 * Reversing a sale destroys revenue and can hand money back, so the person who
 * raised the invoice should not be the person who cancels it. Accountants and
 * managers can; a sales executive cannot, which is the separation the Manager
 * role already promised with "approve cancellations".
 */
const CREDIT_COLLECTIONS = ['creditNotes', 'supplierCreditNotes'];
const PURCHASE_COLLECTIONS = ['bills', 'payments', 'supplierDeposits', 'inventory', 'suppliers'];
/** Moving money between the till and the bank is a treasury act, not a sales or purchase one. */
const TREASURY_COLLECTIONS = ['transfers'];
const MASTER_COLLECTIONS = [
  'services', 'banks', 'expenseCategories', 'employees', 'customers', 'suppliers',
  'airlines', 'hotels', 'visaTypes', 'countries', 'currencies'
];

/**
 * Returns the capability a request needs, or null when it needs none
 * (login, logout, the dashboard shell).
 *
 * `col` is the accounting collection from the query string, when present.
 */
function requiredCap(pathname, method, col) {
  const write = method === 'POST';

  // open to any signed-in user
  if (['/', '/dashboard', '/login', '/logout'].includes(pathname)) return null;

  if (pathname.startsWith('/design')) return 'design';
  if (pathname.startsWith('/integrations')) return 'integrations';
  /**
   * Your own account is not an administrative privilege.
   *
   * Folding this under the `users` capability would have recreated exactly the
   * problem the password form was added to solve: an Accountant or a Sales
   * Executive would be unable to rotate their own password, and only a Super
   * Admin could. Changing your own credentials, having proved you know the
   * current ones, needs no capability at all.
   */
  if (pathname === '/account' || pathname === '/account/password') return null;

  if (pathname.startsWith('/users')) return 'users';
  if (pathname === '/raw') return 'settings';
  if (pathname === '/audit') return 'audit';
  // Seeing a problem and doing something about it are different privileges:
  // Read Only should know the book stopped balancing and must not be able to
  // sign the alert off.
  if (pathname === '/alerts') return 'alerts';
  if (pathname.startsWith('/alerts/')) return 'alerts_ack';
  // Restoring overwrites the whole book, so it sits behind its own capability
  // rather than being folded into settings.
  if (pathname.startsWith('/backup')) return 'backup';

  if (pathname === '/leads') return 'leads_read';
  if (pathname === '/leads/delete') return 'settings';

  if (pathname.startsWith('/edit/')) return 'design';

  if (pathname === '/agencies' || pathname === '/agencies/edit') {
    return write ? 'agencies_write' : 'agencies_read';
  }
  if (pathname === '/agencies/new' || pathname === '/agencies/delete') return 'agencies_write';

  if (pathname.startsWith('/crm')) {
    // Renaming a disposition changes what every past call means, so it is a
    // manager's job rather than part of ordinary lead editing.
    if (pathname.startsWith('/crm/vocab')) return 'crm_vocab';
    if (pathname.startsWith('/crm/import')) return 'crm_assign';
    if (pathname === '/crm/bulk-assign') return 'crm_assign';
    return write ? 'crm_write' : 'crm_read';
  }

  if (pathname === '/books' || pathname === '/books/list' || (pathname === '/books/edit' && !write)) {
    return 'books_read';
  }
  if (pathname === '/books/delete') return 'books_delete';
  if (pathname === '/books/edit' || pathname === '/books/new') {
    // pick the narrowest capability that covers this collection
    if (CREDIT_COLLECTIONS.includes(col)) return 'books_credit';
    if (TREASURY_COLLECTIONS.includes(col)) return 'books_purchase';
    if (SALES_COLLECTIONS.includes(col)) return 'books_sales';
    if (PURCHASE_COLLECTIONS.includes(col)) return 'books_purchase';
    if (MASTER_COLLECTIONS.includes(col)) return 'books_masters';
    return 'books_masters';
  }

  // anything unmapped is super-admin only, on purpose
  return 'settings';
}

/**
 * The one call the server makes. Returns { ok } or { ok:false, cap, reason }.
 *
 * A books collection a role cannot touch is reported by name, because "you
 * cannot edit bills" is actionable and "forbidden" is not.
 */
function check(role, pathname, method, col) {
  const cap = requiredCap(pathname, method, col);
  if (cap === null) return { ok: true };
  if (can(role, cap)) return { ok: true };
  return {
    ok: false,
    cap,
    reason: CAPS[cap] || cap,
    role: normaliseRole(role),
    roleLabel: (ROLES[normaliseRole(role)] || {}).label || role
  };
}

/** Sidebar entries this role should see at all. */
/**
 * May this role edit a lead it does not own?
 *
 * The data dictionary and the CRM spec both say a rep may only mutate rows
 * where `assigned_to` is their own id, and until now nothing enforced it — a
 * Sales Executive could rewrite another rep's disposition and next action.
 */
function canEditAnyLead(role) {
  return can(role, 'crm_all');
}

function visible(role) {
  return {
    design: can(role, 'design'),
    integrations: can(role, 'integrations'),
    crm: can(role, 'crm_read'),
    agencies: can(role, 'agencies_read'),
    books: can(role, 'books_read'),
    leads: can(role, 'leads_read'),
    users: can(role, 'users'),
    audit: can(role, 'audit'),
    alerts: can(role, 'alerts'),
    alertsAck: can(role, 'alerts_ack'),
    backup: can(role, 'backup'),
    raw: can(role, 'settings')
  };
}

/** True when the role may change anything at all in the accounting book. */
const canWriteBooks = (role) =>
  ['books_sales', 'books_purchase', 'books_masters', 'books_delete'].some((c) => can(role, c));

module.exports = {
  canEditAnyLead,
  CAPS, ROLES, normaliseRole, capsOf, can, requiredCap, check, visible, canWriteBooks,
  SALES_COLLECTIONS, PURCHASE_COLLECTIONS, MASTER_COLLECTIONS
};
