/**
 * Prove the accounting and market-intelligence panels are not readable without a
 * session, and only readable as far as the role allows.
 *
 *   node scripts/verify-auth.mjs
 *
 * Needs the admin portal on :4001 (it issues the session) and the app on :3002
 * (it verifies one). Nothing here mints a cookie by hand: every request carries a
 * cookie the portal actually set, because a check that signs its own tokens proves
 * the verifier agrees with itself and nothing more.
 *
 * WHY THE ASSERTIONS LOOK AT THE BODY AND NOT THE STATUS
 *
 * The first two versions of this guard both returned a believable status — 200 with a
 * sign-in card, then 307 to /signin — while the page underneath rendered in parallel
 * and its output travelled in the SAME response. A check that read only the status
 * passed both times. So every assertion below reads the bytes.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:4001';
const APP = process.env.APP_URL || 'http://127.0.0.1:3002';
const USERS = 'content/users.json';
const SITE = 'content/site.json';

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
};

/* ----------------------------------------------------------- probe accounts */

/**
 * One throwaway account per role, one random password for all of them, removed at
 * the end and on a crash. Same approach as verify-admin.mjs and for the same reason:
 * the alternative is a fixed test password in a public repository.
 */
const ROLES = ['super_admin', 'accountant', 'sales_exec', 'read_only'];
const PASS = randomBytes(18).toString('base64url');
const email = (role) => `verify-auth-${role}@local`;
const usersBefore = readFileSync(USERS, 'utf8');

function writeProbes(mutate) {
  const db = JSON.parse(usersBefore);
  db.users = db.users.filter((u) => !u.email.startsWith('verify-auth-'));
  for (const role of ROLES) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(PASS, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    db.users.push({ email: email(role), name: `Auth probe ${role}`, role, salt, hash });
  }
  if (mutate) mutate(db);
  writeFileSync(USERS, JSON.stringify(db, null, 2));
}
const restore = () => writeFileSync(USERS, usersBefore);
writeProbes();
process.on('exit', restore);

/* ------------------------------------------------------------------ helpers */

async function login(role) {
  const body = new URLSearchParams({ email: email(role), password: PASS }).toString();
  const r = await fetch(`${ADMIN}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual'
  });
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const c = raw.map((x) => x.split(';')[0]).find((x) => x.startsWith('ota_admin='));
  if (!c) throw new Error(`no cookie for ${role} (HTTP ${r.status})`);
  return c;
}

/** Status, redirect target and the WHOLE body, because the body is where the leak was. */
async function get(path, cookie) {
  const r = await fetch(`${APP}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual'
  });
  return { status: r.status, location: r.headers.get('location') || '', body: await r.text() };
}

/**
 * Tokens that only appear once the book has actually been read.
 *
 * Deliberately not bare figures. While this was being written, a probe for
 * comma-grouped numbers matched the CSS colour `255,255`, and a probe for the word
 * "priority" matched Next's own `fetchPriority="low"` preload attribute — two false
 * alarms that each cost a round of investigation.
 */
const BOOK = /Accounts receivable|Trial balance|Retained earnings|Sales — air ticket/;
const MARGIN = /Gross profit|gross profit|Cash balance|Bank balance/;
const CRM = /IATA accredited|Hajj licence|BAIRA recruiting/;

/* -------------------------------------------------------------- readiness */

/**
 * Wait for both servers before asserting anything.
 *
 * A cold `next dev` compiles each route on its first request, and this suite's very
 * first request is also that route's first compile. One run crashed here for exactly
 * that reason, and a crash at this point looks identical to the guard being broken —
 * which is the worst possible thing for a security check to be ambiguous about.
 */
