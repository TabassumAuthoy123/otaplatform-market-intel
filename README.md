# OTA Platform — Softifybd

Four things in one Next.js app, plus a zero-dependency admin portal that drives
all of them.

| Area | Route | What it is |
|---|---|---|
| **Market Intelligence** | `/` | 400 researched B2B prospects — who to sell a white-label OTA to |
| **B2C storefront** | `/portal` | The consumer product: live Travelport **and Sabre** flight search merged into one list, booking, packages, hotels, visa |
| **Travel Accounts** | `/accounts` | Invoices, credit notes, supplier bills, cash, bank, expenses, inventory, reports, statements — all writable, all exportable |
| **Admin portal** | `:4001` | Sales CRM, full accounting CRUD, six enforced roles, content, section toggles, theme, API integrations |

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

## Two GDS, one search — Travelport and Sabre, both live

`/portal/flights` asks **Travelport uAPI** and **Sabre** at the same time and
merges the answers into one list, cheapest first, each card labelled with the
supplier that quoted it. DAC–DXB returns 26 fares across the two.

They are queried in parallel, not one after the other, so the page waits for the
slower of them once rather than twice. A supplier that is down or unconfigured
contributes nothing and says why in its own status panel instead of taking the
whole search with it.

`lib/offers.ts` is the seam: one `Offer` type both suppliers normalise into, so
nothing downstream knows or cares which GDS a fare came from. Signatures are
namespaced `tp:` and `sb:`, which is what guarantees a fare is re-priced against
the supplier that quoted it — a Sabre fare can never be confirmed against a
Travelport quote at a different price. A signature with any other prefix is
refused with a 422.

**Flyhub is out of scope and is not being integrated.**

### Travelport

The one thing that cost days: **the Basic Auth username needs the service
prefix.**

```
uAPI3848278978-b1e674f7                 -> HTTP 401, SOAP faultcode 76
Universal API/uAPI3848278978-b1e674f7   -> HTTP 200
```

Same password, same endpoint, same PCC. If you ever see faultcode 76 again,
check the prefix before writing to Travelport.

### Sabre

Two things about Sabre that are not obvious from the documentation:

**The token request is double base64.** Not `base64(user:pass)` — each half is
base64'd first, then the pair is base64'd again:

```
Authorization: Basic base64( base64(user) + ":" + base64(pass) )
```

**`baseFareAmount` is quoted in the fare CONSTRUCTION currency, not the currency
of the total.** A DAC–DXB itinerary came back as base 143 with tax 16,663
against a total of 34,300, because the 143 was USD. Adding those gives a number
that is simply wrong. `lib/sabre.ts` takes base as **total minus tax**, which is
in one currency by definition and always reconciles.

A search that returns zero fares is not always a failure. Sabre's certification
environment has no inventory on DAC→CGP while DAC→DXB returns twenty; the status
panel says "answered normally with nothing" rather than pretending it broke.

Credentials live in `.env` — gitignored, never committed. `.env.example`
documents every variable. `lib/gds.ts` and `lib/sabre.ts` are the only places
that talk to a GDS: host, path, method and body all come from the environment,
so a third supplier is a block of variables and a response parser, not a
rewrite.

### Booking flow

`/portal/flights` → **Select** → `/portal/book` → `/portal/booking?ref=…`

The fare is **re-priced against the supplier that quoted it when you confirm**,
matched on the namespaced itinerary signature rather than the GDS's own key,
which is transaction-scoped and changes on every search. A stale fare gets a 409
and an honest "search again", not a silent wrong price.

Every booking writes a confirmed invoice **and** the matching airline bill into
`content/accounting.json`, so the sale lands in receivables and the margin
report without anyone re-keying it.

**Supplier cost is the whole fare, not the base.** The agency remits base plus
taxes to the airline and keeps its service charge. Booking the base as cost and
the full price as revenue reports the tax as margin — on one DAC–DXB ticket that
produced a 35,657 "profit" on a 35,800 sale. Margin is now exactly what the
agency added: the same booking reports 1,500, which is the service charge and
nothing else. A fictional margin does not stay on one screen; it flows into the
P&L, the margin-by-service report and every commission figure built on them.

**Bookings are held, not ticketed** — and this is an account entitlement
problem, not a code problem. Both suppliers refuse to create a PNR on the
credentials we hold:

| | Call | Answer |
|---|---|---|
| Travelport | `AirCreateReservationReq` | uAPI **1201** — element not routable |
| Sabre | `POST /v2.5.0/passenger/records` | **ERR.2SG.SEC.NOT_AUTHORIZED** |

Search and revalidate work on both. No payload will issue a ticket until Sabre
switches on booking for PCC `S00L` and Travelport makes `AirCreateReservationReq`
routable for PCC `3BX8` / branch `P7251392`. Production credentials are empty in
both database tables. Every confirmation screen says the booking is held. Never
tell a passenger they are ticketed until that step exists.

---

## Admin portal — http://localhost:4001

| Screen | What it does |
|---|---|
| **Design & layout** | Show/hide any storefront section, six curated palettes plus per-colour pickers and font pairs — all beside a live desktop/tablet/mobile preview of the storefront |
| **API integrations** | Which Travelport and Sabre variables are set (status only, never values) and a **Test connection** button that makes a real search and reports status, latency and cheapest fare |
| **Accounting records** | Create, edit and delete every voucher and master across 14 collections — invoices, receipts, credit notes, bills, payments, expenses, deposits, inventory and the six master lists |
| **Users & roles** | Six roles, enforced at the route before any handler runs |
| **Sales CRM** | 400 prospects: lead list with nine filters and six saved views, lead detail with call logging, manager dashboard, and a Call Mode that serves one lead at a time |
| **Agency dataset** | Full CRUD over the researched records |
| **B2C content** | Twenty sections — every word, fare, package and link on the storefront |
| **Demo requests** | Enquiries captured from the storefront |

