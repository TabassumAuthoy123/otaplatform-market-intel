# B2C Portal + Admin Portal — local demo

Two apps added alongside the market-intelligence dashboard, for the CTO walkthrough.

| App | Port | Open | Purpose |
|---|---|---|---|
| **B2C storefront** | `3001` | http://localhost:3001 | Consumer-facing OTA Platform portal — flights, Hajj/Umrah, hotels, visa, agent signup |
| **Admin portal** | `4001` | http://localhost:4001 | Email + password login. Edits every string on the B2C portal |
| Market Intelligence dashboard | `3002` | http://localhost:3002 | The existing 114-agency lead dashboard (moved off 3001) |
| OTAPlatform nginx | `8080` | http://localhost:8080 | Existing Laravel stack |
| OTAPlatform phpMyAdmin | `8081` | http://localhost:8081 | Existing |

Nothing here is public. The admin server binds `127.0.0.1` only, and the B2C
pages carry `robots: noindex, nofollow`.

---

## Run it

Three terminals, from the project root
(`D:\authoy dev\otaplatform-market-intel\otaplatform-market-intel`):

```cmd
npm run b2c
```

```cmd
npm run admin
```

```cmd
npm run dev:alt
```

`npm run b2c` needs its dependencies once:

```cmd
npm run b2c:install
```

First compile of the B2C portal takes 20–60 seconds on Windows. After that it
is instant.

---

## Admin credentials

On first start the admin server creates one account and prints it to the
terminal:

```
email    admin@softifybd.com
password OtaAdmin@2026
```

The account lives in `content/users.json` as a scrypt hash + salt — the
plaintext is never stored. That file is **gitignored**, so it does not reach
GitHub.

### Change the password

```cmd
del content\users.json
set ADMIN_EMAIL=you@softifybd.com
set ADMIN_PASSWORD=your-new-password
node admin\server.js
```

The new account is seeded on that start and printed once. Delete the file again
to redo it.

> Change it before the CTO session if anyone else has seen this file. A default
> password in a repo is a default password.

---

## How the content editing works

```
content/site.json   <- every string, price, route, package and link on the B2C portal
       ↑ writes                              ↓ reads on every request
  admin :4001                           b2c :3001
```

The B2C pages are all `dynamic = 'force-dynamic'` and read `site.json` from disk
per request. So: edit in admin → **Save** → refresh the B2C tab → the change is
there. No rebuild, no restart.

### Admin sections

| Section | Controls |
|---|---|
| Brand & contact | Name, hotline, email, office address |
| Announcement bar | The amber strip above the header, on/off |
| Homepage hero | Headline, subtitle, both buttons, search tabs, badges |
| Navigation | Header menu items |
| Trust numbers | The four tiles under the hero |
| Services | The six "what you can book" cards |
| Flight routes | Sample fares on `/` and `/flights` |
| Packages | Hajj, Umrah and tour packages with inclusion lists |
| Hotels | Sample nightly rates |
| Visa page | Destinations and processing windows |
| Why this platform | The six numbered reasons |
| Credentials | ISO / BASIS / DUNS strip |
| Payment methods | Footer chips |
| Testimonials | Empty by design — see the honesty note below |
| Agent CTA | The B2B block on `/` and `/agents` |
| Agent tiers | Starter / Growth / Professional / Hajj |
| Pricing note | The paragraph under the tiers |
| About page | Company facts and the capability list |
| Contact page | Hotline, email, office |
| Footer | Blurb, link columns, legal, disclaimer |
| **Demo requests** | Submissions from the agent form on the B2C portal |
| **Raw JSON** | Escape hatch — edit `site.json` directly, invalid JSON is rejected |

Editors are generated from the shape of the JSON, so:

- text and long text get inputs and textareas automatically
- numbers get number inputs, booleans get checkboxes
- lists of plain strings become one-per-line textareas
- lists of objects become numbered cards with a **delete** tick and an
  **+ Add item** button that clones the shape of the first row

Adding a field to `site.json` (via Raw JSON) makes it appear in the section form
on the next load. Nothing to wire up.

### Demo requests

The form on `/agents` and `/contact` POSTs to `/api/enquiry`, which appends to
`content/leads.json`. Admin lists them under **Demo requests** with a delete
action. That file is **gitignored** — it holds names and phone numbers.

---

