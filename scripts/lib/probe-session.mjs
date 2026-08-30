/**
 * A throwaway admin session, for checks that need to read a guarded page.
 *
 * WHY THIS EXISTS AS A SHARED FILE
 *
 * The accounting and market-intelligence panels used to answer 200 to anybody. Once
 * they stopped, every check that read one of those pages started failing — thirty-five
 * of them in verify-srs alone, all with the same cause and none of them a real
 * regression. Each of those suites needs the identical four things: a probe account,
 * a real login against the portal, that cookie attached to every app request, and the
 * user file put back exactly as it was.
 *
 * It lives in one file because the alternative is three copies of the code that
 * writes to content/users.json. That file holds the password hashes for the real
 * accounts; a copy that gets the restore logic slightly wrong is not a flaky test, it
 * is a lost account.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not mint a cookie from the signing secret, even though it could — it has
 * the filesystem. A check that signs its own token proves only that the verifier
 * agrees with itself. Every cookie here was issued by the portal's own POST /login,
 * so the login path, the signing, the cookie attributes and the verifier are all on
 * the hook for the result.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const USERS = 'content/users.json';

/**
 * Set up probe accounts and return the handles a check needs.
 *
 * `roles` is the list to create. The password is random per run and never leaves the
 * process, because the alternative — a fixed password in a public repository — is a
 * standing hole that no amount of "it's only for tests" makes safe.
 */
export function probeSession({ roles = ['super_admin'], admin, app, prefix = 'verify-probe-' } = {}) {
  const pass = randomBytes(18).toString('base64url');
  const email = (role) => `${prefix}${role}@local`;
  const before = readFileSync(USERS, 'utf8');

  /**
   * Rewrites the probe rows from the ORIGINAL file every time, not from the current
   * one. That matters for the revocation check, which bumps a tokenVersion and then
   * needs it back: rebuilding from `before` cannot accumulate, so a run that is
   * interrupted between the two writes still leaves the file recoverable.
   */
  function write(mutate) {
    const db = JSON.parse(before);
    db.users = db.users.filter((u) => !u.email.startsWith(prefix));
    for (const role of roles) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
      db.users.push({ email: email(role), name: `Automated probe ${role}`, role, salt, hash });
    }
    if (mutate) mutate(db, email);
    writeFileSync(USERS, JSON.stringify(db, null, 2));
  }

  const restore = () => writeFileSync(USERS, before);
  write();
  // Also on a crash, so a failed run never leaves a probe super-admin behind.
  process.on('exit', restore);

  /**
   * Retry once when the CONNECTION fails, never when the response does.
   *
   * Node keeps a pooled keep-alive socket open to the portal. A suite that opens one,
   * then blocks the event loop for a few seconds — verify-bank spawns a child process to
   * generate its statement — comes back to find the server has closed it on its five
   * second keep-alive timeout, and undici reports ECONNRESET from the reused socket.
   *
   * That is not a test failure and reporting it as one is worse than useless: it made
   * verify-bank fail at its first portal call, reproducibly, while the portal was serving
   * every request put to it by hand. Only transport errors are retried — an HTTP status
   * is an answer and gets reported as it stands.
   */
  async function fetchRetrying(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const code = err && err.cause && err.cause.code;
      if (code !== 'ECONNRESET' && code !== 'ECONNREFUSED' && code !== 'UND_ERR_SOCKET') throw err;
      await new Promise((r) => setTimeout(r, 250));
      return fetch(url, init);
    }
  }

  async function login(role = roles[0]) {
    const body = new URLSearchParams({ email: email(role), password: pass }).toString();
    const r = await fetchRetrying(`${admin}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual'
    });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const c = set.map((x) => x.split(';')[0]).find((x) => x.startsWith('ota_admin='));
    if (!c) throw new Error(`probe login failed for ${role}: HTTP ${r.status}`);
    return c;
  }

  /**
   * Attach the cookie to every request at the app origin, once, by wrapping fetch.
   *
   * The alternative was threading a cookie through the twenty-odd call sites in
   * verify-srs, which is twenty chances to miss one — and a missed one does not error,
   * it silently reports the feature as absent. Only the app origin is touched: the
   * portal issues its own cookies and must not be handed one, and an outbound call to
   * a supplier must never carry a session.
   */
  function attachCookieTo(appOrigin, cookie) {
    const real = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (!url.startsWith(appOrigin)) return real(input, init);
      const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
      if (!headers.has('cookie')) headers.set('cookie', cookie);
      return real(input, { ...init, headers });
    };
    return () => { globalThis.fetch = real; };
  }

  return { email, login, write, restore, usersBefore: before, attachCookieTo, app, admin };
}

/**
 * The common case in one call: probe super-admin, logged in, cookie attached to
 * every app request. Returns the cookie for checks that want to vary it.
 */
export async function signedInProbe({ admin, app, roles, prefix }) {
  const s = probeSession({ roles, admin, app, prefix });
  const cookie = await s.login();
  s.attachCookieTo(app, cookie);
  return { ...s, cookie };
}
