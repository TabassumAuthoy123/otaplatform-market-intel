import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
// eslint-disable-next-line import/extensions -- shared with the zero-dependency admin portal
import { can, capsOf, normaliseRole, ROLES } from '@/admin/roles.js';
import { currentPath, moduleKeyFor } from '@/lib/panelMenus';

/**
 * Who is asking, on the Next side.
 *
 * WHAT WAS WRONG
 *
 * The admin portal has had real authentication for a while — scrypt with a
 * timing-safe compare, HMAC-signed HttpOnly SameSite=Strict cookies, a token
 * version that kills old sessions when a password changes, and six roles enforced
 * at the route before any handler runs.
 *
 * The accounting module had none of it. `GET /accounts/financials` with no cookie
 * and no header answered **200**. The whole book — every voucher, every customer,
 * the BSP position, the credit exposure — sat behind nothing but a loopback bind.
 * That is fine for one person on one laptop and fails the moment an agency wants a
 * second user, access from home, or a hosted deployment.
 *
 * THIS VERIFIES; IT NEVER ISSUES
 *
 * The deliberate choice, and the reason this file is short. Cookies are not
 * port-scoped: a cookie set for `localhost` by the portal on :4001 is sent to the
 * app on :3002 as well, and `SameSite=Strict` is satisfied because both are the
 * same site. So the portal is already the identity provider — this side only has to
 * check its work.
 *
 * That means no second login form, no second password store, and no way for the app
 * to mint a session. A second password store is a second thing to get wrong; a
 * second issuer is a second place a forgery can start. There is exactly one of each,
 * and it is the one that already had the scrypt hashing and the token versioning.
 *
 * WHY IT IS NOT IN MIDDLEWARE
 *
 * Middleware runs on the Edge runtime with no filesystem, and both the signing
 * secret and the user list are files. So the check runs in each route group's
 * layout — the same place, and for the same reason, as the panel-module guard.
 */

const CONTENT = path.join(process.cwd(), 'content');
const SECRET_FILE = path.join(CONTENT, '.session-secret');
const USERS_FILE = path.join(CONTENT, 'users.json');

export type Role = keyof typeof ROLES;

export type Viewer = {
  email: string;
  name: string;
  role: string;
  /** Human label for the role, from the shared definition. */
  roleLabel: string;
  caps: string[];
};

type StoredUser = { email: string; name: string; role: string; tokenVersion?: number };

/**
 * The signing secret, read on every call rather than cached.
 *
 * It is one small file read and it means rotating the secret takes effect at once
 * instead of at the next restart. A cached secret is how a revoked-everything
 * action quietly fails to revoke the process that was not restarted.
 */
function secret(): Buffer | null {
  if (!existsSync(SECRET_FILE)) return null;
  try {
    return readFileSync(SECRET_FILE);
  } catch {
    return null;
  }
}

