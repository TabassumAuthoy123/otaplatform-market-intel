#!/usr/bin/env node
/**
 * OTA Platform — Admin content portal
 * ---------------------------------------------------------------------------
 * Edits ../content/site.json, which the /portal B2C storefront inside the
 * Market Intelligence app renders.
 *
 *   node admin/server.js          (or: npm run admin, from the project root)
 *   http://localhost:4001
 *
 * Set APP_URL if the main app is not on the default port, e.g.
 *   set APP_URL=http://localhost:3000
 *
 * Deliberately zero-dependency: Node's own http/crypto/fs only. Nothing to
 * npm install, nothing native to compile on Windows, starts in under a second.
 *
 * Binds 127.0.0.1 only. This is an admin surface — it must not be reachable
 * from the office network without a deliberate change here.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const clock = require('./clock.js');
const { createScheduler } = require('./scheduler.js');
const fsp = require('node:fs/promises');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.ADMIN_PORT || 4001);

// Where the Market Intelligence app (which serves /portal) is running.
// 3000 is this app's canonical port; override when it is taken.
const APP_URL = (process.env.APP_URL || 'http://localhost:3002').replace(/\/+$/, '');
const PORTAL_URL = `${APP_URL}/portal`;

const AGENCY = require('./agency-fields');
/**
 * The same declaration the app enforces, not a copy of it.
 *
 * Written twice, this screen and the route guard would be two lists, and a drifted
 * list means a module that looks switchable but is not — or is enforced but never
 * offered. Exactly the `/accounts/gds` table that named seven environment variables
 * while the code read thirty-six. So the file is plain CommonJS and both sides read
 * it: `require` here, `allowJs` import in lib/panelMenus.ts.
 */
const { PANEL_MODULES, PANEL_GROUP_LABEL, isModuleOn } = require('../lib/panel-modules.js');
/**
 * The period-lock guard, the same module the app uses. Written twice it would drift
 * into a hole — this portal accepting an edit the app rejects, silently.
 */
const LOCK = require('../lib/period-lock.js');

/**
 * Refuse a write that lands in a closed period.
 *
 * Checks the OLD dates as well as the new ones. Moving a voucher out of a locked
 * month is the same restatement as editing it there, and a guard that only looked at
 * the incoming value would wave it through.
 */
function lockRefusal(book, ...records) {
  const dates = records.flatMap((r) => LOCK.datesOf(r));
  const verdict = LOCK.mayWrite(book.lockedThrough || null, dates);
  return verdict.ok ? null : verdict.reason;
}

function lockedPage(session, reason) {
  return page({
    title: 'Closed period',
    session,
    body: `<h1>That period is closed</h1><p class="sub">${esc(reason)}</p>
      <p style="margin-top:18px"><a class="primary" href="/books">Back to records</a></p>`
  });
}
const CRM = require('./crm-fields');
/**
 * The CRM vocabularies as they are configured, not as they were coded.
 *
 * content/crm-vocab.json overrides admin/crm-fields.js. Read per call rather
 * than held: the file is a couple of KB and a stale dropdown after somebody
 * renames a disposition would be exactly the confusion the screen exists to
 * remove. `hidden` retires a value without deleting it, so a lead that already
 * carries it still renders its label.
 */
const VOCAB_FILE = () => path.join(CONTENT_DIR, 'crm-vocab.json');

function vocab() {
  return CRM.applyOverrides(readJson(VOCAB_FILE(), null));
}

/** Only the values a person should be offered for NEW work. */
function vocabOffered(key) {
  const v = vocab();
  const hide = new Set(v.hidden[key] || []);
  return Object.entries(v.vocab[key]).filter(([k]) => !hide.has(k));
}

/** Any value, including retired ones, so history reads correctly. */
function vocabLabel(key, slug) {
  return vocab().vocab[key][slug] || slug;
}

const RBAC = require('./roles');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const SITE_FILE = path.join(CONTENT_DIR, 'site.json');
const AGENCIES_FILE = path.join(CONTENT_DIR, 'agencies.json');
const CRM_LEADS_FILE = path.join(CONTENT_DIR, 'crm-leads.json');
const CRM_USERS_FILE = path.join(CONTENT_DIR, 'crm-users.json');
const CRM_ACTIVITIES_FILE = path.join(CONTENT_DIR, 'crm-activities.json');
const USERS_FILE = path.join(CONTENT_DIR, 'users.json');
const LEADS_FILE = path.join(CONTENT_DIR, 'leads.json');
const SECRET_FILE = path.join(CONTENT_DIR, '.session-secret');

const SESSION_HOURS = 12;

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * What a backup contains.
 *
 * Deliberately not `users.json` or `.session-secret`. A backup gets emailed
 * around and pasted into chat windows; a password hash and a signing key must
 * not travel that way, and a restore that swapped the user table could lock
 * everybody out or let somebody in.
 */
const BACKUP_SET = [
  'accounting.json', 'site.json', 'agencies.json', 'crm-leads.json',
  'crm-users.json', 'competitors.json', 'audit-log.json'
];

const BACKUP_WHAT = {
  'accounting.json': 'The whole accounting book — every voucher and master',
  'site.json': 'Storefront copy, theme and section toggles',
  'agencies.json': 'The researched agency dataset',
  'crm-leads.json': '400 prospects and their call state',
  'crm-users.json': 'Sales reps the CRM assigns leads to',
  'competitors.json': 'Competitor profiles',
  'audit-log.json': 'Who changed what'
};

const AUDIT_FILE = () => path.join(CONTENT_DIR, 'audit-log.json');

/**
 * The scheduled checks.
 *
 * Started at the bottom of this file, after the server is listening, so a check
 * that asks the app a question is not racing the boot it depends on.
 */
const scheduler = createScheduler({
  contentDir: CONTENT_DIR,
  readJson,
  writeJsonAtomic,
  appUrl: APP_URL,
  backupSet: BACKUP_SET,
  onAudit: (entry) => audit({ email: 'scheduler', role: 'system' }, entry.action, entry)
});

/**
 * Who changed what, and what it looked like before.
 *
 * Six people share this portal and every one of them can move money. An
 * accounting system that cannot answer "who cancelled that invoice" is not one
 * you can put in front of a client, and asking the people involved is not an
 * audit trail.
 *
 * The `before` snapshot is the part that matters. Knowing a record changed is
 * mildly useful; being able to say what it used to say is what settles an
 * argument. Both sides are stored, trimmed to keep the file readable.
 *
 * Failures here are swallowed on purpose. A full disk must not stop somebody
 * recording a receipt — losing one log line is bad, losing the receipt is
 * worse.
 */
async function audit(session, action, entry) {
  try {
    const log = readJson(AUDIT_FILE(), []);
    log.unshift({
      at: new Date().toISOString(),
      user: session ? session.email : 'system',
      role: session ? session.role : '',
      action,
      collection: entry.collection || '',
      recordId: entry.id || '',
      label: entry.label || '',
      summary: entry.summary || '',
      before: entry.before === undefined ? null : trimForLog(entry.before),
      after: entry.after === undefined ? null : trimForLog(entry.after)
    });
    // 5000 entries is months of real use and keeps the file openable by hand.
    await writeJsonAtomic(AUDIT_FILE(), log.slice(0, 5000));
  } catch (err) {
    console.error('audit log write failed:', err.message);
  }
}

/** Keep a snapshot readable: long strings clipped, deep nesting flattened. */
function trimForLog(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (typeof value !== 'object') return value;
  if (depth > 2) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => trimForLog(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = trimForLog(v, depth + 1);
  return out;
}

/** The fields that actually differ, for a one-line "what changed". */
function diffSummary(before, after) {
  if (!before || typeof before !== 'object') return '';
  const changed = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after || {})])) {
    const a = JSON.stringify(before[k]);
    const b = JSON.stringify((after || {})[k]);
    if (a !== b) changed.push(k);
  }
  return changed.length ? changed.join(', ') : 'no field changed';
}

/**
 * One write at a time, per file.
 *
 * `writeJsonAtomic` makes the file REPLACEMENT atomic, which is not the same
 * thing as making the change safe. Every handler does read → mutate its own
 * copy → write, and two handlers overlapping means the second write replaces
 * the first wholesale. Proven before this existed: two edits a moment apart,
 * and the first one vanished with nothing logged and no error shown.
 *
 * Six roles share this portal, so that was a live data-loss path, not a
 * theoretical one. Everything that mutates a content file now goes through
 * `guardedSave`, which re-reads inside the lock so the mutation is applied to
 * what is actually on disk rather than to a stale copy.
 */
const writeChains = new Map();

function serialise(file, task) {
  const prev = writeChains.get(file) ?? Promise.resolve();
  // Swallow the previous failure so one bad save cannot wedge the queue.
  const next = prev.catch(() => {}).then(task);
  writeChains.set(file, next.catch(() => {}));
  return next;
}

/**
 * A short fingerprint of one record, so two people editing DIFFERENT records
 * never collide while two editing the SAME record are told.
 *
 * A whole-file revision counter would be simpler and would reject far too much:
 * with six people working, an accountant saving a receipt would block a
 * colleague saving an unrelated supplier. The unit of conflict is the record.
 */
function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12);
}

/**
 * Re-read, check nobody else moved first, mutate, write.
 *
 * `mutate` receives the FRESH object and returns false to abort. A thrown
 * `ConflictError` reaches the handler, which turns it into a page the person
 * can act on rather than a silent overwrite.
 */
class ConflictError extends Error {
  constructor(detail) {
    super('conflict');
    this.detail = detail;
  }
}

function guardedSave(file, session, mutate, { expectFingerprint, locate } = {}) {
  return serialise(file, async () => {
    const fresh = readJson(file, {});

    if (expectFingerprint !== undefined && typeof locate === 'function') {
      const current = locate(fresh);
      const now = fingerprint(current);
      // No fingerprint at all means the form was not rendered by this server —
      // an old cached page, or something posting directly. Refused either way,
      // but say which it is rather than blaming a colleague who did nothing.
      if (!expectFingerprint) {
        throw new ConflictError({ stale: true, by: 'unknown', at: 'unknown', missing: false });
      }
      if (now !== expectFingerprint) {
        throw new ConflictError({
          expected: expectFingerprint,
          found: now,
          missing: current === undefined || current === null,
          by: (fresh._meta && fresh._meta.lastEditedBy) || 'someone else',
          at: (fresh._meta && fresh._meta.lastEditedAt) || 'a moment ago'
        });
      }
    }

    if (mutate(fresh) === false) return null;
    stampMeta(fresh, session);
    await writeJsonAtomic(file, fresh);
    return fresh;
  });
}

/** The page shown when two people edited the same record. */
function conflictView(session, spec, id, detail) {
  return page({
    title: 'Someone else saved first',
    session,
    active: 'books',
    body: `
      <h1>Someone else saved first</h1>
      <div class="flash warn">
        <strong>Nothing was written.</strong>
        ${detail.stale
          ? `<p style="margin:6px 0 0">This form did not carry a version marker, so there is no way to tell whether <span class="tnum">${esc(id)}</span> has changed since it was opened. That happens with a page restored from browser cache. Open the record again.</p>`
          : detail.missing
            ? `<p style="margin:6px 0 0">The record <span class="tnum">${esc(id)}</span> is no longer in ${esc(spec.label)} — it looks like it was deleted while this form was open.</p>`
            : `<p style="margin:6px 0 0">${esc(detail.by)} changed <span class="tnum">${esc(id)}</span> at ${esc(detail.at)}, after this form was opened. Saving now would silently undo their edit.</p>`}
      </div>
      <p class="sub">
        Open the record again to see the current values, then re-apply your change on top of theirs.
        Your form has not been discarded — use the browser Back button if you need to copy anything out of it first.
      </p>
      <div class="bar">
        <a class="primary" href="/books/edit?col=${esc(spec.key)}&id=${encodeURIComponent(id)}"
           style="text-decoration:none;display:inline-block;padding:9px 18px;border-radius:8px">Reload the record</a>
        <a class="secondary" href="/books/list?col=${esc(spec.key)}">Back to ${esc(spec.label)}</a>
      </div>`
  });
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/* ------------------------------------------------------------ auth & secret */

function sessionSecret() {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE);
  const s = crypto.randomBytes(32);
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(SECRET_FILE, s);
  return s;
}
const SECRET = sessionSecret();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * First boot with no users.json: create one admin so the portal is usable.
 * Override with ADMIN_EMAIL / ADMIN_PASSWORD env vars before first run.
 *
 * THE PASSWORD IS GENERATED, NOT A CONSTANT, AND THAT IS A FIX
 *
 * This used to fall back to a fixed string. That string was committed, and this
 * repository is public — so the default super-admin password of every installation
 * was readable by anybody who found the repo, in this file and again in B2C-ADMIN.md.
 * It was only ever harmless because the portal binds 127.0.0.1; the day somebody runs
 * `dev:lan`, puts it behind a tunnel or deploys it, a published default is a published
 * super-admin account.
 *
 * A shipped default is worse than a generated one even when it is documented, because
 * documenting it is exactly what publishes it. Now the value is random per install and
 * printed to the terminal once. Nobody can commit it, because nobody but the operator
 * ever sees it.
 */
function seedUsersIfMissing() {
  if (fs.existsSync(USERS_FILE)) return null;
  const email = (process.env.ADMIN_EMAIL || 'admin@softifybd.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || `Ota-${crypto.randomBytes(9).toString('base64url')}`;
  const { salt, hash } = hashPassword(password);
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify({ users: [{ email, name: 'Administrator', role: 'admin', salt, hash }] }, null, 2),
    'utf8'
  );
  return { email, password };
}

function findUser(email) {
  const db = readJson(USERS_FILE, { users: [] });
  return db.users.find((u) => u.email === String(email || '').trim().toLowerCase());
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

/**
 * A signed cookie carrying who, until when, and which generation of credentials.
 *
 * `iat` is the moment of issue. The CSRF token is derived from it, so every login
 * gets a different one — previously `csrfFor` was HMAC over the email alone,
 * which meant one token stayed valid for that person for as long as the server
 * secret lived. A token caught in a screenshot or a shared URL never expired.
 *
 * `ver` is the user's tokenVersion. Bumping it on the user record invalidates
 * every cookie already issued to them, which is what makes a password change
 * actually end other sessions. Without it a stateless signed cookie survives
 * until its own expiry no matter what the account does.
 */
function makeSession(email, tokenVersion) {
  const now = Date.now();
  const expires = now + SESSION_HOURS * 3600 * 1000;
  const payload = [Buffer.from(email).toString('base64url'), expires, now, Number(tokenVersion || 0)].join('.');
  return `${payload}.${sign(payload)}`;
}

function readSession(cookieHeader) {
  const raw = parseCookies(cookieHeader).ota_admin;
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [emailB64, expires, iat, ver] = payload.split('.');
  if (!emailB64 || !expires || Number(expires) < Date.now()) return null;
  const email = Buffer.from(emailB64, 'base64url').toString('utf8');
  const user = findUser(email);
  if (!user) return null;

  // A cookie from before the account's current credential generation is dead,
  // however valid its signature. This is what a password change relies on.
  if (Number(ver || 0) !== Number(user.tokenVersion || 0)) return null;

  return { email: user.email, name: user.name, role: user.role, iat: Number(iat || 0) };
}

/**
 * Bound to this session, not just to the person.
 *
 * Including `iat` means the token changes on every login and dies with the
 * session. The previous version hashed the email alone, so one leaked token was
 * good forever.
 */
function csrfFor(session) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`csrf:${session.email}:${session.iat || 0}`)
    .digest('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * `Secure` only when the request actually arrived over TLS.
 *
 * Setting it unconditionally would break the portal entirely on http://localhost,
 * which is how it is used — the browser would refuse to store the cookie and
 * every login would appear to succeed and then bounce straight back to the login
 * screen. Conditional means it is correct in both places rather than in neither.
 */
function secureFlag(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isTls = Boolean(req.socket && req.socket.encrypted) || proto === 'https';
  return isTls ? '; Secure' : '';
}

function sessionCookie(req, value) {
  return `ota_admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secureFlag(req)}`;
}

// crude brute-force brake, per remote address
const attempts = new Map();
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= 10;
}
function noteAttempt(ip) {
  const rec = attempts.get(ip) || { count: 0, first: Date.now() };
  rec.count += 1;
  attempts.set(ip, rec);
}

/* ------------------------------------------------------- JSON path plumbing */

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * What to add to an array that is still empty.
 *
 * "Add item" normally copies the shape of the first row, which works until the
 * array has no rows — the first attachment anyone tried to add would arrive as
 * a bare string and render as one nameless text box. These are the shapes that
 * cannot be inferred.
 */
const EMPTY_ARRAY_SHAPES = {
  attachments: { name: '', url: '', note: '' },
  lines: { serviceId: '', description: '', pnr: '', pax: 1, qty: 1, unitPrice: 0, supplierCost: 0, supplierId: '' }
};

function blankRowFor(arrPath) {
  const key = String(arrPath).split('.').pop();
  const shape = EMPTY_ARRAY_SHAPES[key];
  return shape ? JSON.parse(JSON.stringify(shape)) : '';
}

/** A blank item shaped like `sample`, so "Add item" produces usable fields. */
function blankLike(sample) {
  if (Array.isArray(sample)) return [];
  if (sample && typeof sample === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(sample)) out[k] = blankLike(v);
    return out;
  }
  if (typeof sample === 'number') return 0;
  if (typeof sample === 'boolean') return false;
  return '';
}

/* ------------------------------------------------------------------ sections */

const SECTIONS = [
  { key: 'brand', label: 'Brand & contact', hint: 'Name, hotline, email, office address.' },
  { key: 'announcement', label: 'Announcement bar', hint: 'The strip above the header.' },
  { key: 'hero', label: 'Homepage hero', hint: 'Headline, subtitle, buttons, search tabs, badges.' },
  { key: 'nav', label: 'Navigation', hint: 'Header menu items.' },
  { key: 'trustStats', label: 'Trust numbers', hint: 'The four tiles under the hero.' },
  { key: 'services', label: 'Services', hint: 'What you can book — the six cards.' },
  { key: 'routes', label: 'Flight routes', hint: 'Sample fares shown on / and /flights.' },
  { key: 'packages', label: 'Packages', hint: 'Hajj, Umrah and tour packages.' },
  { key: 'hotels', label: 'Hotels', hint: 'Sample nightly rates.' },
  { key: 'visa', label: 'Visa page', hint: 'Destinations and processing windows.' },
  { key: 'why', label: 'Why this platform', hint: 'The six numbered reasons.' },
  { key: 'credentials', label: 'Credentials', hint: 'ISO, BASIS, DUNS strip.' },
  { key: 'paymentMethods', label: 'Payment methods', hint: 'Footer payment chips.' },
  { key: 'testimonials', label: 'Testimonials', hint: 'Leave empty unless the quote is real and permitted.' },
  { key: 'agentCta', label: 'Agent CTA', hint: 'The B2B block on / and /agents.' },
  { key: 'agentTiers', label: 'Agent tiers', hint: 'Starter / Growth / Professional / Hajj.' },
  { key: 'pricingNote', label: 'Pricing note', hint: 'One paragraph under the tiers.' },
  { key: 'about', label: 'About page', hint: 'Company facts and capability list.' },
  { key: 'contact', label: 'Contact page', hint: 'Hotline, email, office.' },
  { key: 'footer', label: 'Footer', hint: 'Blurb, link columns, legal and disclaimer.' }
];

const LONG_TEXT_KEYS = new Set([
  'body', 'desc', 'detail', 'blurb', 'note', 'text', 'quote', 'subtitle',
  'disclaimer', 'legal', 'pricingNote', '_hint', 'hint', '_note'
]);

/* --------------------------------------------------------------- form render */

