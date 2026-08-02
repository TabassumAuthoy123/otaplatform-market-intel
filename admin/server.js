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
const fsp = require('node:fs/promises');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.ADMIN_PORT || 4001);

// Where the Market Intelligence app (which serves /portal) is running.
// 3000 is this app's canonical port; override when it is taken.
const APP_URL = (process.env.APP_URL || 'http://localhost:3002').replace(/\/+$/, '');
const PORTAL_URL = `${APP_URL}/portal`;

const AGENCY = require('./agency-fields');
const CRM = require('./crm-fields');

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
 */
function seedUsersIfMissing() {
  if (fs.existsSync(USERS_FILE)) return null;
  const email = (process.env.ADMIN_EMAIL || 'admin@softifybd.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'OtaAdmin@2026';
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

function makeSession(email) {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `${Buffer.from(email).toString('base64url')}.${expires}`;
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
  const [emailB64, expires] = payload.split('.');
  if (!emailB64 || !expires || Number(expires) < Date.now()) return null;
  const email = Buffer.from(emailB64, 'base64url').toString('utf8');
  const user = findUser(email);
  return user ? { email: user.email, name: user.name, role: user.role } : null;
}

function csrfFor(session) {
  return crypto.createHmac('sha256', SECRET).update(`csrf:${session.email}`).digest('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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

function renderField(pathKey, key, value, boolPaths, numPaths, arrayLinePaths) {
  const label = key.replace(/^_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const id = pathKey.replace(/[^a-zA-Z0-9]/g, '_');

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
        const inner = renderValue(`${pathKey}.${i}`, item, boolPaths, numPaths, arrayLinePaths);
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
        ${renderValue(pathKey, value, boolPaths, numPaths, arrayLinePaths)}
      </fieldset>`;
  }

  return '';
}

function renderValue(pathKey, value, boolPaths, numPaths, arrayLinePaths) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([k, v]) => renderField(`${pathKey}.${k}`, k, v, boolPaths, numPaths, arrayLinePaths))
      .join('');
  }
  return renderField(pathKey, pathKey.split('.').pop(), value, boolPaths, numPaths, arrayLinePaths);
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

function page({ title, session, body, active = '' }) {
  const nav = session
    ? `
    <aside class="side">
      <div class="brand"><span class="mark">OTA</span><span>Admin</span></div>
      <nav>
        <a href="/dashboard" class="${active === 'dashboard' ? 'on' : ''}">Overview</a>
        <a href="/leads" class="${active === 'leads' ? 'on' : ''}">Demo requests</a>
        <div class="sep">Accounting</div>
        <a href="/books" class="${active === 'books' ? 'on' : ''}">Records — add / edit / delete</a>
        <div class="sep">Storefront</div>
        <a href="/design" class="${active === 'design' ? 'on' : ''}">Design &amp; layout</a>
        <a href="/integrations" class="${active === 'integrations' ? 'on' : ''}">API integrations</a>
        <div class="sep">Sales CRM · 400 prospects</div>
        <a href="/crm/dashboard" class="${active === 'crm-dash' ? 'on' : ''}">Manager dashboard</a>
        <a href="/crm" class="${active === 'crm' ? 'on' : ''}">Lead list</a>
        <a href="/crm/call" class="${active === 'crm-call' ? 'on' : ''}">Call mode</a>
        <div class="sep">Market Intelligence</div>
        <a href="/agencies" class="${active === 'agencies' ? 'on' : ''}">Agency dataset</a>
        <div class="sep">B2C storefront</div>
        ${SECTIONS.map(
          (s) => `<a href="/edit/${s.key}" class="${active === s.key ? 'on' : ''}">${esc(s.label)}</a>`
        ).join('')}
        <div class="sep">Advanced</div>
        <a href="/raw" class="${active === 'raw' ? 'on' : ''}">Raw JSON</a>
      </nav>
      <form method="post" action="/logout" class="out">
        <input type="hidden" name="csrf" value="${esc(csrfFor(session))}">
        <div class="who">${esc(session.email)}</div>
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
  { key: 'invoices', label: 'Customer invoices', hint: 'Sales. Lines carry supplier cost, which is where margin comes from.', idPrefix: 'INV-', noPrefix: 'invoicePrefix', title: ['no'], search: ['no', 'notes'], amount: null, party: 'customerId' },
  { key: 'receipts', label: 'Customer receipts', hint: 'Money in against an invoice.', idPrefix: 'RCP-', noPrefix: 'receiptPrefix', title: ['no'], search: ['no', 'ref'], amount: 'amount', party: 'customerId' },
  { key: 'bills', label: 'Supplier bills', hint: 'What a supplier charged us for a booking.', idPrefix: 'BIL-', noPrefix: 'billPrefix', title: ['no'], search: ['no', 'notes'], amount: 'amount', party: 'supplierId' },
  { key: 'payments', label: 'Supplier payments', hint: 'Money out against a bill.', idPrefix: 'PAY-', noPrefix: 'paymentPrefix', title: ['no'], search: ['no', 'ref'], amount: 'amount', party: 'supplierId' },
  { key: 'expenses', label: 'Expenses', hint: 'Operating spend by category.', idPrefix: 'EXP-', noPrefix: 'expensePrefix', title: ['no'], search: ['no', 'description'], amount: 'amount', party: 'categoryId' },
  { key: 'supplierDeposits', label: 'Supplier deposits', hint: 'Advances placed with consolidators and airlines.', idPrefix: 'DEP-', noPrefix: null, title: ['no'], search: ['no', 'reference', 'note'], amount: 'amount', party: 'supplierId' },
  { key: 'inventory', label: 'Inventory blocks', hint: 'Seats, room nights and quota bought up front.', idPrefix: 'INV-BLK-', noPrefix: null, title: ['name'], search: ['name', 'note'], amount: null, party: 'supplierId' },
  { key: 'customers', label: 'Customers', hint: 'Who we invoice.', idPrefix: 'CUS-', noPrefix: null, title: ['name'], search: ['name', 'phone', 'email'], amount: null, party: null },
  { key: 'suppliers', label: 'Suppliers & vendors', hint: 'Airlines, consolidators, hotels, visa handlers.', idPrefix: 'SUP-', noPrefix: null, title: ['name'], search: ['name', 'phone'], amount: null, party: null },
  { key: 'services', label: 'Services', hint: 'What can appear on an invoice line.', idPrefix: 'SRV-', noPrefix: null, title: ['name'], search: ['name'], amount: null, party: null },
  { key: 'banks', label: 'Bank accounts', hint: 'MFS wallets count as banks.', idPrefix: 'BNK-', noPrefix: null, title: ['name'], search: ['name', 'accountNo'], amount: null, party: null },
  { key: 'expenseCategories', label: 'Expense categories', hint: '', idPrefix: 'EXC-', noPrefix: null, title: ['name'], search: ['name'], amount: null, party: null },
  { key: 'employees', label: 'Employees', hint: '', idPrefix: 'EMP-', noPrefix: null, title: ['name'], search: ['name', 'role'], amount: null, party: null }
];

const bookFile = () => readJson(path.join(CONTENT_DIR, 'accounting.json'), {});
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

function bookEditView(session, book, spec, rec, flash, errors) {
  const boolPaths = [];
  const numPaths = [];
  const linePaths = [];
  const fields = renderValue('rec', rec, boolPaths, numPaths, linePaths);

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
  if (spec.key === 'invoices') {
    if (!Array.isArray(rec.lines) || rec.lines.length === 0) errors.push('An invoice needs at least one line.');
    else for (const [i, l] of rec.lines.entries()) {
      if (num(l.qty) <= 0) errors.push(`Line ${i + 1}: quantity must be greater than zero.`);
      if (num(l.unitPrice) < num(l.supplierCost)) {
        errors.push(`Line ${i + 1}: selling price is below supplier cost — that is a loss, confirm it is deliberate by raising the price or lowering the cost.`);
      }
    }
  }
  if (spec.key === 'inventory') {
    if (num(rec.sold) > num(rec.purchased)) errors.push('Sold cannot exceed purchased.');
    if (num(rec.unitCost) < 0 || num(rec.unitSell) < 0) errors.push('Unit cost and unit sell cannot be negative.');
  }
  if (rec.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(rec.date))) errors.push('Date must be YYYY-MM-DD.');
  return errors;
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
    </form>`;

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
        ${tabLink('sections', 'Sections')}${tabLink('theme', 'Theme &amp; colours')}
      </div>

      <div style="display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);align-items:start">
        <div>${tab === 'theme' ? themeBody : sectionsBody}</div>
        <div style="position:sticky;top:20px">${previewPane(session, device)}</div>
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
            <tr><td><strong>Flyhub</strong></td><td>Consolidator</td><td style="color:var(--muted)">no credentials issued</td></tr>
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
const todayISO = () => new Date().toISOString().slice(0, 10);

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
  return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;${tone}">${esc(CRM.CALL_STATUS[s] || s)}</span>`;
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
          <select name="status">${opt(Object.entries(CRM.CALL_STATUS), q.status, 'All')}</select></label>
        <label class="row" style="margin:0"><span class="lab">Disposition</span>
          <select name="disposition">${opt(Object.entries(CRM.DISPOSITION), q.disposition, 'All')}</select></label>
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
    ${sel('call_status', CRM.CALL_STATUS, lead.call_status, null)}
    <label class="row"><span class="lab">Last call date</span>
      <input type="date" name="last_call_date" value="${esc(lead.last_call_date || '')}"></label>
    ${sel('disposition', CRM.DISPOSITION, lead.disposition, '— none yet —')}
    ${sel('interest_level', CRM.INTEREST, lead.interest_level, '— not scored —')}
    ${sel('demo_scheduled', CRM.DEMO, lead.demo_scheduled, '— n/a —')}
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
                ${Object.entries(CRM.ACTIVITY_TYPE).filter(([k]) => k !== 'status_change')
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
               <td>${esc(CRM.ACTIVITY_TYPE[a.activity_type] || a.activity_type)}</td>
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

  const funnel = CRM.FUNNEL_ORDER.map((s) => ({ s, n: leads.filter((l) => l.call_status === s).length })).filter((r) => r.n > 0);
  const maxFunnel = Math.max(...funnel.map((r) => r.n), 1);

  const dispo = Object.entries(CRM.DISPOSITION)
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
                <a href="/crm?status=${esc(r.s)}" style="color:var(--ink);text-decoration:none">${esc(CRM.CALL_STATUS[r.s])}</a>
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
          <td>${esc(CRM.ACTIVITY_TYPE[a.activity_type] || a.activity_type)}</td>
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
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
        `ota_admin=${makeSession(user.email)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`
      );
    }

    if (!session) return redirect(res, '/login');

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
      return redirect(res, '/login', 'ota_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
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

    /* ---- accounting records: full CRUD ---- */

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

      const book = bookFile();
      const idx = (book[spec.key] || []).findIndex((r) => r.id === url.searchParams.get('id'));
      if (idx < 0) return send(res, 404, page({ title: 'Not found', session, body: '<h1>No record with that id</h1>' }));

      // reuse the storefront content editor's form engine on a single record
      const holder = { rec: JSON.parse(JSON.stringify(book[spec.key][idx])) };
      applyForm(holder, form);
      const next = holder.rec;

      const errors = validateBookRecord(spec, next);
      if (errors.length) return send(res, 422, bookEditView(session, book, spec, next, null, errors));

      book[spec.key][idx] = next;
      await writeJsonAtomic(path.join(CONTENT_DIR, 'accounting.json'), book);
      return redirect(res, `/books/edit?col=${encodeURIComponent(spec.key)}&id=${encodeURIComponent(next.id)}&saved=1`);
    }

    if (pathname === '/books/new' && req.method === 'POST') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));

      const book = bookFile();
      const rows = book[spec.key] || (book[spec.key] = []);
      const rec = rows.length ? blankLike(rows[rows.length - 1]) : { id: '', date: '' };
      rec.id = nextBookId(rows, spec.idPrefix);
      if ('no' in rec && spec.noPrefix && book.company) {
        rec.no = `${book.company[spec.noPrefix] || ''}${String(rows.length + 1).padStart(4, '0')}`;
      }
      if ('date' in rec) rec.date = new Date().toISOString().slice(0, 10);
      rows.push(rec);
      await writeJsonAtomic(path.join(CONTENT_DIR, 'accounting.json'), book);
      return redirect(res, `/books/edit?col=${encodeURIComponent(spec.key)}&id=${encodeURIComponent(rec.id)}`);
    }

    if (pathname === '/books/delete' && req.method === 'POST') {
      const spec = collSpec(url.searchParams.get('col'));
      if (!spec) return redirect(res, '/books');
      const form = parseForm(await readBody(req));
      if (form.csrf !== csrfFor(session)) return send(res, 403, page({ title: 'Blocked', session, body: '<h1>CSRF check failed</h1>' }));
      const remove = new Set([].concat(form.remove ?? []));
      if (remove.size) {
        const book = bookFile();
        book[spec.key] = (book[spec.key] || []).filter((r) => !remove.has(r.id));
        await writeJsonAtomic(path.join(CONTENT_DIR, 'accounting.json'), book);
      }
      return redirect(res, `/books/list?col=${encodeURIComponent(spec.key)}&saved=1`);
    }

    /* ---- design & integrations ---- */

    if (pathname === '/design' && req.method === 'GET') {
      const tab = url.searchParams.get('tab') === 'theme' ? 'theme' : 'sections';
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
      outcome: CRM.CALL_STATUS[candidate.call_status] || candidate.call_status,
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
  content._meta.lastEditedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
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
    if (Array.isArray(arr)) arr.push(arr.length ? blankLike(arr[0]) : '');
  }
}

server.listen(PORT, HOST, () => {
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
