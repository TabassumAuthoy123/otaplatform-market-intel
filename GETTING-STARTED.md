# Getting started — the whole project, explained simply

This file assumes you know nothing about the project. Read it top to bottom and
you will be able to run everything, change everything, and explain it to someone
else.

**There are no passwords in this file.** The repository is public. Where a
credential is needed, this file tells you which file it goes in and what the
variable is called. The values themselves live in files that git ignores.

---

## 1. What this project actually is

One Next.js web application with three areas, plus a small separate admin
program that edits its content.

```
                    ┌─────────────────────────────────────────┐
                    │   ONE web app  ·  http://localhost:3002 │
                    ├─────────────────────────────────────────┤
   /                │  Market Intelligence                    │  who to sell to
                    │  114 travel agencies, priorities, calls │
   /portal          │  B2C storefront                         │  what customers see
                    │  flights, Hajj/Umrah, hotels, visa      │
   /accounts        │  Travel Accounts                        │  where the money went
                    │  invoices, bills, cash, bank, reports   │
                    └─────────────────────────────────────────┘
                                      ▲
                                      │ reads JSON files
                                      │
                    ┌─────────────────┴───────────────────────┐
                    │   Admin portal  ·  http://localhost:4001│
                    │   logs in, edits those JSON files       │
                    └─────────────────────────────────────────┘
```

Think of it as **three notebooks and one pen**. The web app reads the notebooks
and shows them nicely. The admin portal is the pen — the only thing that writes.

The three notebooks:

| File | Holds | Feeds |
|---|---|---|
| `content/agencies.json` | 114 travel agencies we want to sell to | `/`, `/agencies`, `/segments` |
| `content/site.json` | Every word on the customer-facing storefront | `/portal` and its pages |
| `content/accounting.json` | Invoices, bills, receipts, payments, expenses | `/accounts` and its pages |

Nothing is stored twice. Every total you see — profit, balance, outstanding —
is calculated from these files at the moment you load the page. That is why a
change in the admin portal shows up on refresh with no rebuild, and why a total
can never quietly disagree with the entries underneath it.

---

## 2. Running it, from nothing

You need **Node.js 18.17 or newer**. Check with `node -v`.

**Step 1 — install dependencies.** Once, the first time.

```bash
npm install
```

**Step 2 — start the web app.** Leave this terminal open.

```bash
npm run dev:alt
```

Open **http://localhost:3002**

**Step 3 — start the admin portal.** A second terminal, also left open.

```bash
npm run admin
```

Open **http://localhost:4001**

That is everything. No database to install, no Docker needed, works offline.

### Why 3002 and not 3000?

`npm run dev` uses port 3000, which is the normal choice. On this machine port
3000 is occupied by an unrelated `@googlemaps/code-assist-mcp` process, so
`npm run dev:alt` runs on 3002 instead. If you free 3000, use `npm run dev` and
tell the admin portal where the app moved:

```bash
set APP_URL=http://localhost:3000
```

### The other stack on this machine

OTAPlatform (the Laravel product) runs in Docker and is completely separate.
Nothing here touches it.

| What | Port |
|---|---|
| OTAPlatform nginx | 8080 |
| OTAPlatform phpMyAdmin | 8081 |
| OTAPlatform MySQL | 3307 on the host, 3306 inside Docker |
| OTAPlatform Redis | 6379 |
| **This app** | **3002** |
| **This admin portal** | **4001** |

---

## 3. Logging in to the admin portal

The first time the admin portal starts it creates one account and **prints the
email and password into that terminal window**. Look at the terminal where you
ran `npm run admin`:

```
  OTA Platform — Admin content portal
  http://localhost:4001

  First run — admin account created:
    email    ...
    password ...
```

Copy them from there. They are not written in this file, and they are not in the
repository.

The account is stored in `content/users.json` as a scrypt hash plus a salt — the
password itself is never saved anywhere. That file is gitignored.

### Setting your own password

```bash
del content\users.json
set ADMIN_EMAIL=you@softifybd.com
set ADMIN_PASSWORD=your-strong-password
npm run admin
```

Deleting `users.json` makes the portal re-seed on the next start using those two
variables.

> Do this before showing anyone. A default password that has been shared in a
> chat, a screenshot or a document is not a password any more.

---

## 4. The three areas, one at a time

### 4.1 Market Intelligence — `/`