## What came from the market pack

Content on the B2C portal is drawn from
`Softifybd-OTAPlatform-BD-Market-and-Target-Customer-Pack.docx`:

| Docx section | Where it landed |
|---|---|
| 2.1 Product identity | `/about` company facts — office, hotline, product site, credentials, stack |
| 2.2 Technical capability inventory | `/about` capability list. Only the ten **Live** rows are used |
| 5.1 Priority matrix | Shaped the agent tiers on `/agents` (S1 → Starter/Growth, S2 → Hajj tier, S3/S4 → Professional) |
| 6.5 Positioning statement | Hero subtitle, and the "Why this platform" six |
| 7.3 Cluster C — Gulshan / Banani | **Not used on the consumer portal.** Named agencies with phone numbers are internal sales data, and this repo is public |
| 8.1–8.4 Database building, CRM schema | **Not used on the consumer portal** — internal process, no consumer relevance |
| 9.5 Pricing framework | Tier structure only. Taka figures are deliberately left off; `pricingNote` says pricing follows a discovery call |

### Section numbers that do not exist

The request listed 4.5 and 8.5 through 8.11. The docx does not have them —
section 4 stops at 4.2 (`Universe of buyers`, `TAM / SAM / SOM`) and section 8
stops at 8.4 (`Source priority order`, `one-day sprint`, `what to offer ATAB and
HAAB`, `CRM field schema`). Everything that does exist in 4 and 8 was reviewed;
none of it belongs on a consumer storefront, so it is in the dashboard on 3002
instead, where the audience is internal.

### Two honesty rules kept from the pack

Section 2.1 flags two credibility problems on the live OTA Platform page:
placeholder counters (`Businesses 0+`, `Client Satisfaction 0%`) and three
invented testimonials attributed to "CTO, Unknown Group". Neither is repeated
here:

1. **Trust numbers are real** — 3 GDS, 10+ years, 100+ team, 300+ projects, all
   from 2.1 and 2.2.
2. **`testimonials.items` ships empty.** The section does not render at all
   until someone adds a real, named, permission-granted quote in admin. Do not
   fill it with placeholders.

Sample fares and package prices **are** invented, and every page says so — the
amber announcement bar, a chip on filtered flight results, and the footer
disclaimer.

---

## Not committed to git

```
content/users.json        password hash + salt
content/leads.json        captured names and phone numbers
content/.session-secret   HMAC key for session cookies
docs/                     market pack, target-customer deck, Sabre PNR logs
b2c/node_modules, b2c/.next
```

`content/site.json` **is** committed — it is the demo content, and the repo is
public by your decision. It contains no agency names, no phone numbers from the
target list and no taka pricing.

---

## Security notes for the admin portal

- Binds `127.0.0.1` only — not reachable from the office network. Changing
  `HOST` in `admin/server.js` would change that; do not, without a reason.
- Passwords hashed with scrypt (N=16384, r=8, p=1), verified with
  `timingSafeEqual`.
- Session cookie is HMAC-signed, `HttpOnly`, `SameSite=Strict`, 12-hour expiry.
- Every POST carries a per-session CSRF token.
- Ten failed logins from one address locks that address out for 15 minutes.
- Writes are atomic (temp file + rename), so a crash mid-save cannot leave
  `site.json` truncated.

This is a local demo tool, not a production CMS. It has no user management, no
audit trail on content edits beyond `_meta.lastEditedBy`, and no backups —
`site.json` is in git, so `git checkout content/site.json` is the undo.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE :::3001` | Something else on 3001 | `npx kill-port 3001`, or check what holds it: `Get-NetTCPConnection -LocalPort 3001 -State Listen` |
| Admin saves but B2C looks unchanged | Browser cache | Hard refresh (Ctrl+Shift+R). The pages are `force-dynamic`, so a normal refresh should be enough |
| `Cannot find module` on `npm run b2c` | Dependencies not installed | `npm run b2c:install` |
| Admin login rejects the default password | `content/users.json` already existed with a different account | Delete it and restart to reseed |
| B2C 500s with `ENOENT ... site.json` | Started from the wrong folder | The b2c app resolves `../content/site.json` from its own directory — run it via `npm run b2c` from the root, or `npm run dev` from inside `b2c/` |
| Demo request form errors | `content/` not writable | Check the folder exists and is not read-only |