Colours work by CSS variable, so a palette change repaints the whole storefront
with no rebuild.

---

## Roles, enforced

Six roles from the accounting specification. They used to be described on a
settings page and not enforced — one login could do everything. `admin/roles.js`
is the enforcement, and two rules matter:

**Guarding happens at the route, not in the sidebar.** Hiding a link stops
somebody clicking it; it does not stop them typing the URL or replaying a form
post. Every request is checked before any handler runs.

**Anything not explicitly allowed is denied.** A new route is inaccessible to
every non-super-admin until somebody maps it on purpose, which is the safe
direction for a mistake to fall.

| Role | Can |
|---|---|
| Super Admin | Everything, including settings and user management |
| Accountant | All vouchers, credit notes, reports and statements. No settings, no users |
| Sales Executive | Prospect queue, invoices and customer receipts |
| Operations Staff | Supplier bookings, bills, payments and stock only |
| Manager | Read everything, reassign leads, approve cancellations |
| Read Only | Reports and statements. Nothing editable anywhere |

**A Sales Executive can raise an invoice but cannot reverse one.** Credit notes
are a separate capability held by Accountant, Manager and Super Admin, because
the person who made the sale should not be the person who cancels it.

---

## Credit notes and cancellations

`/accounts/credit-notes` reports them; the admin portal writes them.

A credit note reverses part or all of a sale, and the field that does the real
work is **settlement**:

| Settlement | What happens |
|---|---|
| `credit_balance` | The customer had not paid. The receivable simply drops. **No money moves.** |
| any pay method | The customer had already paid. The amount leaves cash or that bank account on the credit note's date. |

Exactly one of those happens. Getting it wrong is how a book double-counts a
refund — reducing the receivable *and* paying the money out for the same credit.

`supplierRefund` is the other half of a cancellation: what the airline gives back
on the bill behind the sale. It comes off the payable, so a cancelled ticket
leaves no phantom debt to the carrier.

The book refuses, at the point of writing:

- a credit larger than the invoice, counting every other credit already raised
  against it, so three small notes cannot do what one large one is refused;
- an unsettled credit larger than what the customer still owes;
- a refund larger than what was actually received — you cannot refund money that
  never arrived;
- a supplier refund larger than what is still outstanding on the bill. Money
  coming back on an already-settled bill is a supplier deposit, not a credit
  note.

Those limits are not bureaucracy. Each one keeps a control account from going
negative, which is what keeps the trial balance true — verified with credit
notes of all three shapes on the seeded book, difference still zero.

A credit note for the full invoice value marks that invoice cancelled
**everywhere**: it drops out of revenue, cost, margin, the sales-by-service
report, the per-booking margin list and the receivables chase list. The stored
status field is a label; where it and the money disagree, the money wins.

---

## The data

| File | Holds | Committed? |
|---|---|---|
| `content/crm-leads.json` | 400 prospects from TOAB, BAIRA, ATAB and the MoRA Hajj register | yes |
| `content/site.json` | Every word on the storefront, plus theme and section toggles | yes |
| `content/accounting.json` | Invoices, credit notes, bills, receipts, payments, expenses, deposits, inventory | yes |
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

Two export endpoints, both producing real files rather than CSV in a costume.

### `/api/accounts/export?format=xlsx|docx|md|csv`

The whole book. The Excel workbook has **sixteen sheets** — summary, P&L, trial
balance, invoices, receipts, credit notes, bills, payments, expenses,
receivables, payables, cash and bank, sales by service, expenses by category,
inventory and supplier deposits. The Word version is a management accounts pack;
Word cannot scroll sideways, so a very wide ledger is trimmed to eight columns
**and says so in the document** rather than reading as complete when it is not.

`&from=` and `&to=` narrow the period, and `&section=creditNotes` narrows to one
ledger. Period filters apply to the vouchers and everything derived from them;
balances that are only true at a point in time — receivables, payables, bank
closings, the trial balance — are always as at today and labelled that way,
because a receivable "for March" is not a thing.

All four formats are built from one derivation, so the Excel and the Word cannot
disagree about a figure. Download buttons sit on `/accounts/reports`,
`/accounts/invoices` and `/accounts/credit-notes`.

### `/api/crm/export?format=xlsx|docx|md|csv`
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
app/(accounts)/         <- Travel Accounts. Own nav
  accounts/             <- dashboard, invoices, credit-notes, bills, cash, bank, expenses,
                           inventory, reports, statements, masters, gds, settings
app/api/agencies/       <- JSON + CSV endpoint
app/api/accounts/export <- the whole book as xlsx / docx / md / csv
app/api/crm/export      <- the prospect database, same four formats
app/api/enquiry/        <- demo-request capture -> content/leads.json

components/             <- Nav, AgencyTable, ui primitives (StatCard, Donut, BarRow, chips)
components/portal/      <- storefront components: Header, Footer, SearchWidget, cards, ui, EnquiryForm
lib/accounting.ts       <- every accounting figure, derived at request time. No stored totals
lib/offers.ts           <- one Offer type both GDS normalise into; namespaced tp:/sb: signatures
lib/gds.ts              <- Travelport uAPI transport + SOAP parsing
lib/sabre.ts            <- Sabre auth (double base64), BFM search, fault diagnosis
lib/bookings.ts         <- held bookings; posts the invoice and supplier bill into the book
lib/content.ts          <- loads content/site.json for the storefront
content/site.json       <- all storefront copy. Written by the admin portal on :4001
admin/server.js         <- the admin portal. Zero dependencies, plain node
admin/roles.js          <- capabilities -> roles -> route map. Checked before every handler
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