The original product. A researched list of 114 Bangladeshi travel agencies that
hold a licence but have no booking platform of their own, which makes them
candidates for OTA Platform.

| Page | What it shows |
|---|---|
| `/` | Headline counts, verified-vs-inferred credential donuts, cluster and district rollups, the top 10 to call, the do-not-call list |
| `/agencies` | All 114 records with live filters and CSV export |
| `/segments` | The six segments S1–S6, with counts and the rules for disqualifying a prospect |
| `/api/agencies` | The same data as JSON or CSV, for anyone who wants the raw file |

**The honesty rule.** Bangladesh publishes no bulk register of IATA numbers or
travel-agency licences. So every credential carries a state:

- **verified** — the agency publishes the number itself, or an official portal confirms it
- **inferred** — a strong public signal, not yet confirmed
- **unknown** — has to be asked on the qualifying call

Exactly one record is currently `verified`. The user interface says so on every
screen. Never present an inferred credential to a client as a fact.

### 4.2 B2C storefront — `/portal`

What a travel customer would see: flight fares, Hajj and Umrah packages, hotels,
visa processing, and a sign-up form for agencies who want to resell.

Reach it from **B2C Portal ↗** in the top navigation. Every storefront page has
**← Market Intelligence** at the very top to get back.

**Everything on it is editable** from the admin portal without touching code —
the headline, the buttons, the fares, the package inclusion lists, the footer
links, all of it.

Two deliberate honesty decisions:

1. **The fares are invented.** They are plausible sample figures, not live GDS
   results. The page says so in three places: the amber bar at the top, a chip
   on filtered flight results, and the footer.
2. **There are no testimonials.** The section does not render at all until
   someone adds a real, named, permission-granted quote. The market research
   document specifically flags the invented testimonials on the live company
   site ("CTO, Unknown Group") as a credibility problem, so this build does not
   repeat it.

### 4.3 Travel Accounts — `/accounts`

A travel-agency accounting system, built from the structure document. Reach it
from **Accounts ↗** in the top navigation.

| Page | Specification module | What it does |
|---|---|---|
| `/accounts` | 1 Dashboard | Today's sales, cash, bank, receivables, payables, expenses, profit; recent transactions; last 10 days; sales and expense breakdowns |
| `/accounts/invoices` | 2 Sales | Customer invoices with supplier cost and margin per invoice, plus every receipt |
| `/accounts/bills` | 3 Purchases | Supplier bills linked to the invoice they were bought for, plus payment vouchers |
| `/accounts/cash` | 4 Cash | Cash book with opening, movements, running balance, closing. Date filter |
| `/accounts/bank` | 5 Bank | The same per bank account. bKash is modelled as a bank |
| `/accounts/expenses` | 6 Expenses | Eight categories, breakdown chart, full register |
| `/accounts/reports` | 7 and 9 Reports | Profit & loss, trial balance, daily grid, outstanding receivable and payable, margin by service, top bookings by profit |
| `/accounts/statements` | 8 Statements | Running ledger for one customer or supplier |
| `/accounts/masters` | 10 Masters | Customers, suppliers, services, banks, categories, employees |
| `/accounts/settings` | 11 and 12 | Company details, document prefixes, the six user roles |
| `/accounts/gds` | Booking management | PNR lookup — see section 5 |

**The one number that matters in travel.** A ticket sold at ৳62,500 that cost
৳58,000 from the airline earned ৳4,500. Turnover is large and margin is thin, so
the system shows **cost and margin on every single invoice line**, not just a
sales total. `/accounts/reports` ranks bookings by gross profit for the same
reason.

**The workflow from the specification**, which the data follows:

```
Customer inquiry → Quotation → Confirmed invoice → Supplier booking →
Supplier bill → Customer payment → Supplier payment → Cash/Bank book →
Reports → Financial statements
```

**Where the numbers come from.** `content/accounting.json` was generated by
`scripts/seed-accounting.mjs` — 45 days of invented but internally consistent
trading, so every report has something to show. Roughly ৳2.4 crore of sales at
about a 7% gross margin, which is realistic for air ticketing. Re-running the
script overwrites the file, so do not run it once you have entered anything
real.

---

## 5. The GDS live check — `/accounts/gds`

Type a PNR (record locator). Two independent answers come back.

**The book half** always works. It finds that PNR on an invoice line and shows
the commercial picture: which customer, what it sold for, what it cost, the
margin, and whether they have paid. No GDS involved.

