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

const ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const SITE_FILE = path.join(CONTENT_DIR, 'site.json');
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
        <div class="sep">Content</div>
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

function dashboardView(session, content, leadCount, flash) {
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
          <div class="tile"><strong class="tnum">${counts.routes}</strong><span>Flight routes</span></div>
          <div class="tile"><strong class="tnum">${counts.packages}</strong><span>Packages</span></div>
          <div class="tile"><strong class="tnum">${counts.hotels}</strong><span>Hotels</span></div>
          <div class="tile"><strong class="tnum">${leadCount}</strong><span>Demo requests</span></div>
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
      return send(res, 200, dashboardView(session, content, leads.length, url.searchParams.get('saved') ? 'Saved.' : null));
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
