# OTA Platform — Softifybd

Four things in one Next.js app, plus a zero-dependency admin portal that drives
all of them.

| Area | Route | What it is |
|---|---|---|
| **Market Intelligence** | `/` | 400 researched B2B prospects — who to sell a white-label OTA to |
| **B2C storefront** | `/portal` | The consumer product: live Travelport flight search, booking, packages, hotels, visa |
| **Travel Accounts** | `/accounts` | Invoices, supplier bills, cash, bank, expenses, reports, statements |
| **Admin portal** | `:4001` | Sales CRM, content, section toggles, theme, API integrations |

> **New here? Read [GETTING-STARTED.md](GETTING-STARTED.md).** It explains the
> whole project from nothing — how to run it, where credentials go, how to
> change things, and an honest list of what is deliberately not built.

---

## Run it

```bash
npm install
```

```bash
npm run dev:alt
```

```bash
npm run admin
```

App on **http://localhost:3002**, admin on **http://localhost:4001**. The admin
prints its login to the terminal on first start — no password is written in this
repository.

`npm run dev` uses port 3000, which on this machine is taken by an unrelated
process, hence `dev:alt` on 3002.

---

## Travelport uAPI — live

Flight search on `/portal/flights` calls Travelport uAPI over SOAP and comes back
with real fares in about two seconds.

The one thing that cost days: **the Basic Auth username needs the service
prefix.**

```
uAPI3848278978-b1e674f7                 -> HTTP 401, SOAP faultcode 76
Universal API/uAPI3848278978-b1e674f7   -> HTTP 200
```

Same password, same endpoint, same PCC. If you ever see faultcode 76 again,
check the prefix before writing to Travelport.

Credentials live in `.env` — gitignored, never committed. `.env.example`
documents every variable. `lib/gds.ts` is the only place that talks to a GDS:
host, path, method and body all come from the environment, so a second supplier
is a block of variables and a response parser, not a rewrite.

### Booking flow

`/portal/flights` → **Select** → `/portal/book` → `/portal/booking?ref=…`

The fare is **re-priced against Travelport when you confirm**, matched on a
stable itinerary signature rather than Travelport's own key, which is
transaction-scoped and changes on every search. A stale fare gets a 409 and an
honest "search again", not a silent wrong price.

Every booking writes a confirmed invoice **and** the matching airline bill into
`content/accounting.json`, so the sale lands in receivables and the margin
report without anyone re-keying it. Selling price is what the customer accepted,
supplier cost is the base fare, and the difference is the agency's margin.

**Bookings are held, not ticketed.** Issuing needs AirCreateReservation and
AirTicketing, which are not wired. Every confirmation screen says so. Never tell
a passenger they are ticketed until that step exists.

---

## Admin portal — http://localhost:4001

| Screen | What it does |
|---|---|
| **Design & layout** | Show/hide any storefront section, six curated palettes plus per-colour pickers and font pairs — all beside a live desktop/tablet/mobile preview of the storefront |
| **API integrations** | Which Travelport variables are set (status only, never values) and a **Test connection** button that makes a real DAC–CGP search and reports status, latency and cheapest fare |
| **Sales CRM** | 400 prospects: lead list with nine filters and six saved views, lead detail with call logging, manager dashboard, and a Call Mode that serves one lead at a time |
| **Agency dataset** | Full CRUD over the researched records |
| **B2C content** | Twenty sections — every word, fare, package and link on the storefront |
| **Demo requests** | Enquiries captured from the storefront |

Colours work by CSS variable, so a palette change repaints the whole storefront
with no rebuild.

---

## The data

| File | Holds | Committed? |
|---|---|---|
| `content/crm-leads.json` | 400 prospects from TOAB, BAIRA, ATAB and the MoRA Hajj register | yes |
| `content/site.json` | Every word on the storefront, plus theme and section toggles | yes |
| `content/accounting.json` | Invoices, bills, receipts, payments, expenses | yes |
| `content/competitors.json` | 28 vendors profiled; only two publish a price | yes |
| `content/crm-activities.json` | Call notes about named individuals | **no** |
| `content/bookings.json` | Passenger names and passport numbers | **no** |
| `content/users.json`, `.session-secret`, `.env` | Credentials | **no** |

Nothing is stored twice. Every total — profit, balance, outstanding, coverage —
is derived from these files at request time, so a total can never drift from the
entries underneath it.

**Contact details are never reformatted.** The government registers print legacy
Dhaka landlines, emails with a comma instead of a dot and backslashes in
addresses. They are preserved deliberately — check the source URL on a lead
before disputing any field.

---

## Exports

`/api/crm/export?format=xlsx|docx|md|csv` — real files, not CSV in a costume.
The Excel workbook has five sheets (master leads, dial-ready call queue,
summary, by tier, per rep); the Word document is a prospect brief grouped by
priority. Every export honours the current filters, so "export what I am looking
at" works. Download buttons sit on `/agencies` and in the admin lead list.