**The live half** calls Travelport. It is switched off until you configure it,
and the page says clearly which variables are missing.

### Turning the live half on

Copy `.env.example` to `.env` and fill in the GDS block:

```
GDS_BASE_URL="https://api.pp.travelport.com"
GDS_PNR_PATH="/v1/reservation/{locator}"
GDS_USERNAME="your-travelport-login-id"
GDS_PASSWORD="your-travelport-password"
```

Restart the app. `.env` is gitignored and will not be committed.

### Read this before wiring it

The endpoint above is **an example of the shape, not a verified Travelport
endpoint**. Travelport sells several APIs — the JSON APIs and the older uAPI
SOAP services — and the correct reservation path depends on which products your
agency is provisioned for. That has to be read off your own Travelport API
documentation.

Rather than hardcode a guess, the route takes the host and path from the
environment, adds HTTP Basic authentication, and hands back exactly what the
upstream returns: status code, body and all. Once the path is right it works. If
your product needs a POST with an XML envelope instead of a GET, that is a small
change in `app/api/gds/pnr/route.ts` and that is the only file to touch.

Two practical warnings:

1. **Preprod normally requires IP whitelisting.** A correct endpoint and correct
   credentials will still fail from an office connection Travelport does not
   know about. You will see a transport error, not a 401.
2. **A Travelport password that has been shared in a screenshot or a chat should
   be rotated.** Those emails say the password does not expire, which means it
   stays valid until someone changes it deliberately.

The password is read from the environment, sent upstream, and never logged,
never returned to the browser, and never written to disk.

---

## 6. Where credentials go

| Credential | Lives in | In git? |
|---|---|---|
| Admin portal login | `content/users.json`, as a scrypt hash | **No** |
| Admin session key | `content/.session-secret` | **No** |
| Travelport / GDS | `.env` | **No** |
| MySQL connection | `.env` | **No** |
| Captured demo requests | `content/leads.json` | **No** |

All five are in `.gitignore`. `.env.example` documents the variable names with
placeholder values, which is the file you read to know what to fill in.

**Nothing above is ever committed.** If you find yourself about to paste a real
password into a file that git tracks, stop — that is the mistake this layout
exists to prevent.

---

## 7. How to change things

### Change words, prices, packages, agencies

Use the admin portal. No code, no restart.

1. Open http://localhost:4001 and sign in
2. Pick a section from the left sidebar
3. Edit, press **Save**
4. Refresh the app tab — the change is there

| Sidebar section | Changes |
|---|---|
| **Agency dataset** | The 114 agencies: search, filter, edit any of 32 fields, add, delete |
| **B2C storefront** (20 sections) | Every word, fare, package and link on `/portal` |
| **Demo requests** | Enquiries submitted from the storefront |
| **Raw JSON** | Direct edit of `site.json`, with invalid JSON rejected |

The edit forms are generated from the shape of the JSON, so a new field added
through Raw JSON appears as a form input on the next page load with no wiring.

### Change how something looks or calculates

That is code.

| To change | Edit |
|---|---|
| Dashboard layout or charts | `app/(dashboard)/page.tsx` |
| Storefront pages | `app/(portal)/portal/**` |
| Accounting pages | `app/(accounts)/accounts/**` |
| Any accounting calculation | `lib/accounting.ts` — every total in one file |
| Agency totals | `lib/agencies.ts` |
| Colours, spacing, fonts | `tailwind.config.ts` and `app/globals.css` |
| Admin portal | `admin/server.js`, field list in `admin/agency-fields.js` |

---

## 8. Project layout

```
app/
  layout.tsx              the html/body shell and the stylesheet, nothing else
  (dashboard)/            Market Intelligence — its own nav and footer
  (portal)/portal/        B2C storefront — its own header and footer
  (accounts)/accounts/    Travel Accounts — its own nav
  api/agencies/           agency JSON and CSV
  api/enquiry/            storefront demo-request capture
  api/gds/pnr/            PNR lookup, local + live

components/               dashboard components
components/portal/        storefront components
components/accounts/      accounting components

lib/agencies.ts           loads content/agencies.json, derives the counts
lib/content.ts            loads content/site.json
lib/accounting.ts         loads content/accounting.json, derives every total

content/                  the three JSON notebooks (plus gitignored secrets)
admin/server.js           the admin portal, zero dependencies
scripts/                  one-off seed scripts
data/schema.ts            canonical types, segments, clusters
data/agencies.ts          the curated seed the agency JSON came from
docs/                     source research documents (gitignored)
```