function renderField(pathKey, key, value, boolPaths, numPaths, arrayLinePaths, enums) {
  const label = key.replace(/^_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const id = pathKey.replace(/[^a-zA-Z0-9]/g, '_');

  /**
   * Anything with a known set of values gets a dropdown rather than a text box.
   *
   * Typing `CUS-004` by hand into a customer field is how a receipt ends up
   * attached to nobody: the id looks plausible, the form accepts it, and the
   * error only shows up later as a customer whose ledger does not add up. The
   * list is built from the book itself, so it cannot offer an id that is not
   * there.
   */
  const choices = enums && enums[key];
  if (choices && (typeof value === 'string' || value === null)) {
    const cur = value == null ? '' : String(value);
    const known = choices.some((o) => o.value === cur);
    return `
      <label class="row">
        <span class="lab">${esc(label)}</span>
        <select name="${esc(pathKey)}" id="${id}">
          ${choices.map((o) => `<option value="${esc(o.value)}"${o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
          ${known ? '' : `<option value="${esc(cur)}" selected>${esc(cur || '—')} (not in the book)</option>`}
        </select>
      </label>`;
  }

  if (typeof value === 'boolean') {
    boolPaths.push(pathKey);
    return `
      <label class="row check">
        <input type="checkbox" name="${esc(pathKey)}" id="${id}" ${value ? 'checked' : ''}>
        <span class="lab">${esc(label)}</span>
      </label>`;
  }

  if (typeof value === 'number') {
    numPaths.push(pathKey);
    return `
      <label class="row">
        <span class="lab">${esc(label)}</span>
        <input type="number" name="${esc(pathKey)}" id="${id}" value="${esc(value)}" step="any">
      </label>`;
  }

  if (typeof value === 'string') {
    const long = LONG_TEXT_KEYS.has(key) || value.length > 90;
    if (long) {
      return `
      <label class="row">
        <span class="lab">${esc(label)}</span>
        <textarea name="${esc(pathKey)}" id="${id}" rows="${Math.min(8, Math.max(2, Math.ceil(value.length / 80)))}">${esc(value)}</textarea>
      </label>`;
    }
    return `
      <label class="row">
        <span class="lab">${esc(label)}</span>
        <input type="text" name="${esc(pathKey)}" id="${id}" value="${esc(value)}">
      </label>`;
  }

  if (Array.isArray(value)) {
    // array of plain strings -> one textarea, one value per line
    if (value.every((v) => typeof v === 'string')) {
      arrayLinePaths.push(pathKey);
      return `
      <label class="row">
        <span class="lab">${esc(label)} <em>one per line</em></span>
        <textarea name="lines:${esc(pathKey)}" rows="${Math.min(12, Math.max(3, value.length + 1))}">${esc(value.join('\n'))}</textarea>
      </label>`;
    }

    // array of objects / nested arrays -> repeated cards
    const items = value
      .map((item, i) => {
        const inner = renderValue(`${pathKey}.${i}`, item, boolPaths, numPaths, arrayLinePaths, enums);
        const title = itemTitle(item, i);
        return `
        <div class="item">
          <div class="item-head">
            <span class="item-no">${i + 1}</span>
            <strong>${esc(title)}</strong>
            <label class="del"><input type="checkbox" name="remove:${esc(pathKey)}.${i}"> delete</label>
          </div>
          ${inner}
        </div>`;
      })
      .join('');

    return `
      <fieldset class="arr">
        <legend>${esc(label)} <span class="count">${value.length}</span></legend>
        ${items || '<p class="empty">No items yet.</p>'}
        <button type="submit" name="addto" value="${esc(pathKey)}" class="btn-add">+ Add item</button>
      </fieldset>`;
  }

  if (value && typeof value === 'object') {
    return `
      <fieldset class="obj">
        <legend>${esc(label)}</legend>
        ${renderValue(pathKey, value, boolPaths, numPaths, arrayLinePaths, enums)}
      </fieldset>`;
  }

  return '';
}

function renderValue(pathKey, value, boolPaths, numPaths, arrayLinePaths, enums) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([k, v]) => renderField(`${pathKey}.${k}`, k, v, boolPaths, numPaths, arrayLinePaths, enums))
      .join('');
  }
  return renderField(pathKey, pathKey.split('.').pop(), value, boolPaths, numPaths, arrayLinePaths, enums);
}

function itemTitle(item, i) {
  if (item && typeof item === 'object') {
    for (const k of ['title', 'label', 'name', 'area', 'country', 'k', 'from']) {
      if (typeof item[k] === 'string' && item[k]) return item[k];
    }
  }
  return `Item ${i + 1}`;
}

/* -------------------------------------------------------------------- layout */

/**
 * The count next to the sidebar link.
 *
 * Read from the alerts file rather than by asking the scheduler, so rendering a
 * page can never trigger a check. A sidebar that does work is a sidebar that
 * makes every page slow.
 */
function alertBadge() {
  try {
    const store = readJson(path.join(CONTENT_DIR, 'alerts.json'), { open: [], acknowledged: {} });
    const acked = store.acknowledged || {};
    const n = (store.open || []).filter((a) => !acked[a.id] && a.severity !== 'info').length;
    if (!n) return '';
    return ` <span style="display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:var(--amber);color:#fff;font-size:10.5px;font-weight:700;text-align:center">${n}</span>`;
  } catch {
    return '';
  }
}

function page({ title, session, body, active = '' }) {
  const vis = session ? RBAC.visible(session.role) : {};
  const roleLabel = session ? ((RBAC.ROLES[RBAC.normaliseRole(session.role)] || {}).label || session.role) : '';
  const nav = session
    ? `
    <aside class="side">
      <div class="brand"><span class="mark">OTA</span><span>Admin</span></div>
      <nav>
        <a href="/dashboard" class="${active === 'dashboard' ? 'on' : ''}">Overview</a>
        ${vis.leads ? `<a href="/leads" class="${active === 'leads' ? 'on' : ''}">Demo requests</a>` : ''}
        ${vis.books ? `<div class="sep">Accounting</div>
        <a href="/books" class="${active === 'books' ? 'on' : ''}">Records${RBAC.canWriteBooks(session.role) ? ' — add / edit / delete' : ' — read only'}</a>
        <a href="/journal" class="${active === 'journal' ? 'on' : ''}">Journal vouchers</a>
        <a href="/bank-statements" class="${active === 'bank-statements' ? 'on' : ''}">Bank statements</a>` : ''}
        ${vis.design || vis.integrations ? '<div class="sep">Storefront</div>' : ''}
        ${vis.design ? `<a href="/design" class="${active === 'design' ? 'on' : ''}">Design &amp; layout</a>` : ''}
        ${vis.integrations ? `<a href="/integrations" class="${active === 'integrations' ? 'on' : ''}">API integrations</a>` : ''}
        ${vis.crm ? `<div class="sep">Sales CRM · 400 prospects</div>
        <a href="/crm/dashboard" class="${active === 'crm-dash' ? 'on' : ''}">Manager dashboard</a>
        <a href="/crm" class="${active === 'crm' ? 'on' : ''}">Lead list</a>
        <a href="/crm/call" class="${active === 'crm-call' ? 'on' : ''}">Call mode</a>
        ${RBAC.can(session.role, 'crm_vocab') ? `<a href="/crm/vocab" class="${active === 'crm-vocab' ? 'on' : ''}">Lists &amp; vocabulary</a>` : ''}
        ${RBAC.can(session.role, 'crm_assign') ? `<a href="/crm/import" class="${active === 'crm-import' ? 'on' : ''}">Import leads</a>` : ''}` : ''}
        ${vis.agencies ? `<div class="sep">Market Intelligence</div>
        <a href="/agencies" class="${active === 'agencies' ? 'on' : ''}">Agency dataset</a>` : ''}
        ${vis.design ? '<div class="sep">B2C storefront content</div>' : ''}
        ${SECTIONS.map(
          (s) => `<a href="/edit/${s.key}" class="${active === s.key ? 'on' : ''}">${esc(s.label)}</a>`
        ).join('')}
        ${vis.users ? `<div class="sep">Administration</div>
        <a href="/users" class="${active === 'users' ? 'on' : ''}">Users &amp; roles</a>
` : ''}
        ${vis.alerts ? `<a href="/alerts" class="${active === 'alerts' ? 'on' : ''}">Alerts${alertBadge()}</a>` : ''}
        ${vis.audit ? `<a href="/audit" class="${active === 'audit' ? 'on' : ''}">Audit log</a>` : ''}
        ${vis.backup ? `<a href="/backup" class="${active === 'backup' ? 'on' : ''}">Backup &amp; restore</a>` : ''}
        ${vis.raw ? `<a href="/raw" class="${active === 'raw' ? 'on' : ''}">Raw JSON</a>` : ''}
      </nav>
      <div style="padding:0 8px 6px">
        <a href="/account" class="${active === 'account' ? 'on' : ''}">Your account</a>
      </div>
      <form method="post" action="/logout" class="out">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="who">${esc(session.email)}<br><span style="color:var(--teal4)">${esc(roleLabel)}</span></div>
        <button type="submit">Sign out</button>
      </form>
    </aside>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · OTA Platform Admin</title>
<style>
:root{--navy:#13294B;--navy9:#0B1A33;--teal:#0F6F73;--teal4:#1FA8AE;--amber:#9A5B00;
--ink:#1F2933;--muted:#5A6472;--surface:#F5F8FA;--panel:#EEF2F5;--hair:#DCE6EC}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);
font:15px/1.5 'Inter','Segoe UI',system-ui,sans-serif}
a{color:var(--teal);text-decoration:none}
.wrap{display:flex;min-height:100vh}
.side{width:250px;flex:0 0 250px;background:var(--navy9);color:#fff;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:9px;padding:18px 18px 14px;font-weight:700;font-size:15px}
.brand .mark{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#fff;color:var(--navy);font-size:12px}
.side nav{display:flex;flex-direction:column;padding:0 8px;flex:1}
.side nav a{padding:8px 11px;border-radius:7px;color:rgba(255,255,255,.72);font-size:13.5px}
.side nav a:hover{background:rgba(255,255,255,.07);color:#fff}
.side nav a.on{background:var(--teal);color:#fff;font-weight:600}
.sep{padding:16px 11px 6px;font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--teal4)}
.out{padding:14px 18px;border-top:1px solid rgba(255,255,255,.1)}
.out .who{font-size:11.5px;color:rgba(255,255,255,.55);margin-bottom:8px;word-break:break-all}
.out button{width:100%;padding:8px;border:1px solid rgba(255,255,255,.22);background:transparent;color:#fff;border-radius:7px;font-size:12.5px;cursor:pointer}
.out button:hover{background:rgba(255,255,255,.1)}
main{flex:1;min-width:0;padding:30px 34px 70px}
h1{margin:0 0 6px;font-size:25px;color:var(--navy);letter-spacing:-.01em}
h1+.sub{margin:0 0 26px;color:var(--muted);font-size:13.5px}
.card{background:#fff;border:1px solid var(--hair);border-radius:12px;padding:22px;margin-bottom:16px}
.grid{display:grid;gap:13px;grid-template-columns:repeat(auto-fill,minmax(270px,1fr))}
.tile{display:block;background:#fff;border:1px solid var(--hair);border-radius:12px;padding:16px 17px}
.tile:hover{border-color:var(--teal4)}
.tile strong{display:block;color:var(--navy);font-size:14.5px;margin-bottom:3px}
.tile span{color:var(--muted);font-size:12.5px}
.row{display:block;margin-bottom:13px}
.row .lab{display:block;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.row .lab em{font-weight:500;text-transform:none;letter-spacing:0;color:var(--muted);opacity:.8}
.row input[type=text],.row input[type=number],.row input[type=email],.row input[type=password],.row textarea{
width:100%;padding:9px 11px;border:1px solid var(--hair);border-radius:8px;background:var(--surface);
font:14px/1.45 inherit;color:var(--navy)}
.row textarea{resize:vertical}
.row input:focus,.row textarea:focus{outline:none;border-color:var(--teal4);background:#fff}
.row.check{display:flex;align-items:center;gap:9px}
.row.check .lab{margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--ink)}
fieldset{border:1px solid var(--hair);border-radius:10px;padding:16px;margin:0 0 16px}
fieldset legend{padding:0 7px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--navy)}
fieldset legend .count{background:var(--panel);border-radius:20px;padding:1px 7px;font-size:10.5px;color:var(--muted)}
.item{border:1px solid var(--hair);border-left:3px solid var(--teal);border-radius:8px;padding:14px;margin-bottom:12px;background:var(--surface)}
.item-head{display:flex;align-items:center;gap:9px;margin-bottom:11px;padding-bottom:9px;border-bottom:1px solid var(--hair)}
.item-no{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:var(--navy);color:#fff;font-size:11px;font-weight:700}
.item-head strong{flex:1;font-size:13.5px;color:var(--navy)}
.del{font-size:11.5px;color:var(--amber);display:flex;align-items:center;gap:4px;cursor:pointer}
.btn-add{background:var(--panel);border:1px dashed var(--hair);border-radius:8px;padding:8px 14px;font-size:12.5px;color:var(--navy);cursor:pointer}
.btn-add:hover{border-color:var(--teal4);color:var(--teal)}
.empty{color:var(--muted);font-size:13px;margin:0 0 12px}
.bar{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--hair);padding:14px 0;margin-top:20px;display:flex;gap:11px;align-items:center}
.primary{background:var(--teal);color:#fff;border:0;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer}
.primary:hover{background:#0B5A5E}
.secondary{border:1px solid var(--hair);background:#fff;border-radius:8px;padding:11px 18px;font-size:13.5px;color:var(--navy);cursor:pointer}
.flash{border-left:3px solid var(--teal);background:rgba(15,111,115,.06);padding:12px 15px;border-radius:8px;margin-bottom:18px;font-size:13.5px}
.flash.warn{border-color:var(--amber);background:rgba(154,91,0,.07)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{background:var(--navy);color:#fff;text-align:left;padding:10px 12px;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em}
td{padding:10px 12px;border-bottom:1px solid var(--hair);vertical-align:top}
tr:nth-child(even) td{background:var(--surface)}
.tnum{font-variant-numeric:tabular-nums}
/* login */
.login{display:grid;place-items:center;min-height:100vh;width:100%}
.login .box{background:#fff;border:1px solid var(--hair);border-radius:14px;padding:32px;width:100%;max-width:380px}
.login h1{font-size:20px;margin-bottom:4px}
.login .sub{margin-bottom:22px}
.err{color:var(--amber);font-size:13px;font-weight:600;margin:0 0 14px}
@media(max-width:820px){.wrap{flex-direction:column}.side{width:100%;flex:none;height:auto;position:static}main{padding:22px 18px 60px}}
</style>
</head><body>
${session ? `<div class="wrap">${nav}<main>${body}</main></div>` : body}
</body></html>`;
}

/* --------------------------------------------------------------------- views */

function loginView(error, seeded) {
  const hint = seeded
    ? `<div class="flash warn">First run — an admin account was created:<br>
       <strong>${esc(seeded.email)}</strong> / <strong>${esc(seeded.password)}</strong><br>
       Change it by deleting <code>content/users.json</code> and restarting with
       <code>ADMIN_EMAIL</code> / <code>ADMIN_PASSWORD</code> set.</div>`
    : '';
  return page({
    title: 'Sign in',
    session: null,
    body: `<div class="login"><form class="box" method="post" action="/login">
      <h1>OTA Platform Admin</h1>
      <p class="sub">Content for the B2C storefront at ${esc(PORTAL_URL)}</p>
      ${hint}
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <label class="row"><span class="lab">Email</span>
        <input type="email" name="email" required autofocus autocomplete="username"></label>
      <label class="row"><span class="lab">Password</span>
        <input type="password" name="password" required autocomplete="current-password"></label>
      <button class="primary" style="width:100%;margin-top:6px" type="submit">Sign in</button>
    </form></div>`
  });
}

function dashboardView(session, content, leadCount, agencyCount, flash) {
  const counts = {
    routes: content.routes?.length ?? 0,
    packages: content.packages?.length ?? 0,
    hotels: content.hotels?.length ?? 0,
    services: content.services?.length ?? 0
  };
  return page({
    title: 'Overview',
    session,
    active: 'dashboard',
    body: `
      <h1>Overview</h1>
      <p class="sub">Edit a section, save, then refresh the B2C portal — content is read from disk on every request.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      <div class="card">
        <div class="grid">
          <a class="tile" href="/agencies"><strong class="tnum">${agencyCount}</strong><span>Agency records →</span></a>
          <div class="tile"><strong class="tnum">${counts.routes}</strong><span>Flight routes</span></div>
          <div class="tile"><strong class="tnum">${counts.packages}</strong><span>Packages</span></div>
          <div class="tile"><strong class="tnum">${counts.hotels}</strong><span>Hotels</span></div>
          <a class="tile" href="/leads"><strong class="tnum">${leadCount}</strong><span>Demo requests →</span></a>
        </div>
      </div>
      <div class="card">
        <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 14px">Sections</h2>
        <div class="grid">
          ${SECTIONS.map(
            (s) => `<a class="tile" href="/edit/${s.key}"><strong>${esc(s.label)}</strong><span>${esc(s.hint)}</span></a>`
          ).join('')}
        </div>
      </div>
      <div class="card">
        <p style="margin:0;font-size:13px;color:var(--muted)">
          B2C storefront: <a href="${esc(PORTAL_URL)}" target="_blank" rel="noreferrer">${esc(PORTAL_URL)}</a> ·
          dashboard: <a href="${esc(APP_URL)}" target="_blank" rel="noreferrer">${esc(APP_URL)}</a> ·
          revision <span class="tnum">${esc(content._meta?.revision ?? 1)}</span>,
          last edited by ${esc(content._meta?.lastEditedBy ?? 'seed')} on ${esc(content._meta?.lastEditedAt ?? '—')}
        </p>
      </div>`
  });
}

function editView(session, sectionKey, content, flash) {
  const meta = SECTIONS.find((s) => s.key === sectionKey);
  const value = content[sectionKey];
  const boolPaths = [];
  const numPaths = [];
  const arrayLinePaths = [];
  const fields = renderField(sectionKey, sectionKey, value, boolPaths, numPaths, arrayLinePaths);

  return page({
    title: meta.label,
    session,
    active: sectionKey,
    body: `
      <h1>${esc(meta.label)}</h1>
      <p class="sub">${esc(meta.hint)}</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      <form method="post" action="/edit/${esc(sectionKey)}">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <input type="hidden" name="__bools" value="${esc(boolPaths.join('|'))}">
        <input type="hidden" name="__nums" value="${esc(numPaths.join('|'))}">
        <div class="card">${fields}</div>
        <div class="bar">
          <button class="primary" type="submit" name="save" value="1">Save changes</button>
          <a class="secondary" href="/dashboard">Cancel</a>
          <span style="margin-left:auto;font-size:12.5px;color:var(--muted)">
            Ticking <em>delete</em> or pressing <em>Add item</em> also saves.
          </span>
        </div>
      </form>`
  });
}

function leadsView(session, leads, flash) {
  return page({
    title: 'Demo requests',
    session,
    active: 'leads',
    body: `
      <h1>Demo requests</h1>
      <p class="sub">Submitted from the storefront's agent form. Stored in content/leads.json (not committed to git).</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      <div class="card" style="padding:0;overflow:hidden">
      ${
        leads.length === 0
          ? `<p class="empty" style="padding:22px">No requests yet. Submit the form at
             <a href="${esc(PORTAL_URL)}/agents" target="_blank" rel="noreferrer">${esc(PORTAL_URL)}/agents</a> to test it.</p>`
          : `<form method="post" action="/leads/delete">
             <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
             <table>
               <thead><tr><th>Received</th><th>Agency / name</th><th>Contact</th><th>Volume</th><th>Message</th><th></th></tr></thead>
               <tbody>
               ${leads
                 .map(
                   (l) => `<tr>
                     <td class="tnum" style="white-space:nowrap">${esc(String(l.receivedAt).slice(0, 16).replace('T', ' '))}</td>
                     <td><strong>${esc(l.agency || '—')}</strong><br><span style="color:var(--muted)">${esc(l.name)}</span></td>
                     <td class="tnum">${esc(l.phone)}<br><span style="color:var(--muted)">${esc(l.email || '—')}</span></td>
                     <td>${esc(l.bookingsPerMonth || '—')}</td>
                     <td style="max-width:280px">${esc(l.message || '—')}</td>
                     <td><label class="del"><input type="checkbox" name="remove" value="${esc(l.id)}"> delete</label></td>
                   </tr>`
                 )
                 .join('')}
               </tbody>
             </table>
             <div class="bar" style="padding:14px 18px"><button class="primary" type="submit">Delete selected</button></div>
           </form>`
      }
      </div>`
  });
}

/* --------------------------------------------------------------- RBAC views */

function forbiddenView(session, verdict, pathname) {
  return page({
    title: 'Not permitted',
    session,
    active: '',
    body: `
      <h1>Not permitted</h1>
      <p class="sub">Your role does not include this.</p>
      <div class="card" style="border-left:4px solid var(--amber)">
        <table>
          <tbody>
            <tr><td style="width:180px;font-weight:600">You are signed in as</td>
                <td>${esc(session.email)} — <strong>${esc(verdict.roleLabel)}</strong></td></tr>
            <tr><td style="font-weight:600">You tried to reach</td><td class="tnum">${esc(pathname)}</td></tr>
            <tr><td style="font-weight:600">That needs</td><td><strong>${esc(verdict.reason)}</strong></td></tr>
          </tbody>
        </table>
        <p style="margin:14px 0 0;font-size:12.5px;color:var(--muted)">
          A Super Admin can change your role under <strong>Users &amp; roles</strong>. This block is applied at the
          route, so it holds whether you clicked a link, typed the address or replayed a form.
        </p>
        <p style="margin:12px 0 0"><a class="secondary" href="/dashboard" style="text-decoration:none">Back to overview</a></p>
      </div>`
  });
}

function usersView(session, users, flash, errors, seededPassword) {
  const roleOptions = (cur) =>
    Object.entries(RBAC.ROLES).map(([k, r]) =>
      `<option value="${esc(k)}"${RBAC.normaliseRole(cur) === k ? ' selected' : ''}>${esc(r.label)}</option>`).join('');

  return page({
    title: 'Users & roles',
    session,
    active: 'users',
    body: `
      <h1>Users &amp; roles</h1>
      <p class="sub">Who can sign in, and what each of them may touch. Enforced at the route, not just in the menu.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      ${errors && errors.length ? `<div class="flash warn"><ul style="margin:0 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      ${seededPassword ? `<div class="flash warn">
        <strong>New user created.</strong> Give them this password once — it is not stored and cannot be shown again:<br>
        <code style="font-size:15px;background:#fff;padding:3px 8px;border-radius:5px;display:inline-block;margin-top:6px">${esc(seededPassword)}</code>
      </div>` : ''}

      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Change role</th><th></th></tr></thead>
          <tbody>
          ${users.map((u) => {
            const isSelf = u.email === session.email;
            return `<tr>
              <td class="tnum" style="font-weight:600;color:var(--navy)">${esc(u.email)}${isSelf ? ' <span style="font-weight:400;color:var(--muted)">(you)</span>' : ''}</td>
              <td>${esc(u.name || '—')}</td>
              <td>${esc((RBAC.ROLES[RBAC.normaliseRole(u.role)] || {}).label || u.role)}</td>
              <td>
                <form method="post" action="/users/role" style="display:flex;gap:7px">
                  <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
                  <input type="hidden" name="email" value="${esc(u.email)}">
                  <select name="role" style="padding:6px 9px;border:1px solid var(--hair);border-radius:7px;font-size:12.5px">${roleOptions(u.role)}</select>
                  <button class="secondary" type="submit" style="padding:6px 12px">Set</button>
                </form>
              </td>
              <td>
                ${isSelf ? '<span style="color:var(--muted);font-size:12px">cannot remove yourself</span>' :
                `<form method="post" action="/users/delete" onsubmit="return confirm('Remove ${esc(u.email)}?')">
                  <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
                  <input type="hidden" name="email" value="${esc(u.email)}">
                  <button type="submit" style="background:none;border:0;color:var(--amber);cursor:pointer;font-size:12.5px">Remove</button>
                </form>`}
              </td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>

      <form method="post" action="/users/new" class="card">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <h2 style="margin:0 0 12px;font-size:14px;color:var(--navy)">Add a user</h2>
        <div style="display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          <label class="row" style="margin:0"><span class="lab">Email</span><input type="email" name="email" required></label>
          <label class="row" style="margin:0"><span class="lab">Name</span><input type="text" name="name"></label>
          <label class="row" style="margin:0"><span class="lab">Role</span><select name="role">${roleOptions('sales_exec')}</select></label>
          <label class="row" style="margin:0"><span class="lab">Password — blank to generate one</span><input type="text" name="password" placeholder="leave blank"></label>
        </div>
        <button class="primary" type="submit" style="margin-top:6px">Create user</button>
      </form>

      <div class="card">
        <h2 style="margin:0 0 12px;font-size:14px;color:var(--navy)">What each role may do</h2>
        <table>
          <thead><tr><th>Role</th><th>Summary</th><th>Capabilities</th></tr></thead>
          <tbody>
            ${Object.entries(RBAC.ROLES).map(([k, r]) => `<tr>
              <td style="font-weight:600;color:var(--navy);white-space:nowrap">${esc(r.label)}</td>
              <td style="font-size:12.5px">${esc(r.summary)}</td>
              <td style="font-size:11.5px;color:var(--muted)">${r.caps.length === Object.keys(RBAC.CAPS).length ? 'everything' : r.caps.map((c) => esc(c)).join(' · ')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <form method="post" action="/users/reset">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="card">
          <h2 style="margin:0 0 6px;font-size:14px;color:var(--navy)">Reset someone else's password</h2>
          <p style="margin:0 0 14px;font-size:12.5px;color:var(--muted);line-height:1.7">
            For somebody who has forgotten theirs or has left. No current password is asked for — the point is that
            nobody has it. Their existing sessions are ended immediately, and the new value is shown once here and
            nowhere else. To change <strong>your own</strong>, use <a href="/account">your account</a>, which asks for
            the current one on purpose.
          </p>
          <label class="row"><span class="lab">Account</span>
            <select name="email">
              ${users.filter((u) => u.email !== session.email).map((u) => `<option value="${esc(u.email)}">${esc(u.email)} — ${esc((RBAC.ROLES[RBAC.normaliseRole(u.role)] || {}).label || u.role)}</option>`).join('')}
            </select></label>
          <label class="row"><span class="lab">New password <em>leave blank to generate one</em></span>
            <input type="text" name="password" autocomplete="off" placeholder="at least 12 characters"></label>
          <div class="bar"><button class="primary" type="submit">Reset password</button></div>
        </div>
      </form>

      <div class="card">
        <h2 style="margin:0 0 10px;font-size:14px;color:var(--navy)">Password handling</h2>
        <p style="margin:0;font-size:12.5px;color:var(--muted);line-height:1.8">
          Hashed with scrypt and a per-user salt. The plaintext is shown once and never again, because it is not
          kept — there is nothing to "view".
          <br><br>
          A password change bumps that account's token version, and every session cookie carries the version it was
          issued under. That is what ends other sessions: the cookie is still correctly signed, and it is still
          refused. Without it a stolen cookie would outlive the password it was obtained with, all the way to its own
          expiry.
        </p>
      </div>`
  });
}

/* ------------------------------------------------------------- book CRUD */

/**
 * Every editable collection in content/accounting.json.
 *
 *   idPrefix / noPrefix  used to mint the next id when a record is created
 *   title                fields tried, in order, for the row heading
 *   search               fields the list search looks in
 *   amount               field shown in the amount column, if any
 *
 * The forms themselves are generated from the shape of each record by the same
 * renderValue()/applyForm() pair the storefront content editor uses, so nested
 * invoice lines get add/remove rows for free and a new field on a record shows
 * up in the form without any wiring.
 */
const BOOK_COLLECTIONS = [
  { key: 'invoices', label: 'Customer invoices', hint: 'Sales. Lines carry supplier cost, which is where margin comes from. Leave currency blank for the book\'s own.', idPrefix: 'INV-', noPrefix: 'invoicePrefix', title: ['no'], search: ['no', 'notes'], amount: null, party: 'customerId' },
  { key: 'receipts', label: 'Customer receipts', hint: 'Money in against an invoice.', idPrefix: 'RCP-', noPrefix: 'receiptPrefix', title: ['no'], search: ['no', 'ref'], amount: 'amount', party: 'customerId' },
  { key: 'bills', label: 'Supplier bills', hint: 'What a supplier charged us for a booking.', idPrefix: 'BIL-', noPrefix: 'billPrefix', title: ['no'], search: ['no', 'notes'], amount: 'amount', party: 'supplierId' },
  { key: 'payments', label: 'Supplier payments', hint: 'Money out against a bill.', idPrefix: 'PAY-', noPrefix: 'paymentPrefix', title: ['no'], search: ['no', 'ref'], amount: 'amount', party: 'supplierId' },
  { key: 'expenses', label: 'Expenses', hint: 'Operating spend by category.', idPrefix: 'EXP-', noPrefix: 'expensePrefix', title: ['no'], search: ['no', 'description'], amount: 'amount', party: 'categoryId' },
  {
    key: 'creditNotes',
    label: 'Credit notes & cancellations',
    hint: 'Reverse part or all of a sale. Settlement decides whether money goes back or the balance just drops.',
    idPrefix: 'CRN-', noPrefix: 'creditNotePrefix', title: ['no'], search: ['no', 'notes'],
    amount: 'amount', party: 'customerId',
    template: {
      id: '', no: '', date: '', customerId: '', invoiceId: '', billId: '',
      reason: 'cancellation', amount: 0, settlement: 'credit_balance', bankId: '',
      supplierRefund: 0, notes: ''
    }
  },
  {
    key: 'supplierCreditNotes',
    label: 'Supplier credit notes',
    hint: 'What a supplier gave back — ADM reversal, overbilling, service failure.',
    idPrefix: 'SCN-', noPrefix: 'supplierCreditPrefix', title: ['no'], search: ['no', 'notes'],
    amount: 'amount', party: 'supplierId',
    template: {
      id: '', no: '', date: '', supplierId: '', billId: '', reason: 'overbilled',
      amount: 0, settlement: 'credit_balance', bankId: '', notes: ''
    }
  },
  {
    key: 'transfers',
    label: 'Deposits & withdrawals',
    hint: 'Cash banked, or drawn back out. Total funds never change, only where they sit.',
    idPrefix: 'TRF-', noPrefix: 'transferPrefix', title: ['no'], search: ['no', 'ref', 'notes'],
    amount: 'amount', party: 'bankId',
    template: {
      id: '', no: '', date: '', direction: 'deposit', bankId: '', amount: 0, ref: '', notes: ''
    }
  },
  { key: 'supplierDeposits', label: 'Supplier deposits', hint: 'Advances placed with consolidators and airlines. This is real money leaving cash or bank.', idPrefix: 'DEP-', noPrefix: null, title: ['no'], search: ['no', 'reference', 'note'], amount: 'amount', party: 'supplierId' },
  { key: 'inventory', label: 'Inventory blocks', hint: 'Seats, room nights and quota bought up front.', idPrefix: 'INV-BLK-', noPrefix: null, title: ['name'], search: ['name', 'note'], amount: null, party: 'supplierId' },
  /**
   * Airline documents. Not a voucher — nothing here posts to the ledger.
   *
   * It is registered alongside the vouchers because it is edited the same way and
   * needs the same fingerprint concurrency, audit and backup, but the amount column
   * is deliberately null: a document carries a fare, not a value, and showing one
   * in the money column would invite somebody to reconcile against it.
   */
  /**
   * Carrier contracts. Deliberately empty on a fresh book — a seeded rate would put
   * money into the margin report and the P&L, so the real ones get typed in.
   */
  /**
   * Tax rules. Empty on a fresh book for the same reason the contracts are — a
   * stale rate shipped inside a product is a wrong invoice that looks
   * authoritative, and the bands here have been revised more than once.
   */
  { key: 'taxRules', label: 'Tax rules', hint: 'A code, what it is charged on, a rate OR a fixed amount per passenger, an optional route band, the services it covers or is exempt from, and the dates it runs between. Resolved against the INVOICE date, so a change never restates a filed month.', idPrefix: 'TAX-', noPrefix: null, title: ['code', 'name'], search: ['code', 'name', 'note'], amount: null, party: null, template: { id: '', code: '', name: '', basis: 'fare', ratePct: 0, fixedAmount: 0, band: 'any', serviceIds: [], exemptServiceIds: [], withholding: false, effectiveFrom: '', effectiveTo: '', active: true, note: '' } },
  { key: 'contracts', label: 'Carrier contracts', hint: 'What each airline allows on a fare. A contract resolves against the ISSUE date on the document, so set the dates carefully — a rate renegotiated in September must not restate August.', idPrefix: 'CTR-', noPrefix: null, title: ['name', 'carrier'], search: ['carrier', 'name', 'note'], amount: null, party: null, template: { id: '', carrier: '', name: '', commissionPct: 0, flatAmount: 0, basis: 'base', band: 'any', cabin: '', effectiveFrom: '', effectiveTo: '', capPerDocument: 0, incentivePct: 0, active: true, note: '' } },
  { key: 'documents', label: 'Airline documents', hint: 'Tickets, EMDs and memos. The fare, tax and commission an invoice line has nowhere to hold. Leave documentNo blank while only a PNR exists.', idPrefix: 'DOC-', noPrefix: null, title: ['documentNo', 'pnr'], search: ['documentNo', 'pnr', 'passengerName', 'platingCarrier'], amount: null, party: 'supplierId' },
  { key: 'customers', label: 'Customers', hint: 'Who we invoice.', idPrefix: 'CUS-', noPrefix: null, title: ['name'], search: ['name', 'phone', 'email'], amount: null, party: null },
  { key: 'suppliers', label: 'Suppliers & vendors', hint: 'Airlines, consolidators, hotels, visa handlers.', idPrefix: 'SUP-', noPrefix: null, title: ['name'], search: ['name', 'phone'], amount: null, party: null },
  { key: 'services', label: 'Services', hint: 'What can appear on an invoice line.', idPrefix: 'SRV-', noPrefix: null, title: ['name'], search: ['name'], amount: null, party: null },
  { key: 'banks', label: 'Bank accounts', hint: 'MFS wallets count as banks.', idPrefix: 'BNK-', noPrefix: null, title: ['name'], search: ['name', 'accountNo'], amount: null, party: null },
  { key: 'expenseCategories', label: 'Expense categories', hint: '', idPrefix: 'EXC-', noPrefix: null, title: ['name'], search: ['name'], amount: null, party: null },
  /**
   * Accounts the accountant adds, on top of the ones derived from the data.
   *
   * The chart used to be derived in full — cash, one per bank, receivables, payables,
   * sales, purchases, one per expense category. Complete for trading, and with nothing
   * at all for accruals, prepayments, provisions, depreciation, retained earnings or a
   * suspense account. A journal voucher would have had nowhere to post. A derived chart
   * cannot invent those, because only the accountant knows which ones this agency keeps.
   *
   * `code` is theirs to choose, so an agency migrating off another system keeps its own
   * account numbers. It is namespaced as GL:<code> on the way into the journal, so a
   * hand-typed `AR` or `CASH` cannot silently merge into a control account.
   */
  { key: 'ledgerAccounts', label: 'Ledger accounts', hint: 'Your own accounts for journal vouchers — depreciation, accruals, prepayments, provisions, retained earnings, suspense. The trading accounts are derived from the data and are always present; these are the ones only you know you keep.', idPrefix: 'GLA-', noPrefix: null, title: ['code', 'name'], search: ['code', 'name', 'note'], amount: null, party: null, template: { id: '', code: '', name: '', group: 'expense', note: '' } },
  { key: 'airlines', label: 'Airlines', hint: 'IATA and accounting codes, for ticket lines and BSP reconciliation.', idPrefix: 'AIR-', noPrefix: null, title: ['name'], search: ['name', 'iataCode'], amount: null, party: null, template: { id: '', name: '', iataCode: '', accountingCode: '', hub: '', note: '' } },
  { key: 'hotels', label: 'Hotels', hint: 'Properties that can appear on a hotel or package line.', idPrefix: 'HTL-', noPrefix: null, title: ['name'], search: ['name', 'city'], amount: null, party: null, template: { id: '', name: '', city: '', country: '', stars: '', segment: '' } },
  { key: 'visaTypes', label: 'Visa types', hint: 'Category, validity, service fee and processing window.', idPrefix: 'VIS-', noPrefix: null, title: ['name'], search: ['name', 'category'], amount: null, party: null, template: { id: '', name: '', category: '', validityDays: '', serviceFee: '', processingDays: '' } },
  { key: 'countries', label: 'Countries', hint: 'ISO code, currency and dialling code.', idPrefix: 'CTR-', noPrefix: null, title: ['name'], search: ['name', 'iso2'], amount: null, party: null, template: { id: '', name: '', iso2: '', currency: '', dialCode: '' } },
  { key: 'currencies', label: 'Currencies', hint: 'Rate to the base currency, and when it was last confirmed. Documents copy the rate when raised, so changing one here never restates a past sale — it prices the next one.', idPrefix: 'CUR-', noPrefix: null, title: ['name'], search: ['name', 'code'], amount: null, party: null, template: { id: '', name: '', code: '', symbol: '', rateToBase: 0, isBase: 0, checkedOn: '' } },
  { key: 'employees', label: 'Employees', hint: '', idPrefix: 'EMP-', noPrefix: null, title: ['name'], search: ['name', 'role'], amount: null, party: null }
];

/**
 * Fixed vocabularies. These have to agree with lib/accounting.ts — the app
 * derives every total from these strings, so a typo here is a voucher that
 * silently stops counting.
 */
const PAY_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
  { value: 'mfs', label: 'bKash / Nagad' },
  { value: 'online', label: 'Online' }
];

/** Only a supplier payment can be settled out of a float already advanced. */
const PAYMENT_METHODS = [
  ...PAY_METHODS,
  { value: 'supplier_deposit', label: 'Drawn from supplier deposit — no fresh money moves' }
];

const BOOK_ENUMS = {
  invoices: {
    status: [
      { value: 'draft', label: 'Draft — not trading yet' },
      { value: 'confirmed', label: 'Confirmed' },
      { value: 'partially_paid', label: 'Partially paid' },
      { value: 'paid', label: 'Paid' },
      { value: 'cancelled', label: 'Cancelled' }
    ]
  },
  receipts: { method: PAY_METHODS },
  payments: { method: PAYMENT_METHODS },
  expenses: { method: PAY_METHODS },
  supplierDeposits: { method: PAY_METHODS, kind: [{ value: 'deposit', label: 'Deposit' }] },
  taxRules: {
    basis: [
      { value: 'fare', label: 'Airline fare' },
      { value: 'commission', label: 'Agency commission' },
      { value: 'service_charge', label: 'Agency service charge' },
      { value: 'gross', label: 'Whole line' }
    ],
    band: [
      { value: 'any', label: 'Any route' },
      { value: 'domestic', label: 'Domestic' },
      { value: 'saarc', label: 'SAARC' },
      { value: 'international', label: 'International' }
    ]
  },
  ledgerAccounts: {
    group: [
      { value: 'asset', label: 'Asset' },
      { value: 'liability', label: 'Liability' },
      { value: 'equity', label: 'Equity' },
      { value: 'income', label: 'Income' },
      { value: 'expense', label: 'Expense' }
    ]
  },
  contracts: {
    basis: [{ value: 'base', label: 'Base fare' }, { value: 'gross', label: 'Fare + tax' }],
    band: [
      { value: 'any', label: 'Any route' },
      { value: 'domestic', label: 'Domestic' },
      { value: 'saarc', label: 'SAARC' },
      { value: 'international', label: 'International' }
    ]
  },
  /**
   * Typed dropdowns rather than free text on all three. A document type or a status
   * typed by hand drifts into `Ticket`, `TKT`, `tkt` — and the day a BSP file has to
   * be matched against it, none of them join.
   */
  documents: {
    type: [
      { value: 'TKT', label: 'Ticket' },
      { value: 'EMD', label: 'EMD' },
      { value: 'MCO', label: 'MCO' },
      { value: 'REFUND', label: 'Refund' },
      { value: 'ADM', label: 'Agency debit memo' },
      { value: 'ACM', label: 'Agency credit memo' }
    ],
    status: [
      { value: 'booked', label: 'Booked, not issued' },
      { value: 'issued', label: 'Issued' },
      { value: 'void', label: 'Voided' },
      { value: 'refunded', label: 'Refunded' },
      { value: 'exchanged', label: 'Exchanged' }
    ],
    formOfPayment: [
      { value: 'bsp_cash', label: 'BSP cash' },
      { value: 'easypay', label: 'IATA EasyPay' },
      { value: 'agency_card', label: 'Agency card' },
      { value: 'customer_card', label: 'Customer card' },
      { value: 'cash', label: 'Direct to supplier' }
    ]
  },
  bills: {
    status: [
      { value: 'unpaid', label: 'Unpaid' },
      { value: 'partially_paid', label: 'Partially paid' },
      { value: 'paid', label: 'Paid' }
    ]
  },
  supplierCreditNotes: {
    reason: [
      { value: 'overbilled', label: 'Overbilled' },
      { value: 'adm_reversal', label: 'ADM reversal' },
      { value: 'service_failure', label: 'Service failure' },
      { value: 'rebate', label: 'Volume rebate' },
      { value: 'other', label: 'Other' }
    ],
    settlement: [
      { value: 'credit_balance', label: 'Credit balance — the bill was unpaid, so we simply owe less' },
      ...PAY_METHODS.map((m) => ({ value: m.value, label: `Received back by ${m.label.toLowerCase()}` }))
    ]
  },
  transfers: {
    direction: [
      { value: 'deposit', label: 'Deposit — cash goes from the till into the bank' },
      { value: 'withdrawal', label: 'Withdrawal — cash comes out of the bank into the till' }
    ]
  },
  creditNotes: {
    reason: [
      { value: 'cancellation', label: 'Cancellation — whole ticket returned' },
      { value: 'partial_refund', label: 'Partial refund' },
      { value: 'date_change', label: 'Date change adjustment' },
      { value: 'overcharge', label: 'Overcharge corrected' },
      { value: 'goodwill', label: 'Goodwill' },
      { value: 'write_off', label: 'Write-off — will not be collected' }
    ],
    settlement: [
      { value: 'credit_balance', label: 'Credit balance — no money moves, the customer simply owes less' },
      ...PAY_METHODS.map((m) => ({ value: m.value, label: `Refunded by ${m.label.toLowerCase()}` }))
    ]
  },
  customers: {
    type: [
      { value: 'walk_in', label: 'Walk-in' },
      { value: 'agency', label: 'Agency' },
      { value: 'corporate', label: 'Corporate' }
    ]
  },
  suppliers: {
    type: [
      { value: 'airline', label: 'Airline' },
      { value: 'consolidator', label: 'Consolidator' },
      { value: 'hotel', label: 'Hotel' },
      { value: 'visa', label: 'Visa handler' },
      { value: 'other', label: 'Other' }
    ]
  },
  visaTypes: {
    category: [
      { value: 'Tourist', label: 'Tourist' },
      { value: 'Business', label: 'Business' },
      { value: 'Religious', label: 'Religious — Hajj / Umrah' },
      { value: 'Student', label: 'Student' },
      { value: 'Employment', label: 'Employment' },
      { value: 'Medical', label: 'Medical' },
      { value: 'Transit', label: 'Transit' }
    ]
  },
  hotels: {
    segment: [
      { value: 'Corporate', label: 'Corporate' },
      { value: 'Leisure', label: 'Leisure' },
      { value: 'Hajj / Umrah', label: 'Hajj / Umrah' }
    ]
  },
  services: {
    category: [
      { value: 'air', label: 'Air ticket' },
      { value: 'hajj_umrah', label: 'Hajj / Umrah' },
      { value: 'tour', label: 'Tour' },
      { value: 'visa', label: 'Visa' },
      { value: 'hotel', label: 'Hotel' },
      { value: 'other', label: 'Other' }
    ]
  },
  inventory: {
    kind: [
      { value: 'seat_block', label: 'Seat block' },
      { value: 'hotel_allotment', label: 'Hotel allotment' },
      { value: 'hajj_quota', label: 'Hajj quota' },
      { value: 'umrah_package', label: 'Umrah package' },
      { value: 'visa_slot', label: 'Visa slot' },
      { value: 'other', label: 'Other' }
    ]
  }
};

/**
 * Every dropdown for one collection: the fixed vocabularies above plus the
 * live lists of customers, suppliers, banks and documents read out of the book.
 */
function bookEnums(book, spec) {
  const opt = (rows, label) => (rows || []).map((r) => ({ value: r.id, label: label(r) }));
  const blank = (rows) => [{ value: '', label: '— none —' }, ...rows];

  const custName = (id) => (book.customers || []).find((c) => c.id === id)?.name || id;
  const supName = (id) => (book.suppliers || []).find((x) => x.id === id)?.name || id;

  /**
   * A document's currency is picked from the Currencies master, so a rate
   * always exists for whatever is chosen. Free text here would let somebody
   * type "usd" and quietly get a rate of 1.
   */
  const currencyOptions = (book.currencies || []).map((c) => ({
    value: c.code,
    label: `${c.code} — ${c.name}${Number(c.isBase) ? ' (base)' : ` @ ${c.rateToBase}`}`
  }));

  const shared = {
    currency: currencyOptions.length ? currencyOptions : [{ value: '', label: 'No currencies configured' }],
    customerId: opt(book.customers, (c) => `${c.name} · ${c.id}`),
    supplierId: opt(book.suppliers, (x) => `${x.name} · ${x.id}`),
    serviceId: opt(book.services, (x) => `${x.name} · ${x.id}`),
    categoryId: opt(book.expenseCategories, (x) => `${x.name} · ${x.id}`),
    bankId: blank(opt(book.banks, (b) => `${b.name} · ${b.accountNo || b.id}`)),
    employeeId: blank(opt(book.employees, (e) => `${e.name} — ${e.role}`)),
    invoiceId: blank(opt(book.invoices, (i) => `${i.no} · ${custName(i.customerId)} · ${i.date}`)),
    invoiceRef: blank(opt(book.invoices, (i) => `${i.no} · ${custName(i.customerId)} · ${i.date}`)),
    billId: blank(opt(book.bills, (b) => `${b.no} · ${supName(b.supplierId)} · ${b.amount}`))
  };

  const merged = { ...shared, ...(BOOK_ENUMS[spec.key] || {}) };
  // A transfer and a supplier credit note both name a required document, so
  // neither offers the blank "none" that optional references get.
  if (spec.key === 'transfers') merged.bankId = opt(book.banks, (b) => `${b.name} · ${b.accountNo || b.id}`);
  if (spec.key === 'supplierCreditNotes') merged.billId = opt(book.bills, (b) => `${b.no} · ${supName(b.supplierId)} · ${b.amount}`);
  return merged;
}

const bookFile = () => readJson(path.join(CONTENT_DIR, 'accounting.json'), {});

/* ================================================= journal voucher screen === */

const JV = require('../lib/journal-rules.js');
/* ============================================== bank statements & reconciliation === */

const BSTMT = require('../lib/bank-statement.js');
const BMATCH = require('../lib/bank-match.js');
const BREC = require('../lib/bank-reconcile.js');

/**
 * The book's side of one bank account, flattened.
 *
 * A deliberate mirror of `bookMovements` in lib/bankrec.ts, and the ONLY duplicated
 * logic in this feature. It exists because the portal cannot import a TypeScript module
 * and `bankBook` — which does the real work of knowing that eight different record types
 * move bank money — lives in lib/accounting.ts.
 *
 * Rather than leave the two to drift silently, `verify-bank.mjs` asserts they produce
 * identical movement sets for every account in the book. If somebody adds a ninth kind
 * to one side, the check fails instead of the portal quietly reporting real transactions
 * as missing from the book.
 */
function bookMovementsJs(book, bankId, from, to) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const mine = (x) => x.bankId === bankId;
  const rows = [];
  const push = (r, direction, kind, note) => {
    if (!inRange(r.date)) return;
    rows.push({
      id: r.id,
      ref: r.no || r.id,
      date: r.date,
      amount: Math.abs(r.amount),
      direction,
      kind,
      note: [r.ref, r.notes, r.note, r.description].filter(Boolean).join(' ').trim()
    });
  };

  // The same eight kinds bankBook() walks. Kept in the same order for diffability.
  for (const r of book.receipts || []) if (mine(r)) push(r, 'in', 'receipt');
  for (const p of book.payments || []) if (mine(p)) push(p, 'out', 'payment');
  for (const e of book.expenses || []) if (mine(e)) push(e, 'out', 'expense');
  for (const c of book.creditNotes || []) {
    // isRefunded() in lib/accounting.ts: a credit note settled in money rather than
    // against the customer's balance.
    if (mine(c) && c.settlement !== 'credit_balance') push(c, 'out', 'refund');
  }
  for (const t of book.transfers || []) {
    if (mine(t)) push(t, t.direction === 'deposit' ? 'in' : 'out', t.direction === 'deposit' ? 'transfer_in' : 'transfer_out');
  }
  for (const c of book.supplierCreditNotes || []) if (mine(c) && c.settlement !== 'credit_balance') push(c, 'in', 'supplier_credit');
  for (const d of book.supplierDeposits || []) if (mine(d) && d.method !== 'cash') push(d, 'out', 'supplier_deposit');

  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
}

/** Opening and closing for a period, the same arithmetic bankBook uses. */
function bookBalances(book, bankId, from, to) {
  const bank = (book.banks || []).find((b) => b.id === bankId) || { openingBalance: 0 };
  const all = bookMovementsJs(book, bankId, null, null);
  const net = (rows) =>
    rows.filter((m) => m.direction === 'in').reduce((t, m) => t + m.amount, 0) -
    rows.filter((m) => m.direction === 'out').reduce((t, m) => t + m.amount, 0);
  return {
    opening: bank.openingBalance + net(all.filter((m) => m.date < from)),
    closing: bank.openingBalance + net(all.filter((m) => m.date <= to))
  };
}

/** Build the whole reconciliation for one stored statement. */
/**
 * What was outstanding when this period began. Mirrors carriedForward in lib/bankrec.ts.
 *
 * The floor is the earliest imported statement for the account: before that there is no
 * evidence a movement is outstanding, only that nobody has looked. Without the floor, one
 * August import would declare every payment since the book opened to be an unpresented
 * cheque.
 */
function carriedForwardJs(book, bankId, from) {
  const earlier = (book.bankStatements || [])
    .filter((s) => s.bankId === bankId && s.to < from)
    .sort((a, b) => String(a.from).localeCompare(String(b.from)));
  if (!earlier.length) return [];

  const seen = new Set();
  for (const st of earlier) {
    const movements = bookMovementsJs(book, bankId, st.from, st.to);
    const m = BMATCH.matchStatement({
      lines: st.lines, movements, carried: [], driftDays: 5, prefixes: BMATCH.bookPrefixes(book)
    });
    for (const r of m.results) if (r.status === 'matched' && r.match) seen.add(r.match.movementId);
    for (const d of st.decisions || []) seen.add(d.movementId);
  }

  const before = new Date(from + 'T00:00:00Z');
  before.setUTCDate(before.getUTCDate() - 1);
  return bookMovementsJs(book, bankId, earlier[0].from, before.toISOString().slice(0, 10))
    .filter((m) => !seen.has(m.id));
}

function reconcileStored(book, statement) {
  const bank = (book.banks || []).find((b) => b.id === statement.bankId);
  const movements = bookMovementsJs(book, statement.bankId, statement.from, statement.to);
  const carried = carriedForwardJs(book, statement.bankId, statement.from);
  const match = BMATCH.matchStatement({
    lines: statement.lines,
    movements,
    carried,
    driftDays: 5,
    prefixes: BMATCH.bookPrefixes(book)
  });

  const taken = new Set(match.results.filter((r) => r.status === 'matched').map((r) => r.match.movementId));
  const byLine = new Map();
  for (const d of statement.decisions || []) {
    if (!byLine.has(d.sourceLine)) byLine.set(d.sourceLine, []);
    byLine.get(d.sourceLine).push(d.movementId);
  }
  for (const [sourceLine, ids] of byLine) {
    const target = match.results.find((r) => r.line.sourceLine === sourceLine);
    if (!target || target.status === 'matched') continue;
    const pool = movements.concat(carried);
    const picked = ids.filter((id) => !taken.has(id)).map((id) => pool.find((m) => m.id === id)).filter(Boolean);
    if (!picked.length) continue;

    // The group must add up exactly. See the note in lib/bankrec.ts: a confirmed grouping
    // is a judgement about what was banked together, not a licence to close a gap.
    const sum = Math.round(picked.reduce((t, m) => t + m.amount, 0) * 100) / 100;
    if (picked.length > 1 && sum !== Math.round(target.line.amount * 100) / 100) {
      target.status = 'ambiguous';
      target.why = `A grouping was confirmed for this line, but the ${picked.length} entries chosen add up to ${sum} against a line of ${target.line.amount}. The difference would have been buried inside the match, so it is refused.`;
      continue;
    }

    for (const m of picked) taken.add(m.id);
    target.status = 'matched';
    target.strength = 'by_hand';
    target.match = { movementId: picked[0].id, ref: picked.map((m) => m.ref).join(' + '), kind: picked[0].kind, drift: 0, byReference: false, wordHits: 0, carried: false };
    target.matchedGroup = picked.map((m) => ({ id: m.id, ref: m.ref, amount: m.amount }));
    const first = (statement.decisions || []).find((d) => d.sourceLine === sourceLine);
    target.decidedBy = first ? first.decidedBy : null;
    match.unmatchedMovements = match.unmatchedMovements.filter((u) => !picked.some((m) => m.id === u.movement.id));
  }

  // See the note on classifications in lib/bankrec.ts: only a person may say a line
  // matching nothing is the bank's own.
  for (const cl of statement.classifications || []) {
    const t = match.results.find((r) => r.line.sourceLine === cl.sourceLine);
    if (!t || t.status !== 'unmatched') continue;
    t.classification = cl.as;
    t.classifiedBy = cl.by;
  }

  match.counts.matched = match.results.filter((r) => r.status === 'matched').length;
  match.counts.ambiguous = match.results.filter((r) => r.status === 'ambiguous').length;
  match.counts.unknownToBook = match.results.filter((r) => r.status === 'unknown_to_book').length;
  match.counts.unpresented = match.unmatchedMovements.length;

  const bal = bookBalances(book, statement.bankId, statement.from, statement.to);
  // Mirrors postedToBank in lib/bankrec.ts. See the note there.
  const postedToBank = (book.journalEntries || [])
    .filter((v) => v.date >= statement.from && v.date <= statement.to)
    .reduce((t, v) => t + v.lines
      .filter((l) => l.account === 'BANK:' + statement.bankId)
      .reduce((x, l) => x + (l.debit || 0) - (l.credit || 0), 0), 0);

  const rec = BREC.reconcile({
    match,
    postedToBank,
    bookOpening: bal.opening,
    bookClosing: bal.closing,
    statementOpening: statement.openingBalance,
    statementClosing: statement.closingBalance,
    statementBalanceSource: statement.balanceSource,
    from: statement.from,
    to: statement.to,
    bankId: statement.bankId,
    bankName: bank ? bank.name : statement.bankId
  });
  return Object.assign({}, rec, { match, movements, statement, bookClosing: bal.closing });
}

/* ------------------------------------------------------------------- the screen */

const bsMoney = (n, book) =>
  ((book.company && book.company.currencySymbol) || '') +
  Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/**
 * The import form, with the file picker reading into the textarea in the browser.
 *
 * The server takes pasted text only — it is `node:http` with no multipart parser, and
 * adding one to accept a file it would immediately turn back into text is a lot of
 * surface for nothing. The picker below reads the file client-side and fills the box,
 * so an operator can upload OR paste and neither of them has to know the difference.
 */
function bsImportForm(session, book, state) {
  state = state || {};
  const banks = book.banks || [];
  const selectedBank = state.bankId || (banks[0] && banks[0].id) || '';
  return `
  <form method="post" action="/bank-statements/preview" class="card">
    <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
    <h2 style="margin-top:0">Import a statement</h2>
    <p class="sub" style="margin-top:4px">
      There is deliberately no built-in layout for any bank. I have not seen a real export from
      Dutch-Bangla, BRAC, City Bank or bKash, and a layout guessed at would put money in the wrong
      column while looking like it knew what it was doing. You map the columns once per account and
      it is remembered.
    </p>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin:14px 0">
      <label>Account<br>
        <select name="bankId">
          ${banks.map((b) => `<option value="${esc(b.id)}"${b.id === selectedBank ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select></label>
      <label>Period from<br><input type="date" name="from" value="${esc(state.from || '')}"></label>
      <label>Period to<br><input type="date" name="to" value="${esc(state.to || '')}"></label>
    </div>
    <label>Paste the CSV, or choose the file<br>
      <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onchange="var f=this.files[0];if(!f)return;var r=new FileReader();r.onload=function(){document.getElementById('bscsv').value=r.result};r.readAsText(f)">
      <textarea id="bscsv" name="csv" rows="10" placeholder="Txn Date,Transaction Details,Cheque No,Withdrawal Amt.,Deposit Amt.,Closing Balance">${esc(state.csv || '')}</textarea>
    </label>
    <p style="margin-top:14px"><button class="primary" type="submit">Read it — nothing is saved yet</button></p>
  </form>`;
}

/** Column pickers, pre-filled with what was suggested or last confirmed. */
function bsMappingRow(headers, mapping) {
  const field = (name, label, hint) => `
    <label style="min-width:170px">${esc(label)}<br>
      <select name="map_${name}">
        <option value="-1">${esc(hint || 'not in this file')}</option>
        ${headers.map((h, i) => `<option value="${i}"${mapping[name] === i ? ' selected' : ''}>${esc(h)}</option>`).join('')}
      </select></label>`;
  return `<div style="display:flex;gap:14px;flex-wrap:wrap;margin:12px 0">
    ${field('date', 'Date')}
    ${field('description', 'Narration')}
    ${field('reference', 'Cheque / reference')}
    ${field('debit', 'Withdrawal')}
    ${field('credit', 'Deposit')}
    ${field('amount', 'Signed amount', 'use Withdrawal/Deposit instead')}
    ${field('balance', 'Running balance')}
  </div>`;
}

function bsPreviewView(session, state) {
  const book = bookFile();
  const p = state.preview;
  const banks = book.banks || [];
  const bank = banks.find((b) => b.id === state.bankId);

  if (p.error && !p.table.headers.length) {
    return page({
      title: 'Bank statements', session, active: 'bank-statements',
      body: `<h1>Import a statement</h1>
        <div class="err" style="border-left:3px solid #b91c1c;background:#fef2f2;padding:12px 14px;margin:14px 0">${esc(p.error)}</div>
        ${bsImportForm(session, book, state)}`
    });
  }

  const chain = p.chain || { checked: false, ok: null, breaks: [], detail: '' };
  const lines = p.lines || [];

  /**
   * The balance-chain result, given more room than anything else on the page.
   *
   * It is the only automatic check that the operator's column mapping is right, and it
   * costs nothing: the bank already printed what each line does to the balance, so if the
   * reading is correct every consecutive pair agrees. Swap Withdrawal and Deposit and it
   * fails on the first pair — before anything is written, rather than at year end.
   */
  const chainBox = chain.checked
    ? `<div style="border-left:3px solid ${chain.ok ? '#047857' : '#b91c1c'};background:${chain.ok ? '#ecfdf5' : '#fef2f2'};padding:12px 14px;margin:14px 0">
        <strong>${chain.ok ? 'The reading checks out.' : 'The reading does not check out.'}</strong> ${esc(chain.detail)}
        ${chain.breaks.length ? `<ul style="margin:8px 0 0 18px">${chain.breaks.slice(0, 5).map((b) => `<li>line ${b.sourceLine}: the balance moves by ${b.by} more than this line accounts for</li>`).join('')}</ul>` : ''}
      </div>`
    : `<div style="border-left:3px solid #b45309;background:#fffbeb;padding:12px 14px;margin:14px 0">
        <strong>Nothing to check the reading against.</strong> ${esc(chain.detail)}
      </div>`;

  const problems = (p.problems || []).length
    ? `<div class="err" style="border-left:3px solid #b91c1c;background:#fef2f2;padding:12px 14px;margin:14px 0">
        <strong>${p.problems.length} line(s) could not be read</strong>
        <ul style="margin:8px 0 0 18px">${p.problems.slice(0, 10).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
       </div>`
    : '';

  const ambiguousDate = p.error && /reads equally well/.test(p.error);
  const dateChoice = `
    <label>Date format<br>
      <select name="dateFormat">
        ${['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY', 'DD-MON-YYYY'].map((f) => {
          const fits = (p.dateFormats && p.dateFormats.candidates || []).includes(f);
          return `<option value="${f}"${f === state.dateFormat || f === p.dateFormat ? ' selected' : ''}${fits ? '' : ' disabled'}>${f}${fits ? '' : ' — does not fit this column'}</option>`;
        }).join('')}
      </select></label>`;

  const rows = lines.slice(0, 25).map((l) => `<tr>
      <td>${esc(l.date)}</td>
      <td>${esc(l.description)}</td>
      <td>${esc(l.reference)}</td>
      <td class="num">${l.direction === 'out' ? esc(String(l.amount)) : ''}</td>
      <td class="num">${l.direction === 'in' ? esc(String(l.amount)) : ''}</td>
      <td class="num">${l.balance === null || l.balance === undefined ? '' : esc(String(l.balance))}</td>
    </tr>`).join('');

  const s = p.summary || {};
  const readyToSave = !p.error && !(p.problems || []).length && lines.length > 0;

  return page({
    title: 'Bank statements', session, active: 'bank-statements',
    body: `
      <h1>What was read</h1>
      <p class="sub">${esc(bank ? bank.name : state.bankId)} · nothing has been saved yet</p>

      ${p.error ? `<div class="err" style="border-left:3px solid #b91c1c;background:#fef2f2;padding:12px 14px;margin:14px 0">${esc(p.error)}</div>` : ''}
      ${problems}
      ${p.error ? '' : chainBox}

      <form method="post" action="${readyToSave ? '/bank-statements/import' : '/bank-statements/preview'}" class="card">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <input type="hidden" name="csv" value="${esc(state.csv)}">
        <input type="hidden" name="bankId" value="${esc(state.bankId)}">
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px">
          <label>Period from<br><input type="date" name="from" value="${esc(state.from || s.from || '')}" required></label>
          <label>Period to<br><input type="date" name="to" value="${esc(state.to || s.to || '')}" required></label>
          ${dateChoice}
        </div>
        <h3 style="margin:14px 0 0">Which column is which</h3>
        ${bsMappingRow(p.table.headers, p.mapping || {})}
        <p style="margin-top:6px">
          <button type="submit" ${readyToSave ? '' : 'class="primary"'}>Re-read with these settings</button>
          ${readyToSave ? `<button class="primary" type="submit" formaction="/bank-statements/import">Save ${lines.length} lines</button>` : ''}
        </p>
      </form>

      ${readyToSave ? `
      <div class="card">
        <h3 style="margin-top:0">${lines.length} lines · ${esc(String(s.from))} to ${esc(String(s.to))}</h3>
        <p class="sub">in ${bsMoney(s.totalIn, book)} · out ${bsMoney(s.totalOut, book)} · net ${bsMoney(s.net, book)}${s.openingPrinted !== null && s.openingPrinted !== undefined ? ` · opens at ${bsMoney(s.openingPrinted, book)}, closes at ${bsMoney(s.closingPrinted, book)}` : ' · the file carries no balance column'}</p>
        <table class="grid"><thead><tr><th>Date</th><th>Narration</th><th>Ref</th><th class="num">Out</th><th class="num">In</th><th class="num">Balance</th></tr></thead>
        <tbody>${rows}</tbody></table>
        ${lines.length > 25 ? `<p class="sub" style="margin-top:8px">first 25 of ${lines.length}</p>` : ''}
      </div>` : ''}

      <p style="margin-top:18px"><a href="/bank-statements">Start again</a></p>`
  });
}

function bankStatementsView(session, params) {
  const book = bookFile();
  const all = book.bankStatements || [];
  const signed = book.bankReconciliations || [];
  const banks = book.banks || [];
  const may = RBAC.can(session.role, 'books_journal');
  const notice = params && params.get('saved');
  const err = params && params.get('error');

  const cards = all
    .slice()
    .sort((a, b) => String(b.to).localeCompare(String(a.to)))
    .map((st) => {
      const rec = reconcileStored(book, st);
      const bank = banks.find((b) => b.id === st.bankId);
      const sign = signed.find((x) => x.statementId === st.id);
      const tone = rec.settled ? '#047857' : rec.reconciled ? '#b45309' : '#b91c1c';
      return `
      <div class="card" style="border-left:3px solid ${tone}">
        <h3 style="margin:0">${esc(bank ? bank.name : st.bankId)} · ${esc(st.from)} to ${esc(st.to)}</h3>
        <p class="sub" style="margin:4px 0 10px">
          ${st.lines.length} lines · ${rec.counts.matched} matched · ${rec.counts.ambiguous} need a decision ·
          ${rec.counts.bankOnly} classified as the bank's own · ${rec.counts.unclassified} unclassified · ${rec.counts.groupCandidate} look grouped · ${rec.counts.bookOnly} not on the statement ·
          difference <strong>${bsMoney(rec.difference, book)}</strong>
          ${sign ? ` · signed off by ${esc(sign.closedBy)} on ${esc(String(sign.closedAt).slice(0, 10))}` : ''}
        </p>
        ${rec.blockers.length ? `<ul class="sub" style="margin:0 0 10px 18px">${rec.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}

        ${may ? rec.match.results.filter((r) => r.status === 'ambiguous' || r.status === 'group_candidate' || (r.status === 'unmatched' && !r.classification)).map((r) => {
          const head = `<div style="flex:1"><strong>${esc(r.line.date)} ${bsMoney(r.line.amount, book)} ${r.line.direction === 'in' ? 'in' : 'out'}</strong><br><span class="sub">${esc(r.line.description)}</span><br><span class="sub" style="color:#b45309">${esc(r.why || '')}</span></div>`;
          if (r.status === 'ambiguous') {
            return `<form method="post" action="/bank-statements/decide" style="display:flex;gap:8px;align-items:end;margin:8px 0;padding:8px;background:#fffbeb">
              <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
              <input type="hidden" name="statement" value="${esc(st.id)}">
              <input type="hidden" name="line" value="${r.line.sourceLine}">
              ${head}
              <label>is<br><select name="movementId"><option value="">leave undecided</option>${(r.candidates || []).map((c) => `<option value="${esc(c.movementId)}">${esc(c.ref)} — ${esc(c.kind)}</option>`).join('')}</select></label>
              <button type="submit">Match it</button></form>`;
          }
          if (r.status === 'group_candidate') {
            return (r.groups || []).map((g, gi) => `<form method="post" action="/bank-statements/group" style="display:flex;gap:8px;align-items:end;margin:8px 0;padding:8px;background:#eff6ff">
              <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
              <input type="hidden" name="statement" value="${esc(st.id)}">
              <input type="hidden" name="line" value="${r.line.sourceLine}">
              ${gi === 0 ? head : '<div style="flex:1"><span class="sub">or</span></div>'}
              <div>${g.map((m) => `<input type="hidden" name="movementId" value="${esc(m.movementId || m.id)}">`).join('')}<span class="sub">${esc(g.map((m) => m.ref).join(' + '))}</span></div>
              <button type="submit">These were banked together</button></form>`).join('');
          }
          return `<form method="post" action="/bank-statements/classify" style="display:flex;gap:8px;align-items:end;margin:8px 0;padding:8px;background:#fef2f2">
            <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
            <input type="hidden" name="statement" value="${esc(st.id)}">
            <input type="hidden" name="line" value="${r.line.sourceLine}">
            <input type="hidden" name="as" value="bank_only">
            ${head}
            <button type="submit">This is the bank's own — a charge or interest</button></form>`;
        }).join('') : ''}

        <p style="margin-top:10px">
          ${may && rec.settled && !sign ? `
            <form method="post" action="/bank-statements/signoff" style="display:inline">
              <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
              <input type="hidden" name="statement" value="${esc(st.id)}">
              <button class="primary" type="submit">Sign this period off</button>
            </form>` : ''}
          ${may ? `
            <form method="post" action="/bank-statements/delete" style="display:inline;margin-left:8px"
                  onsubmit="return confirm('Remove this imported statement? The book itself is untouched — only the bank\\'s record of it goes.')">
              <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
              <input type="hidden" name="statement" value="${esc(st.id)}">
              <button type="submit">Remove the import</button>
            </form>` : ''}
        </p>
      </div>`;
    }).join('');

  return page({
    title: 'Bank statements', session, active: 'bank-statements',
    body: `
      <h1>Bank statements</h1>
      <p class="sub">${all.length} imported · the reconciliation itself is rendered at <a href="${esc(APP_URL)}/accounts/reconcile">/accounts/reconcile</a></p>
      ${notice ? `<div class="ok" style="border-left:3px solid #047857;background:#ecfdf5;padding:12px 14px;margin:14px 0">${esc(notice)}</div>` : ''}
      ${err ? `<div class="err" style="border-left:3px solid #b91c1c;background:#fef2f2;padding:12px 14px;margin:14px 0">${esc(err)}</div>` : ''}
      ${may ? bsImportForm(session, book, {}) : '<div class="note" style="padding:12px 14px">You can read these but not import one — that needs the journal-voucher capability, held by Super Admin and Accountant.</div>'}
      ${cards || '<div class="note" style="padding:14px">Nothing imported yet.</div>'}`
  });
}


/**
 * Line rows out of a submitted form.
 *
 * `parseForm` gives a string for a field that appeared once and an array for one that
 * appeared twice, so a two-line voucher and a one-line voucher come back as different
 * shapes. Both are normalised here rather than at three call sites — the alternative
 * is a voucher that validates as one line, refuses "needs at least two", and shows the
 * accountant two rows on screen.
 */
function journalLinesFromForm(form) {
  const col = (name) => [].concat(form[name] === undefined ? [] : form[name]);
  const accounts = col('line_account');
  const debits = col('line_debit');
  const credits = col('line_credit');
  const memos = col('line_memo');
  const out = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = String(accounts[i] || '').trim();
    const debit = Number(String(debits[i] || '').trim() || 0);
    const credit = Number(String(credits[i] || '').trim() || 0);
    // A blank row is not an error — the form ships spare rows on purpose.
    if (!account && !debit && !credit) continue;
    out.push({ account, debit: Number.isFinite(debit) ? debit : NaN, credit: Number.isFinite(credit) ? credit : NaN, memo: String(memos[i] || '').trim() });
  }
  return out;
}

const JV_BLANK_ROWS = 6;

function journalView(session, params, state = {}) {
  const book = bookFile();
  const chart = JV.chartAccounts(book);
  const control = JV.controlAccountCodes(book);
  const vouchers = (book.journalEntries || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.no).localeCompare(String(a.no)));
  const mayPost = RBAC.can(session.role, 'books_journal');
  const sym = (book.company && book.company.currencySymbol) || '';
  const posted = params && params.get('posted');
  const error = (params && params.get('error')) || null;
  const draft = state.draft || null;
  const errors = state.errors || [];

  const money = (n) => `${sym}${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const options = (selected) =>
    chart
      .map((a) => `<option value="${esc(a.code)}"${a.code === selected ? ' selected' : ''}>${esc(a.name)}${control.has(a.code) ? ' — control' : ''}</option>`)
      .join('');

  const draftLines = draft && draft.lines && draft.lines.length ? draft.lines : [];
  const rows = [];
  for (let i = 0; i < Math.max(JV_BLANK_ROWS, draftLines.length + 2); i++) {
    const l = draftLines[i] || {};
    rows.push(`<tr>
      <td><select name="line_account"><option value="">—</option>${options(l.account || '')}</select></td>
      <td><input name="line_memo" value="${esc(l.memo || '')}" placeholder="optional"></td>
      <td><input name="line_debit" type="number" step="0.01" min="0" value="${l.debit ? esc(String(l.debit)) : ''}" class="num"></td>
      <td><input name="line_credit" type="number" step="0.01" min="0" value="${l.credit ? esc(String(l.credit)) : ''}" class="num"></td>
    </tr>`);
  }

  /**
   * The whole point of the screen, stated on the screen.
   *
   * A journal voucher is the only place in this book where a figure moves because a
   * person said so rather than because a document exists. Somebody posting one should
   * be told what that costs before they post it, not discover it on the financials
   * page a month later.
   */
  const explainer = `
    <div class="note" style="border-left:3px solid #b45309;background:#fffbeb;padding:12px 14px;margin-bottom:16px">
      <strong>What a journal voucher is for.</strong>
      Depreciation, an accrual, a prepayment, a provision, a reclassification, a correction of an
      earlier posting, or the opening balances of an agency moving off another system — anything real
      that no invoice, bill, receipt or payment describes.
      <br><br>
      <strong>Accounts marked “control” are cross-checked.</strong>
      Posting to one is allowed and is sometimes exactly right, but it is never silent: it appears as a
      reconciling item on the Financials screen with this voucher's number, date, narration and your
      name against it. Everything else nets away into the ledger as usual.
    </div>`;

  const form = mayPost
    ? `
    <form method="post" action="/journal/new" class="card" style="margin-bottom:22px">
      <input type="hidden" name="csrf" value="${csrfFor(session)}">
      <h2 style="margin-top:0">Post a voucher</h2>
      ${errors.length ? `<div class="err" style="border-left:3px solid #b91c1c;background:#fef2f2;padding:12px 14px;margin:12px 0">
        <strong>Not posted.</strong><ul style="margin:8px 0 0 18px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0">
        <label>Date<br><input type="date" name="date" value="${esc((draft && draft.date) || todayISO())}" required></label>
        <label style="flex:1;min-width:320px">Narration — why this entry exists<br>
          <input name="narration" value="${esc((draft && draft.narration) || '')}" placeholder="Depreciation for August · Accrue unbilled courier · Opening receivable from Tally" required style="width:100%"></label>
      </div>
      <table class="grid">
        <thead><tr><th style="width:36%">Account</th><th>Memo</th><th style="width:15%">Debit</th><th style="width:15%">Credit</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <p class="sub" style="margin-top:10px">Leave spare rows blank. Debits must equal credits — the voucher is refused otherwise, rather than saved and reconciled later.</p>
      <p style="margin-top:14px"><button class="primary" type="submit">Post voucher</button></p>
    </form>`
    : `<div class="note" style="padding:12px 14px;margin-bottom:22px">You can read journal vouchers but not post one — that needs the <em>${esc(RBAC.CAPS.books_journal)}</em> capability, held by Super Admin and Accountant.</div>`;

  const list = vouchers.length
    ? vouchers
        .map((v) => {
          const debit = (v.lines || []).reduce((t, l) => t + Number(l.debit || 0), 0);
          const hits = (v.lines || []).filter((l) => control.has(l.account));
          return `
          <div class="card" style="margin-bottom:14px">
            <h3 style="margin:0">${esc(v.no)} · ${esc(v.date)} · ${money(debit)}</h3>
            <p class="sub" style="margin:4px 0 10px">${esc(v.narration)} — ${esc(v.createdBy)}${v.reversedBy ? ' · <strong>REVERSED</strong>' : ''}${v.reversalOf ? ' · this is a reversal' : ''}</p>
            ${hits.length ? `<p class="sub" style="color:#b45309;margin:0 0 10px">Touches ${hits.length} control account(s) — listed as a reconciling item on Financials.</p>` : ''}
            <table class="grid"><thead><tr><th>Account</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
              ${(v.lines || []).map((l) => {
                const a = chart.find((x) => x.code === l.account);
                return `<tr><td>${esc(a ? a.name : l.account)}${control.has(l.account) ? ' <span class="pill">control</span>' : ''}</td><td>${esc(l.memo || '')}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`;
              }).join('')}
            </tbody></table>
            ${mayPost && !v.reversedBy && !v.reversalOf ? `
              <form method="post" action="/journal/reverse" style="margin-top:10px" onsubmit="return confirm('Post a reversing voucher for ${esc(v.no)}? Both are kept — nothing is deleted.')">
                <input type="hidden" name="csrf" value="${csrfFor(session)}">
                <input type="hidden" name="id" value="${esc(v.id)}">
                <button type="submit">Reverse this voucher</button>
              </form>` : ''}
          </div>`;
        })
        .join('')
    : `<div class="note" style="padding:14px">No journal vouchers yet. The book has none, so the two derivations on the Financials screen currently agree with nothing standing between them.</div>`;

  return page({
    title: 'Journal vouchers',
    session,
    active: 'journal',
    body: `
      <h1>Journal vouchers</h1>
      <p class="sub">Manual double-entry. ${vouchers.length} posted · ${chart.length} accounts in the chart${(book.ledgerAccounts || []).length ? '' : ' · add your own under Records → Ledger accounts'}</p>
      ${posted ? `<div class="ok" style="border-left:3px solid #047857;background:#ecfdf5;padding:12px 14px;margin:14px 0">Posted <strong>${esc(posted)}</strong>.</div>` : ''}
      ${error ? `<div class="err" style="border-left:3px solid #b91c1c;background:#fef2f2;padding:12px 14px;margin:14px 0">${esc(error)}</div>` : ''}
      ${explainer}
      ${form}
      <h2>Posted vouchers</h2>
      ${list}`
  });
}

const collSpec = (k) => BOOK_COLLECTIONS.find((c) => c.key === k);

/** Next free id in a collection, continuing whatever numbering it already uses. */
function nextBookId(rows, prefix) {
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\d+)$`).exec(String(r.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

function bookIndexView(session, book, flash) {
  return page({
    title: 'Accounting records',
    session,
    active: 'books',
    body: `
      <h1>Accounting records</h1>
      <p class="sub">Create, edit and delete every voucher and master in the book. The app on ${esc(APP_URL)}/accounts reads these on the next page load.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      <div class="card"><div class="grid">
        ${BOOK_COLLECTIONS.map((c) => `
          <a class="tile" href="/books/list?col=${esc(c.key)}">
            <strong class="tnum">${(book[c.key] || []).length}</strong>
            <span>${esc(c.label)} →</span>
            ${c.hint ? `<span style="display:block;margin-top:3px;font-size:11.5px">${esc(c.hint)}</span>` : ''}
          </a>`).join('')}
      </div></div>
      <div class="card">
        <p style="margin:0;font-size:12.5px;color:var(--muted)">
          Totals on the dashboard, the cash book and every report are derived from these rows at request time —
          there are no stored balances to fall out of step. Delete a receipt and the invoice goes back to unpaid
          on the next load.
        </p>
      </div>`
  });
}

function bookListView(session, book, spec, q, flash) {
  const all = book[spec.key] || [];
  const term = String(q.q || '').trim().toLowerCase();
  let rows = term
    ? all.filter((r) => spec.search.concat(['id']).some((f) => String(r[f] ?? '').toLowerCase().includes(term)))
    : all;
  rows = [...rows].reverse();

  const pageNo = Math.max(1, Number(q.page) || 1);
  const pages = Math.max(1, Math.ceil(rows.length / 40));
  const slice = rows.slice((pageNo - 1) * 40, pageNo * 40);

  const nameOf = (coll, id) => {
    const r = (book[coll] || []).find((x) => x.id === id);
    return r ? r.name : id || '—';
  };
  const partyName = (r) => {
    if (!spec.party) return '';
    const v = r[spec.party];
    if (spec.party === 'customerId') return nameOf('customers', v);
    if (spec.party === 'supplierId') return nameOf('suppliers', v);
    if (spec.party === 'categoryId') return nameOf('expenseCategories', v);
    return v || '—';
  };
  const sym = (book.company && book.company.currencySymbol) || '৳';

  return page({
    title: spec.label,
    session,
    active: 'books',
    body: `
      <h1>${esc(spec.label)}</h1>
      <p class="sub">${all.length} records${term ? ` · ${rows.length} match “${esc(term)}”` : ''} · <a href="/books">all collections</a></p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

      <div class="card" style="display:flex;gap:11px;flex-wrap:wrap;align-items:flex-end">
        <form method="get" action="/books/list" style="display:flex;gap:9px;align-items:flex-end;flex:1;min-width:260px">
          <input type="hidden" name="col" value="${esc(spec.key)}">
          <label class="row" style="margin:0;flex:1"><span class="lab">Search</span>
            <input type="text" name="q" value="${esc(q.q || '')}" placeholder="${esc(spec.search.join(', '))}"></label>
          <button class="primary" type="submit">Search</button>
          <a class="secondary" href="/books/list?col=${esc(spec.key)}">Reset</a>
        </form>
        <form method="post" action="/books/new?col=${esc(spec.key)}">
          <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
          <button class="primary" type="submit">+ New ${esc(spec.label.replace(/s$/, '').toLowerCase())}</button>
        </form>
      </div>

      <form method="post" action="/books/delete?col=${esc(spec.key)}" class="card" style="padding:0;overflow:hidden">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <table>
          <thead><tr>
            <th style="width:24px"></th><th>ID</th><th>Reference</th>
            ${spec.party ? '<th>Party</th>' : ''}<th>Date</th>
            ${spec.amount ? '<th style="text-align:right">Amount</th>' : ''}<th></th>
          </tr></thead>
          <tbody>
          ${slice.length === 0
            ? `<tr><td colspan="7" style="padding:24px;color:var(--muted)">Nothing here yet — press <strong>New</strong> above.</td></tr>`
            : slice.map((r) => `<tr>
                <td><input type="checkbox" name="remove" value="${esc(r.id)}"></td>
                <td class="tnum" style="white-space:nowrap"><a href="/books/edit?col=${esc(spec.key)}&id=${encodeURIComponent(r.id)}">${esc(r.id)}</a></td>
                <td><strong>${esc(spec.title.map((f) => r[f]).find(Boolean) || r.id)}</strong></td>
                ${spec.party ? `<td>${esc(partyName(r))}</td>` : ''}
                <td class="tnum">${esc(r.date || '—')}</td>
                ${spec.amount ? `<td class="tnum" style="text-align:right;font-weight:600">${esc(sym)}${Number(r[spec.amount] || 0).toLocaleString('en-IN')}</td>` : ''}
                <td><a href="/books/edit?col=${esc(spec.key)}&id=${encodeURIComponent(r.id)}">Edit</a></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="bar" style="padding:14px 18px">
          <button class="primary" type="submit">Delete selected</button>
          <span style="margin-left:auto;font-size:12.5px;color:var(--muted)">Showing ${slice.length} of ${rows.length} · page ${pageNo} of ${pages}</span>
          ${pageNo > 1 ? `<a class="secondary" href="/books/list?col=${esc(spec.key)}&q=${esc(q.q || '')}&page=${pageNo - 1}">← Prev</a>` : ''}
          ${pageNo < pages ? `<a class="secondary" href="/books/list?col=${esc(spec.key)}&q=${esc(q.q || '')}&page=${pageNo + 1}">Next →</a>` : ''}
        </div>
      </form>`
  });
}

/**
 * Fields that are optional in the data but must still be editable.
 *
 * Older invoices and bills have no currency, rate or attachments on them, and
 * the form is generated from whatever keys the record happens to carry — so
 * without this they would be uneditable forever, and only brand-new records
 * could ever be foreign. Adding the keys with empty values costs nothing: a
 * blank currency means the book's own, and fxOf() treats a missing rate as 1.
 */
function withOptionalFields(spec, rec) {
  /**
   * A receipt needs a settlement currency and rate on the form, or an exchange gain
   * can never be told apart from an overpayment — see lib/fx.ts. Blank means base
   * currency, which is what every existing receipt is.
   */
  if (spec.key === 'receipts') {
    if (rec.currency === undefined) rec.currency = '';
    if (rec.fxRate === undefined) rec.fxRate = 0;
  }
  if (['invoices', 'bills'].includes(spec.key)) {
    if (rec.currency === undefined) rec.currency = '';
    if (rec.fxRate === undefined) rec.fxRate = 0;
  }
  /**
   * Credit limit, surfaced on every customer form whether or not the record has it.
   *
   * The generic editor builds its fields from the record it is given, so a field
   * nobody has yet is a field nobody can ever set — the classic chicken and egg of
   * a schema addition on a document store. Defaulting it to 0 here puts the box on
   * the form, and 0 is read everywhere as "no limit enforced", so an untouched
   * customer behaves exactly as before.
   */
  if (spec.key === 'customers' && rec.creditLimit === undefined) rec.creditLimit = 0;
  /**
   * Memo fields on every document form. A memo raised through the admin portal is
   * useless without the ticket it is against and the reason — those two are the
   * whole difference between a document and an expense line with a note.
   */
  if (spec.key === 'documents') {
    if (rec.againstDocumentNo === undefined) rec.againstDocumentNo = '';
    if (rec.reason === undefined) rec.reason = '';
  }
  if (['invoices', 'bills', 'expenses'].includes(spec.key) && !Array.isArray(rec.attachments)) {
    rec.attachments = [];
  }
  return rec;
}

function bookEditView(session, book, spec, rec, flash, errors) {
  const boolPaths = [];
  const numPaths = [];
  const linePaths = [];
  const fields = renderValue('rec', rec, boolPaths, numPaths, linePaths, bookEnums(book, spec));

  // dropdown help — the raw form shows ids, so list what they mean
  const legend = [];
  for (const [label, coll] of [['Customers', 'customers'], ['Suppliers', 'suppliers'], ['Services', 'services'], ['Banks', 'banks'], ['Expense categories', 'expenseCategories']]) {
    const rows = book[coll] || [];
    if (!rows.length) continue;
    legend.push(`<div style="margin-bottom:10px"><strong style="font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">${esc(label)}</strong>
      <div style="font-size:12px;margin-top:3px;line-height:1.7">${rows.map((r) => `<code style="background:var(--panel);padding:1px 5px;border-radius:4px">${esc(r.id)}</code> ${esc(r.name)}`).join(' · ')}</div></div>`);
  }

  return page({
    title: rec.id,
    session,
    active: 'books',
    body: `
      <h1>${esc(spec.title.map((f) => rec[f]).find(Boolean) || rec.id)}</h1>
      <p class="sub"><span class="tnum">${esc(rec.id)}</span> · ${esc(spec.label)} · <a href="/books/list?col=${esc(spec.key)}">back to list</a></p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      ${errors && errors.length ? `<div class="flash warn"><strong>Not saved:</strong><ul style="margin:6px 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}

      <form method="post" action="/books/edit?col=${esc(spec.key)}&id=${encodeURIComponent(rec.id)}">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <input type="hidden" name="__bools" value="${esc(boolPaths.join('|'))}">
        <input type="hidden" name="__nums" value="${esc(numPaths.join('|'))}">
        <!-- Version marker: a fingerprint of this record as it was rendered.
             The save is refused if it no longer matches, so two people editing
             the same voucher cannot silently overwrite each other. -->
        <input type="hidden" name="__fp" value="${esc(fingerprint((book[spec.key] || []).find((r) => r.id === rec.id) ?? null))}">
        <div class="card">${fields}</div>
        <div class="bar">
          <button class="primary" type="submit" name="save" value="1">Save</button>
          <a class="secondary" href="/books/list?col=${esc(spec.key)}">Cancel</a>
          <span style="margin-left:auto;font-size:12.5px;color:var(--muted)">Ticking <em>delete</em> on a line, or <em>Add item</em>, also saves.</span>
        </div>
      </form>

      ${legend.length ? `<div class="card"><h2 style="margin:0 0 12px;font-size:13.5px;color:var(--navy)">What the ids mean</h2>${legend.join('')}</div>` : ''}`
  });
}

/** The few rules that stop a voucher being nonsense. */
function validateBookRecord(spec, rec) {
  const errors = [];
  const num = (v) => Number(v || 0);
  if (['receipts', 'payments', 'expenses', 'supplierDeposits'].includes(spec.key) && num(rec.amount) <= 0) {
    errors.push('Amount must be greater than zero.');
  }
  if (['bills'].includes(spec.key) && num(rec.amount) < 0) errors.push('A bill cannot be negative.');
  if (spec.key === 'creditNotes') errors.push(...validateCreditNote(rec));
  if (spec.key === 'supplierCreditNotes') errors.push(...validateSupplierCreditNote(rec));
  if (spec.key === 'transfers') errors.push(...validateTransfer(rec));
  if (spec.key === 'payments' && rec.method === 'supplier_deposit') {
    errors.push(...validateDepositDrawdown(rec));
  }
  if (spec.key === 'invoices') {
    if (!Array.isArray(rec.lines) || rec.lines.length === 0) errors.push('An invoice needs at least one line.');
    else for (const [i, l] of rec.lines.entries()) {
      if (num(l.qty) <= 0) errors.push(`Line ${i + 1}: quantity must be greater than zero.`);
      if (num(l.unitPrice) < num(l.supplierCost)) {
        errors.push(`Line ${i + 1}: selling price is below supplier cost — that is a loss, confirm it is deliberate by raising the price or lowering the cost.`);
      }
    }
  }
  /**
   * A foreign document has to carry the rate it was raised at. Leaving it blank
   * would silently value a dollar invoice at one taka, which is not an error
   * anybody notices until the month is closed.
   */
  if (['invoices', 'bills'].includes(spec.key) && rec.currency) {
    const book = bookFile();
    const base = (book.company && book.company.currencySettings && book.company.currencySettings.baseCurrency)
      || (book.company && book.company.currency) || 'BDT';
    const known = (book.currencies || []).some((c) => c.code === rec.currency);
    if (!known) errors.push(`${rec.currency} is not in the Currencies master. Add it there first, with its rate.`);
    if (rec.currency === base) {
      if (rec.fxRate !== undefined && num(rec.fxRate) !== 1 && num(rec.fxRate) !== 0) {
        errors.push(`${base} is the book's own currency, so its rate is 1.`);
      }
    } else if (num(rec.fxRate) <= 0) {
      const cur = (book.currencies || []).find((c) => c.code === rec.currency);
      errors.push(
        `A ${rec.currency} document needs the rate it was raised at.` +
        (cur ? ` Today the master says ${cur.rateToBase} — but use the rate on the day of the document, not today's.` : '')
      );
    }
  }
  if (spec.key === 'currencies') {
    if (!String(rec.code || '').match(/^[A-Z]{3}$/)) errors.push('Currency code must be three capital letters, like BDT or USD.');
    if (num(rec.rateToBase) <= 0) errors.push('Rate to base must be greater than zero — a currency worth nothing cannot price anything.');
    if (num(rec.isBase) === 1 && num(rec.rateToBase) !== 1) errors.push('The base currency has a rate of exactly 1 against itself.');
  }
  if (spec.key === 'countries' && rec.iso2 && !String(rec.iso2).match(/^[A-Z]{2}$/)) {
    errors.push('ISO code must be two capital letters, like BD or AE.');
  }
  if (spec.key === 'airlines' && rec.iataCode && !String(rec.iataCode).match(/^[0-9A-Z]{2}$/)) {
    errors.push('An IATA airline code is two characters, like BG or 6E.');
  }
  if (spec.key === 'inventory') {
    if (num(rec.sold) > num(rec.purchased)) errors.push('Sold cannot exceed purchased.');
    if (num(rec.unitCost) < 0 || num(rec.unitSell) < 0) errors.push('Unit cost and unit sell cannot be negative.');
  }
  // Attachments are references to where a document lives, not uploads. A link
  // that goes nowhere is worse than no link, so an entry needs both a name and
  // a destination.
  if (Array.isArray(rec.attachments)) {
    for (const [i, a] of rec.attachments.entries()) {
      if (!a) continue;
      const hasName = String(a.name || '').trim().length > 0;
      const hasUrl = String(a.url || '').trim().length > 0;
      if (hasUrl && !hasName) errors.push(`Attachment ${i + 1}: give it a name so somebody knows what they are opening.`);
      if (hasName && !hasUrl) errors.push(`Attachment ${i + 1}: give it a link or a file path.`);
    }
  }
  if (rec.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(rec.date))) errors.push('Date must be YYYY-MM-DD.');
  return errors;
}

/**
 * A credit note can only take away money that is actually there.
 *
 * Both limits below exist to keep the control accounts non-negative, which is
 * what keeps the trial balance true:
 *
 *   an unsettled credit reduces the receivable, so it cannot exceed what the
 *   customer still owes on that invoice;
 *
 *   a refunded credit takes cash back out, so it cannot exceed what they
 *   actually paid — you cannot refund money you never received;
 *
 *   a supplier refund reduces the payable, so it cannot exceed what is still
 *   outstanding on the bill. If the bill is already settled and the airline
 *   sends money back, that is a supplier deposit, not a credit note.
 *
 * Credits already raised against the same invoice count towards the limit, so
 * three small notes cannot do what one large one is refused.
 */
function validateCreditNote(rec, bookArg) {
  const errors = [];
  const book = bookArg || bookFile();
  const num = (v) => Number(v || 0);
  const amount = num(rec.amount);
  const refund = num(rec.supplierRefund);

  if (amount <= 0 && refund <= 0) {
    errors.push('A credit note needs either an amount to credit the customer or a supplier refund.');
  }
  if (amount < 0) errors.push('Credit amount cannot be negative.');
  if (refund < 0) errors.push('Supplier refund cannot be negative.');
  if (!rec.customerId) errors.push('Choose the customer being credited.');
  if (!rec.invoiceId) errors.push('Choose the invoice this reverses — a credit note must point at a sale.');

  const invoice = (book.invoices || []).find((i) => i.id === rec.invoiceId);
  if (rec.invoiceId && !invoice) {
    errors.push(`Invoice ${rec.invoiceId} is not in the book.`);
  } else if (invoice) {
    if (rec.customerId && invoice.customerId !== rec.customerId) {
      errors.push('That invoice belongs to a different customer.');
    }
    const gross = (invoice.lines || []).reduce((t, l) => t + num(l.qty) * num(l.unitPrice), 0);
    const total = gross + Math.round(gross * num(invoice.vatRate) / 100);
    const paid = (book.receipts || [])
      .filter((r) => r.invoiceId === invoice.id)
      .reduce((t, r) => t + num(r.amount), 0);

    const others = (book.creditNotes || []).filter((c) => c.id !== rec.id && c.invoiceId === invoice.id);
    const otherAll = others.reduce((t, c) => t + num(c.amount), 0);
    const otherOpen = others.filter((c) => c.settlement === 'credit_balance').reduce((t, c) => t + num(c.amount), 0);
    const otherRefunded = otherAll - otherOpen;

    if (otherAll + amount > total) {
      errors.push(`That would credit ${otherAll + amount} against an invoice of ${total}. At most ${total - otherAll} is left to credit.`);
    }
    if (rec.settlement === 'credit_balance') {
      const owed = total - paid - otherOpen;
      if (amount > owed) {
        errors.push(`The customer only still owes ${Math.max(0, owed)} on that invoice. To give back money they have already paid, set Settlement to the method you are refunding by.`);
      }
    } else {
      const refundable = paid - otherRefunded;
      if (amount > refundable) {
        errors.push(`Only ${Math.max(0, refundable)} has been received on that invoice, so no more than that can be refunded. Use "Credit balance" for the unpaid part.`);
      }
      if (!rec.bankId && rec.settlement !== 'cash') {
        errors.push('Choose the bank or wallet the refund goes out of.');
      }
    }
  }

  if (rec.billId) {
    const bill = (book.bills || []).find((b) => b.id === rec.billId);
    if (!bill) {
      errors.push(`Bill ${rec.billId} is not in the book.`);
    } else if (refund > 0) {
      const paid = (book.payments || []).filter((x) => x.billId === bill.id).reduce((t, x) => t + num(x.amount), 0);
      const otherRefunds = (book.creditNotes || [])
        .filter((c) => c.id !== rec.id && c.billId === bill.id)
        .reduce((t, c) => t + num(c.supplierRefund), 0);
      const outstanding = num(bill.amount) - paid - otherRefunds;
      if (refund > outstanding) {
        errors.push(`Only ${Math.max(0, outstanding)} is still outstanding on ${bill.no}. A refund on an already-settled bill is money coming back in — record it as a supplier deposit.`);
      }
    }
  } else if (refund > 0) {
    errors.push('Choose the supplier bill the refund comes off.');
  }

  return errors;
}

/**
 * A supplier credit note, mirrored on the customer one and refused for the same
 * reasons: unsettled credit cannot exceed what is still owed on the bill, and
 * money cannot come back that was never paid out.
 */
function validateSupplierCreditNote(rec, bookArg) {
  const errors = [];
  const book = bookArg || bookFile();
  const num = (v) => Number(v || 0);
  const amount = num(rec.amount);

  if (amount <= 0) errors.push('A supplier credit note needs an amount.');
  if (!rec.supplierId) errors.push('Choose the supplier.');
  if (!rec.billId) errors.push('Choose the bill this credits — a supplier credit must point at a bill.');

  const bill = (book.bills || []).find((b) => b.id === rec.billId);
  if (rec.billId && !bill) {
    errors.push(`Bill ${rec.billId} is not in the book.`);
  } else if (bill) {
    if (rec.supplierId && bill.supplierId !== rec.supplierId) {
      errors.push('That bill belongs to a different supplier.');
    }
    const paid = (book.payments || []).filter((p) => p.billId === bill.id).reduce((t, p) => t + num(p.amount), 0);
    const refunded = (book.creditNotes || [])
      .filter((c) => c.billId === bill.id)
      .reduce((t, c) => t + num(c.supplierRefund), 0);
    const others = (book.supplierCreditNotes || []).filter((c) => c.id !== rec.id && c.billId === bill.id);
    const otherAll = others.reduce((t, c) => t + num(c.amount), 0);
    const otherOpen = others.filter((c) => c.settlement === 'credit_balance').reduce((t, c) => t + num(c.amount), 0);

    if (otherAll + refunded + amount > num(bill.amount)) {
      const left = num(bill.amount) - otherAll - refunded;
      errors.push(`That would credit more than ${bill.no} is worth. At most ${Math.max(0, left)} is left to credit.`);
    }
    if (rec.settlement === 'credit_balance') {
      const owed = num(bill.amount) - paid - refunded - otherOpen;
      if (amount > owed) {
        errors.push(`Only ${Math.max(0, owed)} is still owed on ${bill.no}. If the supplier is sending money back on a bill already settled, choose the method it arrives by.`);
      }
    } else {
      const recoverable = paid - (otherAll - otherOpen);
      if (amount > recoverable) {
        errors.push(`Only ${Math.max(0, recoverable)} has been paid on ${bill.no}, so no more than that can come back. Use "Credit balance" for the unpaid part.`);
      }
      if (!rec.bankId && rec.settlement !== 'cash') {
        errors.push('Choose the bank or wallet the money arrives in.');
      }
    }
  }

  return errors;
}

/**
 * A transfer must move money that exists.
 *
 * The balance is walked to the transfer's own date rather than to today,
 * because an overdraft in March is still an overdraft even if the account is
 * healthy now.
 */
function validateTransfer(rec, bookArg) {
  const errors = [];
  const book = bookArg || bookFile();
  const num = (v) => Number(v || 0);
  const amount = num(rec.amount);

  if (amount <= 0) errors.push('A transfer needs an amount.');
  if (!rec.bankId) errors.push('Choose the bank account.');
  if (!['deposit', 'withdrawal'].includes(rec.direction)) errors.push('Direction must be deposit or withdrawal.');
  if (!rec.date) return errors;

  const upto = (arr, f) => (arr || []).filter((x) => x.date <= rec.date).reduce((t, x) => t + f(x), 0);
  const isCash = rec.direction === 'deposit';
  const hits = (m, b) => (isCash ? m === 'cash' : m !== 'cash' && b === rec.bankId);

  let available = isCash
    ? num(book.company && book.company.openingCash)
    : num(((book.banks || []).find((b) => b.id === rec.bankId) || {}).openingBalance);

  available += upto(book.receipts, (r) => (hits(r.method, r.bankId) ? num(r.amount) : 0));
  available -= upto(book.payments, (p) => (p.method !== 'supplier_deposit' && hits(p.method, p.bankId) ? num(p.amount) : 0));
  available -= upto(book.expenses, (e) => (hits(e.method, e.bankId) ? num(e.amount) : 0));
  available -= upto(book.supplierDeposits, (d) => (hits(d.method, d.bankId) ? num(d.amount) : 0));
  available -= upto(book.creditNotes, (c) => (c.settlement !== 'credit_balance' && hits(c.settlement, c.bankId) ? num(c.amount) : 0));
  available += upto(book.supplierCreditNotes, (c) => (c.settlement !== 'credit_balance' && hits(c.settlement, c.bankId) ? num(c.amount) : 0));
  for (const t of book.transfers || []) {
    if (t.id === rec.id || t.date > rec.date) continue;
    if (isCash) available += t.direction === 'deposit' ? -num(t.amount) : num(t.amount);
    else if (t.bankId === rec.bankId) available += t.direction === 'deposit' ? num(t.amount) : -num(t.amount);
  }

  if (amount > available) {
    const where = isCash ? 'the till' : 'that account';
    errors.push(`Only ${Math.max(0, Math.round(available))} was in ${where} on ${rec.date}. A transfer cannot move money that is not there.`);
  }
  return errors;
}

/**
 * Settling a bill out of a supplier float can only spend float that is left.
 * Overdrawing it would show an advance the agency never placed.
 */
function validateDepositDrawdown(rec, bookArg) {
  const errors = [];
  const book = bookArg || bookFile();
  const num = (v) => Number(v || 0);
  if (!rec.supplierId) return ['Choose the supplier whose deposit this draws on.'];

  const placed = (book.supplierDeposits || [])
    .filter((d) => d.supplierId === rec.supplierId)
    .reduce((t, d) => t + num(d.amount), 0);
  const drawn = (book.payments || [])
    .filter((p) => p.id !== rec.id && p.supplierId === rec.supplierId && p.method === 'supplier_deposit')
    .reduce((t, p) => t + num(p.amount), 0);
  const left = placed - drawn;

  if (num(rec.amount) > left) {
    errors.push(`Only ${Math.max(0, left)} of deposit is left with that supplier. Pay the rest from cash or a bank account.`);
  }
  if (rec.bankId) errors.push('A payment drawn from a deposit does not come out of a bank account — clear the bank field.');
  return errors;
}

/**
 * Which CRM rep is signed in, matched on the email on their admin account.
 *
 * Returns null when the account is not linked to a rep. That is deliberately
 * not treated as "can see everything": an unlinked account with only `crm_write`
 * is refused, because the safe direction for a missing link is no access rather
 * than everyone's access.
 */
function crmIdentity(session) {
  const email = String(session.email || '').toLowerCase();
  return crmUsers().find((u) => String(u.email || '').toLowerCase() === email && u.email) || null;
}

/**
 * May this session write to this lead?
 *
 * `crm_all` — Manager, Super Admin — passes everything. Anyone else must be
 * linked to the rep the lead is assigned to.
 */
function leadScope(session, lead) {
  if (RBAC.canEditAnyLead(session.role)) return { ok: true, reason: 'crm_all' };

  const me = crmIdentity(session);
  if (!me) {
    return {
      ok: false,
      kind: 'unlinked',
      message: 'This admin account is not linked to a CRM rep, so it cannot edit leads.'
    };
  }
  if (!lead.assigned_to) {
    return {
      ok: false,
      kind: 'unassigned',
      me,
      message: 'This lead is not assigned to anyone yet. A manager has to assign it before it can be worked.'
    };
  }
  if (lead.assigned_to !== me.id) {
    return {
      ok: false,
      kind: 'other_rep',
      me,
      owner: crmUsers().find((u) => u.id === lead.assigned_to) || { name: lead.assigned_to },
      message: 'This lead belongs to another rep.'
    };
  }
  return { ok: true, reason: 'owner', me };
}

function leadScopeView(session, lead, scope) {
  const owner = scope.owner ? scope.owner.name : null;
  return page({
    title: 'Not your lead',
    session,
    active: 'crm',
    body: `
      <h1>Nothing was saved</h1>
      <div class="flash warn">
        <p style="margin:0">${esc(scope.message)}</p>
        ${owner ? `<p style="margin:6px 0 0"><span class="tnum">${esc(lead.lead_id)}</span> ${esc(lead.company)} is assigned to <strong>${esc(owner)}</strong>${scope.me ? `, and you are signed in as ${esc(scope.me.name)}` : ''}.</p>` : ''}
        ${scope.kind === 'unlinked'
          ? '<p style="margin:6px 0 0">A Super Admin can link it by putting this account&rsquo;s email address on the rep in <code>content/crm-users.json</code>.</p>'
          : '<p style="margin:6px 0 0">Two people rewriting the same call notes is how a pipeline stops meaning anything. Ask a manager to reassign it if it should be yours.</p>'}
      </div>
      <div class="bar">
        <a class="secondary" href="/crm/lead?id=${encodeURIComponent(lead.lead_id)}">View the lead</a>
        <a class="secondary" href="/crm">Back to the list</a>
      </div>`
  });
}

/** A lead with every field present, so an import cannot create a ragged record. */
function blankLead() {
  return {
    lead_id: '', priority: 'P3', tier: '', segment: '', company: '', decision_maker: '',
    address: '', city: '', phone: '', mobile: '', email: '', website: '', facebook: '',
    licence_ref: '', booking_engine: '', prospect_note: '', data_source: '', source_url: '',
    assigned_to: '', call_status: 'not_started', last_call_date: '', disposition: '',
    interest_level: '', demo_scheduled: '', next_action: '', next_action_date: '',
    notes: '', do_not_call_reason: ''
  };
}

/**
 * Parse a pasted CSV and work out exactly what it would do.
 *
 * RFC-4180 quoting by hand, because the field values in this dataset genuinely
 * contain commas, quotes and newlines — addresses out of the government register
 * are full of them, and a naive split on commas would shred them.
 *
 * Nothing is written here. The caller previews first.
 */
function planImport(csv) {
  const errors = [];
  const text = String(csv || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { errors: ['Paste some CSV first.'], rows: [], adds: [], updates: [], skipped: [] };

  /* --- RFC-4180 reader ------------------------------------------------- */
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) table.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) table.push(row);

  if (table.length < 2) return { errors: ['That looks like a header with no rows.'], rows: [], adds: [], updates: [], skipped: [] };

  /* --- map the header to field names ---------------------------------- */
  const norm = (h) => String(h).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const known = Object.keys(blankLead());
  const aliases = {
    id: 'lead_id', leadid: 'lead_id', lead: 'lead_id',
    company_agency: 'company', company_name: 'company',
    owner_decision_maker: 'decision_maker', owner: 'decision_maker',
    office_address: 'address', phone_mobile: 'phone',
    ref: 'licence_ref', why_they_are_a_prospect: 'prospect_note',
    source: 'data_source', p: 'priority'
  };
  const header = table[0].map((h) => {
    const k = norm(h);
    return known.includes(k) ? k : (aliases[k] ?? null);
  });
  if (!header.includes('lead_id')) {
    errors.push('No lead_id column. That is the key an import upserts on — without it every row would be a duplicate.');
  }
  const unmapped = table[0].filter((_, i) => header[i] === null);
  if (errors.length) return { errors, rows: [], adds: [], updates: [], skipped: [] };

  /* --- rows ------------------------------------------------------------ */
  const existing = new Map(crmLeads().map((l) => [l.lead_id, l]));
  const rows = [];
  const adds = [];
  const updates = [];
  const skipped = [];
  const seen = new Set();

  for (let r = 1; r < table.length; r += 1) {
    const cells = table[r];
    const rec = {};
    const ignoredCrm = [];
    header.forEach((k, i) => {
      if (!k) return;
      const v = (cells[i] ?? '').trim();
      if (v === '') return;
      /**
       * CALL PROGRESS IS DROPPED HERE, not at apply time.
       *
       * The first version only guarded updates, so a CSV row for a NEW lead
       * could carry call_status=won and the import would create a lead the
       * pipeline counted as closed — a deal nobody made, in the funnel and on
       * the manager dashboard. An import brings research; progress is only ever
       * earned by a rep logging a call.
       */
      if (CRM.EDITABLE.includes(k)) { ignoredCrm.push(k); return; }
      // Phone numbers, emails and addresses go in exactly as printed — the data
      // dictionary is explicit that source artefacts are preserved, not repaired.
      rec[k] = v;
    });
    const id = rec.lead_id;
    if (!id) { skipped.push({ line: r + 1, why: 'no lead_id' }); continue; }
    if (!/^SBD-\d{4}$/.test(id)) { skipped.push({ line: r + 1, why: `lead_id "${id}" is not in the SBD-0000 form` }); continue; }
    if (seen.has(id)) { skipped.push({ line: r + 1, why: `${id} appears more than once in this file` }); continue; }
    seen.add(id);

    if (existing.has(id)) {
      const before = existing.get(id);
      const changed = Object.keys(rec).filter((k) => rec[k] !== before[k]);
      updates.push({ id, company: before.company, changed, wouldTouchCrm: ignoredCrm });
    } else {
      adds.push({ id, company: rec.company || '(no company name)', wouldTouchCrm: ignoredCrm });
    }
    rows.push(rec);
  }

  return { errors, rows, adds, updates, skipped, unmapped, columns: header.filter(Boolean) };
}

/**
 * Import screen: paste, preview, then confirm.
 *
 * The CRM specification asked for this and it was never built, so growing the
 * database past the researched 400 meant hand-editing a JSON file. The preview
 * is the part that matters — an upsert straight off a paste is how a
 * half-finished spreadsheet quietly overwrites the research everything else
 * depends on.
 */
function importView(session, plan, errors, csv) {
  const total = crmLeads().length;
  const list = (arr, render) => arr.slice(0, 12).map(render).join('') + (arr.length > 12 ? `<div style="font-size:11.5px;color:var(--muted);padding:4px 0">and ${arr.length - 12} more</div>` : '');

  return page({
    title: 'Import leads',
    session,
    active: 'crm-import',
    body: `
      <h1>Import leads</h1>
      <p class="sub">
        Paste CSV with a <code>lead_id</code> column. Matching ids are UPDATED, new ones are ADDED, and
        <strong>call progress is never touched</strong> — an import writes research fields only, so re-running a
        seed cannot wipe what a rep recorded. ${total} leads in the database now.
      </p>

      ${errors && errors.length ? `<div class="flash warn"><strong>Not imported:</strong><ul style="margin:6px 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}

      ${plan && plan.done ? `
        <div class="flash">
          Imported. <strong>${plan.done.added} added, ${plan.done.updated} updated.</strong>
          The database now holds ${total} leads. <a href="/crm">Open the lead list →</a>
        </div>` : ''}

      ${plan && !plan.done ? `
        <div class="card">
          <h2 style="margin:0 0 10px;font-size:13.5px;color:var(--navy)">This is what it would do — nothing is written yet</h2>
          <div class="grid" style="margin-bottom:14px">
            <div class="tile"><strong>${plan.adds.length}</strong><span>New leads</span></div>
            <div class="tile"><strong>${plan.updates.length}</strong><span>Existing, would update</span></div>
            <div class="tile"><strong>${plan.skipped.length}</strong><span>Skipped</span></div>
            <div class="tile"><strong>${plan.columns.length}</strong><span>Columns recognised</span></div>
          </div>

          ${plan.unmapped && plan.unmapped.length ? `
            <p style="font-size:12.5px;color:var(--amber);line-height:1.7;margin:0 0 12px">
              <strong>${plan.unmapped.length} column(s) will be ignored</strong> because they do not match a lead field:
              ${esc(plan.unmapped.join(', '))}. Nothing is guessed — a column this does not recognise is left alone
              rather than written into the wrong place.
            </p>` : ''}

          ${plan.adds.length ? `<div style="margin-bottom:12px">
            <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Will be added</div>
            ${list(plan.adds, (a) => `<div style="font-size:12.5px">
              <span class="tnum">${esc(a.id)}</span> ${esc(a.company)}
              ${a.wouldTouchCrm && a.wouldTouchCrm.length ? `<span style="color:var(--amber)"> · ${esc([...new Set(a.wouldTouchCrm)].join(', '))} ignored, that is call progress</span>` : ''}
            </div>`)}
          </div>` : ''}

          ${plan.updates.length ? `<div style="margin-bottom:12px">
            <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Will be updated</div>
            ${list(plan.updates, (u) => `<div style="font-size:12.5px">
              <span class="tnum">${esc(u.id)}</span> ${esc(u.company)}
              ${u.changed.length ? `<span style="color:var(--muted)"> — ${esc(u.changed.join(', '))}</span>` : '<span style="color:var(--muted)"> — no research field differs</span>'}
              ${u.wouldTouchCrm.length ? `<span style="color:var(--amber)"> · ${esc(u.wouldTouchCrm.join(', '))} ignored, that is call progress</span>` : ''}
            </div>`)}
          </div>` : ''}

          ${plan.skipped.length ? `<div>
            <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--amber);margin-bottom:4px">Skipped</div>
            ${list(plan.skipped, (sk) => `<div style="font-size:12.5px;color:var(--muted)">line ${sk.line}: ${esc(sk.why)}</div>`)}
          </div>` : ''}
        </div>` : ''}

      <form method="post" action="/crm/import">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="card">
          <label class="row"><span class="lab">CSV ${plan && !plan.done ? '<em>edit and preview again, or confirm below</em>' : '<em>first row is the header</em>'}</span>
            <textarea name="csv" rows="12" placeholder="lead_id,company,decision_maker,city,mobile,email,website,prospect_note,data_source,source_url">${esc(csv || '')}</textarea></label>
          <div class="bar">
            <button class="primary" type="submit">${plan && !plan.done ? 'Preview again' : 'Preview'}</button>
            ${plan && !plan.done && (plan.adds.length || plan.updates.length) ? `
              <button class="primary" type="submit" name="confirm" value="1" style="background:var(--amber)">
                Apply — ${plan.adds.length} add, ${plan.updates.length} update
              </button>` : ''}
            <span style="margin-left:auto;font-size:12px;color:var(--muted)">
              Export from <a href="${esc(APP_URL)}/api/crm/export?format=csv">/api/crm/export?format=csv</a> to see the exact column names.
            </span>
          </div>
        </div>
      </form>`
  });
}

/**
 * The dropdown lists a manager should own.
 *
 * These were constants in admin/crm-fields.js: adding a disposition meant a code
 * edit and a restart, which the CRM specification explicitly did not want. A
 * manager who cannot add "Interested — waiting on their IATA renewal" will put
 * it in the notes field instead, and then nobody can count it.
 *
 * Retiring is deliberately not deleting. A value recorded against a real lead
 * stays resolvable for ever, or that lead's history would start rendering as a
 * raw slug — so the screen refuses to retire anything still in use, and hides
 * the rest rather than removing them.
 */
function vocabView(session, msg, errors) {
  const v = vocab();
  const leads = crmLeads();
  const acts = crmActivities();
  const fieldFor = { CALL_STATUS: 'call_status', DISPOSITION: 'disposition', INTEREST: 'interest_level', DEMO: 'demo_scheduled', ACTIVITY_TYPE: null };
  const titles = {
    CALL_STATUS: 'Call status — the funnel',
    DISPOSITION: 'Disposition — why the call ended that way',
    INTEREST: 'Interest level',
    DEMO: 'Demo scheduled',
    ACTIVITY_TYPE: 'Activity type — what a logged touch was'
  };

  const usage = (key, slug) => {
    const f = fieldFor[key];
    if (!f) return acts.filter((a) => a.activity_type === slug).length;
    return leads.filter((l) => l[f] === slug).length;
  };

  const block = (key) => {
    const hidden = new Set(v.hidden[key] || []);
    const all = { ...(CRM.DEFAULTS[key] || {}), ...v.vocab[key] };
    const overridden = readJson(VOCAB_FILE(), {})[key];

    return `
      <form method="post" action="/crm/vocab">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <input type="hidden" name="list" value="${esc(key)}">
        <div class="card" style="padding:0;overflow:hidden">
          <div style="padding:14px 18px;border-bottom:1px solid var(--hair);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <h2 style="margin:0;font-size:13.5px;color:var(--navy)">${esc(titles[key])}</h2>
            <span style="font-size:11.5px;color:var(--muted)">${Object.keys(all).length} value(s)${overridden ? ' · customised' : ' · built-in'}</span>
          </div>
          <table>
            <thead><tr><th style="width:26%">Key</th><th>Label shown to reps</th><th style="text-align:right">In use</th><th style="width:90px">Retire</th></tr></thead>
            <tbody>
              ${Object.keys(all).map((slug) => {
                const used = usage(key, slug);
                const isHidden = hidden.has(slug);
                return `
                <tr${isHidden ? ' style="opacity:.55"' : ''}>
                  <td class="tnum" style="font-size:12px">${esc(slug)}${isHidden ? ' <span style="font-size:10.5px;color:var(--amber)">retired</span>' : ''}</td>
                  <td><input type="text" name="label_${esc(slug)}" value="${esc(all[slug])}" style="width:100%"></td>
                  <td class="tnum" style="text-align:right">${used || '—'}</td>
                  <td style="text-align:center">
                    <input type="checkbox" name="retire" value="${esc(slug)}" ${isHidden ? 'checked' : ''} ${used ? 'disabled title="in use — cannot be retired"' : ''}>
                  </td>
                </tr>`;
              }).join('')}
              <tr style="background:var(--panel)">
                <td class="tnum" style="font-size:11.5px;color:var(--muted)">new</td>
                <td><input type="text" name="new_label" placeholder="Add a value — the key is generated from the label"></td>
                <td></td><td></td>
              </tr>
            </tbody>
          </table>
          <div class="bar" style="padding:12px 18px">
            <button class="primary" type="submit">Save this list</button>
            <span style="margin-left:auto"></span>
          </div>
        </div>
      </form>
      ${overridden ? `
        <form method="post" action="/crm/vocab/reset" style="margin:-8px 0 18px">
          <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
          <input type="hidden" name="list" value="${esc(key)}">
          <button class="secondary" type="submit" style="font-size:12px">Reset ${esc(key)} to the built-in list</button>
        </form>` : '<div style="margin-bottom:18px"></div>'}`;
  };

  return page({
    title: 'CRM lists',
    session,
    active: 'crm-vocab',
    body: `
      <h1>CRM lists</h1>
      <p class="sub">
        The dropdowns reps choose from. Changing a label here changes it everywhere, including on calls already
        logged — which is the point, and also why a value that is in use cannot be retired.
      </p>
      ${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
      ${errors && errors.length ? `<div class="flash warn"><strong>Not saved:</strong><ul style="margin:6px 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      ${CRM.OVERRIDABLE.map(block).join('')}`
  });
}

/**
 * What the scheduled checks have found, and — just as important — whether they
 * are still running.
 *
 * The job table is not decoration. A scheduler that has quietly stopped shows an
 * empty alert list, which is indistinguishable from a healthy book unless
 * something says when each check last completed. `overdue` is that something.
 */
function alertsView(session, st, msg) {
  const can = RBAC.can(session.role, 'alerts_ack');
  const sev = (s) => {
    const c = s === 'critical' ? 'var(--amber)' : s === 'warning' ? '#8a6d0b' : 'var(--muted)';
    const bg = s === 'critical' ? 'rgba(154,91,0,.10)' : s === 'warning' ? 'rgba(138,109,11,.10)' : 'var(--panel)';
    return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${c};background:${bg}">${esc(s)}</span>`;
  };
  const ago = (iso) => {
    if (!iso) return 'never';
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  };

  const stopped = st.jobs.filter((j) => j.overdue || j.neverRun);
  const open = st.alerts.filter((a) => !a.ack);
  const acked = st.alerts.filter((a) => a.ack);

  const row = (a) => `
    <tr${a.ack ? ' style="opacity:.6"' : ''}>
      <td style="white-space:nowrap">${sev(a.severity)}</td>
      <td>
        <div style="font-size:13px;font-weight:600;color:var(--navy)">${esc(a.title)}</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:2px">${esc(a.detail)}</div>
        ${a.ack ? `<div style="font-size:11.5px;color:var(--teal);margin-top:4px">Acknowledged by ${esc(a.ack.by)} at ${esc(a.ack.at)}${a.ack.note ? ` — ${esc(a.ack.note)}` : ''}</div>` : ''}
      </td>
      <td style="font-size:11.5px;color:var(--muted);white-space:nowrap">${esc(a.jobLabel)}<br>first seen ${esc(ago(a.firstSeen))}</td>
      <td style="white-space:nowrap">
        ${a.where ? `<a href="${esc(a.where.startsWith('/accounts') || a.where.startsWith('/portal') ? APP_URL + a.where : a.where)}" ${a.where.startsWith('/accounts') || a.where.startsWith('/portal') ? 'target="_blank" rel="noreferrer"' : ''} style="font-size:12.5px">Open →</a>` : ''}
        ${can ? `
          <form method="post" action="/alerts/ack" style="display:inline;margin-left:8px">
            <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
            <input type="hidden" name="id" value="${esc(a.id)}">
            ${a.ack ? '<input type="hidden" name="undo" value="1">' : ''}
            <button type="submit" class="secondary" style="font-size:12px;padding:4px 10px">${a.ack ? 'Re-open' : 'Acknowledge'}</button>
          </form>` : ''}
      </td>
    </tr>`;

  return page({
    title: 'Alerts',
    session,
    active: 'alerts',
    body: `
      <h1>Alerts</h1>
      <p class="sub">
        Six checks run on their own schedule so a problem reaches you instead of waiting to be found.
        ${st.running ? 'The scheduler is running in this process.' : 'The scheduler is NOT running in this process.'}
        Last pass ${esc(ago(st.lastTickAt))}.
      </p>
      ${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

      ${stopped.length ? `
        <div class="flash warn">
          <strong>${stopped.length} check(s) are not running on time.</strong>
          <p style="margin:6px 0 0;font-size:12.5px;line-height:1.7">
            An empty alert list looks exactly like a healthy book, so a stopped check is the one failure that hides
            itself. ${esc(stopped.map((j) => j.label + (j.neverRun ? ' (never run)' : ` (${j.overdueBy} min late)`)).join(', '))}.
          </p>
        </div>` : ''}

      <div class="card"><div class="grid">
        <div class="tile"><strong>${st.counts.critical}</strong><span>Critical</span></div>
        <div class="tile"><strong>${st.counts.warning}</strong><span>Warnings</span></div>
        <div class="tile"><strong>${st.counts.info}</strong><span>For information</span></div>
        <div class="tile"><strong>${st.counts.acknowledged}</strong><span>Acknowledged</span></div>
      </div></div>

      ${can ? `
        <form method="post" action="/alerts/run" class="bar" style="margin-bottom:16px">
          <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
          <button class="primary" type="submit">Run every check now</button>
          <span style="font-size:12.5px;color:var(--muted)">Takes a few seconds — the supplier check makes a real search.</span>
        </form>` : ''}

      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>Severity</th><th>What</th><th>Check</th><th></th></tr></thead>
          <tbody>
            ${open.length === 0
              ? `<tr><td colspan="4" style="padding:26px;text-align:center;color:var(--muted)">
                   Nothing open.${stopped.length ? ' Note the warning above — some checks are not running, so this may not mean much.' : ' Every check has run recently and found nothing.'}
                 </td></tr>`
              : open.map(row).join('')}
            ${acked.length ? `<tr><td colspan="4" style="padding:10px 14px;background:var(--panel);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Acknowledged</td></tr>${acked.map(row).join('')}` : ''}
          </tbody>
        </table>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--hair)">
          <h2 style="margin:0;font-size:13.5px;color:var(--navy)">The checks</h2>
          <p style="margin:3px 0 0;font-size:12px;color:var(--muted)">Each one says why it exists. A job two intervals late is not slow, it is stopped.</p>
        </div>
        <table>
          <thead><tr><th>Check</th><th>Every</th><th>Last completed</th><th>Found</th><th>State</th></tr></thead>
          <tbody>
            ${st.jobs.map((j) => `
              <tr>
                <td>
                  <div style="font-size:13px;font-weight:600;color:var(--navy)">${esc(j.label)}</div>
                  <div style="font-size:11.5px;color:var(--muted);line-height:1.6;max-width:520px">${esc(j.why)}</div>
                </td>
                <td class="tnum" style="white-space:nowrap">${j.everyMinutes < 60 ? `${j.everyMinutes} min` : `${Math.round(j.everyMinutes / 60)} h`}</td>
                <td class="tnum" style="white-space:nowrap;font-size:12px">${esc(ago(j.lastRunAt))}${j.elapsedMs !== null ? `<div style="color:var(--muted)">${j.elapsedMs} ms</div>` : ''}</td>
                <td class="tnum">${j.raised === null ? '—' : j.raised}</td>
                <td style="white-space:nowrap">${
                  j.neverRun ? '<span style="color:var(--amber);font-weight:600">never run</span>'
                  : j.error ? `<span style="color:var(--amber);font-weight:600">failed</span><div style="font-size:11px;color:var(--muted);max-width:280px">${esc(String(j.error).slice(0, 120))}</div>`
                  : j.overdue ? `<span style="color:var(--amber);font-weight:600">${j.overdueBy} min late</span>`
                  : '<span style="color:var(--teal);font-weight:600">on time</span>'
                }</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
  });
}

/**
 * Your own account: who the portal thinks you are, what that lets you do, and
 * the one form every role needs and none of them had.
 */
function accountView(session, flash, errors) {
  const roleKey = RBAC.normaliseRole(session.role);
  const def = RBAC.ROLES[roleKey] || { label: session.role, summary: '', caps: [] };

  return page({
    title: 'Your account',
    session,
    active: 'account',
    body: `
      <h1>Your account</h1>
      <p class="sub">Signed in as <strong>${esc(session.email)}</strong> — ${esc(def.label)}. ${esc(def.summary)}</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      ${errors && errors.length ? `<div class="flash warn"><strong>Not changed:</strong><ul style="margin:6px 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}

      <div class="card">
        <h2 style="margin:0 0 10px;font-size:13.5px;color:var(--navy)">What this role can do</h2>
        <div style="font-size:12.5px;line-height:1.9;color:var(--muted)">
          ${def.caps.map((c) => `<div><span style="color:var(--teal)">✓</span> ${esc(RBAC.CAPS[c] || c)}</div>`).join('')}
        </div>
        <p style="margin:12px 0 0;font-size:12px;color:var(--muted)">
          These are checked on every request before any handler runs, so a screen you cannot see is also a URL you
          cannot post to.
        </p>
      </div>

      <form method="post" action="/account/password">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="card">
          <h2 style="margin:0 0 6px;font-size:13.5px;color:var(--navy)">Change your password</h2>
          <p style="margin:0 0 14px;font-size:12.5px;color:var(--muted);line-height:1.7">
            The current password is asked for even though you are already signed in — that is what stops somebody
            who found an unlocked laptop from taking the account over. Saving will
            <strong>end every other session signed in as you</strong>, including one left open on another machine.
          </p>
          <label class="row"><span class="lab">Current password</span>
            <input type="password" name="current" autocomplete="current-password" required></label>
          <label class="row"><span class="lab">New password <em>at least 12 characters</em></span>
            <input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
          <label class="row"><span class="lab">New password again</span>
            <input type="password" name="again" autocomplete="new-password" minlength="12" required></label>
          <div class="bar"><button class="primary" type="submit">Change password</button></div>
        </div>
      </form>`
  });
}

/* ------------------------------------------------------ design / theme views */

/** Curated palettes. Values are R G B triplets to match the CSS variables. */
const PALETTES = [
  { name: 'Softifybd Navy & Teal', primary: '15 111 115', primaryHover: '11 90 94', navy: '19 41 75', navyDeep: '11 26 51', accentLight: '79 196 201' },
  { name: 'Emerald & Forest', primary: '13 155 122', primaryHover: '10 165 104', navy: '17 45 38', navyDeep: '9 28 24', accentLight: '110 231 183' },
  { name: 'Ocean Breeze', primary: '14 116 178', primaryHover: '11 94 145', navy: '16 42 66', navyDeep: '8 24 40', accentLight: '103 190 235' },
  { name: 'Royal Violet', primary: '109 74 191', primaryHover: '88 58 158', navy: '35 27 66', navyDeep: '20 15 40', accentLight: '176 148 246' },
  { name: 'Sunset Amber', primary: '193 106 22', primaryHover: '160 86 16', navy: '58 38 20', navyDeep: '33 21 11', accentLight: '250 190 106' },
  { name: 'Crimson & Slate', primary: '190 45 62', primaryHover: '158 34 50', navy: '32 38 48', navyDeep: '18 22 30', accentLight: '248 137 148' }
];

const FONTS = ['Inter', 'Plus Jakarta Sans', 'Manrope', 'Poppins', 'DM Sans', 'Source Sans 3', 'Roboto', 'Lato', 'Work Sans', 'Playfair Display'];

const rgbToHex = (t) => {
  const p = String(t || '').trim().split(/\s+/).map(Number);
  if (p.length !== 3 || p.some((n) => Number.isNaN(n))) return '#000000';
  return '#' + p.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
};
const hexToRgb = (h) => {
  const m = String(h || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

function previewPane(session, device) {
  const w = device === 'mobile' ? 390 : device === 'tablet' ? 820 : 1280;
  const label = device === 'mobile' ? 'Mobile 390px' : device === 'tablet' ? 'Tablet 820px' : 'Desktop 1280px';
  const btn = (d, text) =>
    `<a href="?device=${d}" style="padding:6px 13px;border-radius:7px;font-size:12.5px;text-decoration:none;${
      device === d ? 'background:var(--teal);color:#fff' : 'background:var(--panel);color:var(--navy)'
    }">${text}</a>`;

  return `
    <div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;gap:9px;padding:12px 16px;border-bottom:1px solid var(--hair);flex-wrap:wrap">
        <strong style="font-size:13px;color:var(--navy)">Live preview</strong>
        <span style="font-size:11.5px;color:var(--muted)">${esc(label)} · reloads on save</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          ${btn('desktop', 'Desktop')}${btn('tablet', 'Tablet')}${btn('mobile', 'Mobile')}
        </span>
        <a class="secondary" href="${esc(PORTAL_URL)}" target="_blank" rel="noreferrer">Open ↗</a>
      </div>
      <div style="background:var(--panel);padding:18px;display:flex;justify-content:center">
        <div style="width:100%;max-width:${w}px;border:1px solid var(--hair);border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 10px 30px -18px rgba(19,41,75,.5)">
          <iframe src="${esc(PORTAL_URL)}?preview=${Date.now()}" title="storefront preview"
            style="width:100%;height:640px;border:0;display:block"></iframe>
        </div>
      </div>
    </div>`;
}

/**
 * Show and hide header menu entries, including the columns inside a mega menu.
 *
 * A toggle here removes the entry from the desktop bar, the mega panel and the
 * mobile strip at once, because the storefront filters the menu in one place
 * before rendering any of the three. Half-disabling a link is worse than not
 * offering the switch.
 *
 * A mega entry whose children are all switched off stops being a dropdown and
 * goes back to being an ordinary link — an empty panel reads as broken.
 */
/**
 * Show / hide the modules of the panel our own staff and the agency's staff use.
 *
 * Distinct from the storefront toggles above it, and the difference is the whole
 * reason this exists: those hide a link and leave the URL answering 200. These
 * hide the link AND make the route 404, so "off" means off for a bookmark, a
 * search engine and a guessed path too.
 */
function panelMenuManager(session, content) {
  const state = content.panel || {};
  const groups = ['accounts', 'dashboard'];

  const row = (m, first) => {
    const on = isModuleOn(m, state);
    return `
      <div style="display:flex;align-items:center;gap:16px;padding:14px 18px;${first ? '' : 'border-top:1px solid var(--hair)'}">
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:600;color:var(--navy)">
            ${esc(m.label)}
            <code style="margin-left:8px;font-size:11.5px;font-weight:400;color:var(--muted)">${esc(m.href)}</code>
            ${m.locked ? '<span style="margin-left:8px;font-size:11px;color:var(--muted)">always on</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(m.note)}</div>
        </div>
        ${m.locked
          ? `<span style="flex:none;width:46px;height:26px;border-radius:26px;background:#E6EBF0;position:relative">
               <span style="position:absolute;top:3px;left:23px;width:20px;height:20px;border-radius:50%;background:#fff"></span>
             </span>`
          : `<label style="position:relative;display:inline-block;width:46px;height:26px;flex:none;cursor:pointer">
               <input type="checkbox" name="mod_${esc(m.group)}_${esc(m.key)}" ${on ? 'checked' : ''}
                 style="opacity:0;width:0;height:0;position:absolute" onchange="this.form.requestSubmit()">
               <span style="position:absolute;inset:0;border-radius:26px;transition:.2s;background:${on ? 'var(--teal)' : '#CBD5DD'}"></span>
               <span style="position:absolute;top:3px;left:${on ? '23px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s"></span>
             </label>`}
      </div>`;
  };

  return `
    <form method="post" action="/design/panel">
      <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
      <div class="card" style="padding:0;overflow:hidden;margin-top:16px">
        <div style="padding:14px 18px;border-bottom:1px solid var(--hair)">
          <h2 style="margin:0;font-size:14px;color:var(--navy)">Panel modules — show / hide</h2>
          <p style="margin:3px 0 0;font-size:12px;color:var(--muted)">
            Which parts of the internal panel this installation gets. Switching one off removes it from every menu
            <strong>and makes its routes answer 404</strong> — unlike the storefront toggles above, a saved link will
            not get past it. This is separate from user roles: a module that is off is gone for everybody, including a
            Super Admin, and roles still decide who sees what among the ones that are on.
          </p>
        </div>
        ${groups.map((g) => {
          const mods = PANEL_MODULES.filter((m) => m.group === g);
          const live = mods.filter((m) => isModuleOn(m, state)).length;
          return `
            <div style="padding:9px 18px;background:var(--panel);border-top:1px solid var(--hair);display:flex;align-items:center;gap:10px">
              <strong style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">
                ${esc(PANEL_GROUP_LABEL[g])}
              </strong>
              <span style="margin-left:auto;font-size:11.5px;color:var(--muted)">${live} of ${mods.length} on</span>
            </div>
            ${mods.map((m, i) => row(m, i === 0)).join('')}`;
        }).join('')}
        <div class="bar" style="padding:14px 18px">
          <button class="primary" type="submit">Save panel modules</button>
          <span style="margin-left:auto;font-size:12px;color:var(--muted)">
            Takes effect on the next page load in the app — no restart
          </span>
        </div>
      </div>
    </form>`;
}

function menuManager(session, content) {
  const nav = content.nav || [];
  const toggle = (name, on) => `
    <label style="position:relative;display:inline-block;width:46px;height:26px;flex:none;cursor:pointer">
      <input type="checkbox" name="${esc(name)}" ${on ? 'checked' : ''}
        style="opacity:0;width:0;height:0;position:absolute" onchange="this.form.requestSubmit()">
      <span style="position:absolute;inset:0;border-radius:26px;transition:.2s;background:${on ? 'var(--teal)' : '#CBD5DD'}"></span>
      <span style="position:absolute;top:3px;left:${on ? '23px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s"></span>
    </label>`;

  const rows = nav.map((item, i) => {
    const on = item.enabled !== false;
    const groups = item.groups || [];
    const liveChildren = groups.reduce((t, g) => t + g.links.filter((l) => l.enabled !== false).length, 0);
    const kind = groups.length
      ? `<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;background:var(--panel);color:var(--navy)">MEGA · ${liveChildren} of ${groups.reduce((t, g) => t + g.links.length, 0)} links</span>`
      : `<span style="font-size:11px;color:var(--muted)">plain link</span>`;

    const children = groups.map((g, gi) => `
      <div style="margin-top:10px">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">${esc(g.title)}</div>
        ${g.links.map((l, li) => `
          <div style="display:flex;align-items:center;gap:12px;padding:6px 0 6px 2px">
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;color:var(--navy)">${esc(l.label)}</div>
              <div style="font-size:11px;color:var(--muted)">${esc(l.href)}${l.note ? ' · ' + esc(l.note) : ''}</div>
            </div>
            ${toggle(`navlink_${i}_${gi}_${li}`, l.enabled !== false)}
          </div>`).join('')}
      </div>`).join('');

    return `
      <div style="padding:14px 18px;${i ? 'border-top:1px solid var(--hair)' : ''};${on ? '' : 'opacity:.55'}">
        <div style="display:flex;align-items:center;gap:16px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--navy)">${esc(item.label)} ${kind}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:1px">${esc(item.href)}</div>
          </div>
          ${toggle(`nav_${i}`, on)}
        </div>
        ${groups.length ? `<div style="margin-left:2px;padding-left:14px;border-left:2px solid var(--hair)">${children}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <form method="post" action="/design/menu" style="margin-top:18px">
      <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--hair)">
          <h2 style="margin:0;font-size:14px;color:var(--navy)">Header menu &amp; mega menu — show / hide</h2>
          <p style="margin:3px 0 0;font-size:12px;color:var(--muted)">
            Switching an entry off removes it from the desktop bar, the mega panel and the mobile strip together.
            Labels, links and mega-menu columns are edited under <a href="/edit/nav">Navigation</a>.
          </p>
        </div>
        ${rows || '<p class="empty" style="padding:18px">No menu entries yet.</p>'}
        <div class="bar" style="padding:14px 18px">
          <button class="primary" type="submit">Save menu</button>
          <span style="margin-left:auto;font-size:12px;color:var(--muted)">
            ${nav.filter((x) => x.enabled !== false).length} of ${nav.length} entries visible
          </span>
        </div>
      </div>
    </form>`;
}

function designView(session, content, tab, device, flash) {
  const theme = content.theme || {};
  const sections = (content.sections && content.sections.items) || [];

  const tabLink = (k, label) =>
    `<a href="/design?tab=${k}&device=${esc(device)}" style="padding:9px 16px;border-radius:8px;font-size:13px;text-decoration:none;${
      tab === k ? 'background:#fff;color:var(--navy);font-weight:600;box-shadow:0 1px 3px rgba(19,41,75,.12)' : 'color:var(--muted)'
    }">${label}</a>`;

  const swatch = (name, key) => `
    <label class="row" style="margin:0">
      <span class="lab">${esc(name)}</span>
      <span style="display:flex;gap:8px;align-items:center">
        <input type="color" name="hex_${esc(key)}" value="${esc(rgbToHex(theme[key]))}"
          style="width:44px;height:38px;padding:2px;border:1px solid var(--hair);border-radius:8px;background:#fff;cursor:pointer">
        <input type="text" name="rgb_${esc(key)}" value="${esc(theme[key] || '')}" placeholder="R G B"
          style="flex:1;font-family:ui-monospace,Consolas,monospace;font-size:12.5px">
      </span>
    </label>`;

  const sectionsBody = `
    <form method="post" action="/design/sections">
      <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--hair)">
          <h2 style="margin:0;font-size:14px;color:var(--navy)">Storefront sections — show / hide</h2>
          <p style="margin:3px 0 0;font-size:12px;color:var(--muted)">
            Toggle what appears on the storefront home page. Takes effect on the next page load.
          </p>
        </div>
        ${sections.map((s, i) => `
          <div style="display:flex;align-items:center;gap:16px;padding:14px 18px;${i ? 'border-top:1px solid var(--hair)' : ''}">
            <div style="flex:1;min-width:0">
              <div style="font-size:13.5px;font-weight:600;color:var(--navy)">${esc(s.label)}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:1px">${esc(s.note || '')}</div>
            </div>
            <label style="position:relative;display:inline-block;width:46px;height:26px;flex:none;cursor:pointer">
              <input type="checkbox" name="on_${esc(s.key)}" ${s.enabled ? 'checked' : ''}
                style="opacity:0;width:0;height:0;position:absolute" onchange="this.form.requestSubmit()">
              <span style="position:absolute;inset:0;border-radius:26px;transition:.2s;background:${s.enabled ? 'var(--teal)' : '#CBD5DD'}"></span>
              <span style="position:absolute;top:3px;left:${s.enabled ? '23px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s"></span>
            </label>
          </div>`).join('')}
        <div class="bar" style="padding:14px 18px">
          <button class="primary" type="submit">Save sections</button>
          <span style="margin-left:auto;font-size:12px;color:var(--muted)">
            ${sections.filter((s) => s.enabled).length} of ${sections.length} visible
          </span>
        </div>
      </div>
    </form>

    ${menuManager(session, content)}`;

  /**
   * The panel tab previews nothing, deliberately.
   *
   * The storefront preview iframe shows the public site, and switching an internal
   * module off changes nothing there. Showing the same unchanged iframe beside these
   * toggles would say "your change did nothing", which is the opposite of true.
   */
  const panelBody = panelMenuManager(session, content);

  /**
   * Closing a period, with what is inside it counted first.
   *
   * An operator who closes March without knowing there are eleven unpaid March
   * invoices in it has not closed a period, they have hidden a chase list. So the
   * counts come before the button, and the reopen path is the same form with the
   * field cleared — one place, one audit entry either way.
   */
  const lockBody = (() => {
    const book = readJson(path.join(CONTENT_DIR, 'accounting.json'), {});
    const through = book.lockedThrough || '';
    const upTo = (d) => Boolean(d) && String(d) <= through;
    const count = (k) => (book[k] || []).filter((r) => upTo(r.date)).length;
    const inside = through
      ? count('invoices') + count('receipts') + count('bills') + count('payments') + count('expenses')
      : 0;
    const unpaid = through
      ? (book.invoices || []).filter((i) => upTo(i.date) && i.status !== 'paid' && i.status !== 'cancelled').length
      : 0;
    const drafts = through
      ? (book.invoices || []).filter((i) => upTo(i.date) && i.status === 'draft').length
      : 0;

    return `
      <form method="post" action="/design/lock">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="card">
          <h2 style="margin:0 0 4px;font-size:14px;color:var(--navy)">Close a period</h2>
          <p style="margin:0 0 14px;font-size:12px;color:var(--muted);line-height:1.6">
            Everything dated on or before this closes to edits. Reports over a closed period still recompute — the
            arithmetic was never what was unsafe, the inputs were. Correcting a closed month is done with a dated
            adjustment in the open one, which is what leaves an audit trail.
          </p>
          <label class="row" style="margin:0 0 14px">
            <span class="lab">Closed through (YYYY-MM-DD, blank to reopen)</span>
            <input type="text" name="lockedThrough" value="${esc(through)}" placeholder="2026-07-31">
          </label>
          ${through ? `
            <div style="padding:12px 14px;border-left:3px solid var(--teal);background:var(--panel);font-size:12.5px;line-height:1.7">
              <strong style="color:var(--navy)">Inside the closed period:</strong>
              ${inside} voucher(s) · ${unpaid} invoice(s) still unpaid · ${drafts} still draft.
              ${unpaid ? '<br>Unpaid invoices in a closed period are still chased and still appear on statements — closing the period does not settle them.' : ''}
              ${drafts ? '<br><strong style="color:var(--navy)">A draft in a closed period can no longer be confirmed.</strong> Confirm or cancel them before closing, or reopen to deal with them.' : ''}
            </div>` : `
            <div style="padding:12px 14px;border-left:3px solid var(--hair);background:var(--panel);font-size:12.5px;color:var(--muted)">
              Nothing is closed. Every voucher in the book can be edited, which means a March figure can still change
              months after it was reported.
            </div>`}
          <div class="bar" style="margin-top:16px">
            <button class="primary" type="submit">${through ? 'Update the lock' : 'Close the period'}</button>
            <span style="margin-left:auto;font-size:12px;color:var(--muted)">Both closing and reopening are audited.</span>
          </div>
        </div>
      </form>`;
  })();

  const themeBody = `
    <form method="post" action="/design/theme">
      <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">

      <div class="card">
        <h2 style="margin:0 0 4px;font-size:14px;color:var(--navy)">Curated palettes</h2>
        <p style="margin:0 0 14px;font-size:12px;color:var(--muted)">Pick one, or set exact colours below.</p>
        <div class="grid">
          ${PALETTES.map((p) => `
            <button type="submit" name="palette" value="${esc(p.name)}" class="tile" style="text-align:left;cursor:pointer;border:${
              theme.preset === p.name ? '2px solid var(--teal)' : '1px solid var(--hair)'
            }">
              <strong style="font-size:13px">${esc(p.name)}</strong>
              <span style="display:flex;gap:6px;margin-top:9px">
                ${[p.navyDeep, p.navy, p.primary, p.accentLight].map((c) =>
                  `<i style="width:24px;height:24px;border-radius:6px;background:rgb(${esc(c)});display:inline-block"></i>`).join('')}
              </span>
            </button>`).join('')}
        </div>
      </div>

      <div class="card">
        <h2 style="margin:0 0 14px;font-size:14px;color:var(--navy)">Exact colours</h2>
        <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
          ${swatch('Primary (buttons, links)', 'primary')}
          ${swatch('Primary hover', 'primaryHover')}
          ${swatch('Navy (headings)', 'navy')}
          ${swatch('Navy deep (hero, footer)', 'navyDeep')}
          ${swatch('Accent light', 'accentLight')}
        </div>
        <p style="margin:12px 0 0;font-size:12px;color:var(--muted)">
          Use the picker or type an <code>R G B</code> triplet. The picker wins if you change both.
        </p>
      </div>

      <div class="card">
        <h2 style="margin:0 0 14px;font-size:14px;color:var(--navy)">Typography</h2>
        <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
          <label class="row" style="margin:0"><span class="lab">Heading font</span>
            <select name="headingFont">${FONTS.map((f) =>
              `<option value="${esc(f)}"${theme.headingFont === f ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
          <label class="row" style="margin:0"><span class="lab">Body font</span>
            <select name="bodyFont">${FONTS.map((f) =>
              `<option value="${esc(f)}"${theme.bodyFont === f ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        </div>
        <p style="margin:12px 0 0;font-size:12px;color:var(--muted)">
          Loaded from Google Fonts at render time, so the storefront needs an internet connection for anything
          other than the system default.
        </p>
      </div>

      <div class="bar">
        <button class="primary" type="submit">Save theme</button>
        <button class="secondary" type="submit" name="palette" value="Softifybd Navy &amp; Teal">Reset to default</button>
      </div>
    </form>`;

  return page({
    title: 'Design',
    session,
    active: 'design',
    body: `
      <h1>Design &amp; layout</h1>
      <p class="sub">Sections, colours and fonts for the B2C storefront — with the storefront itself beside you.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

      <div style="display:flex;gap:6px;background:var(--panel);padding:6px;border-radius:11px;margin-bottom:16px;flex-wrap:wrap">
        ${tabLink('sections', 'Storefront sections')}${tabLink('panel', 'Panel modules')}${tabLink('lock', 'Close a period')}${tabLink('theme', 'Theme &amp; colours')}
      </div>

      <div style="display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);align-items:start">
        <div>${tab === 'theme' ? themeBody : tab === 'panel' ? panelBody : tab === 'lock' ? lockBody : sectionsBody}</div>
        <div style="position:sticky;top:20px">${tab === 'panel'
          ? `<div class="card"><h2 style="margin:0 0 6px;font-size:14px;color:var(--navy)">Where to see this</h2>
               <p style="margin:0;font-size:12.5px;color:var(--muted);line-height:1.6">
                 These toggles change the internal panel, not the public storefront, so the storefront preview is
                 hidden here — it would show an unchanged page and imply the change did nothing.
               </p>
               <p style="margin:10px 0 0;font-size:12.5px;color:var(--muted);line-height:1.6">
                 Open <a href="${esc(APP_URL)}/accounts" target="_blank" rel="noreferrer">Travel Accounts</a> or
                 <a href="${esc(APP_URL)}/" target="_blank" rel="noreferrer">Market Intelligence</a> after saving. A
                 module switched off disappears from the header and the landing tiles, and its own URL answers 404.
               </p></div>`
          : previewPane(session, device)}</div>
      </div>

      <style>
        @media (max-width: 1100px) {
          h1 + .sub + div + div { grid-template-columns: 1fr !important; }
        }
      </style>`
  });
}

/* --------------------------------------------------------- integrations view */

function integrationsView(session, flash, testResult) {
  const rows = [
    ['GDS_BASE_URL', process.env.GDS_BASE_URL, 'Regional endpoint host'],
    ['GDS_USERNAME', process.env.GDS_USERNAME, 'Must carry the "Universal API/" prefix'],
    ['GDS_PASSWORD', process.env.GDS_PASSWORD, 'Never displayed'],
    ['GDS_SEARCH_PATH', process.env.GDS_SEARCH_PATH, 'LowFareSearch service path'],
    ['GDS_PNR_PATH', process.env.GDS_PNR_PATH, 'UniversalRecord service path'],
    ['GDS_SOAP_ACTION', process.env.GDS_SOAP_ACTION, 'Empty string is correct for uAPI'],
    ['GDS_TIMEOUT_MS', process.env.GDS_TIMEOUT_MS, 'Request timeout']
  ];

  const dot = (ok) =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ok ? 'var(--teal)' : '#CBD5DD'}"></span>`;

  return page({
    title: 'Integrations',
    session,
    active: 'integrations',
    body: `
      <h1>API integrations</h1>
      <p class="sub">Suppliers wired into the platform. Credentials live in <code>.env</code>, which is gitignored — this screen reads their status, never their values.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

      <div class="card">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0;font-size:15px;color:var(--navy)">Travelport uAPI</h2>
          <span style="padding:3px 10px;border-radius:20px;font-size:11.5px;background:${
            process.env.GDS_USERNAME ? 'rgba(15,111,115,.12);color:var(--teal)' : 'var(--panel);color:var(--muted)'
          }">${process.env.GDS_USERNAME ? 'configured' : 'not configured'}</span>
          <span style="font-size:12px;color:var(--muted)">SOAP 1.1 · air_v52_0 / universal_v52_0</span>
          <form method="post" action="/integrations/test" style="margin-left:auto">
            <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
            <button class="primary" type="submit">Test connection</button>
          </form>
        </div>

        <table style="margin-top:16px">
          <thead><tr><th style="width:20px"></th><th>Variable</th><th>Value</th><th>Meaning</th></tr></thead>
          <tbody>
            ${rows.map(([k, v, note]) => `<tr>
              <td>${dot(Boolean(v))}</td>
              <td class="tnum" style="font-weight:600;color:var(--navy)">${esc(k)}</td>
              <td class="tnum" style="color:var(--muted)">${
                k === 'GDS_PASSWORD' ? (v ? '•••••••• set' : 'not set')
                : v ? esc(String(v).length > 54 ? String(v).slice(0, 54) + '…' : v) : '—'
              }</td>
              <td style="font-size:12.5px">${esc(note)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      ${testResult ? `
      <div class="card" style="border-left:4px solid ${testResult.ok ? 'var(--teal)' : 'var(--amber)'}">
        <h2 style="margin:0 0 10px;font-size:14px;color:var(--navy)">
          ${testResult.ok ? 'Travelport answered' : 'Travelport did not return fares'}
        </h2>
        <table>
          <tbody>
            <tr><td style="width:170px;font-weight:600">HTTP status</td><td class="tnum">${esc(testResult.status)}</td></tr>
            <tr><td style="font-weight:600">Round trip</td><td class="tnum">${esc(testResult.ms)} ms</td></tr>
            <tr><td style="font-weight:600">Endpoint</td><td class="tnum">${esc(testResult.host || '—')}</td></tr>
            <tr><td style="font-weight:600">Priced itineraries</td><td class="tnum">${esc(testResult.offers)}</td></tr>
            ${testResult.cheapest ? `<tr><td style="font-weight:600">Cheapest</td><td class="tnum">${esc(testResult.cheapest)}</td></tr>` : ''}
            ${testResult.fault ? `<tr><td style="font-weight:600;color:var(--amber)">Fault</td><td>${esc(testResult.fault)}</td></tr>` : ''}
          </tbody>
        </table>
        <p style="margin:12px 0 0;font-size:12px;color:var(--muted)">Test route: DAC → CGP, ${esc(testResult.date)}, 1 adult.</p>
      </div>` : ''}

      <div class="card">
        <h2 style="margin:0 0 10px;font-size:14px;color:var(--navy)">Not yet wired</h2>
        <table>
          <thead><tr><th>Supplier</th><th>Kind</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td><strong>Sabre</strong></td><td>GDS</td><td style="color:var(--muted)">no credentials issued</td></tr>
            <tr><td><strong>Flyhub</strong></td><td>Consolidator</td><td style="color:var(--muted)">out of scope — not being integrated</td></tr>
            <tr><td><strong>TRACCS</strong></td><td>Travel back-office / accounting</td><td style="color:var(--muted)">evaluation only</td></tr>
            <tr><td><strong>NuFlights</strong></td><td>Travel back-office / accounting</td><td style="color:var(--muted)">evaluation only</td></tr>
          </tbody>
        </table>
        <p style="margin:12px 0 0;font-size:12.5px;color:var(--muted)">
          The transport in <code>lib/gds.ts</code> is supplier-agnostic — host, path, method and body all come from
          the environment. Adding a supplier is a second block of variables and a response parser, not a rewrite.
        </p>
      </div>`
  });
}

/* --------------------------------------------------------------- CRM views */

const APP_EXPORT = (qs) => `${APP_URL}/api/crm/export?${qs}`;
/**
 * The zone every calendar date in the book is stamped in.
 *
 * Read from the book rather than hard-coded so an agency in another country can
 * change it in one place. Falls back to Dhaka, which is who this is for.
 */
function bookTimezone() {
  try {
    const c = bookFile().company;
    return (c && c.timezone) || clock.DEFAULT_ZONE;
  } catch {
    return clock.DEFAULT_ZONE;
  }
}

/** Dhaka's calendar date, not the server's. See admin/clock.js. */
const todayISO = () => clock.todayIn(bookTimezone());

const crmLeads = () => readJson(CRM_LEADS_FILE, []);
const crmUsers = () => readJson(CRM_USERS_FILE, []);
const crmActivities = () => readJson(CRM_ACTIVITIES_FILE, []);

const repName = (users, id) => (id && (users.find((u) => u.id === id) || {}).name) || 'Unassigned';

/** Same filter semantics as filterLeads() in lib/crm.ts. */
function crmFilter(leads, q) {
  const t = todayISO();
  let rows = leads;
  const term = String(q.q || '').trim().toLowerCase();
  if (term) {
    rows = rows.filter((l) =>
      [l.company, l.decision_maker, l.phone, l.mobile, l.email, l.lead_id, l.address, l.segment]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(term)));
  }
  if (q.priority) rows = rows.filter((l) => l.priority === q.priority);
  if (q.tier) rows = rows.filter((l) => l.tier === q.tier);
  if (q.city) rows = rows.filter((l) => l.city === q.city);
  if (q.status) rows = rows.filter((l) => l.call_status === q.status);
  if (q.disposition) rows = rows.filter((l) => l.disposition === q.disposition);
  if (q.assigned) rows = rows.filter((l) => (q.assigned === 'unassigned' ? !l.assigned_to : l.assigned_to === q.assigned));
  if (q.hasWebsite === 'yes') rows = rows.filter((l) => !!l.website);
  if (q.hasWebsite === 'no') rows = rows.filter((l) => !l.website);
  if (q.hasMobile === 'yes') rows = rows.filter((l) => !!l.mobile);
  if (q.hasMobile === 'no') rows = rows.filter((l) => !l.mobile);

  if (q.view === 'due_today') rows = rows.filter((l) => l.next_action_date && l.next_action_date <= t && !CRM.CLOSED.has(l.call_status));
  if (q.view === 'untouched') rows = rows.filter((l) => l.call_status === 'not_started');
  if (q.view === 'no_next_action') rows = rows.filter((l) => l.disposition && !l.next_action && !CRM.CLOSED.has(l.call_status));
  if (q.view === 'p1_queue') rows = rows.filter((l) => l.priority === 'P1' && !CRM.CLOSED.has(l.call_status));
  if (q.view === 'hot') rows = rows.filter((l) => l.disposition === 'interested_hot' || String(l.interest_level) === '5');
  return rows;
}

const PRI_CHIP = {
  P1: 'background:var(--navy);color:#fff',
  P2: 'background:var(--teal);color:#fff',
  P3: 'background:var(--panel);color:var(--muted);border:1px solid var(--hair)',
  P4: 'background:var(--panel);color:var(--muted);border:1px solid var(--hair)',
  P5: 'background:rgba(154,91,0,.12);color:var(--amber)'
};

function priChip(p) {
  return `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10.5px;font-weight:700;${PRI_CHIP[p] || ''}">${esc(p)}</span>`;
}

function statusChip(s) {
  const tone = s === 'won' ? 'background:rgba(15,111,115,.12);color:var(--teal)'
    : s === 'lost' || s === 'do_not_call' ? 'background:var(--panel);color:var(--muted)'
    : s === 'not_started' ? 'background:var(--panel);color:var(--muted)'
    : 'background:rgba(19,41,75,.07);color:var(--navy)';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;${tone}">${esc(vocabLabel('CALL_STATUS', s))}</span>`;
}

const PAGE = 50;

function crmListView(session, all, users, q, flash) {
  const rows = crmFilter(all, q);
  const pageNo = Math.max(1, Number(q.page) || 1);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const slice = rows.slice((pageNo - 1) * PAGE, pageNo * PAGE);

  const tiers = Array.from(new Set(all.map((l) => l.tier).filter(Boolean))).sort();
  const cities = Array.from(new Set(all.map((l) => l.city).filter(Boolean))).sort();

  const qsBase = (over) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, ...over })) if (v) p.set(k, v);
    return p.toString();
  };
  const opt = (list, sel, blank) =>
    [['', blank]].concat(list).map(([v, lab]) =>
      `<option value="${esc(v)}"${String(v) === String(sel || '') ? ' selected' : ''}>${esc(lab)}</option>`).join('');

  const exportQs = qsBase({ page: '' });

  return page({
    title: 'Lead list',
    session,
    active: 'crm',
    body: `
      <h1>Lead list</h1>
      <p class="sub">${all.length} researched prospects from TOAB, BAIRA, ATAB and the MoRA Hajj register. ${rows.length} match the current filter.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

      <div class="card" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)">Saved views</strong>
        ${CRM.SAVED_VIEWS.map((v) =>
          `<a href="/crm?${esc(qsBase({ view: v.key, page: '' }))}"
              style="padding:5px 11px;border-radius:20px;font-size:12.5px;text-decoration:none;${
                (q.view || '') === v.key ? 'background:var(--teal);color:#fff' : 'background:var(--panel);color:var(--navy)'
              }">${esc(v.label)}</a>`).join('')}
      </div>

      <form method="get" action="/crm" class="card" style="display:grid;gap:11px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:end">
        <input type="hidden" name="view" value="${esc(q.view || '')}">
        <label class="row" style="margin:0;grid-column:span 2"><span class="lab">Search</span>
          <input type="text" name="q" value="${esc(q.q || '')}" placeholder="company, owner, phone, email, lead id"></label>
        <label class="row" style="margin:0"><span class="lab">Priority</span>
          <select name="priority">${opt(['P1','P2','P3','P4','P5'].map((p) => [p, `${p} — ${CRM.PRIORITY_HINT[p]}`]), q.priority, 'All')}</select></label>
        <label class="row" style="margin:0"><span class="lab">City</span>
          <select name="city">${opt(cities.map((c) => [c, c]), q.city, 'All')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Tier</span>
          <select name="tier">${opt(tiers.map((t) => [t, t]), q.tier, 'All')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Call status</span>
          <select name="status">${opt(vocabOffered('CALL_STATUS'), q.status, 'All')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Disposition</span>
          <select name="disposition">${opt(vocabOffered('DISPOSITION'), q.disposition, 'All')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Assigned to</span>
          <select name="assigned">${opt([['unassigned', 'Unassigned']].concat(users.map((u) => [u.id, u.name])), q.assigned, 'Anyone')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Has website</span>
          <select name="hasWebsite">${opt([['yes','Yes'],['no','No — sales signal']], q.hasWebsite, 'Either')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Has mobile</span>
          <select name="hasMobile">${opt([['yes','Yes'],['no','No']], q.hasMobile, 'Either')}</select></label>
        <div style="display:flex;gap:8px">
          <button class="primary" type="submit">Filter</button>
          <a class="secondary" href="/crm">Reset</a>
        </div>
      </form>

      <div class="card" style="display:flex;gap:9px;flex-wrap:wrap;align-items:center">
        <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)">Download this list</strong>
        <a class="secondary" href="${esc(APP_EXPORT(exportQs + '&format=xlsx'))}">Excel .xlsx</a>
        <a class="secondary" href="${esc(APP_EXPORT(exportQs + '&format=docx'))}">Word .docx</a>
        <a class="secondary" href="${esc(APP_EXPORT(exportQs + '&format=md'))}">Markdown .md</a>
        <a class="secondary" href="${esc(APP_EXPORT(exportQs + '&format=csv'))}">CSV</a>
        <span style="font-size:12px;color:var(--muted)">Exports honour the filters above</span>
      </div>

      <form method="post" action="/crm/bulk-assign" class="card" style="padding:0;overflow:hidden">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <input type="hidden" name="back" value="${esc(qsBase({}))}">
        <table>
          <thead><tr>
            <th style="width:26px"></th><th>Lead</th><th>Pri</th><th>Company</th><th>Decision maker</th>
            <th>City</th><th>Mobile</th><th>Status</th><th>Next action</th><th>Owner</th>
          </tr></thead>
          <tbody>
          ${slice.length === 0
            ? '<tr><td colspan="10" style="padding:24px;color:var(--muted)">Nothing matches that filter.</td></tr>'
            : slice.map((l) => `<tr>
                <td><input type="checkbox" name="lead" value="${esc(l.lead_id)}"></td>
                <td class="tnum" style="white-space:nowrap"><a href="/crm/lead?id=${encodeURIComponent(l.lead_id)}">${esc(l.lead_id)}</a></td>
                <td>${priChip(l.priority)}</td>
                <td><strong>${esc(l.company)}</strong>${l.website ? '' : '<br><span style="font-size:11px;color:var(--teal)">no website</span>'}</td>
                <td style="font-size:12.5px">${esc(l.decision_maker || '—')}</td>
                <td>${esc(l.city || '—')}</td>
                <td class="tnum" style="font-size:12px;white-space:nowrap">${esc((l.mobile || l.phone || '—').slice(0, 26))}</td>
                <td>${statusChip(l.call_status)}</td>
                <td style="font-size:12px">${esc(l.next_action || '—')}${l.next_action_date ? `<br><span class="tnum" style="color:var(--muted)">${esc(l.next_action_date)}</span>` : ''}</td>
                <td style="font-size:12.5px">${esc(repName(users, l.assigned_to))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="bar" style="padding:14px 18px;flex-wrap:wrap">
          <select name="user_id" style="padding:9px 11px;border:1px solid var(--hair);border-radius:8px">
            <option value="">— assign selected to —</option>
            ${users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}
            <option value="__none__">Unassign</option>
          </select>
          <button class="primary" type="submit">Assign</button>
          <span style="margin-left:auto;font-size:12.5px;color:var(--muted)">
            ${slice.length} of ${rows.length} · page ${pageNo} of ${pages}
          </span>
          ${pageNo > 1 ? `<a class="secondary" href="/crm?${esc(qsBase({ page: pageNo - 1 }))}">← Prev</a>` : ''}
          ${pageNo < pages ? `<a class="secondary" href="/crm?${esc(qsBase({ page: pageNo + 1 }))}">Next →</a>` : ''}
        </div>
      </form>`
  });
}

function leadFormFields(lead, users) {
  const sel = (name, map, cur, blank) => `
    <label class="row"><span class="lab">${esc(name.replace(/_/g, ' '))}</span>
      <select name="${esc(name)}">
        ${blank ? `<option value=""${!cur ? ' selected' : ''}>${esc(blank)}</option>` : ''}
        ${Object.entries(map).map(([v, lab]) =>
          `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(lab)}</option>`).join('')}
      </select></label>`;

  return `
    <label class="row"><span class="lab">Assigned to</span>
      <select name="assigned_to">
        <option value=""${!lead.assigned_to ? ' selected' : ''}>Unassigned</option>
        ${users.map((u) => `<option value="${esc(u.id)}"${lead.assigned_to === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select></label>
    ${sel('call_status', Object.fromEntries(vocabOffered('CALL_STATUS')), lead.call_status, null)}
    <label class="row"><span class="lab">Last call date</span>
      <input type="date" name="last_call_date" value="${esc(lead.last_call_date || '')}"></label>
    ${sel('disposition', Object.fromEntries(vocabOffered('DISPOSITION')), lead.disposition, '— none yet —')}
    ${sel('interest_level', Object.fromEntries(vocabOffered('INTEREST')), lead.interest_level, '— not scored —')}
    ${sel('demo_scheduled', Object.fromEntries(vocabOffered('DEMO')), lead.demo_scheduled, '— n/a —')}
    <label class="row"><span class="lab">Next action</span>
      <input type="text" name="next_action" value="${esc(lead.next_action || '')}" placeholder="e.g. send pricing, call owner back"></label>
    <label class="row"><span class="lab">Next action date</span>
      <input type="date" name="next_action_date" value="${esc(lead.next_action_date || '')}"></label>
    <label class="row"><span class="lab">Do-not-call reason</span>
      <input type="text" name="do_not_call_reason" value="${esc(lead.do_not_call_reason || '')}" placeholder="required if status is Do not call"></label>
    <label class="row"><span class="lab">Notes — call notes and source corrections</span>
      <textarea name="notes" rows="5">${esc(lead.notes || '')}</textarea></label>`;
}

function crmLeadView(session, lead, users, activities, flash, errors) {
  const tel = CRM.telNumber(lead);
  const wa = CRM.waNumber(lead);
  const research = [
    ['Tier', lead.tier], ['Segment', lead.segment], ['Decision maker', lead.decision_maker],
    ['Address', `${lead.address}${lead.city ? ` — ${lead.city}` : ''}`],
    ['Phone', lead.phone], ['Mobile', lead.mobile], ['Email', lead.email],
    ['Website', lead.website], ['Facebook', lead.facebook],
    ['Licence ref', lead.licence_ref], ['Booking engine', lead.booking_engine],
    ['Why a prospect', lead.prospect_note], ['Source', lead.data_source]
  ];

  return page({
    title: lead.company,
    session,
    active: 'crm',
    body: `
      <h1>${esc(lead.company)}</h1>
      <p class="sub"><span class="tnum">${esc(lead.lead_id)}</span> · ${priChip(lead.priority)} ${statusChip(lead.call_status)}
        · <a href="/crm">back to list</a></p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      ${errors && errors.length ? `<div class="flash warn"><strong>Not saved:</strong><ul style="margin:6px 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}

      <div class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        ${tel ? `<a class="primary" style="text-decoration:none;padding:10px 18px" href="tel:${esc(tel)}">Call ${esc(tel)}</a>` : '<span style="color:var(--muted);font-size:13px">No dialable number in the source</span>'}
        ${wa ? `<a class="secondary" href="https://wa.me/${esc(wa)}" target="_blank" rel="noreferrer">WhatsApp</a>` : ''}
        ${lead.email ? `<a class="secondary" href="mailto:${esc(lead.email)}">Email</a>` : ''}
        ${lead.website ? `<a class="secondary" href="${esc(/^https?:/.test(lead.website) ? lead.website : 'https://' + lead.website)}" target="_blank" rel="noreferrer">Open website</a>` : ''}
        ${lead.source_url ? `<a class="secondary" href="${esc(String(lead.source_url).split(' ')[0])}" target="_blank" rel="noreferrer">Source record</a>` : ''}
      </div>

      <div style="display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="card">
          <h2 style="margin:0 0 4px;font-size:14px;color:var(--navy)">Research — verified, do not edit</h2>
          <p style="margin:0 0 14px;font-size:12px;color:var(--muted)">
            Reproduced verbatim from the source register, artefacts and all. Found something wrong? Write it in
            <strong>Notes</strong> — an admin corrects it centrally so the change is traceable.
          </p>
          <table style="font-size:12.5px">
            ${research.map(([k, v]) => `<tr>
              <td style="width:34%;font-weight:600;color:var(--navy);vertical-align:top">${esc(k)}</td>
              <td style="word-break:break-word">${esc(v || '—')}</td></tr>`).join('')}
          </table>
        </div>

        <div>
          <form method="post" action="/crm/lead?id=${encodeURIComponent(lead.lead_id)}" class="card">
            <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
            <h2 style="margin:0 0 12px;font-size:14px;color:var(--navy)">Sales fields</h2>
            ${leadFormFields(lead, users)}
            <button class="primary" type="submit" style="width:100%;margin-top:6px">Save</button>
          </form>

          <form method="post" action="/crm/activity?id=${encodeURIComponent(lead.lead_id)}" class="card">
            <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
            <h2 style="margin:0 0 12px;font-size:14px;color:var(--navy)">Log a touch</h2>
            <label class="row"><span class="lab">Type</span>
              <select name="activity_type">
                ${vocabOffered('ACTIVITY_TYPE').filter(([k]) => k !== 'status_change')
                  .map(([v, lab]) => `<option value="${esc(v)}">${esc(lab)}</option>`).join('')}
              </select></label>
            <label class="row"><span class="lab">Outcome</span>
              <input type="text" name="outcome" placeholder="e.g. spoke to owner, asked for pricing"></label>
            <label class="row"><span class="lab">What was said</span>
              <textarea name="body" rows="3"></textarea></label>
            <button class="primary" type="submit" style="width:100%">Log it</button>
          </form>
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--hair)">
          <h2 style="margin:0;font-size:14px;color:var(--navy)">Activity timeline</h2>
          <p style="margin:2px 0 0;font-size:12px;color:var(--muted)">${activities.length} entries, newest first. Never edited once written.</p>
        </div>
        ${activities.length === 0
          ? '<p class="empty" style="padding:22px">Nothing logged yet.</p>'
          : `<table><thead><tr><th>When</th><th>Type</th><th>By</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>
             ${activities.map((a) => `<tr>
               <td class="tnum" style="white-space:nowrap">${esc(String(a.occurred_at).slice(0, 16).replace('T', ' '))}</td>
               <td>${esc(vocabLabel('ACTIVITY_TYPE', a.activity_type))}</td>
               <td>${esc(repName(users, a.user_id))}</td>
               <td>${esc(a.outcome || '—')}</td>
               <td style="max-width:380px">${esc(a.body || '—')}</td></tr>`).join('')}
             </tbody></table>`}
      </div>`
  });
}

function crmDashboardView(session, leads, users, activities, flash) {
  const t = todayISO();
  const total = leads.length;
  const touched = leads.filter((l) => l.call_status !== 'not_started').length;
  const contacted = leads.filter((l) => CRM.CONTACTED.has(l.call_status)).length;
  const coverage = total ? (touched / total) * 100 : 0;
  const p1Untouched = leads.filter((l) => l.priority === 'P1' && l.call_status === 'not_started').length;
  const dueToday = leads.filter((l) => l.next_action_date && l.next_action_date <= t && !CRM.CLOSED.has(l.call_status));
  const abandoned = leads.filter((l) => l.disposition && !l.next_action && !CRM.CLOSED.has(l.call_status));
  const unassigned = leads.filter((l) => !l.assigned_to);

  const funnel = vocab().order.map((s) => ({ s, n: leads.filter((l) => l.call_status === s).length })).filter((r) => r.n > 0);
  const maxFunnel = Math.max(...funnel.map((r) => r.n), 1);

  const dispo = vocabOffered('DISPOSITION')
    .map(([k, lab]) => ({ k, lab, n: leads.filter((l) => l.disposition === k).length })).filter((r) => r.n > 0);

  const perRep = users.map((u) => {
    const mine = leads.filter((l) => l.assigned_to === u.id);
    return {
      u, assigned: mine.length,
      called: mine.filter((l) => l.call_status !== 'not_started').length,
      reached: mine.filter((l) => CRM.CONTACTED.has(l.call_status)).length,
      demos: mine.filter((l) => l.demo_scheduled === 'yes').length,
      hot: mine.filter((l) => l.disposition === 'interested_hot').length,
      won: mine.filter((l) => l.call_status === 'won').length,
      acts: activities.filter((a) => a.user_id === u.id).length
    };
  });

  const byTier = Array.from(new Set(leads.map((l) => l.tier))).map((tr) => {
    const rows = leads.filter((l) => l.tier === tr);
    return { tier: tr, total: rows.length, touched: rows.filter((l) => l.call_status !== 'not_started').length };
  }).sort((a, b) => b.total - a.total);

  const tile = (label, value, sub, tone) => `
    <div class="tile"><strong class="tnum" style="${tone === 'warn' ? 'color:var(--amber)' : tone === 'good' ? 'color:var(--teal)' : ''}">${esc(value)}</strong>
      <span>${esc(label)}</span>${sub ? `<span style="display:block;margin-top:2px;font-size:11.5px">${esc(sub)}</span>` : ''}</div>`;

  return page({
    title: 'Manager dashboard',
    session,
    active: 'crm-dash',
    body: `
      <h1>Manager dashboard</h1>
      <p class="sub">Who is calling whom, what came back, and where the pipeline is stuck.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

      <div class="card"><div class="grid">
        ${tile('Total prospects', String(total), 'TOAB · BAIRA · ATAB · MoRA')}
        ${tile('Coverage', coverage.toFixed(1) + '%', `${touched} worked at least once`, coverage > 20 ? 'good' : 'warn')}
        ${tile('Reached a human', String(contacted), 'gatekeeper or decision maker')}
        ${tile('P1 untouched', String(p1Untouched), 'call these first', p1Untouched > 0 ? 'warn' : 'good')}
        ${tile('Due today or overdue', String(dueToday.length), 'next action date has passed', dueToday.length ? 'warn' : 'good')}
        ${tile('Abandoned', String(abandoned.length), 'has a disposition, no next action', abandoned.length ? 'warn' : 'good')}
        ${tile('Unassigned', String(unassigned.length), 'nobody owns these', unassigned.length ? 'warn' : 'good')}
        ${tile('Activities logged', String(activities.length), 'calls, notes, status changes')}
      </div></div>

      <div class="card">
        <h2 style="margin:0 0 14px;font-size:14px;color:var(--navy)">Who is doing what</h2>
        <table>
          <thead><tr><th>Sales person</th><th>Role</th><th>Assigned</th><th>Called</th><th>Reached</th><th>Demos</th><th>Hot</th><th>Won</th><th>Activities</th></tr></thead>
          <tbody>${perRep.map((r) => `<tr>
            <td><strong>${esc(r.u.name)}</strong></td>
            <td style="color:var(--muted)">${esc(r.u.role)}</td>
            <td class="tnum">${r.assigned}</td><td class="tnum">${r.called}</td><td class="tnum">${r.reached}</td>
            <td class="tnum">${r.demos}</td><td class="tnum">${r.hot}</td><td class="tnum">${r.won}</td><td class="tnum">${r.acts}</td>
            </tr>`).join('')}</tbody>
        </table>
        ${unassigned.length ? `<p style="margin:12px 0 0;font-size:12.5px;color:var(--amber)">
          ${unassigned.length} leads have no owner. <a href="/crm?assigned=unassigned">Assign them →</a></p>` : ''}
      </div>

      <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
        <div class="card">
          <h2 style="margin:0 0 14px;font-size:14px;color:var(--navy)">Funnel by call status</h2>
          ${funnel.map((r) => `
            <div style="padding:6px 0">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
                <a href="/crm?status=${esc(r.s)}" style="color:var(--ink);text-decoration:none">${esc(vocabLabel('CALL_STATUS', r.s))}</a>
                <strong class="tnum">${r.n}</strong></div>
              <div style="height:6px;background:var(--panel);border-radius:20px">
                <div style="height:100%;width:${Math.max(2, (r.n / maxFunnel) * 100)}%;background:var(--teal);border-radius:20px"></div></div>
            </div>`).join('')}
        </div>

        <div class="card">
          <h2 style="margin:0 0 14px;font-size:14px;color:var(--navy)">What came back</h2>
          ${dispo.length === 0
            ? '<p style="font-size:13px;color:var(--muted)">No dispositions recorded yet — nobody has finished a qualifying call.</p>'
            : dispo.map((r) => `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid var(--hair)">
                <a href="/crm?disposition=${esc(r.k)}" style="color:var(--ink);text-decoration:none">${esc(r.lab)}</a>
                <strong class="tnum">${r.n}</strong></div>`).join('')}
        </div>
      </div>

      <div class="card">
        <h2 style="margin:0 0 14px;font-size:14px;color:var(--navy)">Progress by tier</h2>
        <table>
          <thead><tr><th>Tier</th><th>Total</th><th>Worked</th><th>Untouched</th><th style="width:180px">Coverage</th></tr></thead>
          <tbody>${byTier.map((r) => `<tr>
            <td>${esc(r.tier)}</td><td class="tnum">${r.total}</td><td class="tnum">${r.touched}</td>
            <td class="tnum">${r.total - r.touched}</td>
            <td><div style="height:6px;background:var(--panel);border-radius:20px">
              <div style="height:100%;width:${r.total ? Math.max(2, (r.touched / r.total) * 100) : 0}%;background:var(--teal);border-radius:20px"></div></div></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="card">
        <h2 style="margin:0 0 10px;font-size:14px;color:var(--navy)">Download the whole database</h2>
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          <a class="secondary" href="${esc(APP_EXPORT('format=xlsx'))}">Excel .xlsx — 5 sheets</a>
          <a class="secondary" href="${esc(APP_EXPORT('format=docx'))}">Word .docx — prospect brief</a>
          <a class="secondary" href="${esc(APP_EXPORT('format=md'))}">Markdown .md</a>
          <a class="secondary" href="${esc(APP_EXPORT('format=csv'))}">CSV</a>
        </div>
      </div>`
  });
}

function crmCallView(session, lead, users, activities, remaining, flash, errors) {
  if (!lead) {
    return page({
      title: 'Call mode',
      session,
      active: 'crm-call',
      body: `<h1>Call mode</h1><p class="sub">Nothing left in the queue.</p>
        <div class="card"><p style="margin:0;font-size:13.5px">Every open lead has been worked, or everything is
        closed. <a href="/crm">Open the lead list</a> to widen the filter.</p></div>`
    });
  }
  const tel = CRM.telNumber(lead);
  const wa = CRM.waNumber(lead);

  return page({
    title: 'Call mode',
    session,
    active: 'crm-call',
    body: `
      <h1>Call mode</h1>
      <p class="sub">${remaining} open leads in the queue · ordered by priority, then whatever is overdue.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      ${errors && errors.length ? `<div class="flash warn"><strong>Not saved:</strong><ul style="margin:6px 0 0 16px">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}

      <div class="card" style="border-left:4px solid var(--teal)">
        <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div style="font-size:12px;color:var(--muted)"><span class="tnum">${esc(lead.lead_id)}</span> · ${priChip(lead.priority)} · ${esc(lead.tier)}</div>
            <h2 style="margin:6px 0 2px;font-size:24px;color:var(--navy)">${esc(lead.company)}</h2>
            <div style="font-size:13.5px">${esc(lead.decision_maker || 'Decision maker not published')}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:3px">${esc(lead.address || '')}${lead.city ? ' — ' + esc(lead.city) : ''}</div>
          </div>
          <div style="text-align:right">
            <div class="tnum" style="font-size:19px;font-weight:700;color:var(--navy)">${esc(lead.mobile || lead.phone || 'no number')}</div>
            <div style="margin-top:8px;display:flex;gap:7px;justify-content:flex-end;flex-wrap:wrap">
              ${tel ? `<a class="primary" style="text-decoration:none;padding:9px 16px" href="tel:${esc(tel)}">Call</a>` : ''}
              ${wa ? `<a class="secondary" href="https://wa.me/${esc(wa)}" target="_blank" rel="noreferrer">WhatsApp</a>` : ''}
              ${lead.website ? `<a class="secondary" href="${esc(/^https?:/.test(lead.website) ? lead.website : 'https://' + lead.website)}" target="_blank" rel="noreferrer">Site</a>` : ''}
            </div>
          </div>
        </div>
        <div style="margin-top:14px;padding:12px 14px;background:var(--surface);border-radius:8px;font-size:13px">
          <strong style="color:var(--navy)">Why they are a prospect:</strong> ${esc(lead.prospect_note || '—')}
          ${lead.booking_engine ? `<br><strong style="color:var(--navy)">Their site today:</strong> ${esc(lead.booking_engine)}` : ''}
          ${lead.licence_ref ? `<br><strong style="color:var(--navy)">Licence:</strong> ${esc(lead.licence_ref)}` : ''}
        </div>
      </div>

      <div class="card" style="background:var(--navy9);color:#fff">
        <h2 style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--teal4)">Qualify in four questions</h2>
        <ol style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.9">
          <li>Mash e roughly koto ta booking hoy? <span style="color:rgba(255,255,255,.55)">— under 20–30, disqualify politely</span></li>
          <li>Ticket issue kivabe koren — nijer IATA, na onno agency er panel theke? <span style="color:rgba(255,255,255,.55)">— "onner panel" = core target</span></li>
          <li>Nijer booking website ba app ache? <span style="color:rgba(255,255,255,.55)">— "ache" = log who built it, move on</span></li>
          <li>Apnar under e sub-agent ache? Taderke kivabe manage koren? <span style="color:rgba(255,255,255,.55)">— "Excel e" = the B2B panel sells itself</span></li>
        </ol>
      </div>

      <form method="post" action="/crm/call" class="card">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <input type="hidden" name="lead_id" value="${esc(lead.lead_id)}">
        <h2 style="margin:0 0 12px;font-size:14px;color:var(--navy)">Log the outcome and move on</h2>
        <div style="display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
          ${leadFormFields(lead, users)}
        </div>
        <label class="row"><span class="lab">Add to the timeline (optional)</span>
          <input type="text" name="activity_body" placeholder="what they actually said"></label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="primary" type="submit" name="advance" value="1">Save and next lead →</button>
          <button class="secondary" type="submit" name="advance" value="">Save and stay</button>
          <a class="secondary" href="/crm/call?skip=${encodeURIComponent(lead.lead_id)}">Skip for now</a>
        </div>
      </form>

      ${activities.length ? `<div class="card" style="padding:0;overflow:hidden">
        <div style="padding:13px 18px;border-bottom:1px solid var(--hair)"><h2 style="margin:0;font-size:13.5px;color:var(--navy)">Previous touches</h2></div>
        <table><tbody>${activities.slice(0, 6).map((a) => `<tr>
          <td class="tnum" style="white-space:nowrap;width:130px">${esc(String(a.occurred_at).slice(0, 16).replace('T', ' '))}</td>
          <td>${esc(vocabLabel('ACTIVITY_TYPE', a.activity_type))}</td>
          <td>${esc(a.outcome || '')}</td><td>${esc(a.body || '')}</td></tr>`).join('')}</tbody></table>
      </div>` : ''}`
  });
}

/* ------------------------------------------------------------ agency views */

const PAGE_SIZE = 25;

function clusterOptions(rows) {
  return Array.from(new Set(rows.map((r) => r.clusterId).filter(Boolean))).sort();
}

function agencyListView(session, rows, q, flash) {
  const clusters = clusterOptions(rows);

  let filtered = rows;
  const term = (q.q || '').trim().toLowerCase();
  if (term) {
    filtered = filtered.filter((r) =>
      [r.name, r.address, r.phone, r.district, r.signal, r.id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term))
    );
  }
  if (q.priority) filtered = filtered.filter((r) => r.priority === q.priority);
  if (q.segment) filtered = filtered.filter((r) => r.segment === q.segment || r.segmentSecondary === q.segment);
  if (q.cluster) filtered = filtered.filter((r) => r.clusterId === q.cluster);

  const pageNo = Math.max(1, Number(q.page) || 1);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);

  const qs = (over) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, ...over })) if (v) p.set(k, v);
    return p.toString();
  };

  const opt = (list, sel) =>
    list.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v || 'All')}</option>`).join('');

  return page({
    title: 'Agency dataset',
    session,
    active: 'agencies',
    body: `
      <h1>Agency dataset</h1>
      <p class="sub">${rows.length} records in content/agencies.json. The dashboard, the agency database page and /api/agencies all read this file.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

      <form method="get" action="/agencies" class="card" style="display:flex;gap:11px;flex-wrap:wrap;align-items:flex-end">
        <label class="row" style="flex:2;min-width:220px;margin:0"><span class="lab">Search</span>
          <input type="text" name="q" value="${esc(q.q || '')}" placeholder="name, phone, address, signal"></label>
        <label class="row" style="margin:0"><span class="lab">Priority</span>
          <select name="priority">${opt(['', ...AGENCY.PRIORITIES], q.priority || '')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Segment</span>
          <select name="segment">${opt(['', ...AGENCY.SEGMENTS], q.segment || '')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Cluster</span>
          <select name="cluster">${opt(['', ...clusters], q.cluster || '')}</select></label>
        <button class="primary" type="submit">Filter</button>
        <a class="secondary" href="/agencies">Reset</a>
      </form>

      <form method="post" action="/agencies/new" style="margin-bottom:16px">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <button class="btn-add" type="submit">+ Add a new agency</button>
      </form>

      <div class="card" style="padding:0;overflow:hidden">
        <form method="post" action="/agencies/delete">
          <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
          <table>
            <thead><tr>
              <th>ID</th><th>Agency</th><th>Cluster / district</th><th>Pri</th><th>Seg</th>
              <th>Phone</th><th>Stage</th><th></th><th></th>
            </tr></thead>
            <tbody>
            ${
              slice.length === 0
                ? '<tr><td colspan="9" style="padding:22px;color:var(--muted)">Nothing matches that filter.</td></tr>'
                : slice
                    .map(
                      (r) => `<tr>
                <td class="tnum" style="white-space:nowrap">${esc(r.id)}</td>
                <td><strong>${esc(r.name)}</strong></td>
                <td>${esc(r.clusterId)}<br><span style="color:var(--muted)">${esc(r.district)}</span></td>
                <td><strong>${esc(r.priority)}</strong></td>
                <td>${esc(r.segment)}${r.segmentSecondary ? ' + ' + esc(r.segmentSecondary) : ''}</td>
                <td class="tnum" style="white-space:nowrap">${esc(r.phone || '—')}</td>
                <td>${esc(r.stage)}</td>
                <td><a href="/agencies/edit?id=${encodeURIComponent(r.id)}">Edit</a></td>
                <td><label class="del"><input type="checkbox" name="remove" value="${esc(r.id)}"> delete</label></td>
              </tr>`
                    )
                    .join('')
            }
            </tbody>
          </table>
          <div class="bar" style="padding:14px 18px">
            <button class="primary" type="submit">Delete selected</button>
            <span style="margin-left:auto;font-size:12.5px;color:var(--muted)">
              Showing ${slice.length} of ${filtered.length} matching · page ${pageNo} of ${pages}
            </span>
            ${pageNo > 1 ? `<a class="secondary" href="/agencies?${esc(qs({ page: pageNo - 1 }))}">← Prev</a>` : ''}
            ${pageNo < pages ? `<a class="secondary" href="/agencies?${esc(qs({ page: pageNo + 1 }))}">Next →</a>` : ''}
          </div>
        </form>
      </div>`
  });
}

function agencyEditView(session, rec, clusters, flash) {
  const field = (f) => {
    const v = rec[f.key];
    const id = 'f_' + f.key;
    const lab = `<span class="lab">${esc(f.label)}</span>`;

    if (f.readonly) {
      return `<label class="row">${lab}<input type="text" value="${esc(v ?? '')}" readonly
        style="background:var(--panel);color:var(--muted)"><input type="hidden" name="${esc(f.key)}" value="${esc(v ?? '')}"></label>`;
    }
    if (f.type === 'bool') {
      return `<label class="row check"><input type="checkbox" name="${esc(f.key)}" id="${id}"${v ? ' checked' : ''}>
        <span class="lab">${esc(f.label)}</span></label>`;
    }
    if (f.type === 'number') {
      return `<label class="row">${lab}<input type="number" step="any" name="${esc(f.key)}" id="${id}" value="${v === null || v === undefined ? '' : esc(v)}"></label>`;
    }
    if (f.type === 'textarea') {
      return `<label class="row">${lab}<textarea name="${esc(f.key)}" id="${id}" rows="3">${esc(v ?? '')}</textarea></label>`;
    }
    if (f.type === 'lines') {
      const arr = Array.isArray(v) ? v : [];
      return `<label class="row"><span class="lab">${esc(f.label)} <em>one per line</em></span>
        <textarea name="lines:${esc(f.key)}" rows="${Math.max(2, arr.length + 1)}">${esc(arr.join('\n'))}</textarea></label>`;
    }
    if (f.type === 'select' || f.type === 'cluster') {
      const options = f.type === 'cluster' ? clusters : f.options;
      const cur = v ?? '';
      return `<label class="row">${lab}<select name="${esc(f.key)}" id="${id}">
        ${options.map((o) => `<option value="${esc(o)}"${String(o) === String(cur) ? ' selected' : ''}>${esc(o === '' ? '— none —' : o)}</option>`).join('')}
      </select></label>`;
    }
    return `<label class="row">${lab}<input type="text" name="${esc(f.key)}" id="${id}" value="${esc(v ?? '')}"></label>`;
  };

  return page({
    title: rec.name || 'New agency',
    session,
    active: 'agencies',
    body: `
      <h1>${esc(rec.name || 'New agency')}</h1>
      <p class="sub"><span class="tnum">${esc(rec.id)}</span> · editing content/agencies.json</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      <form method="post" action="/agencies/edit?id=${encodeURIComponent(rec.id)}">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        ${AGENCY.GROUPS.map(
          (g) => `<fieldset class="obj"><legend>${esc(g.title)}</legend>
            <div style="display:grid;gap:0 16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
              ${g.fields.map(field).join('')}
            </div>
          </fieldset>`
        ).join('')}
        <div class="bar">
          <button class="primary" type="submit">Save agency</button>
          <a class="secondary" href="/agencies">Back to list</a>
        </div>
      </form>`
  });
}

/** Write a submitted agency form back onto a record, coercing by field type. */
function applyAgencyForm(rec, form) {
  for (const f of AGENCY.FIELDS) {
    if (f.readonly) continue;

    if (f.type === 'bool') {
      rec[f.key] = f.key in form;
      continue;
    }
    if (f.type === 'lines') {
      const raw = form[`lines:${f.key}`];
      const val = String(Array.isArray(raw) ? raw[raw.length - 1] : raw ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (val.length) rec[f.key] = val;
      else delete rec[f.key];
      continue;
    }

    if (!(f.key in form)) continue;
    const raw = form[f.key];
    const v = String(Array.isArray(raw) ? raw[raw.length - 1] : raw).trim();

    if (f.type === 'number') {
      if (v === '') rec[f.key] = null;
      else {
        const n = Number(v);
        rec[f.key] = Number.isFinite(n) ? n : null;
      }
      continue;
    }

    if (v === '' && f.nullable) {
      // segmentSecondary is optional rather than nullable — drop the key entirely
      if (f.key === 'segmentSecondary') delete rec[f.key];
      else rec[f.key] = null;
      continue;
    }
    rec[f.key] = v;
  }
  return rec;
}

/** AG-001, AG-002 … next free id. */
function nextAgencyId(rows) {
  let max = 0;
  for (const r of rows) {
    const m = /^AG-(\d+)$/.exec(String(r.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `AG-${String(max + 1).padStart(3, '0')}`;
}

function rawView(session, content, flash, error) {
  return page({
    title: 'Raw JSON',
    session,
    active: 'raw',
    body: `
      <h1>Raw JSON</h1>
      <p class="sub">Escape hatch. Invalid JSON is rejected and nothing is written.</p>
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      ${error ? `<div class="flash warn">${esc(error)}</div>` : ''}
      <form method="post" action="/raw">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="card">
          <label class="row"><span class="lab">content/site.json</span>
          <textarea name="json" rows="30" spellcheck="false" style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px">${esc(
            JSON.stringify(content, null, 2)
          )}</textarea></label>
        </div>
        <div class="bar"><button class="primary" type="submit">Save JSON</button>
        <a class="secondary" href="/dashboard">Cancel</a></div>
      </form>`
  });
}

/* -------------------------------------------------------------------- server */

function send(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers
  });
  res.end(html);
}

function redirect(res, location, cookie) {
  const headers = { location, 'cache-control': 'no-store' };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}

/**
 * The cap exists so a runaway request cannot eat memory, not to police document size.
 *
 * It was 2 MB, which was ample until the book gained imported bank statements. The raw
 * JSON editor posts the WHOLE book back through a form field, and form encoding roughly
 * triples JSON — every quote becomes %22, every brace %7B, every newline %0A — so a
 * 314 KB book arrives as a 2.1 MB body and was refused. Nothing was wrong with the book
 * or the request; the limit had simply been sized against a smaller product.
 *
 * 32 MB, because a year of statements for three accounts is roughly 1 MB of parsed lines
 * plus the original files kept beside them, and a limit that has to be revisited every
 * time the product grows is a limit that will be hit at the worst moment.
 */
const MAX_BODY = 32 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`Body too large — over ${Math.round(MAX_BODY / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** urlencoded body -> { field: value | value[] } */
function parseForm(raw) {
  const out = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  return out;
}

const seeded = seedUsersIfMissing();
let seedNotice = seeded;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const session = readSession(req.headers.cookie);
  const ip = req.socket.remoteAddress || 'local';

  try {
    /* ---- unauthenticated ---- */
    if (pathname === '/login' && req.method === 'GET') {
      if (session) return redirect(res, '/dashboard');
      return send(res, 200, loginView(null, seedNotice));
    }

    if (pathname === '/login' && req.method === 'POST') {
      if (tooManyAttempts(ip)) {
        return send(res, 429, loginView('Too many attempts. Wait 15 minutes.', null));
      }
      const form = parseForm(await readBody(req));
      const user = findUser(form.email);
      const ok = user && verifyPassword(String(form.password || ''), user.salt, user.hash);
      if (!ok) {
        noteAttempt(ip);
        return send(res, 401, loginView('Wrong email or password.', null));
      }
      attempts.delete(ip);
      seedNotice = null;
      return redirect(
        res,
        '/dashboard',
        sessionCookie(req, makeSession(user.email, user.tokenVersion))
      );
    }

    if (!session) return redirect(res, '/login');

    /* ---- role guard ----
       Enforced here, before any handler runs, so hiding a sidebar link is a
       convenience and this is the actual control. Unmapped routes are
       super-admin only by design. */
    {
      const verdict = RBAC.check(session.role, pathname, req.method, url.searchParams.get('col'));
      if (!verdict.ok) return send(res, 403, forbiddenView(session, verdict, pathname));
    }

    /* ---- authenticated ---- */
    // Every POST handler below verifies form.csrf against csrfFor(session)
    // after parsing its own body.

    if (pathname === '/' || pathname === '/dashboard') {
      const content = readJson(SITE_FILE, {});
      const leads = readJson(LEADS_FILE, []);
      const agencies = readJson(AGENCIES_FILE, []);
      return send(
        res,
        200,
        dashboardView(session, content, leads.length, agencies.length, url.searchParams.get('saved') ? 'Saved.' : null)
      );
    }

    if (pathname === '/logout' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      return redirect(res, '/login', `ota_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag(req)}`);
    }

    if (pathname === '/leads' && req.method === 'GET') {
      return send(res, 200, leadsView(session, readJson(LEADS_FILE, []), url.searchParams.get('saved') ? 'Updated.' : null));
    }

    if (pathname === '/leads/delete' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const remove = new Set([].concat(form.remove ?? []));
      const leads = readJson(LEADS_FILE, []).filter((l) => !remove.has(l.id));
      await writeJsonAtomic(LEADS_FILE, leads);
      return redirect(res, '/leads?saved=1');
    }

    /* ---- users & roles ---- */

    if (pathname === '/users' && req.method === 'GET') {
      const db = readJson(USERS_FILE, { users: [] });
      return send(res, 200, usersView(session, db.users, url.searchParams.get('saved') ? 'Saved.' : null, null, null));
    }

    if (pathname === '/users/role' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const db = readJson(USERS_FILE, { users: [] });
      const target = db.users.find((u) => u.email === String(form.email || '').toLowerCase());
      const role = String(form.role || '');
      if (!target || !RBAC.ROLES[role]) return redirect(res, '/users');
      // never let the last super admin demote themselves out of existence
      const supers = db.users.filter((u) => RBAC.normaliseRole(u.role) === 'super_admin');
      if (supers.length === 1 && supers[0].email === target.email && role !== 'super_admin') {
        return send(res, 422, usersView(session, db.users, null, ['That is the only Super Admin - promote someone else first, or nobody can manage users.'], null));
      }
      target.role = role;
      await writeJsonAtomic(USERS_FILE, db);
      return redirect(res, '/users?saved=1');
    }

    /**
     * Change your own password.
     *
     * There was no way to do this at all. The users screen said "to reset one,
     * remove the user and add them again" — which the last Super Admin cannot
     * do, because deleting them is refused so the portal can never lock everyone
     * out. So the one account that must be able to rotate its password was the
     * one account that could not.
     *
     * The current password is required even though the session already proves
     * who this is: it is what stops someone who walked up to an unlocked laptop
     * from taking the account over. Every other session for this user dies,
     * which is the point of a password change and is why tokenVersion exists.
     */
    if (pathname === '/account' && req.method === 'GET') {
      return send(res, 200, accountView(session, url.searchParams.get('pw') ? 'Password changed. Any other session signed in as you has been ended.' : null, null));
    }

    if (pathname === '/account/password' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const db = readJson(USERS_FILE, { users: [] });
      const me = db.users.find((u) => u.email === session.email);
      if (!me) return send(res, 404, page({ title: 'Not found', session, body: '<h1>Your account no longer exists</h1>' }));
      if (!me.email) return send(res, 500, page({ title: 'Error', session, body: '<h1>Account record is malformed</h1>' }));

      const current = String(form.current || '');
      const next = String(form.next || '');
      const again = String(form.again || '');
      const errors = [];

      if (!verifyPassword(current, me.salt, me.hash)) errors.push('That is not your current password.');
      if (next.length < 12) errors.push('A new password needs at least 12 characters. This account can move money.');
      if (next !== again) errors.push('The two new passwords do not match.');
      if (next && next === current) errors.push('The new password is the same as the old one.');
      if (errors.length) return send(res, 422, accountView(session, null, errors));

      const seeded = hashPassword(next);
      me.salt = seeded.salt;
      me.hash = seeded.hash;
      me.tokenVersion = Number(me.tokenVersion || 0) + 1;
      await writeJsonAtomic(USERS_FILE, db);
      await audit(session, 'update', {
        collection: 'users', id: me.email,
        summary: 'Changed their own password; every other session for this account was ended'
      });

      // This session has to be re-issued or the cookie we just invalidated
      // would log the person out of the change they just made.
      return redirect(res, '/account?pw=1', sessionCookie(req, makeSession(me.email, me.tokenVersion)));
    }

    /**
     * A Super Admin resetting somebody else's password.
     *
     * No current password, because the point is that nobody has it — someone has
     * left, or forgotten it. The new value is shown once and never stored in
     * readable form, and their existing sessions are ended immediately.
     */
    if (pathname === '/users/reset' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const db = readJson(USERS_FILE, { users: [] });
      const target = db.users.find((u) => u.email === String(form.email || '').trim().toLowerCase());
      if (!target) return send(res, 422, usersView(session, db.users, null, ['No account with that email address.'], null));
      if (target.email === session.email) {
        return send(res, 422, usersView(session, db.users, null,
          ['Use the change-password form for your own account — it asks for the current one on purpose.'], null));
      }

      const plain = String(form.password || '').trim() || crypto.randomBytes(12).toString('base64url');
      if (plain.length < 12) {
        return send(res, 422, usersView(session, db.users, null, ['A password needs at least 12 characters.'], null));
      }
      const seeded = hashPassword(plain);
      target.salt = seeded.salt;
      target.hash = seeded.hash;
      target.tokenVersion = Number(target.tokenVersion || 0) + 1;
      await writeJsonAtomic(USERS_FILE, db);
      await audit(session, 'update', {
        collection: 'users', id: target.email,
        summary: `Reset the password for ${target.email}; their existing sessions were ended`
      });
      return send(res, 200, usersView(session, db.users, `Password reset for ${target.email}. Give them this value now — it is not stored anywhere readable.`, null, plain));
    }

    if (pathname === '/users/new' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const db = readJson(USERS_FILE, { users: [] });
      const email = String(form.email || '').trim().toLowerCase();
      const role = String(form.role || '');
      const errors = [];
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) errors.push('Give a valid email address.');
      if (db.users.some((u) => u.email === email)) errors.push('That email already has an account.');
      if (!RBAC.ROLES[role]) errors.push('Pick a role.');
      if (errors.length) return send(res, 422, usersView(session, db.users, null, errors, null));

      const plain = String(form.password || '').trim() || crypto.randomBytes(9).toString('base64url');
      const seeded = hashPassword(plain);
      db.users.push({ email, name: String(form.name || '').trim() || email, role, salt: seeded.salt, hash: seeded.hash, tokenVersion: 0 });
      await writeJsonAtomic(USERS_FILE, db);
      return send(res, 200, usersView(session, db.users, 'User created.', null, plain));
    }

    if (pathname === '/users/delete' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const db = readJson(USERS_FILE, { users: [] });
      const email = String(form.email || '').toLowerCase();
      if (email === session.email) {
        return send(res, 422, usersView(session, db.users, null, ['You cannot remove your own account while signed in.'], null));
      }
      const kept = db.users.filter((u) => u.email !== email);
      if (!kept.some((u) => RBAC.normaliseRole(u.role) === 'super_admin')) {
        return send(res, 422, usersView(session, db.users, null, ['Removing that user would leave no Super Admin.'], null));
      }
      db.users = kept;
      await writeJsonAtomic(USERS_FILE, db);
      return redirect(res, '/users?saved=1');
    }

    /* ---- accounting records: full CRUD ---- */

    /* =================================================== journal vouchers ===
     *
     * A dedicated screen rather than another entry in the generic /books CRUD.
     *
     * The generic editor builds a form by copying the shape of the last record in a
     * collection, which works for a flat voucher and does not work here: a journal
     * voucher is a header plus an unbounded list of account/debit/credit lines, and
     * the one rule that makes it a journal voucher at all — debits equal credits —
     * has no expression in a per-field editor. A voucher that saves unbalanced is not
     * a voucher, so the validation has to be able to refuse the whole submission.
     *
     * The rules themselves live in lib/journal-rules.js, shared verbatim with the app
     * on :3002. Neither side gets its own opinion about what a valid voucher is.
     */

    /* ============================================ bank statements & reconciliation ===
     *
     * Import is a THREE-step flow — read, confirm, save — and the middle step is not
     * politeness. A statement is somebody else's record of your money, and the one way to
     * ruin it is a column mapped the wrong way round: every transaction keeps its amount
     * and reverses its direction, the totals stay plausible, and nothing says a word. The
     * preview shows what was read and checks it against the running balance the bank
     * itself printed before anything is written.
     */

    if (pathname === '/bank-statements' && req.method === 'GET') {
      return send(res, 200, bankStatementsView(session, url.searchParams));
    }

    if (pathname === '/bank-statements/preview' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const csv = String(form.csv || '');
      const bankId = String(form.bankId || '');
      if (!csv.trim()) return redirect(res, '/bank-statements?error=' + encodeURIComponent('Paste the statement, or choose the file.'));

      // A mapping only counts once the operator has actually seen the pickers, so it is
      // taken from the form when the form carried one and left to the suggester otherwise.
      const hasMapping = Object.keys(form).some((k) => k.indexOf('map_') === 0);
      const mapping = hasMapping
        ? {
            date: Number(form.map_date), description: Number(form.map_description),
            reference: Number(form.map_reference), debit: Number(form.map_debit),
            credit: Number(form.map_credit), amount: Number(form.map_amount),
            balance: Number(form.map_balance)
          }
        : null;

      const preview = BSTMT.preview(csv, mapping, form.dateFormat || null);
      return send(res, preview.error ? 422 : 200, bsPreviewView(session, {
        csv, bankId, from: form.from, to: form.to, dateFormat: form.dateFormat, preview
      }));
    }

    if (pathname === '/bank-statements/import' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const csv = String(form.csv || '');
      const bankId = String(form.bankId || '');
      const from = String(form.from || '').trim();
      const to = String(form.to || '').trim();
      const mapping = {
        date: Number(form.map_date), description: Number(form.map_description),
        reference: Number(form.map_reference), debit: Number(form.map_debit),
        credit: Number(form.map_credit), amount: Number(form.map_amount),
        balance: Number(form.map_balance)
      };
      const preview = BSTMT.preview(csv, mapping, form.dateFormat || null);

      if (preview.error || (preview.problems || []).length || !(preview.lines || []).length) {
        return send(res, 422, bsPreviewView(session, { csv, bankId, from, to, dateFormat: form.dateFormat, preview }));
      }
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(from) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(to)) {
        preview.error = 'Give the period the statement covers. It decides which book entries are compared, and guessing it from the lines would quietly exclude anything the bank has not shown yet.';
        return send(res, 422, bsPreviewView(session, { csv, bankId, from, to, dateFormat: form.dateFormat, preview }));
      }

      /**
       * Lines outside the stated period are refused rather than trimmed.
       *
       * Trimming looks helpful and hides the likeliest cause: the wrong period typed, or
       * the wrong file for this account. Either way the reconciliation that follows would
       * be built on a set nobody chose.
       */
      const stray = preview.lines.filter((l) => l.date < from || l.date > to);
      if (stray.length) {
        preview.error = `${stray.length} line(s) fall outside ${from} to ${to} — the first is ${stray[0].date}. Either the period is wrong or this is the wrong file; nothing is trimmed to make it fit.`;
        return send(res, 422, bsPreviewView(session, { csv, bankId, from, to, dateFormat: form.dateFormat, preview }));
      }

      const id = `BST-${bankId}-${from}`;
      let existed = false;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const rows = b.bankStatements || (b.bankStatements = []);
        existed = rows.some((s) => s.id === id);
        const keep = rows.filter((s) => s.id !== id);
        keep.push({
          id, bankId, from, to,
          openingBalance: preview.summary.openingPrinted,
          closingBalance: preview.summary.closingPrinted,
          balanceSource: 'file',
          dateFormat: preview.dateFormat,
          mapping: preview.mapping,
          lines: preview.lines,
          // A re-import starts clean: decisions were made about the OLD reading of the
          // file, and carrying them onto a new one would silently reattach a person's
          // judgement to lines they never saw.
          decisions: [],
          importedAt: new Date().toISOString(),
          importedBy: session.email,
          raw: csv
        });
        b.bankStatements = keep;
      });

      await audit(session, existed ? 'update' : 'create', {
        collection: 'bankStatements', id, label: `${bankId} ${from}..${to}`,
        summary: `${existed ? 'Re-imported' : 'Imported'} ${preview.lines.length} statement lines for ${bankId}, ${from} to ${to}${existed ? ' — previous hand-made matches were cleared' : ''}`
      });
      return redirect(res, '/bank-statements?saved=' + encodeURIComponent(`${preview.lines.length} lines imported.${existed ? ' This replaced an earlier import, so any matches decided by hand were cleared.' : ''}`));
    }

    if (pathname === '/bank-statements/decide' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const stId = String(form.statement || '');
      const line = Number(form.line);
      const movementId = String(form.movementId || '');

      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const st = (b.bankStatements || []).find((s) => s.id === stId);
        if (!st) return;
        st.decisions = (st.decisions || []).filter((d) => d.sourceLine !== line);
        // An empty choice REMOVES the decision rather than storing a blank one, so an
        // operator can always put a line back to undecided.
        if (movementId) {
          st.decisions.push({ sourceLine: line, movementId, decidedBy: session.email, decidedAt: new Date().toISOString() });
        }
      });
      await audit(session, 'update', {
        collection: 'bankStatements', id: stId, label: stId,
        summary: movementId
          ? `Matched statement line ${line} to ${movementId} by hand — the automatic pass had refused it as ambiguous`
          : `Put statement line ${line} back to undecided`
      });
      return redirect(res, '/bank-statements?saved=' + encodeURIComponent(movementId ? 'Matched by hand.' : 'Back to undecided.'));
    }


    if (pathname === '/bank-statements/classify' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const stId = String(form.statement || '');
      const line = Number(form.line);
      const as = String(form.as || '');

      /**
       * Saying a line is the bank's own is a JUDGEMENT, and it is recorded as one.
       *
       * The matcher can establish that nothing in the book fits. It cannot establish that
       * therefore the bank did this alone — a cheque from an unreconciled period, a deposit
       * the bank aggregated and an actual service charge all look identical to it. Both of
       * the first two were silently treated as charges before this existed, and the
       * adjustment draft offered to post money that was already in the book.
       */
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const st = (b.bankStatements || []).find((x) => x.id === stId);
        if (!st) return;
        st.classifications = (st.classifications || []).filter((c) => c.sourceLine !== line);
        if (as === 'bank_only') {
          st.classifications.push({ sourceLine: line, as: 'bank_only', by: session.email, at: new Date().toISOString() });
        }
      });
      await audit(session, 'update', {
        collection: 'bankStatements', id: stId, label: stId,
        summary: as === 'bank_only'
          ? `Declared statement line ${line} to be the bank's own item — it now enters the adjustment column and needs posting`
          : `Took back the classification of statement line ${line}`
      });
      return redirect(res, '/bank-statements?saved=' + encodeURIComponent(as === 'bank_only' ? 'Classified as the bank\'s own.' : 'Classification removed.'));
    }

    if (pathname === '/bank-statements/group' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const stId = String(form.statement || '');
      const line = Number(form.line);
      const ids = [].concat(form.movementId === undefined ? [] : form.movementId).filter(Boolean);

      // One line, several book entries. Stored as several decisions sharing a sourceLine;
      // the applier checks they sum to the line before accepting any of them.
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const st = (b.bankStatements || []).find((x) => x.id === stId);
        if (!st) return;
        st.decisions = (st.decisions || []).filter((d) => d.sourceLine !== line);
        for (const id of ids) {
          st.decisions.push({ sourceLine: line, movementId: String(id), decidedBy: session.email, decidedAt: new Date().toISOString() });
        }
      });
      await audit(session, 'update', {
        collection: 'bankStatements', id: stId, label: stId,
        summary: ids.length
          ? `Confirmed statement line ${line} is ${ids.length} book entries banked together`
          : `Cleared the grouping on statement line ${line}`
      });
      return redirect(res, '/bank-statements?saved=' + encodeURIComponent(ids.length ? 'Grouping confirmed.' : 'Grouping cleared.'));
    }
    if (pathname === '/bank-statements/signoff' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const stId = String(form.statement || '');
      const current = bookFile();
      const st = (current.bankStatements || []).find((s) => s.id === stId);
      if (!st) return redirect(res, '/bank-statements');

      const rec = reconcileStored(current, st);
      /**
       * Refused unless it is genuinely settled.
       *
       * A sign-off is a claim, and this is the one place the system can stop somebody
       * making a false one by accident. "Reconciled" is not enough on its own: a period
       * can agree perfectly while carrying charges the book has never recorded, and
       * signing that off would freeze the omission in place with a name against it.
       */
      if (!rec.settled) {
        const why = rec.blockers.concat(
          rec.difference !== 0 ? [`The two sides differ by ${rec.difference}.`] : [],
          rec.requiresPosting ? [`${rec.requiresPosting} item(s) on the statement have not been recorded in the book. Post them first — a signed period with unrecorded bank charges is an omission with somebody's name on it.`] : []
        );
        return redirect(res, '/bank-statements?error=' + encodeURIComponent(why.join(' ')));
      }

      const id = `BRC-${st.bankId}-${st.from}`;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const rows = b.bankReconciliations || (b.bankReconciliations = []);
        b.bankReconciliations = rows.filter((r) => r.id !== id).concat([{
          id, bankId: st.bankId, statementId: st.id, from: st.from, to: st.to,
          closedAt: new Date().toISOString(),
          closedBy: session.email,
          // Stored on purpose. Everything else in this book is derived so it cannot go
          // stale; a sign-off is a claim made at a moment, and keeping the number that was
          // true then is what lets the app notice a later edit invalidating it.
          differenceAtClose: rec.difference,
          bookClosingAtClose: rec.bookClosing
        }]);
      });
      await audit(session, 'create', {
        collection: 'bankReconciliations', id, label: `${st.bankId} ${st.from}..${st.to}`,
        summary: `Signed off the bank reconciliation for ${st.bankId}, ${st.from} to ${st.to}, difference ${rec.difference}`
      });
      return redirect(res, '/bank-statements?saved=' + encodeURIComponent('Signed off.'));
    }

    if (pathname === '/bank-statements/delete' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const stId = String(form.statement || '');
      let gone = null;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        gone = (b.bankStatements || []).find((s) => s.id === stId) || null;
        b.bankStatements = (b.bankStatements || []).filter((s) => s.id !== stId);
        // The sign-off goes with it. A sign-off without the statement it was made against
        // is a claim nobody can check.
        b.bankReconciliations = (b.bankReconciliations || []).filter((r) => r.statementId !== stId);
      });
      await audit(session, 'delete', {
        collection: 'bankStatements', id: stId, label: stId,
        summary: gone ? `Removed the imported statement for ${gone.bankId}, ${gone.from} to ${gone.to}, and any sign-off made against it` : 'Removed an imported statement',
        before: gone
      });
      return redirect(res, '/bank-statements?saved=' + encodeURIComponent('Import removed. The book itself is unchanged.'));
    }

    if (pathname === '/journal' && req.method === 'GET') {
      return send(res, 200, journalView(session, url.searchParams));
    }

    if (pathname === '/journal/new' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const draft = {
        date: String(form.date || '').trim(),
        narration: String(form.narration || '').trim(),
        lines: journalLinesFromForm(form)
      };

      const book = bookFile();
      const verdict = JV.validateVoucher(book, draft, LOCK.isLocked);
      /**
       * Every failure at once, and the draft handed straight back.
       *
       * A form that reports one problem per submission is how a five-line voucher
       * takes five attempts, and one that clears the boxes on a refusal is how an
       * accountant retypes a voucher they had already typed correctly except for the
       * date.
       */
      if (!verdict.ok) return send(res, 422, journalView(session, url.searchParams, { draft, errors: verdict.errors }));

      let rec = null;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const rows = b.journalEntries || (b.journalEntries = []);
        // Numbered inside the lock: two people clicking Post at the same moment would
        // otherwise be handed the same number and one voucher would overwrite it.
        rec = {
          id: `jv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          no: JV.nextVoucherNo(b),
          date: draft.date,
          narration: draft.narration,
          lines: verdict.lines.map((l) => ({
            account: l.account,
            debit: JV.round(l.debit),
            credit: JV.round(l.credit),
            memo: String(l.memo || '')
          })),
          createdBy: session.email,
          createdAt: new Date().toISOString()
        };
        rows.push(rec);
      });

      const control = JV.controlAccountCodes(book);
      const hits = rec.lines.filter((l) => control.has(l.account)).map((l) => l.account);
      await audit(session, 'create', {
        collection: 'journalEntries', id: rec.id, label: rec.no,
        summary: `Posted ${rec.no} for ${verdict.totalDebit.toFixed(2)}${hits.length ? ` — touches control account(s): ${hits.join(', ')}` : ''}`,
        after: rec
      });
      return redirect(res, `/journal?posted=${encodeURIComponent(rec.no)}`);
    }

    if (pathname === '/journal/reverse' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const id = String(form.id || '');
      const book = bookFile();
      const target = (book.journalEntries || []).find((v) => v.id === id);
      if (!target) return redirect(res, '/journal');
      if (target.reversedBy) return redirect(res, `/journal?error=${encodeURIComponent(`${target.no} has already been reversed.`)}`);

      /**
       * Dated today, not on the original's date.
       *
       * Back-dating the reversal into the month being corrected would make both
       * vouchers vanish from that month's figures, which is the opposite of what a
       * correction is for: the mistake happened, and the month it was noticed is a
       * fact about the book. It also means a reversal can never reach into a closed
       * period — the lock below would refuse it, and rightly.
       */
      const on = todayISO();
      const draft = { date: on, narration: `Reversal of ${target.no} — ${target.narration}`, lines: JV.reversalLines(target) };
      const verdict = JV.validateVoucher(book, draft, LOCK.isLocked);
      if (!verdict.ok) return send(res, 422, journalView(session, url.searchParams, { draft, errors: verdict.errors }));

      let rec = null;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (b) => {
        const rows = b.journalEntries || (b.journalEntries = []);
        rec = {
          id: `jv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          no: JV.nextVoucherNo(b),
          date: on,
          narration: draft.narration,
          lines: draft.lines,
          createdBy: session.email,
          createdAt: new Date().toISOString(),
          reversalOf: target.id
        };
        rows.push(rec);
        // Both sides of the pair are marked, so neither can be read without the other.
        const original = rows.find((v) => v.id === target.id);
        if (original) original.reversedBy = rec.id;
      });
      await audit(session, 'update', {
        collection: 'journalEntries', id: rec.id, label: rec.no,
        summary: `Reversed ${target.no} with ${rec.no} — both kept, nothing deleted`,
        after: rec
      });
      return redirect(res, `/journal?posted=${encodeURIComponent(rec.no)}`);
    }

    if (pathname === '/books' && req.method === 'GET') {
      return send(res, 200, bookIndexView(session, bookFile(), url.searchParams.get('saved') ? 'Saved.' : null));
    }

    if (pathname === '/books/list' && req.method === 'GET') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const q = Object.fromEntries(url.searchParams.entries());
      return send(res, 200, bookListView(session, bookFile(), spec, q, q.saved ? 'Saved.' : null));
    }

    if (pathname === '/books/edit' && req.method === 'GET') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const book = bookFile();
      const rec = (book[spec.key] || []).find((r) => r.id === url.searchParams.get('id'));
      if (!rec) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No record with that id</h1><p><a href="/books">Back</a></p>' }));
      return send(res, 200, bookEditView(session, book, spec, rec, url.searchParams.get('saved') ? 'Saved.' : null, null));
    }

    if (pathname === '/books/edit' && req.method === 'POST') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const recId = url.searchParams.get('id');
      const book = bookFile();
      const idx = (book[spec.key] || []).findIndex((r) => r.id === recId);
      if (idx < 0) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No record with that id</h1>' }));

      // reuse the storefront content editor's form engine on a single record
      const holder = { rec: withOptionalFields(spec, JSON.parse(JSON.stringify(book[spec.key][idx]))) };
      applyForm(holder, form);
      const next = holder.rec;

      const errors = validateBookRecord(spec, next);
      if (errors.length) return send(res, 422, bookEditView(session, book, spec, next, null, errors));

      // Both the record as it stands and the record as submitted, so an edit cannot
      // walk a voucher out of a closed month.
      const refused = lockRefusal(book, book[spec.key][idx], next);
      if (refused) return send(res, 409, lockedPage(session, refused));

      let before = null;
      try {
        await guardedSave(
          path.join(CONTENT_DIR, 'accounting.json'),
          session,
          (fresh) => {
            const i = (fresh[spec.key] || []).findIndex((r) => r.id === recId);
            if (i < 0) return false;
            before = fresh[spec.key][i];
            fresh[spec.key][i] = next;
          },
          {
            expectFingerprint: String(form.__fp || ''),
            locate: (fresh) => (fresh[spec.key] || []).find((r) => r.id === recId) ?? null
          }
        );
      } catch (err) {
        if (err instanceof ConflictError) return send(res, 409, conflictView(session, spec, recId, err.detail));
        throw err;
      }

      await audit(session, 'update', {
        collection: spec.key, id: next.id,
        label: spec.title.map((f) => next[f]).find(Boolean) || next.id,
        summary: `Changed ${diffSummary(before, next)}`,
        before, after: next
      });
      return redirect(res, `/books/edit?col=${encodeURIComponent(spec.key)}&id=${encodeURIComponent(next.id)}&saved=1`);
    }

    if (pathname === '/books/new' && req.method === 'POST') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      // Built inside the lock: `nextBookId` reads the collection to pick the
      // next number, so two people clicking New at the same moment would
      // otherwise both be handed the same id and one record would be lost.
      let rec = null;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (book) => {
        const rows = book[spec.key] || (book[spec.key] = []);
        // A collection that is still empty has no row to copy the shape from, so
        // the spec carries a template. Without it the first credit note anyone
        // creates is a form with two boxes on it.
        rec = withOptionalFields(spec, rows.length ? blankLike(rows[rows.length - 1]) : blankLike(spec.template || { id: '', date: '' }));
        if (spec.template) for (const [k, v] of Object.entries(spec.template)) if (v !== '' && v !== 0) rec[k] = v;
        rec.id = nextBookId(rows, spec.idPrefix);
        if ('no' in rec && spec.noPrefix && book.company) {
          rec.no = `${book.company[spec.noPrefix] || ''}${String(rows.length + 1).padStart(4, '0')}`;
        }
        if ('date' in rec) rec.date = todayISO();
        rows.push(rec);
      });
      await audit(session, 'create', {
        collection: spec.key, id: rec.id, label: rec.no || rec.id,
        summary: `Created a blank ${spec.label.toLowerCase().replace(/s$/, '')}`,
        after: rec
      });
      return redirect(res, `/books/edit?col=${encodeURIComponent(spec.key)}&id=${encodeURIComponent(rec.id)}`);
    }

    if (pathname === '/books/delete' && req.method === 'POST') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const remove = new Set([].concat(form.remove ?? []));
      if (remove.size) {
        // Deleting a voucher out of a closed month restates it just as surely as
        // editing one there.
        const current = bookFile();
        const doomed = (current[spec.key] || []).filter((r) => remove.has(r.id));
        const refusedDelete = lockRefusal(current, ...doomed);
        if (refusedDelete) return send(res, 409, lockedPage(session, refusedDelete));

        let gone = [];
        await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (book) => {
          gone = (book[spec.key] || []).filter((r) => remove.has(r.id));
          book[spec.key] = (book[spec.key] || []).filter((r) => !remove.has(r.id));
        });
        for (const rec of gone) {
          // Deletions are logged one per record with the whole record kept, so
          // a voucher removed by mistake can be typed back in from the log.
          await audit(session, 'delete', {
            collection: spec.key, id: rec.id,
            label: spec.title.map((f) => rec[f]).find(Boolean) || rec.id,
            summary: `Deleted from ${spec.label}`,
            before: rec
          });
        }
      }
      return redirect(res, `/books/list?col=${encodeURIComponent(spec.key)}&saved=1`);
    }

    if (pathname === '/audit' && req.method === 'GET') {
      const log = readJson(AUDIT_FILE(), []);
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const who = url.searchParams.get('user') || '';
      const what = url.searchParams.get('collection') || '';
      const act = url.searchParams.get('action') || '';

      let rows = log;
      if (who) rows = rows.filter((r) => r.user === who);
      if (what) rows = rows.filter((r) => r.collection === what);
      if (act) rows = rows.filter((r) => r.action === act);
      if (q) {
        rows = rows.filter((r) =>
          [r.user, r.label, r.summary, r.recordId, r.collection].join(' ').toLowerCase().includes(q));
      }

      const users = [...new Set(log.map((r) => r.user))].sort();
      const colls = [...new Set(log.map((r) => r.collection).filter(Boolean))].sort();
      const page1 = rows.slice(0, 300);

      const chip = (a) => {
        const c = a === 'delete' ? 'var(--amber)' : a === 'create' ? 'var(--teal)' : 'var(--navy)';
        return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;background:${c}">${esc(a)}</span>`;
      };
      const sel = (name, cur, opts, blank) =>
        `<select name="${name}"><option value="">${blank}</option>${opts
          .map((o) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`)
          .join('')}</select>`;

      return send(res, 200, page({
        title: 'Audit log',
        session,
        active: 'audit',
        body: `
          <h1>Audit log</h1>
          <p class="sub">Every create, edit and delete against the accounting book, with what the record said before the change. ${log.length} entries held, newest first.</p>

          <form method="get" action="/audit" class="card" style="display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap">
            <label style="flex:1;min-width:200px"><span class="lab">Search</span>
              <input type="text" name="q" value="${esc(url.searchParams.get('q') || '')}" placeholder="user, record, field"></label>
            <label><span class="lab">User</span>${sel('user', who, users, 'Everyone')}</label>
            <label><span class="lab">Collection</span>${sel('collection', what, colls, 'All')}</label>
            <label><span class="lab">Action</span>${sel('action', act, ['create', 'update', 'delete'], 'All')}</label>
            <button class="primary" type="submit">Filter</button>
            <a class="secondary" href="/audit">Reset</a>
          </form>

          <div class="card" style="padding:0;overflow:hidden">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>What changed</th><th>Before</th></tr></thead>
              <tbody>
                ${page1.length === 0
                  ? '<tr><td colspan="6" style="padding:26px;text-align:center;color:var(--muted)">Nothing logged yet. Every change made from here on is recorded.</td></tr>'
                  : page1.map((r) => `
                  <tr>
                    <td class="tnum" style="white-space:nowrap">${esc(String(r.at).slice(0, 16).replace('T', ' '))}</td>
                    <td>${esc(r.user)}<div style="font-size:11px;color:var(--muted)">${esc(r.role || '')}</div></td>
                    <td>${chip(r.action)}</td>
                    <td><span class="tnum">${esc(r.recordId)}</span><div style="font-size:11.5px;color:var(--muted)">${esc(r.collection)} · ${esc(r.label || '')}</div></td>
                    <td style="font-size:12.5px">${esc(r.summary || '')}</td>
                    <td style="font-size:11px;color:var(--muted);max-width:340px;word-break:break-word">
                      ${r.before ? esc(JSON.stringify(r.before).slice(0, 220)) : '—'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${rows.length > 300 ? `<p class="sub">Showing the first 300 of ${rows.length}. Narrow the filter to see the rest.</p>` : ''}`
      }));
    }

    if (pathname === '/crm/import' && req.method === 'GET') {
      return send(res, 200, importView(session, null, null, null));
    }

    if (pathname === '/crm/import' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const plan = planImport(String(form.csv || ''));
      if (plan.errors.length) return send(res, 422, importView(session, null, plan.errors, String(form.csv || '')));

      // Preview first, always. An upsert that ran straight off a paste is how
      // 400 researched records get quietly overwritten by a half-finished
      // spreadsheet, and the research is the asset here.
      if (!form.confirm) {
        return send(res, 200, importView(session, plan, null, String(form.csv || '')));
      }

      const leads = crmLeads();
      const byId = new Map(leads.map((l) => [l.lead_id, l]));
      let added = 0;
      let updated = 0;
      for (const row of plan.rows) {
        const existing = byId.get(row.lead_id);
        if (existing) {
          // `planImport` already dropped every call-progress column, so nothing
          // here can overwrite what a rep recorded.
          for (const [k, v] of Object.entries(row)) {
            if (v !== '' && v !== undefined) existing[k] = v;
          }
          updated += 1;
        } else {
          leads.push({ ...blankLead(), ...row });
          added += 1;
        }
      }
      await writeJsonAtomic(CRM_LEADS_FILE, leads);
      await audit(session, 'update', {
        collection: 'crm-leads', id: 'import',
        summary: `Imported ${plan.rows.length} row(s): ${added} added, ${updated} updated (research fields only)`
      });
      return send(res, 200, importView(session, { ...plan, done: { added, updated } }, null, ''));
    }

    if (pathname === '/crm/vocab' && req.method === 'GET') {
      return send(res, 200, vocabView(session, url.searchParams.get('msg')));
    }

    if (pathname === '/crm/vocab' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const stored = readJson(VOCAB_FILE(), {});
      const errors = [];
      const key = String(form.list || '');
      if (!CRM.OVERRIDABLE.includes(key)) errors.push('Unknown list.');

      const leads = crmLeads();
      const fieldFor = { CALL_STATUS: 'call_status', DISPOSITION: 'disposition', INTEREST: 'interest_level', DEMO: 'demo_scheduled', ACTIVITY_TYPE: null };
      const inUse = (slug) => {
        const f = fieldFor[key];
        if (!f) return crmActivities().some((a) => a.activity_type === slug);
        return leads.some((l) => l[f] === slug);
      };

      if (!errors.length) {
        stored[key] = stored[key] || {};

        // relabel anything submitted
        for (const [k, v] of Object.entries(form)) {
          const m = /^label_(.+)$/.exec(k);
          if (!m) continue;
          const label = String(v || '').trim();
          if (!label) { errors.push(`"${m[1]}" cannot have an empty label.`); continue; }
          stored[key][m[1]] = label;
        }

        // retire, but never for a value already recorded against real work
        const retire = new Set([].concat(form.retire ?? []));
        const defaults = CRM.DEFAULTS[key] || {};
        for (const slug of Object.keys({ ...defaults, ...stored[key] })) {
          if (retire.has(slug)) {
            if (inUse(slug)) {
              errors.push(`"${slug}" is recorded against existing work, so it cannot be retired — it would render as a raw slug on those records.`);
              continue;
            }
            stored[key][slug] = null;
          } else if (stored[key][slug] === null) {
            delete stored[key][slug];
          }
        }

        // add a new value
        const newLabel = String(form.new_label || '').trim();
        if (newLabel) {
          const slug = CRM.slugify(newLabel);
          if (!slug) errors.push('That label produces no usable key — use letters and numbers.');
          else if (slug in { ...defaults, ...stored[key] }) errors.push(`"${slug}" already exists in this list.`);
          else stored[key][slug] = newLabel;
        }
      }

      if (errors.length) return send(res, 422, vocabView(session, null, errors));

      await writeJsonAtomic(VOCAB_FILE(), stored);
      await audit(session, 'update', {
        collection: 'crm-vocab', id: key,
        summary: `Changed the ${key} list`,
        after: stored[key]
      });
      return redirect(res, `/crm/vocab?msg=${encodeURIComponent('Saved. The dropdowns change on the next page load.')}`);
    }

    if (pathname === '/crm/vocab/reset' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const key = String(form.list || '');
      if (!CRM.OVERRIDABLE.includes(key)) return redirect(res, '/crm/vocab');
      const stored = readJson(VOCAB_FILE(), {});
      delete stored[key];
      await writeJsonAtomic(VOCAB_FILE(), stored);
      await audit(session, 'update', { collection: 'crm-vocab', id: key, summary: `Reset the ${key} list to the built-in defaults` });
      return redirect(res, `/crm/vocab?msg=${encodeURIComponent(`${key} is back to the built-in list.`)}`);
    }

    if (pathname === '/alerts' && req.method === 'GET') {
      return send(res, 200, alertsView(session, scheduler.status(), url.searchParams.get('msg')));
    }

    if (pathname === '/alerts/run' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const r = await scheduler.runAll(`manual by ${session.email}`);
      const msg = r.skipped
        ? `Not started — ${r.skipped}.`
        : `Ran ${r.ran.length} check(s). ${r.ran.filter((x) => x.error).length} could not complete.`;
      return redirect(res, `/alerts?msg=${encodeURIComponent(msg)}`);
    }

    if (pathname === '/alerts/ack' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const id = String(form.id || '');
      const done = form.undo
        ? await scheduler.unacknowledge(id)
        : await scheduler.acknowledge(id, session.email, form.note);
      if (done) {
        await audit(session, 'update', {
          collection: 'alerts', id,
          summary: form.undo ? 'Re-opened an alert' : `Acknowledged an alert${form.note ? `: ${String(form.note).slice(0, 120)}` : ''}`
        });
      }
      return redirect(res, `/alerts?msg=${encodeURIComponent(done ? (form.undo ? 'Re-opened.' : 'Acknowledged.') : 'That alert is no longer open.')}`);
    }

    /* ---- backup & restore ---- */

    if (pathname === '/backup' && req.method === 'GET') {
      const files = BACKUP_SET.map((f) => {
        const full = path.join(CONTENT_DIR, f);
        let size = 0, when = '';
        try {
          const st = fs.statSync(full);
          size = st.size;
          when = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
        } catch { /* a file that does not exist yet is not an error */ }
        return { f, size, when, exists: size > 0 };
      });

      return send(res, 200, page({
        title: 'Backup & restore',
        session,
        active: 'backup',
        body: `
          <h1>Backup &amp; restore</h1>
          <p class="sub">The whole book is a handful of JSON files. A backup is those files in one download; a restore puts them back.</p>
          ${url.searchParams.get('restored') ? '<div class="flash">Restored. Every figure in the app is derived on the next page load, so the change is already live.</div>' : ''}
          ${url.searchParams.get('error') ? `<div class="flash warn">${esc(url.searchParams.get('error'))}</div>` : ''}

          <div class="card">
            <h2 style="margin:0 0 12px;font-size:13.5px;color:var(--navy)">What is in a backup</h2>
            <table>
              <thead><tr><th>File</th><th>Holds</th><th style="text-align:right">Size</th><th>Last written</th></tr></thead>
              <tbody>${files.map((x) => `
                <tr>
                  <td class="tnum">${esc(x.f)}</td>
                  <td style="font-size:12.5px;color:var(--muted)">${esc(BACKUP_WHAT[x.f] || '')}</td>
                  <td class="tnum" style="text-align:right">${x.exists ? (x.size / 1024).toFixed(1) + ' KB' : '—'}</td>
                  <td class="tnum" style="font-size:12px;color:var(--muted)">${esc(x.when || 'not present')}</td>
                </tr>`).join('')}</tbody>
            </table>
            <div class="bar">
              <a class="primary" href="/backup/download" style="text-decoration:none;display:inline-block;padding:9px 18px;border-radius:8px">Download backup</a>
              <span style="font-size:12.5px;color:var(--muted)">One JSON file containing every file above, plus the time and who took it.</span>
            </div>
          </div>

          <div class="card">
            <h2 style="margin:0 0 6px;font-size:13.5px;color:var(--navy)">Restore</h2>
            <p style="margin:0 0 12px;font-size:12.5px;color:var(--muted);line-height:1.7">
              Paste a backup below. <strong>Every file it contains is overwritten.</strong> A copy of what is
              on disk right now is written to <code>content/pre-restore-backup.json</code> first, so a
              restore of the wrong file can itself be undone. Type <code>RESTORE</code> to confirm — the
              word is there because this is the one action on this portal that cannot be fixed by editing
              one record.
            </p>
            <form method="post" action="/backup/restore">
              <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
              <label class="row"><span class="lab">Backup JSON</span>
                <textarea name="payload" rows="10" placeholder="Paste the contents of a downloaded backup file"></textarea></label>
              <label class="row"><span class="lab">Type RESTORE to confirm</span>
                <input type="text" name="confirm" autocomplete="off" placeholder="RESTORE"></label>
              <div class="bar"><button class="primary" type="submit">Restore from this backup</button></div>
            </form>
          </div>`
      }));
    }

    if (pathname === '/backup/download' && req.method === 'GET') {
      const payload = {
        takenAt: new Date().toISOString(),
        takenBy: session.email,
        app: 'OTA Platform admin portal',
        files: {}
      };
      for (const f of BACKUP_SET) {
        const full = path.join(CONTENT_DIR, f);
        if (fs.existsSync(full)) payload.files[f] = readJson(full, null);
      }
      const body = JSON.stringify(payload, null, 2);
      const name = `otaplatform-backup-${todayISO().replace(/-/g, '')}.json`;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store'
      });
      await audit(session, 'update', { collection: 'backup', id: name, summary: 'Downloaded a backup' });
      return res.end(body);
    }

    if (pathname === '/backup/restore' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const bad = (msg) => redirect(res, `/backup?error=${encodeURIComponent(msg)}`);

      if (String(form.confirm || '').trim() !== 'RESTORE') return bad('Type RESTORE in the confirmation box. Nothing was changed.');

      let parsed;
      try {
        parsed = JSON.parse(form.payload || '');
      } catch (err) {
        return bad(`That is not valid JSON: ${err.message}. Nothing was changed.`);
      }
      if (!parsed || typeof parsed.files !== 'object' || parsed.files === null) {
        return bad('That JSON is not a backup — it has no "files" object. Nothing was changed.');
      }
      const names = Object.keys(parsed.files).filter((f) => BACKUP_SET.includes(f));
      if (names.length === 0) {
        return bad('The backup contains none of the files this portal manages. Nothing was changed.');
      }

      // snapshot what is on disk BEFORE overwriting, so this is reversible
      const rollback = { takenAt: new Date().toISOString(), takenBy: session.email, reason: 'automatic, before a restore', files: {} };
      for (const f of names) {
        const full = path.join(CONTENT_DIR, f);
        if (fs.existsSync(full)) rollback.files[f] = readJson(full, null);
      }
      await writeJsonAtomic(path.join(CONTENT_DIR, 'pre-restore-backup.json'), rollback);

      for (const f of names) await writeJsonAtomic(path.join(CONTENT_DIR, f), parsed.files[f]);

      await audit(session, 'update', {
        collection: 'backup',
        id: parsed.takenAt || 'unknown',
        summary: `Restored ${names.length} file(s): ${names.join(', ')}. Taken ${parsed.takenAt || 'at an unknown time'} by ${parsed.takenBy || 'unknown'}.`
      });
      return redirect(res, '/backup?restored=1');
    }

    /* ---- design & integrations ---- */

    if (pathname === '/design' && req.method === 'GET') {
      const raw = url.searchParams.get('tab');
      const tab = ['theme', 'panel', 'lock'].includes(raw) ? raw : 'sections';
      const device = ['mobile', 'tablet', 'desktop'].includes(url.searchParams.get('device'))
        ? url.searchParams.get('device') : 'desktop';
      return send(res, 200, designView(session, readJson(SITE_FILE, {}), tab, device,
        url.searchParams.get('saved') ? 'Saved — the preview has reloaded.' : null));
    }

    if (pathname === '/design/sections' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const content = readJson(SITE_FILE, {});
      const items = (content.sections && content.sections.items) || [];
      // an unchecked box is simply absent from the body
      for (const item of items) item.enabled = `on_${item.key}` in form;
      stampMeta(content, session);
      await writeJsonAtomic(SITE_FILE, content);
      return redirect(res, '/design?tab=sections&saved=1');
    }

    /**
     * Close a period, or reopen one.
     *
     * Deliberately here rather than on any record screen, and deliberately typed
     * rather than picked: reopening a closed month is how a filed figure gets
     * restated, so it has to be a decision somebody made on purpose. Both
     * directions are audited with the old and new dates, because "who reopened
     * March" is the first question an auditor asks.
     */
    if (pathname === '/design/lock' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const through = String(form.lockedThrough || '').trim();
      if (through && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(through)) {
        return send(res, 422, lockedPage(session, `"${through}" is not a date. Use YYYY-MM-DD, or clear the field to reopen everything.`));
      }
      let before = null;
      await guardedSave(path.join(CONTENT_DIR, 'accounting.json'), session, (book) => {
        before = book.lockedThrough ?? null;
        book.lockedThrough = through || null;
      });
      await audit(session, 'update', {
        collection: 'company', id: 'period-lock',
        summary: through
          ? `Closed everything on or before ${through}${before ? ` (was ${before})` : ''}`
          : `Reopened the whole book${before ? ` (was closed through ${before})` : ''}`,
        before: { lockedThrough: before }, after: { lockedThrough: through || null }
      });
      return redirect(res, '/design?tab=lock&saved=1');
    }

    if (pathname === '/design/panel' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const content = readJson(SITE_FILE, {});
      /**
       * Rebuild from the declaration, not from the form.
       *
       * An unchecked box is simply absent from the body, so iterating the FORM
       * would never see a module being switched off — it would see nothing and
       * leave the old value in place, and the toggle would appear to work while
       * saving nothing. Iterating the declared modules and asking whether each
       * one is present is the only version that can record an "off".
       *
       * Locked modules are written as `true` rather than skipped, so the file
       * always states the full picture instead of relying on the reader to know
       * which keys are special.
       */
      const panel = { accounts: {}, dashboard: {} };
      for (const m of PANEL_MODULES) {
        panel[m.group][m.key] = m.locked ? true : `mod_${m.group}_${m.key}` in form;
      }
      content.panel = panel;
      stampMeta(content, session);
      await writeJsonAtomic(SITE_FILE, content);
      const off = PANEL_MODULES.filter((m) => !panel[m.group][m.key]);
      await audit(session, 'update', {
        collection: 'panel', id: 'modules',
        summary: off.length
          ? `${off.length} module(s) switched off: ${off.map((m) => m.href).join(', ')}`
          : 'every panel module is on'
      });
      return redirect(res, '/design?tab=panel&saved=1');
    }

    if (pathname === '/design/menu' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const content = readJson(SITE_FILE, {});
      const nav = content.nav || [];
      // an unchecked box is simply absent from the body, same as the sections form
      nav.forEach((item, i) => {
        item.enabled = `nav_${i}` in form;
        (item.groups || []).forEach((g, gi) => {
          g.links.forEach((l, li) => {
            l.enabled = `navlink_${i}_${gi}_${li}` in form;
          });
        });
      });
      stampMeta(content, session);
      await writeJsonAtomic(SITE_FILE, content);
      await audit(session, 'update', {
        collection: 'nav', id: 'header-menu',
        summary: `${nav.filter((x) => x.enabled !== false).length} of ${nav.length} menu entries visible`
      });
      return redirect(res, '/design?tab=sections&saved=1');
    }

    if (pathname === '/design/theme' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const content = readJson(SITE_FILE, {});
      content.theme = content.theme || {};

      const chosen = form.palette && PALETTES.find((p) => p.name === form.palette);
      if (chosen) {
        Object.assign(content.theme, chosen, { preset: chosen.name });
      } else {
        for (const key of ['primary', 'primaryHover', 'navy', 'navyDeep', 'accentLight']) {
          // the picker is authoritative when it disagrees with the typed triplet
          const fromHex = hexToRgb(form[`hex_${key}`]);
          const typed = String(form[`rgb_${key}`] || '').trim();
          const wasHex = rgbToHex(content.theme[key]) !== String(form[`hex_${key}`] || '');
          if (wasHex && fromHex) content.theme[key] = fromHex;
          else if (/^\d+\s+\d+\s+\d+$/.test(typed)) content.theme[key] = typed;
          else if (fromHex) content.theme[key] = fromHex;
        }
        content.theme.preset = 'Custom';
        if (form.headingFont) content.theme.headingFont = String(form.headingFont);
        if (form.bodyFont) content.theme.bodyFont = String(form.bodyFont);
      }
      stampMeta(content, session);
      await writeJsonAtomic(SITE_FILE, content);
      return redirect(res, '/design?tab=theme&saved=1');
    }

    if (pathname === '/integrations' && req.method === 'GET') {
      return send(res, 200, integrationsView(session, null, null));
    }

    if (pathname === '/integrations/test' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const date = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
      let result;
      try {
        const r = await fetch(`${APP_URL}/api/gds/search?from=DAC&to=CGP&date=${date}`, { cache: 'no-store' });
        const j = await r.json();
        const lv = j.live || {};
        const raw = typeof lv.data === 'string' ? lv.data : '';
        const prices = Array.from(raw.matchAll(/TotalPrice="([A-Z]{3})(\d+(?:\.\d+)?)"/g)).map((m) => Number(m[2]));
        result = {
          ok: Boolean(lv.upstreamOk),
          status: lv.upstreamStatus ?? '—',
          ms: lv.elapsedMs ?? 0,
          host: lv.endpointHost,
          offers: (raw.match(/<air:AirPricePoint /g) || []).length,
          cheapest: prices.length ? `${(raw.match(/TotalPrice="([A-Z]{3})/) || [])[1] || ''}${Math.min(...prices)}` : '',
          fault: lv.fault ? `${lv.fault.code || ''} ${lv.fault.faultString || ''}`.trim() : '',
          date
        };
      } catch (e) {
        result = { ok: false, status: 'no response', ms: 0, offers: 0, fault: e.message, date };
      }
      return send(res, 200, integrationsView(session, null, result));
    }

    /* ---- sales CRM ---- */

    if (pathname === '/crm' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams.entries());
      return send(res, 200, crmListView(session, crmLeads(), crmUsers(), q, q.saved ? 'Saved.' : null));
    }

    if (pathname === '/crm/dashboard' && req.method === 'GET') {
      return send(res, 200, crmDashboardView(session, crmLeads(), crmUsers(), crmActivities(), null));
    }

    if (pathname === '/crm/lead' && req.method === 'GET') {
      const leads = crmLeads();
      const lead = leads.find((l) => l.lead_id === url.searchParams.get('id'));
      if (!lead) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No lead with that id</h1><p><a href="/crm">Back to list</a></p>' }));
      const acts = crmActivities().filter((a) => a.lead_id === lead.lead_id)
        .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
      return send(res, 200, crmLeadView(session, lead, crmUsers(), acts, url.searchParams.get('saved') ? 'Saved.' : null, null));
    }

    if (pathname === '/crm/lead' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const leads = crmLeads();
      const idx = leads.findIndex((l) => l.lead_id === url.searchParams.get('id'));
      if (idx < 0) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No lead with that id</h1>' }));

      const scope = leadScope(session, leads[idx]);
      if (!scope.ok) return send(res, 403, leadScopeView(session, leads[idx], scope));

      const result = await applyCrmForm(leads, idx, form, session);
      if (result.errors.length) {
        const acts = crmActivities().filter((a) => a.lead_id === leads[idx].lead_id)
          .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
        return send(res, 422, crmLeadView(session, result.candidate, crmUsers(), acts, null, result.errors));
      }
      return redirect(res, `/crm/lead?id=${encodeURIComponent(leads[idx].lead_id)}&saved=1`);
    }

    if (pathname === '/crm/activity' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const id = url.searchParams.get('id');
      // Logging a call is a write about that lead, so it is scoped the same way.
      const actLead = crmLeads().find((l) => l.lead_id === id);
      if (actLead) {
        const scope = leadScope(session, actLead);
        if (!scope.ok) return send(res, 403, leadScopeView(session, actLead, scope));
      }
      const acts = crmActivities();
      acts.push({
        id: 'ACT-' + Math.random().toString(36).slice(2, 10),
        lead_id: id,
        user_id: null,
        activity_type: String(form.activity_type || 'note'),
        outcome: String(form.outcome || '').slice(0, 96),
        body: String(form.body || '').slice(0, 4000),
        occurred_at: new Date().toISOString()
      });
      await writeJsonAtomic(CRM_ACTIVITIES_FILE, acts);
      return redirect(res, `/crm/lead?id=${encodeURIComponent(id)}&saved=1`);
    }

    if (pathname === '/crm/bulk-assign' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const ids = new Set([].concat(form.lead ?? []));
      const target = String(form.user_id || '');
      if (ids.size && target) {
        const leads = crmLeads();
        const acts = crmActivities();
        const now = new Date().toISOString();
        for (const l of leads) {
          if (!ids.has(l.lead_id)) continue;
          const before = l.assigned_to;
          l.assigned_to = target === '__none__' ? null : target;
          l.updated_at = now;
          l.updated_by = session.email;
          if (before !== l.assigned_to) {
            acts.push({
              id: 'ACT-' + Math.random().toString(36).slice(2, 10),
              lead_id: l.lead_id, user_id: l.assigned_to,
              activity_type: 'status_change',
              outcome: 'assigned',
              body: `assigned_to: ${before || 'Unassigned'} → ${l.assigned_to || 'Unassigned'} (by ${session.email})`,
              occurred_at: now
            });
          }
        }
        await writeJsonAtomic(CRM_LEADS_FILE, leads);
        await writeJsonAtomic(CRM_ACTIVITIES_FILE, acts);
      }
      return redirect(res, `/crm?${form.back || ''}${form.back ? '&' : ''}saved=1`);
    }

    if (pathname === '/crm/call' && req.method === 'GET') {
      const leads = crmLeads();
      const t = todayISO();
      const skip = url.searchParams.get('skip');
      let queue = leads.filter((l) => !CRM.CLOSED.has(l.call_status))
        .sort((a, b) => CRM.queueRank(a, t) - CRM.queueRank(b, t) || a.lead_id.localeCompare(b.lead_id));
      if (skip) queue = queue.filter((l) => l.lead_id !== skip);
      const wanted = url.searchParams.get('id');
      const lead = wanted ? leads.find((l) => l.lead_id === wanted) : queue[0];
      const acts = lead
        ? crmActivities().filter((a) => a.lead_id === lead.lead_id).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
        : [];
      return send(res, 200, crmCallView(session, lead || null, crmUsers(), acts, queue.length, url.searchParams.get('saved') ? 'Saved.' : null, null));
    }

    if (pathname === '/crm/call' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const leads = crmLeads();
      const idx = leads.findIndex((l) => l.lead_id === String(form.lead_id || ''));
      if (idx < 0) return redirect(res, '/crm/call');

      const result = await applyCrmForm(leads, idx, form, session, String(form.activity_body || ''));
      if (result.errors.length) {
        const t = todayISO();
        const queue = leads.filter((l) => !CRM.CLOSED.has(l.call_status));
        const acts = crmActivities().filter((a) => a.lead_id === leads[idx].lead_id);
        return send(res, 422, crmCallView(session, result.candidate, crmUsers(), acts, queue.length, null, result.errors));
      }
      return redirect(res, form.advance ? '/crm/call?saved=1' : `/crm/call?id=${encodeURIComponent(leads[idx].lead_id)}&saved=1`);
    }

    /* ---- agency dataset ---- */

    if (pathname === '/agencies' && req.method === 'GET') {
      const rows = readJson(AGENCIES_FILE, []);
      const q = Object.fromEntries(url.searchParams.entries());
      return send(res, 200, agencyListView(session, rows, q, q.saved ? 'Saved.' : null));
    }

    if (pathname === '/agencies/edit' && req.method === 'GET') {
      const rows = readJson(AGENCIES_FILE, []);
      const rec = rows.find((r) => r.id === url.searchParams.get('id'));
      if (!rec) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No agency with that id</h1><p><a href="/agencies">Back to list</a></p>' }));
      return send(res, 200, agencyEditView(session, rec, clusterOptions(rows), url.searchParams.get('saved') ? 'Saved.' : null));
    }

    if (pathname === '/agencies/edit' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const rows = readJson(AGENCIES_FILE, []);
      const idx = rows.findIndex((r) => r.id === url.searchParams.get('id'));
      if (idx < 0) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No agency with that id</h1>' }));
      applyAgencyForm(rows[idx], form);
      await writeJsonAtomic(AGENCIES_FILE, rows);
      return redirect(res, `/agencies/edit?id=${encodeURIComponent(rows[idx].id)}&saved=1`);
    }

    if (pathname === '/agencies/new' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const rows = readJson(AGENCIES_FILE, []);
      const rec = AGENCY.blankAgency(nextAgencyId(rows));
      rows.push(rec);
      await writeJsonAtomic(AGENCIES_FILE, rows);
      return redirect(res, `/agencies/edit?id=${encodeURIComponent(rec.id)}`);
    }

    if (pathname === '/agencies/delete' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const remove = new Set([].concat(form.remove ?? []));
      if (remove.size === 0) return redirect(res, '/agencies');
      const rows = readJson(AGENCIES_FILE, []).filter((r) => !remove.has(r.id));
      await writeJsonAtomic(AGENCIES_FILE, rows);
      return redirect(res, '/agencies?saved=1');
    }

    if (pathname === '/raw' && req.method === 'GET') {
      return send(res, 200, rawView(session, readJson(SITE_FILE, {}), url.searchParams.get('saved') ? 'Saved.' : null, null));
    }

    if (pathname === '/raw' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      let parsed;
      try {
        parsed = JSON.parse(String(form.json || ''));
      } catch (e) {
        return send(res, 400, rawView(session, readJson(SITE_FILE, {}), null, `Not valid JSON: ${e.message}`));
      }
      stampMeta(parsed, session);
      await writeJsonAtomic(SITE_FILE, parsed);
      return redirect(res, '/raw?saved=1');
    }

    const editMatch = pathname.match(/^\/edit\/([a-zA-Z0-9_]+)$/);
    if (editMatch) {
      const key = editMatch[1];
      if (!SECTIONS.some((s) => s.key === key)) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No such section</h1>' }));

      if (req.method === 'GET') {
        return send(res, 200, editView(session, key, readJson(SITE_FILE, {}), url.searchParams.get('saved') ? 'Saved.' : null));
      }

      if (req.method === 'POST') {
        const form = parseForm(await readBody(req));
        if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
        const content = readJson(SITE_FILE, {});
        applyForm(content, form);
        stampMeta(content, session);
        await writeJsonAtomic(SITE_FILE, content);
        return redirect(res, `/edit/${key}?saved=1`);
      }
    }

    return send(res, 404, page({ title: 'Not found', session, body: '<h1>404</h1><p><a href="/dashboard">Back to overview</a></p>' }));
  } catch (err) {
    console.error('[admin]', err);
    return send(res, 500, page({ title: 'Error', session, body: `<h1>Server error</h1><pre>${esc(err.message)}</pre>` }));
  }
});