function findUser(email: string): StoredUser | null {
  try {
    const db = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as { users?: StoredUser[] };
    const wanted = String(email || '').trim().toLowerCase();
    return (db.users ?? []).find((u) => u.email === wanted) ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify the portal's session cookie.
 *
 * Every check the portal makes, made again here, because a verifier that skips one
 * of them is a hole with a plausible explanation:
 *
 *   the signature, compared in constant time — a length-varying compare leaks
 *   the expiry, so a stolen cookie stops working
 *   the user still existing, so a deleted account cannot keep reading the book
 *   the token version, which is what makes a password change end other sessions
 *
 * Returns null for every failure without saying which. A verifier that explains
 * itself is an oracle.
 */
export function viewer(): Viewer | null {
  const raw = cookies().get('ota_admin')?.value;
  if (!raw) return null;

  const key = secret();
  if (!key) return null;

  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);

  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const [emailB64, expires, , ver] = payload.split('.');
  if (!emailB64 || !expires) return null;
  if (Number(expires) < Date.now()) return null;

  const email = Buffer.from(emailB64, 'base64url').toString('utf8');
  const user = findUser(email);
  if (!user) return null;

  // A cookie from before the account's current credential generation is dead,
  // however valid its signature. This is what a password change relies on.
  if (Number(ver ?? 0) !== Number(user.tokenVersion ?? 0)) return null;

  const role = normaliseRole(user.role);
  return {
    email: user.email,
    name: user.name,
    role,
    roleLabel: (ROLES as Record<string, { label: string }>)[role]?.label ?? role,
    caps: capsOf(role)
  };
}

/**
 * Which capability a panel module requires to be READ.
 *
 * Every page under /accounts is read-only — no server actions, no writes, and every
 * form is a GET filter. Checked rather than assumed. So this maps to *seeing*
 * rather than to *doing*, and `books_read` covers most of it: a role that may read
 * the book may read any report derived from it.
 *
 * The exceptions are the screens that are not reports. The GDS page shows credential
 * state and runs live supplier calls, which is `integrations`. Settings is
 * `settings`. Contracts and tax rules are master data and carry commercial terms, so
 * they sit behind `books_masters` — a read-only role has no business knowing what
 * commission the agency negotiated.
 *
 * A module with no entry here is denied to everyone but a super admin. That is the
 * safe direction for a mistake to fall, and it is the same rule the portal uses.
 */
const MODULE_CAP: Record<string, string> = {
  // accounts
  accounts: 'books_read',
  invoices: 'books_read',
  'credit-notes': 'books_read',
  bills: 'books_read',
  cash: 'books_read',
  bank: 'books_read',
  expenses: 'books_read',
  inventory: 'books_read',
  documents: 'books_read',
  bsp: 'books_read',
  /*
   * The three that show the whole business rather than a record. See the note on
   * books_financials in admin/roles.js: reports carries per-service cost and margin,
   * ledger carries every account including the purchase side, financials is the P&L,
   * balance sheet and trial balance.
   */
  reports: 'books_financials',
  ledger: 'books_financials',
  financials: 'books_financials',
  reminders: 'books_read',
  statements: 'books_read',
  masters: 'books_masters',
  taxes: 'books_masters',
  contracts: 'books_masters',
  gds: 'integrations',
  settings: 'settings',
  // market intelligence
  home: 'agencies_read',
  agencies: 'agencies_read',
  competitors: 'agencies_read',
  segments: 'agencies_read'
};

export function capabilityFor(moduleKey: string): string | null {
  return MODULE_CAP[moduleKey] ?? null;
}

/** May this viewer read that module? Unmapped modules are super-admin only. */
export function mayRead(v: Viewer, moduleKey: string): boolean {
  const cap = capabilityFor(moduleKey);
  if (!cap) return v.role === 'super_admin';
  return can(v.role, cap);
}

export { can };


/**
 * Where to send a request that may not proceed.
 *
 * Built here rather than inlined at the two call sites so both refusals look
 * identical from outside. An anonymous caller and a signed-in caller without the
 * capability both land on /signin; only the reason differs, and the reason is not
 * a secret because it says nothing the caller does not already know about their own
 * session. What it deliberately does NOT do is vary by whether the user exists,
 * whether the password was wrong or whether the session merely expired -- verify()
 * collapses all of those into null and this keeps them collapsed.
 */
export function signInUrl(reason: 'anonymous' | 'forbidden', refused?: string | null): string {
  const q = new URLSearchParams({ reason });
  // Only a local path is ever carried, and the sign-in page re-checks it. Two checks
  // for one property, because this is the sort of thing a later caller passes a full
  // URL into without thinking.
  if (refused && refused.startsWith('/') && !refused.startsWith('//')) q.set('next', refused);
  return `/signin?${q.toString()}`;
}

/**
 * Refuse here, in the data layer, because refusing in the layout does not work.
 *
 * WHAT WAS WRONG WITH THE OBVIOUS PLACE
 *
 * The guard started in the two group layouts, which is where every write-up of the
 * App Router puts it and where it reads best. It does not hold. A layout and the
 * page beneath it render in PARALLEL, so a layout that returns a sign-in card — or
 * even one that calls redirect() — does not stop the page from running. Both were
 * built and both were measured against the running dev server on
 * `GET /accounts/financials` with no cookie:
 *
 *   early return   200, 49,919 byte body, chart of account names in the payload
 *   redirect()     307, 48,009 byte body, same names in the payload
 *
 * A 307 whose body carries the page it is redirecting away from. The account names
 * are `Accounts receivable`, `Retained ...` and both trial balance headings; no
 * figures surfaced in those particular runs, which is the part to be uneasy about
 * rather than reassured by. How far the page gets before the stream is cut is
 * decided by timing — render speed, file cache warmth, book size — not by the
 * guard. A leak that depends on a race still leaks; it just also passes a test.
 *
 * Middleware would be early enough, and cannot do it: it runs on the Edge runtime,
 * and both the signing secret and the user record are files.
 *
 * So the check moves to the only place a page cannot render around — the function
 * that opens the data. There is nothing to serialise if the read never returns, and
 * a page added next year gets this for free instead of having to remember.
 *
 * Callers that have authorised themselves some other way — the /api routes, which
 * middleware already restricts to loopback — use the *Unguarded reader directly.
 * That is deliberately an ugly name: it should be obvious in a diff and easy to
 * grep for, because every one of them is a place this check is not running.
 */
export function requireRead(): void {
  const who = viewer();
  const path = pathOfRequest();
  if (!who) redirect(signInUrl('anonymous', path));
  const key = path ? moduleKeyFor(path) : null;
  if (key && !mayRead(who, key)) redirect(signInUrl('forbidden', path));
}

/**
 * The path, or null when there is no request to read one from.
 *
 * `headers()` throws outside a request scope. A build-time prerender and a unit
 * test both count as outside, and neither should be turned into a redirect — so an
 * unavailable path means "no module to check", not "refuse". The session check above
 * it is unaffected: no request means no cookie means no viewer means refused
 * already.
 */
function pathOfRequest(): string | null {
  try {
    return currentPath();
  } catch {
    return null;
  }
}
