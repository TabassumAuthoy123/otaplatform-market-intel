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

### Ticketing — built, and refused

`lib/ticketing.ts` creates the PNR, issues the ticket, voids it and refunds it,
on either supplier. It is real code that runs against the real endpoints, and
`/accounts/gds` executes it on every page load so the status below can never go
stale.

Both suppliers refuse, and the refusals are the point:

| | Call | Answer |
|---|---|---|
| Travelport | `AirCreateReservationReq` on `/uAPI/AirService` | uAPI **8236** — *"No provider/supplier is configured for this user for the requested transaction"* |
| Sabre | `POST /v2.5.0/passenger/records` | HTTP 403 **ERR.2SG.SEC.NOT_AUTHORIZED** — *"Authorization failed due to no access privileges"* |

8236 is the useful one: it can only be reached by a request that has already
parsed, routed and validated. The payload is right; the account has no booking
provider. Sabre's 403 comes back on the same credentials search uses all day,
which is what makes it entitlement rather than authentication.

To unblock: **Travelport** must enable a booking provider for PCC `3BX8` on
branch `P7251392`; **Sabre** must enable booking and ticketing on PCC `S00L`.
Both are still certification credentials — production credentials are empty in
both database tables.

Three things this cost, worth knowing before touching that file:

- `AirCreateReservationReq` goes to **AirService**, not UniversalRecordService.
  The latter answers a Tomcat 404 page for it; the former validates it properly.
- uAPI rejects `AuthorizedBy="OTA Platform"` outright — *"may only contain
  letters and numbers"* — and reports it as **1005 Unable to parse XML stream**.
  Read as a refusal that looks like the booking block. The raw fault is kept on
  every result for exactly this reason.
- The first version grew its own copy of Sabre's auth and invented two
  environment variables that do not exist, so it 401'd on working credentials.
  `lib/sabre.ts` owns the handshake; ticketing calls into it.

Every confirmation screen says the booking is held. Never tell a passenger they
are ticketed until entitlement is granted.

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

## Against the accounting specification

Every line of `Travel_Tourism_Accounting_Software_Structure.docx`, and where it
lives. Marked honestly: **built** means you can use it now, **partial** says what
is missing, **config only** means the settings exist but nothing sends.

| § | Specification | State | Where |
|---|---|---|---|
| 1 | Dashboard — today's sales, cash, bank, pending in and out, expenses, profit, recent transactions, quick actions | built | `/accounts` |
| 2 | Quotation → confirmed invoice, five statuses, receipts, five payment methods, receipt voucher | built | `/accounts/invoices` |
| 2 | Customer credit note — refund, cancellation, adjustment | built | `/accounts/credit-notes` |
| 3 | Supplier booking, supplier invoice, three statuses, payment voucher | built | `/accounts/bills` |
| 3 | Supplier credit note | built | admin → Supplier credit notes |
| 4 | Daily cash receipt, cash payment, cash book with opening/closing | built | `/accounts/cash` |
| 5 | Bank receipts, payments, **deposit, withdrawal**, bank book | built | `/accounts/bank` |
| 6 | Eight expense categories | built | `/accounts/expenses` |
| 7 | Daily sales / cash / bank / expense / profit, supplier payment, customer collection, outstanding both ways | built | `/accounts/reports` |
| 8 | Customer, supplier, cash, bank and company statements; daily → yearly and custom filters | built | `/accounts/statements`, `/accounts/financials` |
| 9 | Sales, profit, expense, supplier, customer, commission, outstanding both ways | built | `/accounts/reports` |
| 9 | **Cancelled booking report, refund report** | built | `/accounts/credit-notes`, export sheets 22 and 23 |
| 9 | **Cash flow, general ledger, trial balance, P&L, balance sheet** | built | `/accounts/ledger`, `/accounts/financials` |
| 10 | Customers, suppliers, services, **airlines, hotels, visa types, countries, currencies**, banks, expense categories, employees, users | built | `/accounts/masters`, admin → Records |
| 11 | Company info, four voucher prefixes, VAT, currency, **backup & restore** | built | `/accounts/settings`, admin → Backup |
| 11 | Email, SMS and WhatsApp settings | config only | see below |
| 12 | Six user roles | built and **enforced at the route** | `admin/roles.js` |
| + | Booking management, PNR tracking, supplier cost vs selling price, gross profit per booking | built | `/accounts/reports`, `/portal/book` |
| + | Ticketing, void and refund calls | built; **refused on GDS entitlement**, proved live | `lib/ticketing.ts`, `/accounts/gds` |
| + | Partial payments, VAT support, automatic numbering | built | throughout |
| + | **Multi-currency** | built | any invoice or bill can name a currency and a rate |
| + | **Audit log** | built | admin → Audit log |
| + | **Payment reminders** | built, but nothing is sent | `/accounts/reminders` |
| + | **Document attachments** | built as links, not uploads | see below |
| + | **PDF & Excel export** | built | every screen; Excel has 25 sheets |

### The three that are deliberately less than they sound

**Email, SMS and WhatsApp are configuration, not a transport.** No mail server or
gateway is wired up. The reminders screen composes the message and hands it to
you with an `mailto:` and a WhatsApp link; it never claims to have sent
anything. A system that reports chasing a customer it never contacted is worse
than one that admits it did nothing.

