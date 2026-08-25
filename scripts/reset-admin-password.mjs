/**
 * Set an admin account's password from the machine that owns the file.
 *
 *   node scripts/reset-admin-password.mjs admin@softifybd.com
 *
 * It reads the new password from STDIN, never from argv. A password passed as an
 * argument is visible in `ps`, in the shell history file, and in any process listing
 * a colleague or a monitoring agent can read — which is a strange price to pay for
 * saving a keystroke.
 *
 *   node scripts/reset-admin-password.mjs admin@softifybd.com < /path/to/a/file
 *   printf '%s' "$NEW" | node scripts/reset-admin-password.mjs admin@softifybd.com
 *
 * WHY THIS EXISTS
 *
 * The portal can already change a password two ways: `/account` for your own, and a
 * Super Admin resetting somebody else's. Both need somebody signed in. There was no
 * answer at all for the case where the LAST Super Admin's password is lost — and the
 * portal deliberately refuses to delete the last Super Admin, precisely so nobody can
 * lock everyone out. Between those two rules the account became unrecoverable.
 *
 * The recovery is filesystem access, which is the right authority for it: whoever can
 * read content/users.json can already read every hash in it. This does not widen who
 * can get in; it just stops a lost password from being terminal.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not print the password back, does not log it, and does not write it
 * anywhere except as a scrypt hash with a fresh salt. The parameters match
 * admin/server.js exactly (N=16384, r=8, p=1, 64 bytes) — if those ever diverge the
 * portal would refuse a password this set, so they are asserted rather than assumed.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const USERS = 'content/users.json';
const email = (process.argv[2] || '').toLowerCase().trim();

if (!email) {
  console.error('usage: printf %s "newpassword" | node scripts/reset-admin-password.mjs <email>');
  process.exit(2);
}

/** Everything on stdin, trailing newline stripped — a heredoc or a pipe both add one. */
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');

/**
 * The same floor the portal enforces on its own forms. Enforced here too, because a
 * back door that skips the rules is how the rules stop meaning anything.
 */
if (password.length < 12) {
  console.error(`Refused: the password is ${password.length} characters. The portal requires 12.`);
  process.exit(1);
}

const db = JSON.parse(readFileSync(USERS, 'utf8'));
const user = db.users.find((u) => String(u.email).toLowerCase() === email);
if (!user) {
  console.error(`Refused: no account ${email}. Accounts are: ${db.users.map((u) => u.email).join(', ')}`);
  process.exit(1);
}

const salt = randomBytes(16).toString('hex');
user.salt = salt;
user.hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

/**
 * Bump it for the same reason the portal does on a password change: a stateless
 * signed cookie issued under the OLD password stays validly signed until its own
 * expiry. Without this line, changing the password because you think it leaked would
 * leave whoever has the leaked cookie signed in.
 */
user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;

writeFileSync(USERS, JSON.stringify(db, null, 2));

console.log(`Password set for ${user.email} (${user.role}).`);
console.log(`Every existing session for that account is now dead — tokenVersion is ${user.tokenVersion}.`);
console.log('Restart nothing; the portal reads the file per request.');