`(dashboard)`, `(portal)` and `(accounts)` are Next.js **route groups**. The
brackets mean the folder name does not appear in the URL — it exists only so
each area can have its own header and footer. That is why the dashboard is at
`/` and not at `/dashboard`.

---

## 9. Honest limitations

Written down deliberately. Do not discover these in front of a client.

**Accounting**

- Single-entry with derived control accounts, **not** double-entry. The trial
  balance is a position summary derived from the vouchers, not from posted
  journal lines, so it does not prove ledger integrity the way real double-entry
  would. It does now carry an explicit **Difference** row which must read zero —
  it read ৳8,67,000 during the build because purchases were taken from live
  invoice lines while payables came from every bill raised, and bills against
  cancelled invoices fell down the gap. Purchases now come from the bills. If
  that row is ever non-zero again, something in the data is wrong.
- No credit notes, no refunds, no cancellations processed yet — the specification
  lists them and the data structure has a place for them, but the screens are not
  built.
- No multi-currency. Everything is BDT. The field exists; the conversion does not.
- VAT is wired through the calculation but set to 0%.
- No PDF or Excel export.
- The book is generated sample data, not real trading.

**Admin and security**

- **One login, no roles.** The six roles are described on the settings page and
  stored in the book, but nothing is enforced. Anyone who reaches the admin
  portal can edit everything. Fine for a local demo; not fine for real users.
- No audit trail on content edits beyond who saved last and when.
- No backups. `git checkout content/…` is the undo.
- The admin portal binds `127.0.0.1` only, so it is not reachable from the
  office network. Do not change that without thinking about it.

**GDS**

- The live half has never been run against Travelport from here, because no
  credentials are configured. The transport, authentication and error handling
  are written and the code path is exercised; the endpoint contract is not
  verified.

**General**

- Data lives in JSON files, not a database. Correct for a single-user local demo,
  wrong for concurrent users — two people saving at the same time is a
  last-write-wins race.
- Storefront fares and accounting figures are invented sample data throughout.

---

## 10. Moving to a real database

The Prisma schema and plain SQL are already written for MySQL 8:
`prisma/schema.prisma` and `db/schema.sql`.

Every page reads its data through exactly one module — `lib/agencies.ts`,
`lib/content.ts`, `lib/accounting.ts`. Swapping the file reads in those three
files for database queries is the whole migration. No page changes.

To create the tables inside the existing OTAPlatform MySQL container, run from
the OTAPlatform folder:

```bash
docker compose exec -T mysql mysql -uroot -proot < db/schema.sql
```

That creates a separate `ota_market_intel` database. The existing `otaplatform`
database is untouched.

---

## 11. If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE :::3000` | Something else holds port 3000 | Use `npm run dev:alt` |
| `EADDRINUSE :::3002` or `:::4001` | An old server is still alive | `npx kill-port 3002 4001` |
| A page hangs on "Compiling…" forever | Corrupt `.next` cache, usually after a config change mid-compile | Stop the server, delete `.next`, start again |
| Admin saves but the page looks the same | Browser cache | Hard refresh with Ctrl+Shift+R |
| A storefront link gives 404 | Link in `site.json` missing the `/portal` prefix | Fix it in admin — `/portal/flights`, not `/flights` |
| Admin's links point at the wrong port | `APP_URL` not set | `set APP_URL=http://localhost:3000` before `npm run admin` |
| Admin rejects the password | `content/users.json` already exists from an earlier run | Delete it and restart to re-seed |
| `ENOENT ... .json` | Started from the wrong folder | Run from the project root; loaders resolve against `process.cwd()` |
| GDS check says "not configured" | No `.env`, or the GDS block is commented out | Section 5 |
| GDS check gives a transport error | Wrong host, or your IP is not whitelisted with Travelport | Section 5 |

---

## 12. Where to look next

- [README.md](README.md) — the Market Intelligence dataset and its research method
- [B2C-ADMIN.md](B2C-ADMIN.md) — the storefront and admin portal in detail
- [DOCKER.md](DOCKER.md) — running alongside the OTAPlatform Docker stack
- `data/schema.ts` — the canonical shape of an agency record; change types here first
- `lib/accounting.ts` — every accounting calculation, with the reasoning in comments

Internal build. Not for public hosting.