async function waitFor(url, what) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0) { await r.text(); return; }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not answer at ${url} — start it before running this`);
}
await waitFor(`${ADMIN}/login`, 'the admin portal');
await waitFor(`${APP}/signin`, 'the app');

/* ---------------------------------------------------------- 1. anonymous */

const ANON = ['/accounts', '/accounts/financials', '/accounts/invoices', '/accounts/documents',
  '/', '/agencies', '/competitors', '/segments'];

for (const p of ANON) {
  const r = await get(p);
  // A switched-off module 404s first, and legitimately — that is the module guard.
  if (r.status === 404) { ok(`anonymous ${p} — module switched off, 404`, true, 'module guard, not auth'); continue; }
  const clean = !BOOK.test(r.body) && !CRM.test(r.body);
  ok(`anonymous ${p} refused with nothing in the body`,
    r.status === 307 && r.location.startsWith('/signin') && clean,
    `HTTP ${r.status} -> ${r.location || '(none)'}  ${r.body.length}b  ${clean ? 'clean' : 'LEAKED'}`);
}

const signin = await get('/signin?reason=anonymous&next=%2Faccounts%2Ffinancials');
ok('the sign-in page itself is reachable without a session',
  signin.status === 200 && /Sign in to open the book/.test(signin.body), `HTTP ${signin.status}`);
ok('the sign-in page names the path that was refused',
  signin.body.includes('/accounts/financials'), 'so the person knows what to ask for');
const abs = await get('/signin?reason=anonymous&next=https%3A%2F%2Fevil.example%2Fx');
/**
 * Scripts are stripped before looking, and that is not the check being weakened.
 *
 * Next echoes the request URL back into the router state it embeds in a <script> —
 * `initialCanonicalUrl` and the `__PAGE__?{...}` key both carry whatever was in the
 * query string, and no page code can stop that. Only the caller's own request comes
 * back to the caller, so there is nothing there to exploit.
 *
 * What WOULD matter is the sign-in page turning that string into a link, or printing
 * it where a person reads it: a phishing URL rendered on a page that looks like ours
 * borrows our credibility. So the assertion is about the rendered document, and the
 * href count is asserted separately rather than folded in, because "absent from the
 * text" and "not linked" fail for different reasons.
 */
const rendered = abs.body.replace(/<script[\s\S]*?<\/script>/g, '');
ok('an absolute next= is not rendered on the sign-in page',
  !rendered.includes('evil.example'), 'only local paths are displayed');
ok('and it is never turned into a link',
  !/href="https?:\/\/evil\.example/.test(abs.body), 'no anchor points at it');

/* ------------------------------------------- 2. a session that may read */

const su = await login('super_admin');
const fin = await get('/accounts/financials', su);
ok('super_admin opens Financials and the book is actually there',
  fin.status === 200 && BOOK.test(fin.body), `HTTP ${fin.status}  ${fin.body.length}b`);
const home = await get('/', su);
ok('super_admin opens the market dashboard',
  home.status === 200 && CRM.test(home.body), `HTTP ${home.status}  ${home.body.length}b`);

const acc = await login('accountant');
const accFin = await get('/accounts/financials', acc);
ok('accountant opens Financials', accFin.status === 200 && BOOK.test(accFin.body), `HTTP ${accFin.status}`);

/* --------------------------------- 3. a session that may NOT read that */

for (const role of ['sales_exec', 'read_only']) {
  const c = await login(role);
  for (const p of ['/accounts/financials', '/accounts/reports', '/accounts/ledger']) {
    const r = await get(p, c);
    if (r.status === 404) { ok(`${role} ${p} — module switched off`, true, 'module guard'); continue; }
    const clean = !BOOK.test(r.body);
    ok(`${role} refused ${p} with nothing in the body`,
      r.status === 307 && r.location.includes('reason=forbidden') && clean,
      `HTTP ${r.status} -> ${r.location}  ${r.body.length}b  ${clean ? 'clean' : 'LEAKED'}`);
  }

  const inv = await get('/accounts/invoices', c);
  ok(`${role} still opens Sales, which is their own work`,
    inv.status === 200 || inv.status === 404, `HTTP ${inv.status}`);

  const land = await get('/accounts', c);
  const leaked = MARGIN.test(land.body);
  ok(`${role} sees the landing without cost, margin or the treasury position`,
    land.status === 200 && !leaked,
    `HTTP ${land.status}  ${leaked ? 'MARGIN VISIBLE' : 'no margin, no cash or bank balance'}`);
  const navLink = /accounts\/financials/.test(land.body);
  ok(`${role} is not offered a Financials link they cannot open`,
    !navLink, navLink ? 'link present in the nav' : 'filtered out of the nav');
}

const suLand = await get('/accounts', su);
ok('super_admin still sees the margin and treasury figures on the landing',
  suLand.status === 200 && MARGIN.test(suLand.body), `HTTP ${suLand.status}`);

/* ----------------------------------------------- 4. forged and stale cookies */

const flip = (c) => c.slice(0, -1) + (c.slice(-1) === 'A' ? 'B' : 'A');
const tampered = await get('/accounts/financials', flip(su));
ok('a cookie with one character of the signature changed is refused',
  tampered.status === 307 && !BOOK.test(tampered.body), `HTTP ${tampered.status}`);

const truncated = await get('/accounts/financials', su.slice(0, -6));
ok('a truncated signature is refused rather than compared short',
  truncated.status === 307 && !BOOK.test(truncated.body), `HTTP ${truncated.status}`);

const payloadOnly = su.slice('ota_admin='.length).split('.').slice(0, -1).join('.');
const noSig = await get('/accounts/financials', `ota_admin=${payloadOnly}`);
ok('a payload with the signature removed is refused',
  noSig.status === 307 && !BOOK.test(noSig.body), `HTTP ${noSig.status}`);

/**
 * Expiry lives inside the signed payload, so it cannot be edited without breaking
 * the signature — which is the whole point of putting it there. The clock is not ours
 * to move, so the field is edited instead and the assertion is simply that the result
 * is refused. That covers both outcomes worth having: either the expiry check fires,
 * or the signature check does.
 */
const parts = su.slice('ota_admin='.length).split('.');
const past = `ota_admin=${[parts[0], String(Date.now() - 60000), parts[2], parts[3], parts[4]].join('.')}`;
const expired = await get('/accounts/financials', past);
ok('a cookie whose expiry has been moved into the past is refused',
  expired.status === 307 && !BOOK.test(expired.body), `HTTP ${expired.status}`);

/* ------------------------------------------------ 5. tokenVersion revocation */

/**
 * The one check that proves a session can be KILLED rather than merely left to
 * expire. Sign in, bump the user's tokenVersion the way the portal does when a
 * password changes, and the cookie already in hand has to stop working.
 */
const revoke = await login('super_admin');
const before = await get('/accounts/financials', revoke);
writeProbes((db) => {
  const u = db.users.find((x) => x.email === email('super_admin'));
  u.tokenVersion = Number(u.tokenVersion || 0) + 1;
});
const after = await get('/accounts/financials', revoke);
ok('a live session dies the moment the user tokenVersion is bumped',
  before.status === 200 && after.status === 307 && !BOOK.test(after.body),
  `${before.status} before the bump, ${after.status} after`);
writeProbes();

/* --------------------------------- 6. the module guard still wins the tie */

/**
 * A module the installation does not have must 404 for an anonymous caller too. If it
 * answered "sign in to see this" it would confirm the module exists, and an outsider
 * could enumerate which modules an installation was sold by reading the difference.
 */
const siteBefore = readFileSync(SITE, 'utf8');
const site = JSON.parse(siteBefore);
site.panel = site.panel || {};
site.panel.accounts = Object.assign({}, site.panel.accounts || {}, { bsp: false });
writeFileSync(SITE, JSON.stringify(site, null, 2));
try {
  const off = await get('/accounts/bsp');
  ok('a switched-off module 404s for an anonymous caller instead of asking them to sign in',
    off.status === 404 && !off.location.includes('/signin'),
    `HTTP ${off.status} -> ${off.location || '(none)'}`);
  const offSigned = await get('/accounts/bsp', su);
  ok('and 404s for a super_admin too — off means off for everybody',
    offSigned.status === 404, `HTTP ${offSigned.status}`);
} finally {
  writeFileSync(SITE, siteBefore);
}

/* ----------------------------------- 7. the api routes are not collateral */

/**
 * The guard moved into getBook and getDataset, and the /api routes read the same
 * files. They authorise differently — middleware holds them to loopback — so they
 * call the *Unguarded readers directly. If that wiring broke they would redirect to
 * /signin, which would silently break the export buttons and every script using them.
 */
for (const [p, what] of [['/api/agencies', 'the agency dataset'], ['/api/accounts/export?format=csv', 'the book export']]) {
  const r = await fetch(`${APP}${p}`, { redirect: 'manual' });
  const body = await r.text();
  ok(`/api still serves ${what} on loopback with no cookie`,
    r.status === 200 && body.length > 1000, `HTTP ${r.status}  ${body.length}b`);
}

/* ------------------------------------------- 8. every guarded page is guarded */

/**
 * Not a request-based check, and the most useful one here. Every page in the two
 * guarded groups has to reach its data through a guarded reader. The moment one calls
 * an *Unguarded function, or reads a content file directly, it sits outside the guard
 * — and no amount of testing the other twenty-three pages would notice.
 */
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const pages = walk('app/(accounts)').concat(walk('app/(dashboard)')).filter((p) => p.endsWith('page.tsx'));
const READER = /\b(getBook|getMarket|getDataset|getCompetitors)\(/;
const escapes = pages.filter((p) => {
  const src = readFileSync(p, 'utf8');
  return !READER.test(src) || /Unguarded\(/.test(src);
});
ok(`all ${pages.length} pages in the guarded groups read through a guarded reader`,
  escapes.length === 0, escapes.length ? escapes.join(', ') : 'no page reads around the guard');

/* ---------------------------------------------------------------- teardown */

restore();
ok('the probe accounts are gone and users.json is unchanged',
  readFileSync(USERS, 'utf8') === usersBefore, 'restored byte for byte');

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