/**
 * Writes the editable CRM fields of one lead from a submitted form.
 *
 * Research fields are not in CRM.EDITABLE and are therefore rejected here, not
 * merely hidden in the UI — rule 7 of 05_DATA_DICTIONARY.md. Validation runs
 * before anything touches disk, so a rejected save leaves the file untouched
 * and the caller re-renders the form with the candidate values still in it.
 *
 * Every change to call_status, disposition, assigned_to or interest_level
 * writes a status_change activity, which is what makes the manager dashboard
 * and the per-lead timeline true.
 */
async function applyCrmForm(leads, idx, form, session, activityBody) {
  const lead = leads[idx];
  const candidate = { ...lead };

  for (const f of CRM.EDITABLE) {
    if (!(f in form)) continue;
    const raw = form[f];
    const v = String(Array.isArray(raw) ? raw[raw.length - 1] : raw).trim();
    candidate[f] = v === '' ? null : v;
  }
  if (!candidate.call_status) candidate.call_status = lead.call_status || 'not_started';

  const errors = CRM.validateLead(candidate, todayISO());
  if (errors.length) return { errors, candidate };

  const now = new Date().toISOString();
  const acts = crmActivities();
  const watched = ['call_status', 'disposition', 'assigned_to', 'interest_level'];
  for (const f of watched) {
    if (String(lead[f] ?? '') === String(candidate[f] ?? '')) continue;
    acts.push({
      id: 'ACT-' + Math.random().toString(36).slice(2, 10),
      lead_id: lead.lead_id,
      user_id: candidate.assigned_to || null,
      activity_type: 'status_change',
      outcome: f,
      body: `${f}: ${lead[f] || '—'} → ${candidate[f] || '—'} (by ${session.email})`,
      occurred_at: now
    });
  }
  if (activityBody && activityBody.trim()) {
    acts.push({
      id: 'ACT-' + Math.random().toString(36).slice(2, 10),
      lead_id: lead.lead_id,
      user_id: candidate.assigned_to || null,
      activity_type: 'call',
      outcome: vocabLabel('CALL_STATUS', candidate.call_status),
      body: activityBody.trim().slice(0, 4000),
      occurred_at: now
    });
  }

  candidate.updated_at = now;
  candidate.updated_by = session.email;
  leads[idx] = candidate;

  await writeJsonAtomic(CRM_LEADS_FILE, leads);
  await writeJsonAtomic(CRM_ACTIVITIES_FILE, acts);
  return { errors: [], candidate };
}