---

## Honesty rule baked into the schema

Bangladesh publishes **no bulk IATA or licence register**, so the dashboard separates:

- **verified** — the number is published by the agency or confirmed on an official portal
- **inferred** — a strong public signal (own marketing, customer reviews) not yet confirmed
- **unknown** — must be asked on the qualifying call

Right now exactly **1 record is verified** (goFLY publishes IATA 42337956 / ATAB 4298 /
Civil Aviation 0007726). Everything else is inferred or unknown, and the UI says so.
Do not present an inferred credential to a client as a fact.

**To move records from inferred → verified:**

| Credential | Where | Bulk export? |
|---|---|---|
| Civil Aviation licence | `regtravelagency.gov.bd` (TAMS, Ministry of Civil Aviation & Tourism) | Search per agency; RTI request for the register |
| CAAB NOC | `caab.gov.bd` | No |
| IATA | IATA customer portal | No — per agency only |
| ATAB | `member.atab.org.bd/verify-member` | No |
| Hajj | `hajj.gov.bd` phase lists | **Yes — do this first, ~750 records** |

---

## Project structure

```
data/schema.ts          <- CANONICAL types, segments, clusters, label maps. Change here first.
data/agencies.ts        <- SEED ONLY. The curated original content/agencies.json came from
content/agencies.json   <- the live 114-record dataset. Written by the admin portal on :4001
lib/agencies.ts         <- runtime loader + derived TARGETS / EXCLUDED / STATS / PIPELINE
prisma/schema.prisma    <- Prisma mirror (MySQL 8): agencies, contacts, activities, deals, data_sources
db/schema.sql           <- plain MySQL DDL + 3 reporting views, for the dev/DBA team

app/layout.tsx          <- shell only: <html><body> + globals.css
app/(dashboard)/        <- Market Intelligence. Own nav + footer
  page.tsx              <- dashboard
  agencies/             <- database page
  segments/             <- segment explainer
app/(portal)/           <- B2C storefront. Own header + footer
  portal/               <- /portal, /portal/flights, packages, hotels, visa, agents, about, contact
app/api/agencies/       <- JSON + CSV endpoint
app/api/enquiry/        <- demo-request capture -> content/leads.json

components/             <- Nav, AgencyTable, ui primitives (StatCard, Donut, BarRow, chips)
components/portal/      <- storefront components: Header, Footer, SearchWidget, cards, ui, EnquiryForm
lib/content.ts          <- loads content/site.json for the storefront
content/site.json       <- all storefront copy. Written by the admin portal on :4001
admin/server.js         <- the admin portal. Zero dependencies, plain node
docs/                   <- source documents: market pack (docx), deck brief (md), rendered deck (pdf), Sabre API logs
```

---

## Wiring the real database

The dataset is a flat JSON file so the demo cannot break. When you want it in MySQL:

**Option A — Prisma (recommended)**

```bash
cp .env.example .env          # point DATABASE_URL at your MySQL
npx prisma migrate dev --name init
npx prisma studio             # browse/edit records in a GUI
```

**Option B — straight into the existing OTAPlatform MySQL container**

```bash
# run from the OTAPlatform folder — root password is 'root', host port is 3307
docker compose exec -T mysql mysql -uroot -proot < db/schema.sql
```

Three reporting views ship with the DDL:

- `v_credential_summary` — the headline dashboard numbers in one row
- `v_cluster_rollup` — agencies, A/B/C split and IATA count per cluster
- `v_call_sheet` — the dial-ready list: A and B priority, no existing platform

Once the DB is live, swap the file reads in `lib/agencies.ts` for Prisma queries.
Every page and the API route go through that one module, so nothing else changes — the schema is
identical.

---

## Data model, in one paragraph

`Agency` is the core record. It hangs off `Cluster` (which hangs off `District` →
`Division`) and off `Segment` (S1–S6, with an optional secondary segment for agencies that
span two, e.g. IATA **and** Hajj). Credentials are four independent `CredentialState`
enums plus their numbers, so verification progress is trackable per credential rather than
per agency. Commercial qualification lives on the agency (`salesMode`, `hasOwnPlatform`,
`monthlyBookings`, `subAgentCount`, `currentSupplier`). CRM state is `stage` +
`nextActionAt` + `ownerRep`, with `Contact` for people, `Activity` for the call log
(including an `objection` field to capture the prospect's own words), and `Deal` for tier
and value. `DataSource` records where every row came from, which is what makes the dataset
defensible when the CEO asks.

---

## Notes

- Phone numbers were captured from live public business listings on **29 July 2026**.
  Expect a 10–20% bounce rate; that is normal.
- `compliance_flag` exists for a reason: two records carry serious public allegations of
  misrepresenting Hajj hotel bookings. Escalate, never auto-onboard.
- Call window: **Sunday–Thursday, 11:00–13:00 and 15:00–17:00**. Almost every agency on
  this list closes Friday.

Internal — Sales & BD use only.