**Attachments are references, not uploads.** The admin portal is plain Node with
no dependencies; accepting binaries would mean multipart parsing, a storage
path, size limits and a way to serve files back. A link to where the scan
actually lives — a shared drive, Drive, a folder on the office server — is what
agencies already do. A `file://` path opens on the machine it points at and not
from another computer; that is a property of the link, not a fault here.

**PDF is the browser's print dialog.** `globals.css` has a real print
stylesheet: navigation and filters drop out, table headings repeat across pages,
nothing stays trapped in a scroll window. A PDF library would be a second
renderer to keep in step with the pages people actually reviewed, and it would
drift.

---

## How the accounting stays honest

Three properties, each of which has caught a real bug in this codebase.

**Nothing is stored twice.** Every total is derived from the vouchers at request
time. A hand edit to a voucher cannot leave a total stale, because there is no
total to go stale.

**The same data is derived twice, on purpose.** Control accounts feed the
dashboards; journal postings feed the ledger. `/accounts/financials` leads with
the two side by side, and says so in red if they ever disagree. This caught a
sign error where credit notes were being subtracted from a contra-income account
that was already negative — the ledger read 1,097,800 high, exactly twice the
credit notes.

**Differences are displayed, not assumed.** The trial balance prints its own
difference row; the balance sheet prints the gap between its two sides; the
reconciliation panel prints all six. Every one of them reads zero today, and if
one stops, the page says so rather than hiding it.

### Bugs this approach found, and what each one would have cost

| Found | Was reporting |
|---|---|
| Supplier cost booked as the base fare, not the whole fare | 35,657 "profit" on a 35,800 ticket — the airline's tax counted as margin |
| Supplier deposits never left the bank | 88 lakh of advances recorded with no outflow; available funds overstated by the same |
| Purchases taken from invoice cost lines, payables from bills | Trial balance out by 867,000 |
| Sabre `baseFareAmount` quoted in the fare construction currency | Base 143 and tax 16,663 against a total of 34,300 — the 143 was USD |
| Credit notes subtracted from a contra-income account | Revenue 1,097,800 too high |
| Seeded cash and bank running negative on real dates | The book claiming money was spent that was never there |

`scripts/reconcile-funds.mjs` is the fix for the last one and is worth reading:
it walks every account day by day, finds its worst moment and raises the opening
balance so that moment clears a floor. Opening balances sit on the equity side,
so the trial balance does not move.

---

## Verifying it rather than believing it

```bash
node scripts/verify-srs.mjs
```

Run it with the app on :3002 and the admin on :4001. **Do not run `next build`
while the dev server is up** — it overwrites `.next` underneath the running
process and every page starts returning 500 until the server is restarted with a
clean `.next`. It looks exactly like a catastrophic regression and is not one.

Seventy checks against the running app: each one loads the page and looks for
the feature the specification asks for, or reads the book and tests that an
identity holds. It is there because "it is all done" is not a claim anybody
should accept on trust, including from me. It currently reports **70 passed, 0
failed**, and it fails loudly if a page stops carrying what it claims.

Four of those checks are integrity rather than presence: both trial balances
must be zero, the control accounts must agree with the journal, the balance
sheet must balance, and no cash or bank account may ever go negative on any date
in the book.

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
| Accountant | All vouchers, credit notes, reports, statements and the audit log. No settings, no users |
| Sales Executive | Prospect queue, invoices and customer receipts |
| Operations Staff | Supplier bookings, bills, payments and stock only |
| Manager | Read everything, reassign leads, approve cancellations, read the audit log |
| Read Only | Reports and statements. Nothing editable anywhere |

**A Sales Executive can raise an invoice but cannot reverse one.** Credit notes
are a separate capability held by Accountant, Manager and Super Admin, because
the person who made the sale should not be the person who cancels it.

**Only a Super Admin can restore a backup.** Restoring overwrites the whole
book, so it is its own capability rather than being folded in with settings. A
copy of what is on disk is written to `content/pre-restore-backup.json` first,
so restoring the wrong file can itself be undone, and the confirmation box wants
the word RESTORE typed out. Backups deliberately exclude `users.json` and the
session secret: a backup gets emailed around, and a password hash must not
travel that way.

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
| `content/accounting.json` | The whole book — 22 collections, from invoices to currencies | yes |
| `content/audit-log.json` | Who changed what, keyed by staff email | **no** |
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

The whole book. The Excel workbook has **twenty-five sheets** — summary, P&L,
trial balance, invoices, receipts, credit notes, bills, payments, expenses,
receivables, payables, cash and bank, sales by service, expenses by category,
inventory, supplier deposits, balance sheet, cash flow, general ledger, the full
journal, the reconciliation, cancelled bookings, refunds paid, supplier credits
and bank transfers. The Word version is a management accounts pack;
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

## Multi-currency

Any invoice or bill can name a currency and the rate it was raised at. Line
amounts stay in the document currency — exactly what the customer sees — and
everything the book totals is converted at the document's own stored rate.

The rate is copied onto the document and never looked up again. A rate that
moves next month must not restate a sale that was already made and already paid,
which is the whole reason it lives on the document rather than being read from
the Currencies master at display time.

Receipts and payments are base currency only. Money moved through a real bank
account at a real amount, and inventing an unrealised gain would put a figure in
a book that has nowhere to hold it.

Verified end to end: a USD 4,800 invoice at 122.5 adds exactly 588,000 to
receivables and to revenue, the USD 4,360 bill behind it adds 534,100 to
payables, and all six reconciliation checks stay at zero.

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