function stampMeta(content, session) {
  content._meta = content._meta || {};
  content._meta.revision = Number(content._meta.revision || 0) + 1;
  content._meta.lastEditedBy = session.email;
  content._meta.lastEditedAt = clock.stampIn(bookTimezone());
}

/**
 * Write the submitted form back onto the content object.
 * Order matters: scalars first, then string-arrays, then deletes, then adds —
 * so an index-based delete never shifts a path we are still writing to.
 */
function applyForm(content, form) {
  const bools = new Set(String(form.__bools || '').split('|').filter(Boolean));
  const nums = new Set(String(form.__nums || '').split('|').filter(Boolean));
  const reserved = new Set(['csrf', '__bools', '__nums', 'save', 'addto']);

  // scalars
  for (const [k, v] of Object.entries(form)) {
    if (reserved.has(k) || k.startsWith('remove:') || k.startsWith('lines:')) continue;
    const value = Array.isArray(v) ? v[v.length - 1] : v;
    if (nums.has(k)) {
      const n = Number(value);
      setPath(content, k, Number.isFinite(n) ? n : 0);
    } else {
      setPath(content, k, value);
    }
  }

  // booleans — unchecked boxes are absent from the body entirely
  for (const p of bools) setPath(content, p, p in form);

  // string arrays from newline textareas
  for (const [k, v] of Object.entries(form)) {
    if (!k.startsWith('lines:')) continue;
    const p = k.slice('lines:'.length);
    const raw = Array.isArray(v) ? v[v.length - 1] : v;
    setPath(
      content,
      p,
      String(raw)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  // deletes — group by array path, remove from the end
  const removals = new Map();
  for (const k of Object.keys(form)) {
    if (!k.startsWith('remove:')) continue;
    const target = k.slice('remove:'.length);
    const i = target.lastIndexOf('.');
    const arrPath = target.slice(0, i);
    const idx = Number(target.slice(i + 1));
    if (!Number.isInteger(idx)) continue;
    if (!removals.has(arrPath)) removals.set(arrPath, []);
    removals.get(arrPath).push(idx);
  }
  for (const [arrPath, idxs] of removals) {
    const arr = getPath(content, arrPath);
    if (!Array.isArray(arr)) continue;
    for (const i of idxs.sort((a, b) => b - a)) arr.splice(i, 1);
  }

  // add a blank row, shaped like the existing first item
  if (form.addto) {
    const arrPath = Array.isArray(form.addto) ? form.addto[0] : form.addto;
    const arr = getPath(content, arrPath);
    if (Array.isArray(arr)) arr.push(arr.length ? blankLike(arr[0]) : blankRowFor(arrPath));
  }
}

server.listen(PORT, HOST, () => {
  // Started here, not at import time: the checks that ask the app a question
  // need something listening, and a failure at boot would raise an alert about
  // the boot rather than about the book.
  scheduler.start();
  console.log('');
  console.log('  OTA Platform — Admin content portal');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  editing:   ${SITE_FILE}`);
  console.log(`  storefront ${PORTAL_URL}   (override with APP_URL)`);
  if (seeded) {
    console.log('');
    console.log('  First run — admin account created:');
    console.log(`    email    ${seeded.email}`);
    console.log(`    password ${seeded.password}`);
    console.log('  Change it: delete content/users.json, then restart with ADMIN_EMAIL / ADMIN_PASSWORD set.');
  }
  console.log('');
});
