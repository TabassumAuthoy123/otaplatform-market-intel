# B2C Storefront + Admin Portal

The B2C storefront is **not a separate app**. It lives inside the Market
Intelligence app as the `/portal` route group, reachable from the **B2C Portal ↗**
item in the dashboard nav bar. Only two processes run.

| Process | Port | Open | What it is |
|---|---|---|---|
| **Market Intelligence** (main app) | `3002` | http://localhost:3002 | Dashboard, agency database, segments — **and** `/portal`, the B2C storefront |
| **Admin portal** | `4001` | http://localhost:4001 | Email + password login. Content management for the storefront |
| OTAPlatform nginx | `8080` | http://localhost:8080 | Existing Laravel stack, untouched |
| OTAPlatform phpMyAdmin | `8081` | http://localhost:8081 | Existing |

`3002` rather than the app's canonical `3000` because on this machine `3000` is
held by an unrelated `@googlemaps/code-assist-mcp` process. `npm run dev` still
targets 3000 if you free it; `npm run dev:alt` is 3002.

Nothing here is public. The admin server binds `127.0.0.1` only, and every page
in the app sends `robots: noindex, nofollow`.

---

## Run it

Two terminals, from the project root
(`D:\authoy dev\otaplatform-market-intel\otaplatform-market-intel`):

```cmd
npm run dev:alt
```

```cmd
npm run admin
```

First compile of a route takes 5–60 seconds on Windows. After that it is
instant.

If you run the main app on a different port, tell admin where it is so its links
point at the right place:

```cmd
set APP_URL=http://localhost:3000
npm run admin
```

---

## Routes

**Dashboard** — `app/(dashboard)/`, chrome from `app/(dashboard)/layout.tsx`

| Route | Page |
|---|---|
| `/` | Dashboard — credential counts, donuts, cluster and district rollups, top 10 calls |
| `/agencies` | All 114 records, live filters, click-to-dial, CSV export |
| `/segments` | S1–S6 with live counts and disqualification rules |
| `/api/agencies` | JSON + CSV endpoint |

**B2C storefront** — `app/(portal)/portal/`, chrome from `app/(portal)/layout.tsx`

| Route | Page |
|---|---|
| `/portal` | Storefront home — hero + search, trust numbers, services, routes, packages, why, credentials, agent CTA |
| `/portal/flights` | Search + sample fares, filters by destination |
| `/portal/packages` | Hajj, Umrah and tour packages grouped by kind |
| `/portal/hotels` | Sample nightly rates |
| `/portal/visa` | Destinations and processing windows |
| `/portal/agents` | Platform tiers + demo-request form |
| `/portal/about` | Company facts and capability list |
| `/portal/contact` | Direct lines + form |
| `/api/enquiry` | POST target for the demo-request form |

Two route groups so each half keeps its own header and footer. `(dashboard)` and
`(portal)` are Next route groups — they do not appear in the URL. `app/layout.tsx`
is now just `<html><body>` plus the stylesheet.

Getting between them: **B2C Portal ↗** in the dashboard nav, and
**← Market Intelligence** in the dark strip at the top of every storefront page.

---

## Admin credentials

On first start the admin server creates one account and prints it to the
terminal:

```
email    admin@softifybd.com
password OtaAdmin@2026
```

Stored in `content/users.json` as a scrypt hash + salt — the plaintext is never
written anywhere. That file is **gitignored**.

### Change the password

```cmd
del content\users.json
set ADMIN_EMAIL=you@softifybd.com
set ADMIN_PASSWORD=your-new-password
npm run admin
```

The new account is seeded on that start and printed once.

> Change it before the CTO session. A default password that has been written
> down is not a password.

---

## How content editing works

```
content/site.json   <- every string, fare, route, package and link on /portal
       ^ writes                                    | reads on every request
  admin :4001                          app :3002  /portal
```

The `(portal)` layout and pages are all `dynamic = 'force-dynamic'` and read
`content/site.json` from disk per request. Edit in admin → **Save** → refresh the
`/portal` tab. No rebuild, no restart.

### Admin sections

| Section | Controls |
|---|---|
| Brand & contact | Name, hotline, email, office address |
| Announcement bar | The amber strip above the storefront header, on/off |
| Homepage hero | Headline, subtitle, both buttons, search tabs, badges |
| Navigation | Storefront menu items |
| Trust numbers | The four tiles under the hero |
| Services | The six "what you can book" cards |
| Flight routes | Sample fares on `/portal` and `/portal/flights` |
| Packages | Hajj, Umrah and tour packages with inclusion lists |
| Hotels | Sample nightly rates |
| Visa page | Destinations and processing windows |
| Why this platform | The six numbered reasons |
| Credentials | ISO / BASIS / DUNS strip |
| Payment methods | Footer chips |
| Testimonials | Empty by design — see the honesty note below |
| Agent CTA | The B2B block on `/portal` and `/portal/agents` |
| Agent tiers | Starter / Growth / Professional / Hajj |
| Pricing note | The paragraph under the tiers |
| About page | Company facts and the capability list |
| Contact page | Hotline, email, office |
| Footer | Blurb, link columns, legal, disclaimer |
| **Demo requests** | Submissions from the storefront's agent form |
| **Raw JSON** | Escape hatch — edit `site.json` directly, invalid JSON is rejected |

Editors are generated from the shape of the JSON:

- text and long text get inputs and textareas automatically
- numbers get number inputs, booleans get checkboxes
- lists of plain strings become one-per-line textareas
- lists of objects become numbered cards with a **delete** tick and an
  **+ Add item** button that clones the shape of the first row

Adding a field via Raw JSON makes it appear in its section form on the next
load. Nothing to wire up.

**Links must include the `/portal` prefix.** The nav, hero buttons and footer
columns in `site.json` all point at `/portal/flights`, `/portal/agents` and so
on. A link saved as `/flights` will 404 — that path belongs to nothing.

### Demo requests

The form on `/portal/agents` and `/portal/contact` POSTs to `/api/enquiry`,
which appends to `content/leads.json`. Admin lists them under **Demo requests**
with a delete action. That file is **gitignored** — it holds names and phone
numbers.

### What admin does *not* edit

The 114-agency dataset. That lives in `data/agencies.ts` as typed TypeScript and
is the dashboard's data, not storefront content. Editing it needs either the
Prisma path in [README.md](README.md) or a separate editor — say the word if you
want one.

---

## What came from the market pack

Content on the storefront is drawn from
`Softifybd-OTAPlatform-BD-Market-and-Target-Customer-Pack.docx`:

| Docx section | Where it landed |
|---|---|
| 2.1 Product identity | `/portal/about` company facts — office, hotline, product site, credentials, stack |
| 2.2 Technical capability inventory | `/portal/about` capability list. Only the ten **Live** rows are used |
| 5.1 Priority matrix | Shaped the agent tiers (S1 → Starter/Growth, S2 → Hajj tier, S3/S4 → Professional) |
| 6.5 Positioning statement | Hero subtitle and the "Why this platform" six |
| 7.3 Cluster C — Gulshan / Banani | **Not on the storefront.** Named agencies with phone numbers are internal sales data and this repo is public — it stays in the dashboard |
| 8.1–8.4 Database building, CRM schema | **Not on the storefront** — internal process, no consumer relevance |
| 9.5 Pricing framework | Tier structure only. Taka figures deliberately left off; `pricingNote` says pricing follows a discovery call |

### Section numbers that do not exist

The request listed 4.5 and 8.5 through 8.11. The docx does not have them —
section 4 stops at 4.2 (`Universe of buyers`, `TAM / SAM / SOM`) and section 8
stops at 8.4 (`Source priority order`, `one-day sprint`, `what to offer ATAB and
HAAB`, `CRM field schema`). Everything that does exist in 4 and 8 was read; none
of it belongs on a consumer storefront, so it stays on the dashboard side where
the audience is internal.

### Two honesty rules kept from the pack

Section 2.1 flags two credibility problems on the live OTA Platform page:
placeholder counters (`Businesses 0+`, `Client Satisfaction 0%`) and three
invented testimonials attributed to "CTO, Unknown Group". Neither is repeated:

1. **Trust numbers are real** — 3 GDS, 10+ years, 100+ team, 300+ projects, all
   from 2.1 and 2.2.
2. **`testimonials.items` ships empty.** The section does not render at all until
   someone adds a real, named, permission-granted quote in admin.

Sample fares and package prices **are** invented, and the storefront says so in
three places: the amber announcement bar, a chip on filtered flight results, and
the footer disclaimer.

---

## Not committed to git

```
content/users.json        password hash + salt
content/leads.json        captured names and phone numbers
content/.session-secret   HMAC key for session cookies
docs/                     market pack, target-customer deck, Sabre PNR logs
node_modules, .next
```

`content/site.json` **is** committed — it is the demo content, and the repo is
public by your decision. It contains no agency names, no phone numbers from the
target list and no taka pricing.

---

## Security notes for the admin portal

- Binds `127.0.0.1` only — not reachable from the office network. Changing
  `HOST` in `admin/server.js` would change that.
- Passwords hashed with scrypt (N=16384, r=8, p=1), verified with
  `timingSafeEqual`.
- Session cookie is HMAC-signed, `HttpOnly`, `SameSite=Strict`, 12-hour expiry.
- Per-session CSRF token on every POST.
- Ten failed logins from one address locks that address out for 15 minutes.
- Writes are atomic (temp file + rename), so a crash mid-save cannot truncate
  `site.json`.

Zero dependencies — Node's own `http`, `crypto` and `fs`. Nothing to install,
nothing native to compile on Windows.

This is a local demo tool, not a production CMS: no user management, no audit
trail beyond `_meta.lastEditedBy`, no backups. `site.json` is in git, so
`git checkout content/site.json` is the undo.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE :::3000` | `@googlemaps/code-assist-mcp` holds 3000 | Use `npm run dev:alt` (3002), or free 3000 first |
| `EADDRINUSE :::3002` or `:::4001` | Old server still alive | `npx kill-port 3002 4001` |
| Admin saves but the storefront looks unchanged | Browser cache | Hard refresh (Ctrl+Shift+R) |
| A storefront link 404s | Link in `site.json` missing the `/portal` prefix | Fix it in admin — `/portal/flights`, not `/flights` |
| Admin's "B2C storefront" link points at the wrong port | `APP_URL` not set | `set APP_URL=http://localhost:3000` before `npm run admin` |
| Admin login rejects the default password | `content/users.json` already exists with another account | Delete it and restart to reseed |
| App 500s with `ENOENT ... site.json` | Started from the wrong folder | Run from the project root — the loader resolves `content/site.json` against `process.cwd()` |
| Route hangs on "Compiling …" and never finishes | Stale/corrupt `.next` after a config change mid-compile | Stop the server, delete `.next`, start again |
| Demo request form errors | `content/` not writable | Check the folder exists and is not read-only |
