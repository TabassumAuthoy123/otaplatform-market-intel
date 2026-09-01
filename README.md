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

> **The app binds 127.0.0.1.** `next dev` publishes on 0.0.0.0 by default, and
> every route under `/api` serves data with no session in front of it — the whole
> accounting book, the 400-lead CRM with named decision makers and their mobile
> numbers, the agency dataset. On an office network that was one URL away for
> anyone on the same wifi, and it was verified working from the LAN address
> before it was closed. `npm run dev:lan` exposes it deliberately, and the data
> routes then refuse any non-loopback request without `APP_ACCESS_KEY`.
>
> **The default admin password was published.** `seedUsersIfMissing` fell back to a
> fixed string, and that string was committed twice — in `admin/server.js` and again in
> `B2C-ADMIN.md` — to this public repository. The default super-admin password of every
> installation was readable by anyone who found the repo. Only the loopback bind kept it
> harmless. It is now generated per install and printed once, no password appears in any
> doc, and a check fails if either comes back. **Removing it from HEAD does not remove it
> from git history** — if you ever ran an install on that default, change it:
> `printf '%s' 'new' | node scripts/reset-admin-password.mjs admin@softifybd.com`.
>
> **The pages now need a session too.** For a long time only `/api` was
> considered, and the twenty-five *pages* that render the same data were not:
> `GET /accounts/financials` with no cookie returned the trial balance, the
> balance sheet and every customer balance, and `GET /agencies` returned the
> whole prospect list. Both are now refused. See
> [Signing in to the app](#signing-in-to-the-app) — including why the guard is
> in the data layer rather than in the layout, which is where it was first put
> and where it did not work.

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
uAPI1234567890-a1b2c3d4                 -> HTTP 401, SOAP faultcode 76
Universal API/uAPI1234567890-a1b2c3d4   -> HTTP 200
```

Same password, same endpoint, same PCC. If you ever see faultcode 76 again,
check the prefix before writing to Travelport.

The account id above is a made-up example. **The real one used to be printed here**,
in a file in a public repository, which made it half of a working credential pair
alongside a password that had already been exposed in a screenshot. The lesson is
not "be careful with passwords" — everyone already believes that. It is that a
username does not feel like a secret while you are pasting a debugging note, and a
README is the file people copy into issues. `.env` is the only place either half
belongs, and `/accounts/gds` is where you check them.

### Credentials — where they are, and how to check one without printing it

**The values are not in this file and will not be.** This repository is public. A
credential committed to it is published the moment it is pushed, and stays
reachable through the commit history after the line is deleted — the Travelport
password has already been exposed that way once and still needs rotating. A
README is the *worst* place for one, because it is the file people paste into
issues and chats.

Everything you actually need in order to verify a credential is available without
its value, and it is more reliable than reading one off a screen. Open
**`/accounts/gds`**. It reads `process.env` in the running process — not a copy of
`.env` — and prints, for every variable below:

- whether it is **set**
- for identifiers (host, PCC, branch, provider, paths, timeouts): **the value**,
  because a PCC is not a secret and hiding it is part of what made the 8236
  diagnosis take weeks
- for secrets: **length and the first 12 hex of sha256**, never the value

To confirm a password matches what you have:

```bash
printf %s 'the-value-you-think-it-is' | sha256sum
```

The first 12 characters must equal the fingerprint on the page. This catches
things eyeballing cannot: a trailing space, a smart quote pasted from an email, a
truncated copy. `lib/credentials.ts` is the single declaration; the page and the
checks both read it, and a check fails if the code reads a supplier variable the
declaration does not list — which is how a table came to omit `GDS_TARGET_BRANCH`
and send somebody into a fake entitlement wall.

| Variable | What it is | Required |
|---|---|---|
| `GDS_BASE_URL` | uAPI host | yes |
| `GDS_USERNAME` | uAPI user — needs the `Universal API/` prefix, or every call 401s like a bad password | yes, secret |
| `GDS_PASSWORD` | uAPI password, sent as HTTP Basic | yes, secret |
| `GDS_TARGET_BRANCH` | Branch every booking is made against. **Absent = uAPI 8236, which reads as an entitlement refusal and is not one** | yes |
| `GDS_SEARCH_BODY` | LowFareSearch SOAP body, `{from}` `{to}` `{date}` | yes |
| `GDS_PROVIDER_CODE` | Host to book through; `1G` is Galileo | no — 1G |
| `GDS_PCC` | Pseudo city code. Quote it to Travelport support | no |
| `GDS_IS_PRODUCTION` | Set only for production credentials; guards the booking probe | no |
| `GDS_TIMEOUT_MS` | Deadline for a **whole** Travelport attempt | no — 20000 |
| `GDS_SEARCH_PATH` `GDS_PNR_PATH` `GDS_PNR_BODY` `GDS_BOOK_PATH` `GDS_TICKET_PATH` `GDS_CANCEL_PATH` | Per-call overrides for a different Travelport product | no |
| `GDS_CACHE_TTL_MS` | How long a merged fare list may be reused | no — 90000 |
| `GDS_DEBUG_DUMP` | `1` writes every request and response to `content/gds-debug/`. Off by default — the bodies carry passenger names | no |
| `SABRE_BASE_URL` | Sabre host | yes |
| `SABRE_USER_ID` | Sabre user id | yes, secret |
| `SABRE_PASSWORD` | Sabre password. Header is `base64(base64(user):base64(pass))` — the single-base64 form fails as INVALID_CREDENTIALS | yes, secret |
| `SABRE_PCC` | Sabre PCC | no |
| `SABRE_TIMEOUT_MS` | Deadline for a **whole** Sabre attempt — token and call share it | no — 30000 |
| `SABRE_IS_PRODUCTION` `SABRE_BOOK_PATH` `SABRE_TICKET_PATH` `SABRE_VOID_PATH` `SABRE_REFUND_PATH` | Environment flag and per-call overrides | no |
| `APP_URL` | Where the storefront answers; the scheduler calls itself here | no |
| `APP_ACCESS_KEY` | Needed to reach `/api/accounts`, `/api/crm`, `/api/agencies`, `/api/gds`, `/api/sabre`, `/api/ticketing` from a non-loopback Host. Unset = those routes are loopback-only | no, secret |
| `TICKETING_PROBE_ON_PRODUCTION` | `1` lets the booking probe run on production credentials. Off by default: the probe creates a real PNR, and on a production PCC that is inventory held by a page refresh | no |
| `FX_MAX_AGE_DAYS` | How stale a hand-typed rate may get before it raises an alert | no — 7 |
| `ADMIN_PORT` `ADMIN_URL` | Where the admin portal listens and answers | no |
| `ADMIN_EMAIL` `ADMIN_PASSWORD` | Seed the first Super Admin on an empty users file; ignored once a user exists. Stored scrypt-hashed | no, secret |

`.env.example` carries the same list with blank values — copy it, fill it in,
restart. `.env` is gitignored and verified absent from GitHub after every push.

### Rotating a supplier password

Neither supplier lets you change a password over the API — Travelport is done in
MyTravelport or through their support desk, Sabre in Sabre Central. That part is
manual and cannot be otherwise.

Everything after it is scripted, because that is where it goes wrong: the same
secret lives in **two** places, this app's `.env` and the OTAPlatform MySQL
config table, and changing one without the other leaves a 401 that reads like an
outage.

```bash
echo "the-new-password" | node scripts/rotate-gds-password.mjs travelport
```

Piped rather than passed as an argument, so it never lands in shell history or
the process list. It writes both places, keeps the previous `.env` as
`.env.before-rotation` (gitignored), then runs a real DAC–DXB search and prints
what the supplier answered. If it cannot confirm a live search it says so and
leaves the rollback in place.

### Sabre

Two things about Sabre that are not obvious from the documentation:

**The token request is double base64.** Not `base64(user:pass)` — each half is
base64'd first, then the pair is base64'd again:

```
Authorization: Basic base64( base64(user) + ":" + base64(pass) )
```

**`baseFareAmount` is quoted in the fare CONSTRUCTION currency, not the currency
of the total.** Travelport does exactly the same thing with `BasePrice`, and that
went unnoticed for weeks after this one was fixed — a DAC–BKK card read
`base USD170 · tax BDT10509` against a total of ৳31,469. Fixing one supplier is
not evidence about the other. `scripts/verify-flights.mjs` now adds up every card
on seven routes, which is what found it. A DAC–DXB itinerary came back as base 143 with tax 16,663
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

### Ticketing — Travelport books, Sabre is refused

`lib/ticketing.ts` creates the PNR, issues the ticket, voids it, refunds it and
cancels the record, on either supplier. It is real code that runs against the real
endpoints, and `/accounts/gds` executes it on every page load so the status below
can never go stale.

Because it now genuinely books, that page **creates a real PNR and cancels it
again** on every load. Free on certification inventory; on a production PCC it
would hold and release real airline seats on a refresh, so it refuses to run
against production credentials unless `TICKETING_PROBE_ON_PRODUCTION=1` says
otherwise. A cancelled record still retrieves — as an empty shell with no segments
and no travellers — so "still retrievable" is not a failed cancel.

| | Call | Answer |
|---|---|---|
| Travelport | `AirCreateReservationReq` on `/uAPI/AirService` | **creates a real PNR** — provider locator returned, segment status `HK` |
| Travelport | `AirTicketingReq` | Galileo host: **NEED TICKET ACCOUNT** — genuinely blocked |
| Sabre | `POST /v1/trip/orders/createBooking` | HTTP 200 with **UNAUTHORIZED_ACCESS** in the body — *"the service PassengerDetailsRQ returned an authorization failure"* |

**This file said Travelport was entitlement-blocked, and that was wrong for
weeks.** The claim rested on uAPI **8236** — *"No provider/supplier is configured
for this user for the requested transaction"* — which reads like a refusal and is
not one. uAPI is a facade over several hosts and the request must name which host
and which branch. The search body had always carried `<com:Provider Code="1G"/>`,
which is why search worked. The booking body carried no `ProviderCode` at all,
and `GDS_TARGET_BRANCH` was missing from `.env`, so every create went out with
`TargetBranch=""`. 8236 was our own missing attributes described back to us.

The old text even argued the point: *"8236 is only reachable by a request that
has already parsed, routed and validated. The payload is right; the account has
no booking provider."* The first half is true. The conclusion does not follow —
a request can parse perfectly and still fail to say where to send it.

Five faults were stacked, each hiding the next, and each new error code looked
like a fresh block:

| Symptom | Real cause |
|---|---|
| 8236 no provider configured | `TargetBranch=""` + no `ProviderCode` on the segment |
| 4037 provide ProviderCode for ActionStatus | needed on `ActionStatus` too |
| **NEED TICKET ACCOUNT** on create | `ActionStatus Type="TAW"` invokes ticketing *during* the create |
| 13529 phone not allowed | traveller phone was `Type="Agency"`, must be `Mobile` |
| 13518 departure after arrival | the probe's hand-made times, not the supplier |

With all of those fixed, `AirCreateReservationReq` returns a PNR. Verified end to
end: retrieved by locator, passenger and segment read back, segment `Status="HK"`,
then cancelled with `UniversalRecordCancelReq`. **Retrieve needs the *provider*
locator, not the Universal Record locator** — an earlier check used the UR
locator, got *"UNABLE TO RETRIEVE"* and nearly became a second false negative.
`travelportCall` therefore prefers `ProviderReservationInfo/@LocatorCode` over the
`UniversalRecord` and `AirReservation` ones, and keeps all three.

Also proved, because it is the kind of thing that gets misread as a block:
`ClassOfService="E"` is not sellable on this account and answers **3000**, while
`Y`, `M` and `K` all book. A closed booking class is a fare problem, not a
permission problem.

**What is actually blocked on Travelport is ticketing, and only ticketing.**
`AirTicketingReq` reaches the Galileo host and the host answers **NEED TICKET
ACCOUNT** for PCC `3BX8`. That is a host-side setup item. So the ask to Travelport
changed completely: not *"enable a booking provider"* (already open) but *"set up
a ticket account on the Galileo host for PCC 3BX8"*. Sending the first email would
have wasted a support cycle on a thing that was never off.

`GDS_TARGET_BRANCH` is now **required** — `tpEnvelope` throws with that reasoning
in the message rather than silently sending `TargetBranch=""` and letting the next
person read 8236 as entitlement again.

**The Sabre row was wrong until 3 August 2026.** It read
`POST /v2.5.0/passenger/records → 403`. That path **does not exist on this host**
— it answers 404, as does `/v2.4.0`; only `/v2.3.0` is there. A 404 was being
reported as an entitlement refusal, which is a different problem with a different
fix and would have sent the wrong request to Sabre's support desk. Enumerating the
host found the live endpoint, and the payload was then built by posting to it and
reading the validation errors back one field at a time — wrong field names
(`toAirportCode`, not `destination`), times that had to be `HH:MM`, a required
`flightStatusCode`, phones as plain strings, and an address that needs
`stateProvince` even for a country that has none.

Only with all of that correct does the real refusal appear, and it is worth
having precisely: `createBooking` calls **PassengerDetailsRQ** internally, so
that is the service name to put in the email.

**The fix briefly made things worse, which is the part worth reading.** Sabre's
Offers and Orders endpoints refuse **inside an HTTP 200**, with errors shaped
`{ category, type, description }` rather than the `{ code, message }` the older
services use. Reading only the old shape left `ok` evaluating to true, and the
probe announced *"Sabre accepted the create pnr — ticketing entitlement has been
granted."* A platform telling an agency a booking exists when the supplier said no
is the worst failure available here, so a create-PNR now needs an empty `errors`
array **and** a confirmation id before it counts.

To unblock: **Travelport** must set up a ticket account on the Galileo host for
PCC `3BX8` — booking already works, so this is about issuing only. **Sabre** must
enable `PassengerDetailsRQ` and `/v1.3.0/air/ticket` on PCC `S00L`. Both of those
Sabre paths already exist on the host — they answer 403, not 404 — so the
integration is correct and only the account has to change.
Both are still certification credentials — production credentials are empty in
both database tables.

Four things this cost, worth knowing before touching that file:

- `AirCreateReservationReq` goes to **AirService**, not UniversalRecordService.
  The latter answers a Tomcat 404 page for it; the former validates it properly.
- uAPI rejects `AuthorizedBy="OTA Platform"` outright — *"may only contain
  letters and numbers"* — and reports it as **1005 Unable to parse XML stream**.
  Read as a refusal that looks like the booking block. The raw fault is kept on
  every result for exactly this reason.
- The first version grew its own copy of Sabre's auth and invented two
  environment variables that do not exist, so it 401'd on working credentials.
  `lib/sabre.ts` owns the handshake; ticketing calls into it.
- **A supplier error code is not a diagnosis.** Four different Travelport codes
  each looked like the same block. `diagnose()` now answers them separately —
  8236 and 1201 say *our config, our payload*; 3000 says *this booking class is
  closed*; only NEED TICKET ACCOUNT sets `entitlementBlocked: true`. Set
  `GDS_DEBUG_DUMP=1` to write every request and response to `content/gds-debug/`
  (gitignored) when a new code turns up.

Every confirmation screen says the booking is held, which is now literally true on
Travelport — the seats really are held. Never tell a passenger they are ticketed:
issuing is still refused on both suppliers.

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
| + | Ticketing, void and refund calls | built; **Travelport creates real PNRs**, issuing refused on both, proved live | `lib/ticketing.ts`, `/accounts/gds` |
| + | Partial payments, VAT support, automatic numbering | built | throughout |
| + | **Multi-currency** | built | invoices, bills and receipts each name a currency and a rate; settling at a different rate posts the gain or the loss |
| + | **Audit log** | built | admin → Audit log |
| + | **Payment reminders** | built, but nothing is sent | `/accounts/reminders` |
| + | **Document attachments** | built as links, not uploads | see below |
| + | **PDF & Excel export** | built | every screen; Excel has 25 sheets |

### Switching modules off per installation

Admin portal → **Design → Panel modules**. Eighteen switches over the two internal
modules, with the two roots locked on.

This is not the same as the storefront section and menu toggles beside it, and the
difference is the whole point. Those hide a link and leave the URL answering 200 —
`/portal/hotels` is still there for a bookmark, a search engine or a guessed path.
That is half a feature. Here **off means off**: the link disappears from every menu
and the route answers **404**.

| | Storefront sections / menu | Panel modules |
|---|---|---|
| Hides the link | yes | yes |
| Blocks the URL | **no** | **yes, 404** |
| Scope | public site | `/accounts/*`, `/`, `/agencies`, `/competitors`, `/segments` |
| Where | Design → Storefront sections | Design → Panel modules |

An agency that only sells air tickets can drop Hajj inventory; one whose accountant
works outside the system can drop the general ledger; one with no GDS of its own can
drop the GDS check. It sits **on top of** the six roles rather than replacing them:
a module that is off is gone for everyone including a Super Admin, and roles still
decide who sees what among the ones left on.

**How the enforcement is split, because neither half works alone.** A server layout
is the only place one check can cover sixteen pages instead of sixteen copies that a
seventeenth page can forget — but a layout is not told the pathname. Middleware
knows the pathname but runs on the Edge runtime and cannot read a file. So
middleware stamps `x-panel-path` onto the request and the layout reads it, loads
`content/site.json`, and calls `notFound()`. Deleting the middleware line breaks no
build and no nav test; it silently stops every disabled route from 404ing while the
links stay hidden.

**Three things this turned up that the toggles alone would not have fixed:**

- The sixteen nav links were rendered **twice** — desktop bar and mobile strip — so
  filtering at either render site would have left a module hidden on one breakpoint
  and visible on the other. Filtering once at the source fixes both. The storefront
  menu manager taught this lesson already; it applied here too.
- The first version passed the nav an **allowlist** of enabled hrefs. It carried
  only the four market-intelligence modules, so `/portal` and `/accounts` — which
  belong to other groups and are not toggleable here — matched nothing and vanished.
  It is a blocklist now: an allowlist must enumerate everything that may pass, a
  blocklist only what must not, and empty is the right default.
- **Fourteen cross-module links in page bodies** kept pointing at modules that were
  now 404 — ten drill-downs from the dashboard home into `/agencies`, the statements
  page into `/accounts/financials`, and two storefront pages into accounts. The
  feature meant to tidy the panel up was manufacturing dead links. `ModuleLink`
  renders nothing when its target is off; the tiles and bars already degrade to
  plain text without an `href`, so the number survives and only the navigation goes.
  One of the fourteen was a plain `<a>` rather than a `<Link>` and an automated sweep
  for `<Link>` missed it — worth knowing before trusting such a sweep.

The module list lives in `lib/panel-modules.js` as plain CommonJS, which is
deliberate: the Next app and the zero-dependency admin portal both read it, one by
`import` and one by `require`. Written twice, the screen and the guard would be two
lists, and a drifted list means a module that looks switchable but is not — the same
failure as the `/accounts/gds` table that named seven environment variables while the
code read thirty-six.

### The airline document — the sub-ledger the book was missing

`/accounts/documents`. A ticket has a document number, a base fare, a list of
taxes, a commission the airline allows, a plating carrier, a passenger, sectors,
and **two dates that drive different things** — the issue date moves cash, the
travel date earns revenue. All of that used to collapse into one `supplierCost`
number on an invoice line, and with it went the ability to reconcile against a BSP
billing file, raise an ADM against a ticket, defer revenue to the month of travel,
or attribute margin to the consultant who sold it.

That is the difference between this and TRAACS, which is the reference product in
this category: their book is organised around the airline document and ours was
organised around the invoice.

**This change moves no total, and that is asserted rather than asserted-to.**
Documents do not post. An invoice line still carries the money and still posts
exactly as before; a document is a sub-ledger record the line points at through a
nullable `documentId`. Proven twice over:

- the reconciliation after the migration is identical to before — all six control
  accounts and both trial balances, every difference still zero;
- strip `documents[]` and `line.documentId` from the book and it is **byte-identical**
  to the pre-migration backup.

A check now fails if the journal builder ever starts iterating documents, because
that single edit is what would break the guarantee while every screen still looked
right.

```bash
node scripts/backfill-documents.mjs            # report only
node scripts/backfill-documents.mjs --write    # do it, then re-check the book
```

**The migration invents nothing.** 89 invoice lines carry a PNR; 60 of them are air
tickets and became documents. None gets a ticket number, a fare, a tax line or a
commission, because the book never had them. A fabricated 13-digit number
reconciles against nothing and costs somebody a day to discover that; a guessed
fare split produces a margin that looks precise and is not. So they are
`status: "booked"` — a PNR exists, nothing was issued — which is also literally our
own GDS position, since Travelport creates real PNRs and Galileo refuses to issue.

Where the fare is unknown every derivation falls back to the invoice line's
`supplierCost`, which is the number every other report already used. The screen
says `not recorded` rather than `৳0`, and names the fallback on each row. Both are
checked: an unknown fare must read as unknown, never as zero.

Packages are skipped deliberately. A Hajj or Umrah package also carries a PNR and
is genuinely a flight plus hotel plus ground, so turning one into a single ticket
would misrepresent it.

#### Fare capture — both suppliers were already sending it

A DAC–DXB search returns the taxes **itemised by IATA code**, from both GDS, and
every one of them was being reduced to a single summed number before it reached
anything:

| | How it arrives | What was kept |
|---|---|---|
| Travelport | `<air:TaxInfo Category="BD" Amount="BDT500"/>` — 55 per response | the `Taxes` attribute only |
| Sabre | `taxDescs[]` dictionary + `{ref}` pointers, with human descriptions | `totalTaxAmount` only |

Both are now parsed and carried through the offer onto the booking and onto the
document. A booking made through the storefront produces this, verified live:

```
DOC-0061  TKT  booked        BS341 DAC→DXB      travelDate 2026-09-26
base 25,900   +   BD 500 · OW 2,500 · P7 1,234 · P8 1,234
                  UT 4,000 · ZR 168 · E5 446 · YQ 617        =  36,599
invoice line SFT-INV-0119 supplierCost                          36,599
```

Those codes are the Bangladesh rules as line items — **OW** the excise duty,
**BD** the embarkation fee, **E5** the VAT, **UT** the travel tax. A rule like the
Hajj excise-duty waiver applies to a code and cannot be applied to a total, which
is why the itemisation is the thing that matters rather than the number.

Three checks hold it: base plus the itemised taxes must equal the invoice line's
cost on every priced document, the codes must be real ones rather than a single
`TOTAL` bucket, and a document created from a booking must carry a travel date and
its sectors.

Travelport's taxes are scoped to each `AirPricingInfo`'s own body. Read from the
whole response they would attach every fare's taxes to every offer — plausible
looking, and nonsense.

#### Revenue on the travel date, not the invoice date

A ticket sold in June for an October flight is **cash in June and revenue in
October**. Both used to land in June, which overstated June and left October
looking empty — and for an agency selling Hajj a year ahead, that is most of the
reported profit sitting in the wrong year.

New account: **`DEFERRED_INCOME` — sold, not yet flown**, a liability. The agency
has been paid to carry somebody in October; until October it owes them the trip.

**The implementation deliberately does not touch the invoice posting.** The obvious
way is to credit deferred income instead of sales and credit sales on the travel
date — it works, and it edits the one posting every other figure in the book
depends on. Instead the revenue is moved **out** on the invoice date and back **in**
on the travel date, as its own pair:

```
2026-08-12  SFT-INV-0119  Deferral      Dr Sales  38,099   Cr Deferred  38,099
2026-09-26  SFT-INV-0119  Recognition   Dr Deferred 38,099  Cr Sales    38,099
```

Two consequences make the redundancy worth it:

- Over the whole book the pair **nets to zero**, so the control-versus-ledger
  reconciliation is arithmetically unchanged. Step 2 cannot break the check that
  would catch step 2 being wrong.
- Any view bounded to a date sees the reversal but not yet the recognition — which
  *is* the deferral, emerging from the dates rather than from a conditional that
  has to be kept in step with a calendar.

Read off the live ledger card:

| View | Deferred income closing |
|---|---|
| As at 2026-08-12 | **৳38,099** held as a liability, out of sales |
| Whole book | **৳0** — the pair nets out |

**It self-checks.** The reconciliation table gains a seventh row comparing deferred
income *as at today* by two independent routes: the control figure walks the
documents and sums what is sold and not yet flown, the ledger figure is whatever
balance the journal is carrying. They agree only if the deferral dates, the
recognition dates and the travel-date boundary all line up. A whole-book comparison
would have been trivially true and would have passed just as happily with the
recognition leg missing entirely.

That row earned itself immediately: the first version negated the ledger balance on
an assumption about sign conventions — accounts payable two rows above is also a
liability and is compared directly — and the check came back at double the value
with the sign inverted.

Only a travel date **later than the invoice date** defers anything. A ticket sold
and flown in the same period was never deferred, and the 60 migrated documents have
no travel date at all, so they are untouched.

#### Credit control — checked before the sale, not at month end

`customer.creditLimit`, and an exposure derived on every request. The failure this
prevents is the one that actually kills small agencies: a corporate client quietly
runs up months of tickets, stops paying, and the agency has already remitted every
one of those fares to the airline.

The expensive part of that feature is a receivables figure that is correct at the
moment you ask. This book already recomputes receivables from the vouchers on every
request, so the exposure is a group-by and the limit is one new field. What was
missing was somewhere to put the limit and somewhere to check it.

**Exposure** is the unpaid balance of every live invoice after receipts and credit
notes — not the invoice totals. `/accounts/reports` shows it per customer against
the limit, breaches first.

**Absent or 0 means no limit is enforced.** That default is what let this ship: a
default of "no credit" would have stopped every agency on the book from buying
anything on the day it went live. A limit is opted into one customer at a time.

**It warns everywhere and refuses in exactly one place.** Across the accounts module
a breach is reported and the save goes through, because an agency deciding to
extend credit past its own limit for a good reason should not have to edit a master
record first. The storefront booking API refuses, because nobody there is
exercising that judgement:

```
HTTP 409  {"code":"CREDIT_LIMIT",
  "error":"TEST PROBE owes 38,099 against a limit of 10,000. This sale would take
           them to 76,198. Take payment against the open invoices, or raise the
           limit in Masters."}
```

409 and not 500. The customer can act on it, so it has to arrive as a refusal with
a reason rather than a stack trace — a working control that looks like an outage
gets switched off. Verified that the refused booking wrote **nothing**: no invoice,
no bill, no document, and no entry in `bookings.json`.

A scheduled job raises a breach as an alert every six hours, so it reaches somebody
rather than waiting to be found on a page. A customer with no limit raises nothing.

One test-hygiene note worth keeping. The first version of the regression check
picked any customer with a limit and posted a booking — and if that customer was
*within* their limit the sale went through, writing a real invoice into the book
every time the check passed. A test with a side effect on production data is a slow
leak, and the green path is exactly where nobody looks for one. It now selects only
a customer already over their limit, and anything other than a 409 is a failure.
Proven by running the suite twice: 120 invoices before and after.

#### BSP reconciliation — the three-way match

`/accounts/bsp`. IATA's Billing and Settlement Plan issues a report each period
listing every sale, refund and memo it believes the agency owes on, and **takes the
net at the remittance date whether or not the agency checked**. An agency that does
not reconcile pays whatever the file says — including airline errors it had the
right to dispute, and its own staff issuing outside the system.

Three sources: what the GDS sold, what the book recorded, what IATA will bill. The
document table already *is* the second and was built from the first, so the
remaining join is against the billing file. Every row lands in exactly one bucket,
and each is a different action:

| Verdict | What it means |
|---|---|
| **Matched** | Nothing to do |
| **Amounts differ** | Raise it before the remittance date or it is taken anyway. This is what an ADM usually turns out to be |
| **Not in the book** | IATA is billing something never seen here — issued outside the system, or a mistyped number. The most expensive of the five |
| **Not on this billing** | Recorded as issued and not billed: unbilled, or a different period |
| **Matched on PNR only** | Provisional. A PNR is not a document number and can carry several tickets — a hint, never a settlement |

**Why CSV and not the HOT file.** The machine-readable BSP output is the HOT file,
a fixed-width flat file laid out by the IATA DISH standard. We do not have that
specification, and inferring column positions from a sample would produce a parser
that looks finished and silently misreads a tax field the day a row is one
character longer. The importer takes CSV with an explicit column mapping — what
BSPlink exports — and the matcher does not care which reader produced the rows. The
DISH reader, when the layout is in hand, feeds the same matcher.

**Why it matches nothing today, said on the page rather than hidden.** BSP keys on
the document number and no document here has one, because Galileo answers NEED
TICKET ACCOUNT for PCC 3BX8. The screen says exactly that. Everything works the day
issuing is switched on.

**Three defects the first test file found, all mine.** Running four rows through it
was worth more than re-reading the code:

- An **ADM matched a ticket** by PNR and reported the gap between a ৳2,500 memo and
  a ৳36,599 fare as a pricing dispute — a number that would have been taken to an
  airline. A memo is a claim *against* a ticket, not a ticket. Sales only.
- **One document matched twice.** Two rows sharing a PNR both matched it, so one
  sale looked like two. The used-set now guards the PNR pass, not just the leftovers.
- The tile read **"in dispute: ৳0" beside a row showing ৳1,200**. Provisional
  differences are not disputes — the join may be wrong — but a screen that says zero
  next to a visible gap reads as a bug. Surfaced under its own name.

The page **never writes**: pasting a file produces a report, and that is asserted.

#### A note on test hygiene, because this bit twice

The credit-limit check posts a real booking to prove the refusal fires. It polluted
the book **twice, in two different ways**:

1. It picked any customer with a limit; if that customer was *within* their limit the
   sale went through and wrote an invoice every time the check passed.
2. Fixed, it then built the passenger name by splitting the customer name on
   whitespace and taking the last two words — turning "Meridian Corporate Travel"
   into "Corporate Travel", a customer that did not exist. The booking flow created
   one, with no limit, and sold to it. The check then correctly reported that a
   customer over their limit had been allowed to book — of a customer it had just
   invented.

It now splits on the last space so first + last rejoins exactly, and **fails if the
attempt creates a customer at all**, whatever the status code says. Verified over
three consecutive runs: 10 customers, 120 invoices, 62 documents, unchanged.

#### ADM and ACM — the first documents that move money

An Agency Debit Memo is the airline reaching back into a settled sale and taking
more: a fare it says was underpriced, a commission it says was not earned, a tax it
says was short. Until now it could only be typed in as an expense with a note — at
which point it stops being attributable to a ticket, a carrier or a route.

A memo is now a document like any other, with two fields the others do not need:
`againstDocumentNo` and `reason`. That is the whole difference between knowing you
lost money and knowing why.

**Held apart from ordinary payables, deliberately.** Memos settle through BSP
alongside tickets so they could sit in Accounts payable. Two reasons not to: the
control side of AP is derived from supplier *bills*, so posting there would have
forced that derivation to grow a second source — and an agency wants the memo total
on its own, because it measures the agency's own error rate rather than its trading.

```
ADM   Dr Airline debit memos      Cr Airline memos payable
ACM   Dr Airline memos payable    Cr Airline debit memos
```

A memo you successfully dispute is marked **voided** and posts nothing, which is
why winning an argument makes the liability go down. Both sides agree about that or
the number stays up by exactly the amount somebody won.

**A gap this nearly shipped with.** The balance sheet is built from the ledger, so
it picked the memo up on its own. The P&L is derived from vouchers, and a memo is
not a voucher — so a liability would have appeared with no matching cost in the
profit figure and the two screens would have quietly disagreed. `summarise()` now
carries a memo line and the P&L shows it separately from operating expenses, where
burying it beside the electricity bill would hide the one cost worth watching.

**It closes the loop from step 4.** The BSP page showed the memo as *not in the
book* because it had no document to match. With one, it matches exactly:

```
Matched   0571234567898   IATA ৳2,500   book ৳2,500   diff ৳0
```

#### Three checks that had memorised yesterday's answer

Step 5 turned three green checks red without breaking anything:

- **"Documents never reach the journal"** was step 1's additive guarantee, and step
  5 breaks it on purpose for one type. Narrowed rather than deleted — the journal
  may iterate documents *exactly once*, and that loop must refuse anything that is
  not a memo. Deleting it would have removed the only thing standing between a
  stray posting rule and every ticket being counted twice.
- **"A memo never matches a ticket"** asserted the memo was unmatched, which was
  correct only while memos had no documents. Rewritten to the property that holds
  in both states: a memo matches its own memo document or nothing, never a ticket.
- **"verdict by verdict"** counted `unknown >= 2` and went red when the memo
  matched. Counts properties now, not a tally.

And one mistake worth recording. Rewriting those three by locating each block with
a paren-counting scan **deleted ten unrelated checks**, including the two that scan
for leaked secrets — regex literals and strings contain unbalanced parens, so the
scan ran past each block's real end. Caught by the check count dropping from 147 to
137, restored from git, and redone by matching each block's closing `});` at column
zero. Verified by diffing the check names before and after: 131 and 131, with
exactly the two intended renames.

#### Margin by branch and by consultant

Two nullable foreign keys and a group-by. The cheapest thing left on the list, and
what an owner with three offices asks about in the first ten minutes — not "what
did we sell" but **which counter is actually making money, and which of my staff is
discounting to hit a number**. TRAACS sells it as "Profit by Branch, Team or
Product"; we had the product half already through `salesByService`.

`branches[]` is a new master — three counters and one of `kind: 'online'`. The
attribution lives on the **invoice**, not only on the document, because margin is
revenue less cost and both live on the invoice line. Attribution that only reached
air tickets would leave a visa or a hotel sale belonging to nobody, and counter
staff sell all three.

| | Invoices | Revenue | Margin | % |
|---|---|---|---|---|
| Head office — Gulshan | 39 | ৳96.2 lakh | ৳6.0 lakh | 6.2 |
| Chattogram counter | 35 | ৳89.6 lakh | ৳6.1 lakh | 6.8 |
| Uttara counter | 37 | ৳85.2 lakh | ৳6.6 lakh | 7.7 |
| Online — storefront | 2 | ৳76k | — | — |

**Coverage is stated above the table, not below it.** A branch table built on 2% of
the sales is a table somebody will quote as the whole picture, so the proportion
that can be attributed at all decides whether the numbers are worth reading.
Currently 115 of 115 live invoices.

**Unattributed is a row, sorted last however large it is.** A report whose totals do
not add back to the whole book gets argued with rather than used, and an
unattributed backlog is a backlog rather than a performer.

**A storefront sale attributes itself.** The booking flow finds the online branch by
`kind`, never by a hard-coded id, so an installation that names its channel
something else still gets it and one with no online branch leaves the sale
unattributed rather than assigned somewhere untrue. No consultant is set — nobody
sold it, which is the point. Proven by making a real booking through the API,
checking `branchId=BR-ONL` landed on both the invoice and the document, then
removing the record.

**A memo is charged to whoever caused it, not to a sale.** A memo has no invoice, so
the document is the only route — and the consultant who mispriced a fare is the
person it belongs to.

`scripts/seed-attribution.mjs` creates the branches and spreads the **demo**
invoices across them. It is the one script here that invents, and it says so
loudly: `backfill-documents.mjs` refuses to invent a ticket number because the PNRs
it migrates belong to real bookings, whereas the 118 seeded invoices are not records
of anything — assigning a branch to a synthetic sale falsifies no history, and a
report showing 98% unattributed cannot demonstrate anything. The two real storefront
sales are left alone.

#### The branded travel document

`/accounts/documents/<id>/itinerary`. The Itinerary Plus equivalent: agency
letterhead, the passenger's details, their itinerary and their fare.

**Deliberately last, and it took a day rather than a week.** Every field it prints
— passenger name, sectors with departure times, base fare, taxes by IATA code,
plating carrier, ticket number — exists because of the document table and fare
capture. Built first, on an invoice line holding one `supplierCost` and a free-text
description, it would have been a letterhead wrapped around a sentence.

The fare prints **itemised**: base, then every tax by its own code, then the agency
service charge, then the total. A passenger asking why the ticket costs what it
does gets an answer rather than one line reading "taxes". Eight codes on the live
document.

**It never claims a ticket exists.** No document here has a number, because Galileo
answers NEED TICKET ACCOUNT — so the header reads *"Booking confirmed — not yet
ticketed"* and the body says the document **cannot be used to board**. Leaving a
blank where a ticket number belongs, or inventing one, is the single thing a
document like this must not do: the passenger takes it to an airport counter.

**It lives inside the panel, not on the storefront.** It carries a name, a route
and a fare. A public URL keyed on a document id is guessable, and the whole point
of the middleware work was that customer data does not sit on a reachable path. It
renders under `/accounts`, which is loopback-bound and behind the panel-module
gate; the agency prints it or saves it as PDF and sends that. The browser's print
dialog rather than a PDF library, for the reason already given elsewhere — a second
renderer drifts from the page people actually reviewed.

**A memo is not handed to a passenger.** An ADM is a claim raised against a ticket;
rendering one here would put an airline's clawback in a customer's hands. It 404s,
and that is checked.

---

#### Carrier contracts — the last item, and real margin

`/accounts/contracts`. Every fare the GDS quotes comes back with **no commission on
it**, because the commission lives in a contract rather than in the fare. So
`commissionAmt` was recorded as null — unknown, not zero, since zero claims the
airline allowed nothing — and margin has only ever been the agency's own service
charge. For an agency on a 3% deal with its main carrier that understates the
margin on every ticket it sells.

**Commission is not income arriving separately.** Under BSP the agency remits fare
plus tax **less** commission, so it reduces what is owed. That means it belongs in
the supplier cost, and margin then falls out of arithmetic the book already does.
No new account, no new posting rule — the booking flow writes the bill net of it
and cost of sales, gross profit and margin-by-branch are all correct without being
told about commission at all.

Proven end to end with a temporary 3% BS contract, then removed:

```
document   base 25,900 + tax 10,699 = 36,599      commission 777  (3% of base)
invoice line supplierCost                35,822   = 36,599 − 777
bill                                     35,822
margin  37,599 − 35,822 =                 1,777   = service charge 1,000 + commission 777
```

**Effective dates, for the reason the tax rules need them.** A contract resolves
against the **issue date on the document**, not against today, so a rate
renegotiated in September cannot restate August's tickets. Resolution happens at
read time, so a corrected contract flows through immediately — and the date bound
is what makes that safe.

The table also carries a flat per-document amount (some carriers here pay a fixed
sum per sector rather than a rate), a route band, a cabin restriction, a per-document
cap, and a **PLB rate that is recorded and never applied per ticket** — it settles
quarterly against total production, so slicing it across sales would report money
that has not been earned and may never be.

**Nothing is seeded, and that is the hardest rule in the file to keep.** A
fabricated rate puts money into the margin report and the P&L — worse than a
fabricated ticket number, which at least only fails to reconcile. The book ships
with zero contracts and the resolver returns null for anything not covered.

**So the screen has a calculator instead.** "What is 3% worth on what we already
fly" is the question before a negotiation, and answering it in a spreadsheet is how
a rate gets agreed that turns out to be worth less than the volume commitment
attached to it. It reads and computes; it writes nothing, and that is asserted. It
also **names the documents it cannot cover** — the migrated ones with no fare split
— because a figure quoted at an airline should not silently exclude them.

---

#### Tax as dated data, not a rate on the company record

`/accounts/taxes`. `company.vatRate` was one number, and for this market that is
wrong in three separate ways — every one of them checked rather than assumed:

- **Excise duty on an air ticket is a fixed amount banded by route**, not a
  percentage, and the bands have been revised more than once. A percentage-only
  field cannot state it at all.
- **VAT on a travel agent's commission was waived** by the NBR after ATAB's
  representations. A product that assumes commission is VAT-able bills the agency's
  customers wrongly.
- **Hajj carries its own exemptions** — airfare excise duty and VAT have both been
  waived for pilgrims, which given the Hajj volume in this dataset is not an edge
  case.

And a rate is a thing that *changes*. Held as one number, a budget-night revision
silently restates every invoice ever raised, because the report recomputes from the
current value. Held as dated rules, last year keeps last year's treatment — which is
the only reason a figure on a screen can be compared with what was filed.

A rule carries a code, what it is charged on (fare, commission, service charge or
the whole line), a rate **or** a fixed amount per passenger, a route band, the
services it covers, the services **exempt** from it, a withholding flag, and the
dates it runs between. It resolves against the **invoice date**, never today.

The Hajj waiver is modelled as an **exemption on a general rule** rather than as a
separate Hajj rule, so the waiver being withdrawn is one edit.

**Nothing is seeded**, for the same reason as the carrier contracts: the bands move,
and a stale rate shipped inside a product is a wrong invoice that looks
authoritative. The amounts reported in the press are here as reference, not loaded
as data — domestic and SAARC excise bands, the 15% VAT on aeronautical charges, the
commission waiver, the Hajj waiver. An empty table means each invoice keeps applying
its own stored rate, so nothing already invoiced changes.

The screen carries the same shape of calculator as the contracts page, for the same
reason: an excise band is announced as a number and the question is what it costs
across the volume already flown. ৳1,000 per passenger against this book is
৳3,51,000 over 351 passengers.

#### Closing a period

Admin portal → Design → **Close a period**. One date; on or before it the book
refuses writes.

**This edge got sharper as the week went on.** Every figure here is recomputed from
the vouchers on every request, and that has been worth having — a total cannot go
stale. But editing a voucher dated in March silently changes March's profit,
March's VAT and March's trial balance, months after the return was filed. A stored
total would at least have disagreed loudly; a derived one just quietly reports a
different past. And the more that derives from the vouchers — deferred revenue, memo
liabilities, branch margin, commission — the more a late edit moves without anyone
deciding it should.

It does **not** freeze the derivations. Reports over a closed period still
recompute, because the arithmetic was never what was unsafe — the inputs were. And
it does not prevent correcting a closed month, only doing so *silently*: the
refusal names the right move, which is a dated adjustment in the open period.

**The guard checks the old dates as well as the new ones.** Moving a voucher out of
a locked month is the same restatement as editing it there, and a guard that only
looked at the incoming value would wave it through.

It lives in `lib/period-lock.js` as plain CommonJS shared by both writers — the same
split as `lib/panel-modules.js` and for a sharper reason. Two processes write to this
book and both must refuse the same dates; a guard written twice drifts, and a
drifted guard is a hole where the admin accepts what the app rejects, silently.

**Closing counts what is inside first.** An operator who closes March without
knowing there are eleven unpaid March invoices in it has not closed a period, they
have hidden a chase list. And a draft in a closed period can never be confirmed,
which is worth saying before the button rather than after. Driven end to end through
the real form: closing through 2026-07-31 reported 571 vouchers, 23 still unpaid and
3 still draft; an invoice dated 2026-06-18 then came back **409** with the reason and
was byte-identical afterwards, while one dated 2026-08-01 saved normally. Both
closing and reopening are audited, because "who reopened March" is the first
question an auditor asks.

The lock was released afterwards. A demo book with 571 of 580 vouchers closed makes
the admin portal look broken.

---

#### Exchange gain, overpayment, and the hole they were both falling into

This started as "add FX gain/loss" and turned out to be **closing a latent defect**.

A receipt posted `Dr bank / Cr receivables` for the whole cash amount, while the
control side computed the amount due as `max(0, total − paid)` — **floored at zero**.
Those two agree only while no receipt ever exceeds what its invoice is carrying.
Nothing had, so nothing had broken.

Proven rather than argued. One receipt of ৳595,200 against an invoice receivables
was carrying at ৳588,000:

```
Accounts receivable    control 37,98,378   ledger 37,91,178   difference 7,200
Trial balance — control basis                                 out by 7,200
```

The two-derivation check caught it, which is what it is for. But nothing in the code
*handled* it, so the first foreign settlement or the first overpayment would have
broken the book and left somebody hunting.

**The two causes are different and must not be merged.** The same ৳595,200 can mean
two unrelated things:

| Receipt | Exchange gain | Customer credit |
|---|---|---|
| **4,800 USD @ 124** against an invoice carried at 122.5 | **৳7,200** | 0 |
| **৳595,200 in taka** against a ৳588,000 debt | 0 | **৳7,200** |

The first is a gain on the rate — nobody overpaid. The second is money the agency
**owes back**, and booking it as a gain would report profit it does not have.

Telling them apart needs the settlement rate, which is why `receipt.currency` and
`receipt.fxRate` had to exist. Without them the safer reading applies: an
overpayment, which never invents income.

**The actual fix is that there is now one allocation function.** The defect existed
because two pieces of code answered *"how much did this relieve"* differently. The
journal builder and the control-side derivations both call `allocate` in
`lib/fx.ts`, and one function cannot disagree with itself.

Two new accounts: **Exchange gain / (loss)** as income — one account, not two,
because a gain and a loss are the same movement in opposite directions and splitting
them means netting two numbers by hand to answer the only question anybody asks. And
**Customer credit balances** as a liability, because a customer who overpays is owed
the difference and letting it sit as a negative asset is precisely what made the two
derivations disagree.

Both are compared by the same route as every other control account. Verified live
with each receipt in turn: exchange gain 7,200 / credit 0, then the reverse, and
every row level at zero on both.

One thing this also tidied that was *not* a defect: the control-basis trial balance
never stated the airline memos. It stayed balanced without them — they net across
both columns — but it did not represent them. It does now.

---

That completes the design note — all seven steps, the commission item, the two gaps
the design note itself identified, and one latent defect found while opening the
next one. What remains is not code. **Travelport must set up a ticket account on the Galileo host
for PCC 3BX8** — booking already works — and real contract rates have to come from
the agency's own agreements.

### Putting a real agency on it

Every row above was true and the module still could not be handed to an agency,
which is a distinction worth stating plainly rather than leaving in a gap between
"built" and "usable".

`content/accounting.json` holds a 45-day demo — 118 invoices, 163 bills, 150
payments, about ৳2.7 crore of turnover that belongs to nobody. An agency starting
on that issues its first invoice as `SFT-INV-119` into a ledger it did not write,
and its opening trial balance is a stranger's. There was no way to clear it.

```bash
node scripts/new-book.mjs                      # report only, writes nothing
node scripts/new-book.mjs --confirm NEW-BOOK   # actually do it
```

It removes every voucher and movement — invoices, receipts, bills, payments,
expenses, both kinds of credit note, supplier deposits, transfers — and keeps the
setup that is the same for any agency in this market: chart of accounts, 9
currencies, 12 airlines, 9 hotels, 10 visa types, 12 countries, 8 services, 8
expense categories, 3 bank accounts, 6 roles, the voucher prefixes, VAT and the
company record. Stock lines survive as products with `purchased` and `sold` reset
to zero, because a Hajj seat block is a product, not a movement.

| Flag | Effect |
|---|---|
| *(none)* | Report what would change. Writes nothing. |
| `--confirm NEW-BOOK` | Do it. The phrase is required — this cannot be reached by clicking. |
| `--keep-parties` | Keep customers and suppliers, with opening balances zeroed |
| `--keep-openings` | Keep opening cash and bank balances instead of zeroing them |
| `--company "Name"` | Set the company name in the same pass |

Opening balances are zeroed by default. A fresh book with bank balances and no
equity behind them does not balance, and a trial balance that is out on day one
teaches the operator to ignore it — enter real opening balances through Masters
and Settings, where the equity side is handled.

It backs the book up to `content/backups/` before writing, writes atomically, then
asks the running app for the reconciliation and prints it. Verified on a copy: all
six control accounts and both trial balances come back at zero with zero
difference, and `/accounts/financials` and `/accounts/invoices` both render. If it
cannot reach the app it says it could not verify rather than implying it did.

`_meta.note` is rewritten too. It currently reads *"Demo figures — generated by
scripts/seed-accounting.mjs"*, and that line is load-bearing: it is what tells the
next person the numbers are not real. A live book that still announces itself as a
demo is its own kind of lie.

**This is not wired to a button and nothing runs it automatically.** Clearing a
book is the one operation here that cannot be undone from inside the app, and the
demo data is also a sales asset — the screens are only persuasive because there is
plausible trading in them. Run it when you onboard an agency, not before.

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

## What a deep audit found, and what it changed

Everything up to this point had been checked by asking whether a URL answered.
That proves routing and nothing else, which is why the list below survived every
earlier pass. Each item is now covered by a regression check in
`scripts/verify-srs.mjs` or `scripts/verify-admin.mjs`.

| Was | Now |
|---|---|
| Every `/api` route open, app on 0.0.0.0. The whole book and all 400 leads downloadable from the LAN — verified. | Binds 127.0.0.1; `middleware.ts` refuses non-loopback requests to the data routes without `APP_ACCESS_KEY`. |
| Two saves a moment apart, and the first one silently gone — proven by replaying the real write path. | Writes serialised per file, and each record form carries a fingerprint. A stale save gets 409 and a page naming who changed it. |
| Every date stamped in UTC. Between midnight and 6am Dhaka that is YESTERDAY; at a month end, the previous month's P&L. | `lib/clock.ts` and `admin/clock.js` stamp in `company.timezone`, default `Asia/Dhaka`. |
| `crm_write` let any Sales Executive rewrite another rep's leads, despite the spec and the data dictionary both requiring otherwise. | `crm_all` is a separate capability. A rep is scoped to leads assigned to them, on the lead form and on call logging. |
| Accounting pages at 2–4.3s. `journal()` rebuilt four or five times per render; `allBankBalances` scanned every voucher once per bank. | Memoised on the book object — a new request still re-derives from disk. Financials went from 2,165ms to under 500ms. |
| `getBook()` was a bare `JSON.parse`. A truncated file gave a stack trace. | Fails with the filename, "nothing has been changed", and where the backup is. |
| `crm-leads.json` re-parsed on every request — 421 KB now, ~6 MB at the 5,800 leads the spec asks for. | Cached on mtime and size, so an admin write still shows on the very next load. |
| `salesByService` rounded per line while `invoiceTotals` rounded the total — no drift yet, but guaranteed once more foreign-currency invoices exist. | Both convert once per invoice. Checked by recomputing both ways and comparing. |
| The shared Docker network to OTAPlatform's MySQL was commented out, so "runs alongside" needed an edit nobody would find. | Enabled and named, port published on loopback only. |
| One aria attribute on the whole storefront. | Named menus and a labelled group per mega column — and deliberately no `aria-expanded`, because a CSS-only panel could never update it truthfully. |
| **No way to change a password.** The users screen said to delete the account and add it again — impossible for the last Super Admin, whose deletion is refused so the portal can never lock everyone out. So the one account that had to be able to rotate its password was the one that could not. | `/account`, reachable by every role, asks for the current password and ends every other session for that account. A Super Admin can reset somebody else's. |
| **One CSRF token per person, valid for the life of the server secret.** A token caught in a screenshot never expired. | Derived from the session's issue time, so it changes on every login and dies with the session. |
| **A stateless signed cookie outlived the password it was obtained with**, all the way to its own expiry. | Every cookie carries the account's `tokenVersion`. Bumping it on a password change makes correctly-signed cookies refuse. Verified: a second live session is dead the moment the password changes. |
| `Secure` was never set on the session cookie. | Set when the request arrived over TLS, and not on plain `http://localhost` — where setting it unconditionally would break every login instead of securing anything. |

**Three findings were my own tests being wrong and the app being right**, and are
recorded because a false alarm costs real time: outstanding is not the same as
credit headroom on a bill; `fetch` silently drops a `Host` header, so a guard
that worked looked broken; and disabling one menu entry removes four links, not
two, because the header renders every entry twice and that href also sits in a
mega panel.

**And one thing this audit broke and caught.** Moving the version marker onto the
record form put it in the wrong form first, taking all twenty storefront content
editor pages to HTTP 500. Nothing failed, because the suite checked `/design`,
`/books` and `/crm` and stopped. It now sweeps every `/edit/*` page.

---

## Things that were static and no longer are

An audit of what in this platform was hard-coded, manual, or only true because
somebody typed it once. Four were fixed; one turned out to need something from
the supplier rather than from me, and that is recorded rather than papered over.

**Every search re-asked both suppliers.** A customer reloading the fare list
waited 1.5–3 seconds per supplier for an answer that had not changed, and every
reload spent certification quota. Merged results are now cached for 90 seconds
and the list **says how old the quote is** rather than implying it is live.
Measured on DAC–DXB: 9.5s → 0.64s.

The TTL is short deliberately. A GDS fare is a live quote — the whole reason
`repriceOffer` exists is that one can vanish between seeing it and booking it.
**Re-pricing never reads the cache**; confirming a booking always asks the
supplier, because a cache feeding the confirmation step would be a way to sell a
fare that no longer exists.

**CRM dropdowns needed a code edit and a restart.** Adding a disposition meant
editing `admin/crm-fields.js`, which the CRM specification explicitly did not
want — and a manager who cannot add "Interested, waiting on their IATA renewal"
puts it in the notes field instead, where nothing can count it. `/crm/vocab` now
owns the call status, disposition, interest, demo and activity lists. Zero
hard-coded uses remain.

Retiring a value **hides it rather than deleting it**, and the screen refuses to
retire anything already recorded against a lead — otherwise that lead's history
would start rendering as a raw slug.

**There was no CSV import.** Export existed in four formats; growing past the
researched 400 towards the 5,800 in the roadmap meant hand-editing JSON.
`/crm/import` upserts on `lead_id` with a **mandatory preview** — adds, updates,
skips and ignored columns, all before anything is written. An upsert straight off
a paste is how a half-finished spreadsheet quietly overwrites the research
everything else depends on.

**An import cannot fabricate call progress.** The first version guarded updates
only, so a CSV row for a *new* lead could carry `call_status=won` and the import
would create a lead the pipeline counted as closed — a deal nobody made, in the
funnel and on the manager dashboard. Call-progress columns are now stripped when
the CSV is read, so adds and updates are both safe, and the preview names what it
is ignoring.

**Currency rates are typed by hand.** Freezing the rate onto each document is
correct and stays — a rate that moves next month must not restate a sale already
paid. But the *master* rate then ages silently, and it is what prices the next
foreign invoice. A scheduled check now reports any rate never confirmed or older
than thirty days, and `checkedOn` records when a human last looked.

### Hotels: entitled, but blocked on a schema rather than a permission

`/portal/hotels`, `/portal/packages` and `/portal/visa` are stored samples while
flights is live. Probing the Sabre host settled why that can change:

```
POST /v4.0.0/get/hotelavail    400  live — validates our payload
POST /v3.0.0/get/hoteldetails  400  live — validates our payload
POST /v1.0.0/book/hotel        403  ERR.2SG.SEC.NOT_AUTHORIZED
```

Hotel **search is entitled on these credentials** — it validates the request
rather than refusing it, which is the same distinction that mattered for flight
booking. Hotel *booking* is blocked exactly as flight booking is.

What stopped the build was the request schema: `SearchCriteria` must match one of
three alternatives and every shape tried came back *"instance failed to match
exactly one schema (matched 0 out of 3)"*. Roughly twenty attempts got no closer,
and guessing at a third-party schema indefinitely is not work — nor is shipping a
hotel page that pretends. **The ask to Sabre is therefore a document, not a
permission:** send the GetHotelAvail v4 `SearchCriteria` schema. The moment that
arrives this is a small piece of work, because the transport, auth and merge
layer already exist for flights.

---

## Scheduled checks

Nothing in this platform used to run on a timer. Every figure is derived at
request time, which is the right design for correctness and a poor one for
noticing — if the trial balance broke at 2am, or a supplier credential stopped
working, or an inventory block expired with stock on it, the first anybody knew
was the next time a human opened the right screen.

Six checks now run inside the admin portal, each on its own interval:

| Check | Every | Why it exists |
|---|---|---|
| Book integrity | 30 min | Two independent derivations of the same vouchers must agree. Verified by breaking it on purpose: a receipt pointing at an invoice that is not in the book made the control accounts and the journal differ by ৳12,345, and both were reported as critical within one pass. |
| Held bookings past ticketing | 1 h | A hold is only worth something until the supplier deadline — see the bug below. |
| Overdue receivables | 12 h | The chase list only existed while somebody had the page open. |
| Inventory expiry | 12 h | Unsold stock with an expiry date is cash on a shelf. It was displayed and never warned about. |
| Supplier connections | 1 h | A dead GDS credential looks exactly like a route with no inventory — the storefront just shows fewer fares. |
| Daily backup | 24 h | The only backup was a button somebody had to press. Fourteen dated copies are kept in `content/backups/`. |
| Currency rates | 12 h | Rates are hand-typed and freeze onto documents correctly, but the master then ages silently and prices the next foreign invoice. |

Three properties matter more than the checks themselves.

**Alerts are derived, not accumulated.** Each pass replaces that job's alerts
wholesale, so a problem that gets fixed disappears without anybody closing it —
confirmed by restoring the book and watching both critical alerts close on the
next pass. Only `firstSeen` and an acknowledgement persist, because "how long has
this been wrong" cannot be recovered from a book that is already correct again.

**A check that throws becomes an alert about itself.** A silent check is worse
than no check, because the screen looks calm either way.

**A stopped scheduler is made visible.** This is the failure that hides itself:
an empty alert list and a dead runner are indistinguishable. Every job records
when it last completed, a job two intervals late is reported as stopped rather
than slow, and `/accounts` says so in red at the top rather than showing a
reassuring blank.

Seeing an alert and signing it off are separate capabilities. Read Only is told
the book stopped balancing and cannot acknowledge it away.

**It has already caught a real outage.** Running `next build` while the dev server
was live corrupted `.next` — the known gotcha in troubleshooting below — and
`/accounts` started returning 500. Two of the seven checks failed on that pass,
and they were exactly the two that ask the app a question: book integrity and
supplier connections. The other five passed, so the failure was attributed
correctly rather than looking like a broken book. A clean restart put all seven
back. That is the design working: a check that cannot run reports itself instead
of going quiet.

```bash
# the fix for that gotcha
rm -rf .next && npm run dev:alt
```

### A bug this work found

The fare card showed `ticket by …` and the booking record threw it away —
`latestTicketing` was never stored. A held booking therefore lost the one date
that decides whether it is still worth anything, and would have sat there
quietly past its deadline describing a fare that no longer existed. It is stored
now, urgency is derived per day rather than frozen at write time, and a supplier
that quoted no deadline is its own state — `unknown`, which needs a human — not
treated as fine.

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
npm run verify
```

```bash
node scripts/verify-srs.mjs      # 195 checks — specification, hardening, automation
node scripts/verify-admin.mjs    # 50 checks — the admin portal, signed in
node scripts/verify-auth.mjs     # 39 checks — who may read what, and what leaks when refused
node scripts/verify-journal.mjs  # 31 checks — manual vouchers, and the reconciliation surviving them
node scripts/verify-bank.mjs     # 69 checks — a bank statement against the book, and every refusal
node scripts/verify-flights.mjs  # 57 checks — seven live routes against both GDS
```

**`verify-flights.mjs` reads the fare cards back out of the rendered page** and
checks each one for the things that make it safe to quote: a flight number, a
base and tax that add up to the total, a signature the booking page can
re-price, cheapest-first ordering, and a price that is not absurd. A wrong fare
is worse than no fare, because somebody would quote it. It also confirms a
forged signature is refused rather than guessed at, and that the page never
claims a ticket was issued.

Run it with the app on :3002 and the admin on :4001. **Do not run `next build`
while the dev server is up** — it overwrites `.next` underneath the running
process and every page starts returning 500 until the server is restarted with a
clean `.next`. It looks exactly like a catastrophic regression and is not one.

**441 checks** across the six suites against the running app: each one loads a
page and looks for the feature the specification asks for, reads the book and tests
that an identity holds, or asks for something it should not be given and checks the
bytes that come back. It is there because "it is all done" is not a claim anybody
should accept on trust, including from me. It currently reports **195 + 50 + 39 + 31 + 69 + 57
passed, 0 failed**, and it fails loudly if a page stops carrying what it claims — or
starts carrying something it should not.

Four of those checks are integrity rather than presence: both trial balances
must be zero, the control accounts must agree with the journal, the balance
sheet must balance, and no cash or bank account may ever go negative on any date
in the book.

**`verify-admin.mjs` signs in and uses the portal.** Everything else only ever
asked whether a URL answered, which proves routing and nothing else — a form can
render perfectly and still write nothing, write the wrong thing, or accept a
voucher that breaks the book. This one logs in, creates a supplier credit note
through the real form with the real CSRF token, watches the invalid version get
refused, saves the valid one, confirms the payable moved by exactly that amount,
finds the change in the audit log, switches menu entries off and sees them leave
the storefront, exercises backup and restore, is refused on a forged CSRF token,
and deletes what it made.

It creates its own throwaway super-admin with a random password and removes it
again — the final assertion is that `content/users.json` came back byte for
byte. No test password is committed anywhere.

---

---

---

---

## Finding things, and taking them away

The admin portal's lead list has had saved views, a search box, eight filters and four
export formats for months. The panel an agency's own staff use had almost none of it,
and the gap was in the wrong direction — the screen used twice a year was the one that
could be searched.

| | Before | Now |
|---|---|---|
| `/accounts` | nothing at all | 5 saved views, search, 5 filters, 4 exports + print |
| `/` | one export format | 6 saved views, search, 5 filters, 4 exports |
| `/agencies` | search, filters, 3 exports | + 6 saved views, each with a count |

**A saved view is a question with a name on it.** Every one is expressible in the filter
row underneath, and that is exactly why they exist: nobody rebuilds "never touched" out
of three dropdowns twice a day.

Three decisions worth stating, because each one is a way this could have been wrong:

**The accounting search reads the whole book, not the ten rows on screen.** A search
that only looked at the visible list would answer "not found" for almost every voucher
— worse than having no search, because it would be believed.

**Filtering `/` scopes every figure on it, not a list underneath.** The filter is pushed
down into `getMarket()` rather than applied to a table here, so all thirty-odd
aggregates move together and the page states `62 of 400` rather than silently
redefining what 100% means. A screen where the tiles say 400 and the table says 62 is a
screen telling two stories.

**The accounting export honours the DATES and deliberately ignores the search term.**
That export builds twenty-six ledgers out of the book; narrowing all of them by a
free-text search would quietly produce a trial balance that does not balance. A
download that disagrees with itself is worse than one that ignores a filter, because
nobody checks a spreadsheet against the screen.

The city dropdown on `/` is built from the whole market rather than the current scope —
built from the scoped data it would shrink to the one city already chosen and become a
control that cannot be changed once used.

---

## `/portal/accounting` — what the module is, before anyone gets a login

The storefront sold "a full ledger" in six words and the accounting module had no page
anywhere. A prospect could not find out what was in it without being given a demo
account, which is the wrong order round: the demo should confirm what the page already
said.

**The screen list and the role table are derived from the same declarations the product
runs on** — `lib/panel-modules.js` and `admin/roles.js`. A marketing page that lists
features by hand starts lying the first time a module is renamed, and it lies in the
direction of promising more than exists. Derived, the worst that can happen is the page
being terse.

It also says what the module is **not** — not a tax filing service, not payroll, not an
auditor — because those are the three things a Bangladeshi agency will assume are
included and would otherwise find out after signing.

Public, with no session and no figure from anybody's book: it describes the product,
not an installation.

---

---

---

## Running the paths that had never run

Several features had a route, a form, a validator, a journal account and a dropdown — and
no data had ever gone through any of them. A code path that has never executed is not
"probably fine"; it is untested in the strongest sense. Putting real records through them,
one at a time, through the portal so the validations and the audit trail actually run.

### Supplier deposit drawdowns

A pay method, a validator, `AC.ADVANCES`, and a dropdown option — and **zero of the book's
150 payments used it**. Everything below executed for the first time.

It works: the validator refuses an overdraw, a legitimate drawdown reduces the float,
`Dr Accounts payable / Cr Advances to suppliers` posts, and both derivations agree. Qatar's
float went ৳18,00,000 → ৳13,90,000 on a ৳4,10,000 drawdown.

It also found two things.

**A payment was never checked against what the bill still owed.** The first drawdown was
aimed at a bill a supplier had already refunded in full. It went straight through, and the
two derivations then disagreed by the whole ৳4,10,000: the journal debited Accounts payable
a second time while the control side floored the row at zero and reported no change.

Only `reconciliation()` noticed — the right last line of defence and the wrong first one. A
figure caught by a cross-check has already been written, and on a busy book it is written
among two hundred others. **The floor is exactly why it hides**: `Math.max(0, billed − paid
− …)` is correct for reporting what is owed and useless for spotting an overpayment,
because the overpaid amount is precisely what the floor removes.

`validateNotOverpaid` now refuses it before the write, counting everything that can settle a
bill — payments, supplier refunds on customer credit notes, supplier credit notes — and
saying which of them already covered it:

> `SFT-BIL-0125 has 0 still owing out of 410000 (410000 refunded by the supplier). Paying
> more would take Accounts payable below what is actually owed.`

**A refused save leaves a numbered blank behind.** `/books/new` creates the record *before*
the form is filled, so an abandoned or rejected edit leaves an empty voucher holding a
voucher number. It changes no figure — a zero posts nothing — but it puts gaps in the
numbering, and a gap in a voucher sequence is a question an auditor asks. Not changed here:
the create-then-edit flow is how the whole portal works, and a browser user sees the form
they are meant to fill. Worth knowing it litters.

### A suite that had quietly lost its session

Adding those checks exposed something in `verify-admin` itself. Its password-change section
ends by restoring `myCookie` — the cookie from *before* the change, which that change
deliberately kills by bumping `tokenVersion`. Every request after it went to `/login`.

Nothing noticed, because nothing followed. The first check added after that point read a
`302` with an empty body and reported a record as saved when it had never been submitted —
which is how a refusal check comes back green while refusing nothing. **A suite that
silently loses its session is worse than one that fails: every assertion after that point is
measuring a redirect.** It now keeps the re-issued cookie.

## Two todays, and a float that rose when you spent it

An adversarial audit — five lenses over the code and the data, every finding then put to a
verifier told to refute it — returned 16 confirmed problems from 57 candidates. Two were
live wrong numbers on screens an agency acts on. Both are fixed; a third surfaced while
fixing them.

### `todayISO()` was the newest voucher, not today

It returned the latest date on any invoice or receipt. Nothing recorded why, and it meant
the product had **two todays**: this one, and `clock.todayIn(zone())` in `admin/jobs.js`
which the scheduled alerts use. On the demo book they were nineteen days apart:

| | |
|---|---|
| Reminders screen | 10 invoices past 30 days, ৳18,12,380 |
| Overdue alert job | 21 invoices past 30 days, ৳34,66,980 |

Same book, same instant. **The screen an agency phones people from was missing eleven
customers.**

It also tied the whole book's age to its newest row. One invoice with a mistyped year
moves "today" forward by months: every open invoice becomes overdue, deferred income
collapses to nothing because every travel date is now in the past — and `reconciliation()`
stays clean throughout, **because both sides of its as-at check are bounded by the same
poisoned date.** A cross-check cannot catch a bad clock it shares.

It is now the calendar date in the company's timezone. The cost is stated plainly: a demo
book seeded in the past looks its age, so more reads as overdue and less as deferred. That
is the correct answer; the old behaviour was flattering rather than right.

### The supplier float had two definitions, and one of them went the wrong way

The Inventory screen computed `deposited − max(0, billed − settled)`. The portal's
drawdown validator computed `placed − drawn`. They were **৳31,79,600** apart:

| supplier | screen said | portal would allow |
|---|---|---|
| Biman | **−৳1,74,100** | ৳6,50,000 |
| Qatar | −৳1,58,500 | ৳18,00,000 |

The screen showed the float exhausted and overdrawn while the portal stood ready to
authorise the whole advance against it.

Worse than a second opinion: `settled` counted **every** payment to that supplier,
including a drawdown against the deposit itself. Spending the float raised `settled`, which
lowered `outstandingBills`, which **raised the reported available float**. A number that
goes up when you spend it is not a definition, it is a bug.

It survived because **zero of 150 payments used the `supplier_deposit` method**, so the two
were never put side by side. The rest of the codebase already knew better — the portal and
`verify-srs` both exclude that method from bank movements precisely because no fresh money
moves. One place forgot.

`lib/supplier-float.js` is now the single definition, imported by both. **The float is what
was advanced less what has been drawn against it.** What is still owed on bills is reported
beside it, never netted in — netting them was the original error, because *an unpaid bill
does not consume an advance, it sits beside it.*

### Found while fixing: the alert job never converted currency

With the clocks agreed the two still differed, and the reason was a third derivation. The
overdue job computed invoice totals by hand — `gross = Σ qty × unitPrice`, plus VAT, less
receipts — which is a second implementation of `invoiceTotals` and **never converted
currency**. `SFT-INV-0118` is $4,800 at 122.5, worth ৳5,88,000; the job valued it at
৳4,800. **A hundred-and-twenty-two-fold understatement**, on the one list an agency phones
people from.

The job now reads the app's own receivables ledger, which converts and is dated by the real
clock. One derivation. Screen and alert both read 22 invoices, ৳40,54,980.

### And a mess of my own making

Running `verify-srs` and `verify-admin` **at the same time** left five probe accounts in
`content/users.json`, one of them a `super_admin` — the exact thing that file's own comment
says must never happen. Both suites write it, and each restores the snapshot it took, so
the second one hands the first one's probes back permanently.

The snapshot now strips probe residue **on the way in**, which makes the file self-healing:
a crashed run, a killed terminal or an overlap leaves a mess that the next run clears rather
than preserves. It does **not** make concurrent runs safe — they still fight over one file —
and `npm run verify` chains them with `&&` for that reason.

Three suites also each had their own fetch helper and the same keep-alive bug: a pooled
socket idles past the server's five-second timeout while the suite blocks on something
slow, and the next request comes back `ECONNRESET`. `retryTransport` is now shared and
retries **transport errors only** — an HTTP status is an answer and gets reported as it
stands.

### A check that went red for reasons outside its subject

"Every check has run and none of them failed" asserted on `scheduler-state.json` as it
happened to stand, which made it a test of the last few hours rather than of the jobs. It
failed for a stale error from a boot three hours earlier, and again when a scheduled tick
fired *during* the suite — the fare-search job competes with the suite's own flight searches
and exceeded its 105-second budget. It now triggers the pass and then reads the result:
deterministic, slower, and actually exercising the jobs. **A check that goes red for reasons
outside its subject teaches people to ignore it.**

## Bank reconciliation

The book knew what it thought each bank account held. It had no way to ask the bank.
That gap is where a travel agency actually loses money — a cheque nobody banked, a
charge nobody recorded, a debit nobody authorised — and none of it is visible from
inside the book, because from inside the book everything reconciles with itself.

Import a statement at **Accounting → Bank statements** in the portal; the reconciliation
renders at `/accounts/reconcile`.

### There is no built-in layout for any bank, on purpose

The obvious feature is a dropdown: Dutch-Bangla, BRAC, City Bank, bKash. It is not
built. **I have not seen a real export from any of them**, and a layout guessed at is
worse than none — it puts money in the wrong column while looking like it knows what it
is doing. Same rule as the carrier contracts and the tax rates: nothing here is invented.

What is built instead is a mapping stated once per account, and the checks that make a
wrong mapping obvious immediately rather than at year end:

**The running balance is the check.** The bank has already told you what each line does
to the balance. If the reading is right, every consecutive pair satisfies
`previous ± amount = current`. Map Withdrawal and Deposit the wrong way round and it
fails on the first pair — measured on the test fixture, 125 breaks out of 126 lines,
before anything is saved. A statement with no balance column is not refused; it is
labelled as unverifiable.

**A date column that reads two ways is refused, not guessed.** `03/04/2026` is the third
of April and the fourth of March. The format is resolved against the *whole column* —
one day over twelve settles it — and when the column is genuinely ambiguous the operator
is asked. Guessing would move transactions by up to eleven months in a system whose
entire purpose is agreeing with somebody else about when money moved. A date that does
not exist (`31/02`) is refused rather than coerced into `2026-02-31`, a string that sorts
like a date, is not one, and would sit between the 28th and the 1st in every range filter
in the book.

**Lines outside the stated period are refused, never trimmed.** Trimming looks helpful
and hides the likeliest cause: the wrong period typed, or the wrong file for this account.

### A match must be unique to be automatic

Cheques clear late, so the matcher has to tolerate a few days of drift. The moment it
does, this book's own data becomes dangerous: **twenty-nine amounts repeat on different
days** through the Dutch-Bangla account, two payments of exactly ৳30,500 one day apart
among them. A matcher that picks the nearest is right about half the time and silent
either way, and the accountant finds out when a supplier calls about a bill the book says
is settled.

Three passes, strongest first, and a book entry consumed by an earlier pass is gone:

| Strength | What it means |
|---|---|
| `reference` | the bank's narration named the voucher — `CHQ SFT-PAY-0048` |
| `exact_date` | same day, same amount, same direction |
| `within_window` | same amount and direction, up to five days later |

**Anything not unique at its strength matches nothing** — and that cuts both ways: a line
fitting two entries is left alone, and two lines fitting one entry both stand down.

**Amounts are exact. There is no tolerance band.** A bank does not round. If the book
says 30,500 and the statement says 30,450, that fifty is a charge, a fee or an error, and
every one of those needs seeing. A "close enough" match would swallow exactly the
differences this exists to find.

A missed match leaves a line on a list somebody reads. A wrong match hides a real
difference inside a matched pair. The two are not symmetric, so this does not trade them
off evenly — it takes the visible failure every time.

### The statement, and what it refuses to claim

```
Per the bank                              Per the book
  Balance per the statement                 Balance per the book
  + deposits in transit                     + credits not in the book
  - unpresented payments                    - debits not in the book
  = adjusted bank balance          ===      = adjusted book balance
```

Work it through and the two sides are algebraically identical — **but only while the two
opening balances are the same number.** If last month was never finished, its unfinished
business falls straight through to the difference. That is the property worth having: a
reconciliation whose two sides always agreed would be a tautology that reassures
everybody and proves nothing. This one agrees exactly when last month was closed and
every line this month has been classified, and names the gap when it was not.

**An unresolved ambiguity blocks the verdict.** An ambiguous line *is* in the book — we
just do not know which entry. Counting it as "the bank did this alone" would be a lie
that happens to balance. It is excluded from both adjustment columns and the statement is
marked incomplete.

### What an adversarial review found, and what changed

Three independent designs for this were generated and put through nine adversarial
reviews while the implementation was being written. Two findings were real, both
reproduced against the shipped code, and both were the same failure wearing different
clothes: **the reconciliation reported itself reconciled, with a difference of zero, and
offered a journal voucher that would have recorded money the book already held.**

| The case | What happened | Why it was invisible |
|---|---|---|
| A cheque written 31 July, presented 2 August | The candidate set was bounded by the period, so it matched nothing in August, was declared a bank charge, and the draft offered to post it | The July payment sat outstanding in the *other* column, so both sides moved by 71,000 and the difference stayed at zero |
| Three customer cheques banked as one deposit | The single credit matched nothing and became a "bank credit"; the three receipts became "deposits in transit" | Same shape — both columns moved by 100,000 and the arithmetic tied |

The root cause was one overclaim. The verdict `unknown_to_book` said *the bank did this
alone* when all the matcher actually knew was *nothing in the pool fits*. Three changes:

**Unmatched is now just `unmatched`, and it does not enter the arithmetic.** A line
becomes a bank item when a person classifies it, never by default. Unclassified lines are
excluded, which makes the difference **exactly what they are worth** — a far stronger
statement than "it reconciles". On the test fixture the four bank-only items start
unexplained and the screen reads **−৳13,624**, not a green tick.

**Outstanding items are carried forward.** A cheque that did not clear last month is in
this month's candidate pool, so it matches when it does clear. The carry-forward floor is
the *earliest imported statement* for that account: before that there is no evidence a
movement is outstanding, only that nobody looked. Without the floor, one August import
would declare all sixty-six payments since the book opened to be unpresented cheques. A
carried item gets a ninety-day window rather than five — past that it is not an
unpresented cheque, it is one nobody banked, and matching a look-alike would bury that.

**Many-to-one is detected and offered, never applied.** A bounded subset search finds
groups of outstanding entries summing exactly to a line. It produces a decision for a
person, and **a confirmed group is still refused unless it adds up exactly** — a grouping
is a judgement about what was banked together, not a licence to close a gap.

Two smaller findings, also fixed: **the statement is now checked against itself** —
closing minus opening must equal what the lines add up to, which is the only thing
standing between a typed balance and a reconciliation built on a typo — and **each
adjustment line is dated the day it happened** rather than the period end, which had been
putting a charge taken on the 3rd into the 31st and would refuse the whole voucher if the
period end happened to be locked.

**Reconciled is not the same as finished.** A statement can agree perfectly while
carrying four items the book has never recorded — a maintenance fee, excise duty,
interest, an unexplained ATM debit. The arithmetic works *because* those sit in the
adjustment column. Nothing has been posted, the P&L is still missing the charges, and
next month they will still be there. So `reconciled` states agreement and `settled`
states the work, and **sign-off is refused unless it is settled** — a signed period with
unrecorded bank charges is an omission with somebody's name on it.

**Deposits in transit and unpresented cheques get no journal entry at all.** The book is
already right; the bank is behind. Posting an adjustment for those is the classic way a
reconciliation double-counts, which is why they live in the other column.

**A sign-off records the difference that was true when it was signed.** Everything else
in this book is derived so it cannot go stale; this is the one deliberate exception. A
voucher back-dated into a closed reconciliation moves the book's closing balance, the
stored number does not, and the screen says so instead of showing a tick over a figure
that has since changed.

### The P&L was ignoring every journal voucher

`profitAndLoss()` is built from `summarise()` and `expensesByCategory()`, and both walk
**vouchers**. That was complete until manual journal vouchers existed, and then it
silently stopped being — because a depreciation charge, an accrued rent and a bank fee all
post to real expense accounts and none of them touch a voucher.

The demo book showed it plainly. The journal carried ৳67,700 of such expenses and the P&L
reported a net profit that ignored every taka:

| | |
|---|---|
| P&L net profit, as reported | **৳753,000** |
| Journal expenses it could not see | ৳67,700 |
| True net profit | **৳685,300** |

Meanwhile the balance sheet derives retained earnings *from the journal*, so the two
statements disagreed about profit by exactly that amount and neither said so.
`reconciliation()` did not catch it and could not: it cross-checks ten control accounts,
and "does the P&L agree with the balance sheet" is a different question that nothing was
asking.

The P&L now picks up income and expense accounts the voucher figures do not already
represent, and **lists them separately rather than merging them into the expense
categories**. An expense voucher was raised against a document; a journal line exists
because somebody decided it should. An accountant reading the P&L can tell which is which
without opening the ledger.

**`plAgreesWithLedger()` is the third cross-check**, and it is rendered on the Financials
screen — because the first version was not, and **an uncalled check is not a check**. It
carried an arithmetic error for a day for exactly that reason.

### What the ৳867,000 was, and the asset that was missing

The first account of this gap said "supplier bills for stock not yet sold, which has no
inventory asset to sit in", and pointed at the inventory table. That was a guess and it
was wrong: `book.inventory` never touches a bill or a posting, so its ৳15,479,400 of
unsold blocks cannot contribute a taka.

The real cause, checked to the taka: a supplier bill debited `PURCHASES` on its own date
unconditionally, while `summarise()` builds cost of sales from **live** invoices only —
`isLive` excludes draft. **Five draft invoices carried exactly ৳867,000 of supplier
bills**, in the ledger as cost and correctly out of the P&L, with nothing holding the
difference.

**The P&L was the side that was right.** Matching says the cost of an unsold booking is
not yet a cost. What was missing was an **asset**, and `WIP_SUPPLIER_COST` — *Unbilled
supplier cost, work in progress* — is it.

| | before | after |
|---|---|---|
| P&L net profit | ৳688,676 | ৳688,676 |
| Ledger income less expense | −৳178,324 | **৳688,676** |
| Difference | ৳867,000 | **৳0** |
| Balance-sheet retained earnings | −৳178,324 | **৳688,676** |
| Total assets | ৳23,125,224 | ৳23,992,224 |

The balance sheet closed to zero both before and after, because the missing asset and the
understated equity moved together. **Balancing proved nothing** — which is exactly why the
bridge check exists separately from `reconciliation()`.

### Derived at the posting, not corrected by a voucher

`buildJournal` decides a bill's debit account from the status of the invoice it belongs
to. A draft invoice's bill debits the asset; everything else debits cost of sales.

**A period-end adjusting voucher was considered and rejected.** A voucher can be posted
twice, and posting it twice takes the difference to *minus* ৳867,000 with every check
still reading clean — because its credit leg lands back on `PURCHASES`, where the P&L's
journal sweep cannot see it. **A correction that can be applied twice is not a
correction.** Deriving it means there is nothing to post and nothing to post twice: when a
draft is finalised, the bill moves to cost of sales by itself, on the right date, with no
entry and no chance of forgetting.

**Only `draft` is capitalised, on purpose.** A *cancelled* booking's supplier cost is a
loss, not an asset — the sale is off and the agency holds nothing. A bill whose
`invoiceRef` names no invoice, or carries none, is expensed too: the asset is a claim that
the money bought something still sellable, and an unlinked bill is no evidence of that.
Both fall to the expensing side deliberately, **because the failure that matters is cost
hidden inside an asset, not an asset shown as cost.**

### The check that was supposed to catch it was itself wrong

`plAgreesWithLedger` subtracted supplier refunds from a cost figure that was already net
of them — `cost = grossCost - supplierRefunds - supplierCredits` in `summarise()`. It
therefore claimed to explain ৳1,322,500 of an ৳867,000 gap and reported `unexplained` as
**−৳455,500**: a negative unexplained gap, which is nonsense on its face, and which
quietly absorbed ৳455,500 of real discrepancy into its own "known reason" bucket.

That is the exact failure mode the comment above the function warns against, committed by
the function itself. It survived because nothing rendered its answer.

There is now **no explanatory bucket at all**. A bucket is somewhere a real misstatement
can sit and still read clean, which made the check answer a weaker question than its own
name. With the asset in place there is nothing legitimate left to explain, so it asserts
the difference itself is zero and merely *reports* what is capitalised beside it.

`verify-journal` asserts three things on the rendered page: that the check appears at all,
that the difference is exactly zero, and that no supplier cost sits in cost of sales which
cost of sales does not recognise.

### The same hole, one layer down — found by planting a voucher

The first fix let the P&L pick up journal-only accounts and **excluded** the ones the
voucher figures already cover: Sales, Purchases, the expense categories. That left the
same hole one level below, because `expensesByCategory` walks `book.expenses` and
therefore represents the **voucher part** of a category and nothing else.

A journal voucher posted to Government Fees reached the ledger and **no part of the P&L at
all**. Proved by planting one: a ৳50,000 voucher moved `unexplained` on the bridge from
৳0 to exactly ৳50,000 — the bridge doing its job, and the P&L failing to do its own.

The split is now by **origin, not by account**: voucher postings are in the rows above,
manual postings are listed separately, and every income and expense account is covered by
exactly one of the two. The same argument applies to Sales, Credit notes, Purchases and
Memo cost — `summarise()` sees a manual entry to none of them either.

The planted voucher is now a permanent check: it must appear on the P&L as its own row,
and the bridge must stay fully explained once it does.

### One export, two answers to "Net profit"

The Summary sheet reported `Net profit 758,000` from `summarise()` alone while the P&L
sheet reported `688,676` including journal vouchers — same label, same file, ৳69,324
apart. A reader who quotes the wrong one is not being careless; the file gave them two
answers. The Summary row is now labelled *trading only, before journal adjustments* and
points at the sheet carrying the figure to quote, rather than being silently changed —
the voucher-only view is worth having, it just has to say that it is one.

### The reconciliation asked for a posting and could not see it arrive

`requiresPosting` counted classified bank-only lines and never came down. Classify four
charges, post them correctly, come back — and it still said the period was unfinished,
with nothing on screen to do about it. **A feature that asks for an action and cannot
notice it happening is worse than one that never asked.**

Now detected, not recorded. A voucher hitting the bank account inside the period moves the
**journal** balance while leaving `bankBook`'s voucher-derived closing alone, so the two
are compared: once the journal has moved by exactly what the classified items are worth,
they are on the book. Nothing to tick off, and nothing that *can* be ticked off without
the entry existing. Posting the wrong amount, or the right amount the wrong way round,
leaves it unsettled — three charges recorded and one forgotten is precisely the state
worth catching.

### The scheduler guessed a number where it could have waited

The startup pass ran fifteen seconds after boot, with a comment saying the app might still
be compiling. The worry was right and the number was wrong: `next dev` takes thirty to
sixty seconds on first request, so **Book integrity — the most important check in the
product — failed with `fetch failed` on almost every boot** and sat failed until somebody
re-ran it by hand, while raising a critical alert about itself. Seen three times in one
day.

It now polls until the app answers, up to three minutes, then runs anyway if it never
does — because a genuinely absent app *is* worth an alert. The difference is that the
alert then means something.

### The GDS check could not wait as long as the app was allowed to take

`Supplier connections` fetches the storefront's live fare search and had **no timeout**,
so it inherited Node's default thirty seconds for response headers — while the app gives
*each* supplier up to `GDS_TIMEOUT_MS`, forty-five seconds as configured. A two-supplier
search slower than thirty therefore came back `fetch failed` and was raised as a critical
"Supplier connections could not run".

That is a false alarm about the agency's suppliers, which is the specific thing this job
must not do carelessly: **an operator who learns the GDS alert cries wolf stops reading
it, and the real credential failure it was built for goes unread too.** A live search here
has legitimately taken 36 seconds.

The budget is now derived from the app's own setting so the two cannot drift apart again,
and a timeout says so in words that distinguish it — "the fare search did not answer
within Ns; the suppliers may be slow rather than broken" is a different instruction from
"the credential is dead".

It then failed differently, and usefully: **`the storefront answered HTTP 500`**, because
a scheduled pass landed while `next dev` was compiling that route after a restart. The
startup pass waits for the app; a tick an hour later had no such protection. One retry
after five seconds now separates *compiling* from *broken* — and a persistent 500 still
raises, which is the case the job exists for. Deliberately only one: a job that retries
until it succeeds is a job that never reports anything.

### A suite that failed for a reason that was not a failure

`verify-bank` began failing at its first portal call, reproducibly, while the portal
answered every request put to it by hand. The cause: the readiness probes open a pooled
keep-alive socket, `execFileSync` then blocks the event loop for a couple of seconds
generating the statement fixture, and the server closes the idle socket on its five-second
timeout — so the next request comes back `ECONNRESET` from a dead socket.

Fixed twice over: the fixture is now generated **before** anything is fetched, which
removes the idle window, and `probe-session` retries once on a transport error. Only
transport errors — an HTTP status is an answer and gets reported as it stands.

### Two implementations, and the check that stops them drifting

`bookMovements` exists twice — TypeScript in `lib/bankrec.ts` for the app, plain JS in
`admin/server.js` for the portal, which cannot import TypeScript. **Eight** record types
move money through a bank account: receipts, payments, expenses, refunded credit notes,
transfers in, transfers out, supplier credit notes, and supplier deposits.

That list is not obvious. Preparing this I counted the Dutch-Bangla movements twice from
first principles and got it wrong both times — 188, then 192, against a true 192. The
four I dropped were supplier deposits, which do not look like bank movements until you
remember an agency wires a float to its consolidator. A matcher that forgets a kind
reports real transactions as missing from the book, and the accountant hunts a bank error
that never happened.

So the app side delegates to `bankBook` — the same derivation the Bank screen already
uses — `assertComplete` fails if the flattened net stops matching the bank column, and
`verify-bank.mjs` asserts the app and the portal agree on the counts they render.

### What it found while being built

The book gained imported statements and the portal's raw-JSON editor started refusing to
save: form encoding roughly triples JSON, so a 314 KB book arrives as a 2.1 MB body
against a 2 MB cap sized for a smaller product. Raised to 32 MB with the arithmetic
written down, because a limit that has to be revisited every time the product grows will
be hit at the worst moment.

### Known limits, stated

**A foreign-currency account is not modelled.** `Bank` has no currency field, so "City
Bank — USD" is a name and the book values it in taka. Reconciling that against a real USD
statement would be wrong, and nothing here pretends otherwise.

**bKash Merchant is treated as a bank account** and takes thirty MFS receipts. An MFS
settlement report is not shaped like a bank statement; the column mapping will carry it,
but none of that has been tested against a real bKash export.

**Import is paste or file-picker, not upload.** The portal is `node:http` with no
multipart parser; the picker reads the file in the browser and fills the box, so an
operator does not have to know the difference.

### `verify-bank.mjs`

63 checks. The fixture is **generated from the book's own 192 movements** by
`scripts/make-bank-statement.mjs` and then broken in seven specific ways — a cheque
presented four days late, an unpresented payment, a deposit in transit, two bank charges,
an interest credit and an unexplained ATM debit. A hand-written fixture tests the cases
its author thought of; this one carries the awkwardness already in the data.

It proves: the parser and the balance chain, a swapped mapping caught, an ambiguous date
refused, an impossible date refused, preview writing nothing, a stray period refused, the
import storing its mapping and the original file, the app rendering all four bank-only
items, **the difference equalling exactly the unexplained lines**, the draft offering
nothing while they are unexplained, both sides agreeing once they are classified,
`settled` staying false with four items unposted, no entry matched twice, ambiguity refusing a verdict from both directions, a
near amount and a wrong direction and an out-of-window date all refused, **a carried-forward cheque
matching when it clears and a look-alike two hundred days later still refused**, **an
aggregated deposit offered as a group and never posted twice**, **a confirmed group
refused when it does not add up**, **a typed closing balance its own lines cannot produce
caught**, an opening gap surfacing by name, sign-off refused while items are unexplained,
a Manager refused at the route, the app and portal agreeing on their counts, and the book restored byte for byte.

## Journal vouchers, and what they cost the reconciliation

Every posting in this book used to be derived from a business document — an invoice, a
receipt, a bill, a payment, an expense, a credit note. That covers trading and nothing
else. There was no way to record depreciation, an accrual, a prepayment, a provision,
a reclassification between two accounts, a correction of a posting made last month, or
the opening balances of an agency migrating off TRAACS or Tally.

An accountant handed this book **could not close a month, and could not bring their
existing balances in on day one** — which is the same as saying they could not adopt
it at all. `/accounts/journal` renders them; the admin portal writes them.

### The design problem, which is the interesting part

The central safety property of this book is that the same figures are derived TWICE by
independent routes — control accounts walk the vouchers, the journal builds
double-entry from those same vouchers — and `reconciliation()` asserts the two agree.
**That agreement is evidence precisely because neither derivation can see the other.**

A manual voucher exists only on the journal side. Post one to Accounts receivable and
the ledger moves while `receivables()` does not, and the reconciliation reports a
difference that is not a defect. Three ways out, two of them wrong:

| Option | Why not |
|---|---|
| Teach the control functions about manual entries | The two routes would share a term, and two derivations that share a term agreeing proves nothing. It converts the book's best evidence into a tautology. |
| Forbid manual entries from touching a control account | The cross-check survives untouched and the feature loses its two most important uses — opening balances for receivables and payables, and correcting a mis-posted customer balance. |
| **State the adjustment** | The routes stay independent. `reconciliation()` gains a third column: control **plus manual adjustments** must equal the ledger. A difference not explained by a listed voucher is still exactly as loud as it was. |

The third is what is built, and it is also what a real reconciliation looks like —
reconciling items are listed, not hidden, and that is the point of them.

```
Account                  Control total   Manual adj.   Ledger balance   Difference
Cash in hand                   308,780        -1,450          307,330            0
Accounts receivable          4,386,378             0        4,386,378            0
```

**Said plainly: a manual voucher can be used to paper over a genuine defect.** Post the
difference to the account that disagrees and the check goes green. That risk is not
removable — it exists in every accounting system ever written, and it is why auditors
read journals first. What is controllable is visibility, so a voucher touching a
control account is never silent: it is listed by number, date, narration and author on
the Financials screen and on its own sheet in the export, rather than netted into a
total.

### The rules, and where they live

`lib/journal-rules.js` is plain CommonJS because **two processes need it and only one
of them can run TypeScript**. The app renders vouchers; the zero-dependency portal
writes them. Two copies of "what counts as a valid voucher" would agree on the day they
were written and not for long after — and the failure would be the portal accepting a
posting the app cannot render. Same arrangement as `lib/panel-modules.js` and
`lib/period-lock.js`.

The chart of accounts moved there too, and `lib/accounting.ts` calls straight into it.
An account list and a rule that says "the account must be in the list" have to come
from one place, or the rule means nothing.

A voucher is refused unless: debits equal credits, there are at least two lines, every
account exists in the chart, no line is both a debit and a credit, nothing is negative,
a narration is present, and the date is neither before the financial year nor inside a
closed period. **Every failure is reported at once and the typed voucher is handed
back** — a form that reports one problem per submission is how a five-line voucher
takes five attempts.

**A posted voucher is reversed, never edited or deleted.** A posted entry that can be
silently altered is not an audit trail, it is a draft — and the correction of a mistake
is itself a fact about the month somebody may need to explain. The reversal is dated
today rather than back into the month being corrected, so both vouchers stay visible
where they happened.

### Your own accounts

The chart used to be derived in full and had nothing for accruals, prepayments,
provisions, depreciation, retained earnings or suspense — a voucher would have had
nowhere to post. **Records → Ledger accounts** lets an accountant add their own, with
their own codes so an agency migrating off another system keeps its account numbers.
Codes are namespaced `GL:<code>` on the way into the journal, so a hand-typed `AR` or
`CASH` cannot silently merge into a control account.

`node scripts/seed-journal.mjs` loads nine adjustment accounts and four worked
vouchers — depreciation, an accrual, a prepaid release, and a counter cash shortage.
The last one posts to Cash on purpose, so the reconciling-items panel has something in
it.

### A defect this uncovered

Making the chart user-editable broke an assumption that had been safe for as long as
the chart *was* the data: `summariseBalances` walked the chart and dropped any posting
whose account it did not find. Delete a ledger account a voucher had posted to and
those lines silently left the ledger — **the journal trial balance came apart by 10,200
with nothing on screen to say why.**

A trial balance that balances must not depend on masters data. Orphaned postings are
now surfaced under their raw code as `— account no longer in the chart`. It is
deliberately ugly: the fix is to restore the account or reverse the voucher, and it
should not be comfortable to live with.

### Who may post one

`books_journal`, held by **Super Admin and Accountant only** — deliberately not by
Manager, who can already read the financials and approve a cancellation. The person who
reviews the numbers should not also be the person who can adjust them. Reading the
journal needs `books_financials`, the same as the ledger, because a voucher can carry
cost and margin.

`scripts/verify-journal.mjs` proves it end to end in 23 checks: every refusal, the
period lock, a balanced voucher reaching the book with a number and an author, a
control-account voucher showing up as an adjustment with the difference still zero, the
reversal pair pointing at each other, the whole reconciliation still clean afterwards,
and a Manager being refused at the route rather than merely not shown the form.

## Signing in to the app

The admin portal on `:4001` had a login, six roles and a signed cookie. The app on
`:3002` had none of it. Every accounting page and every market-intelligence page
answered `200` to anybody who could reach the port — twenty-five pages carrying the
trial balance, the balance sheet, every customer and supplier balance, supplier cost
and margin, and 400 researched prospects with named decision makers and their mobile
numbers. The `/api` routes had been thought about and closed; the pages that render
the same data out of the same files had not.

### One issuer, and the app is not it

`lib/auth.ts` **verifies a session and never issues one.** There is no second login
form, no second password store and no second place a forgery could start. The portal
signs a cookie; the app checks it.

That works because **cookies are not scoped by port.** A cookie set by
`localhost:4001` is sent to `localhost:3002`, and `SameSite=Strict` is satisfied
because both are the same site. So signing in on the portal signs you in to the
panel, which is also the behaviour an agency expects: one login, not two.

What the app verifies, in order — and any failure returns the same nothing:

| Check | Why it is there |
|---|---|
| HMAC over the payload, compared with `timingSafeEqual` | The signature is the whole security boundary |
| Length equality before the compare | `timingSafeEqual` throws on a length mismatch, which would turn a forged cookie into a 500 |
| Expiry, from inside the signed payload | Outside it, the expiry would be editable by the holder |
| The account still exists | A deleted account's cookie must die with it |
| `tokenVersion` matches the account's | This is what makes a session **killable**, not merely expiring — a password change bumps it and every outstanding cookie refuses |

The refusal never says which check failed, and never distinguishes "no such account"
from "wrong password" from "expired". `viewer()` returns `null` for all of them.

### The guard is in the data layer, and that was not the first attempt

Two versions were built before this one, and both were wrong in the same way.

**A layout and the page beneath it render in parallel.** Returning a sign-in card
from the layout does not stop the page from running, and neither does calling
`redirect()` from it. The page renders anyway and its output is serialised into the
same response. Measured against the running dev server, `GET /accounts/financials`
with no cookie:

| Guard | Response | Body | What was in it |
|---|---|---|---|
| Layout returns a sign-in card | `200` | 49,919 b | `Accounts receivable`, `Retained …`, both trial balance headings |
| Layout calls `redirect()` | `307` | 48,009 b | the same names, in the body of the redirect |
| **Guard inside `getBook()`** | `307` | 9,842 b | nothing from the book |

A 307 whose body carries the page it is redirecting away from. No figures surfaced in
those particular runs, and that is the part to be uneasy about rather than reassured
by: how far the page gets before the stream is cut is decided by render speed, file
cache warmth and book size — not by the guard. **A leak that depends on a race still
leaks; it just also passes a test.**

Middleware would be early enough and cannot do this: it runs on the Edge runtime, and
both the signing secret and the user record are files on disk.

So the check sits in the only place a page cannot render around it — the function that
opens the data. `getBook()`, `getMarket()`, `getDataset()` and `getCompetitors()` call
`requireRead()` before reading anything. There is nothing to serialise if the read
never returns, and **a page added next year gets this for free instead of having to
remember.** A check in `verify-auth.mjs` reads all twenty-five pages in the two
guarded groups and fails if any one of them reaches its data another way.

The `/api` routes authorise differently — middleware holds them to loopback — so they
call `getBookUnguarded()` and `getDatasetUnguarded()`. The ugly name is the point:
every call site is a place this check is **not** running, and it should be obvious in
a diff and trivial to grep for.

### `books_financials`, split out of `books_read`

Every one of the six roles held `books_read`. That was harmless while it only meant
"may open the invoice list". It stopped being harmless when the same capability began
gating the profit and loss, the balance sheet, the trial balance, the general ledger
and the per-service cost and margin — **a Sales Executive with `books_read` could read
what the agency pays its consolidator for a ticket it sells them.** That is the single
number a travel agency most wants its own counter staff not to have.

So the line is now drawn where an agency draws it:

- **`books_read`** — the records I work with: invoices, receipts, bills, statements, a
  customer's balance.
- **`books_financials`** — the whole business's position and what things actually
  cost. Held by Super Admin, Accountant and Manager. Not by Sales Executive,
  Operations Staff or Read Only.

`/accounts/financials`, `/accounts/reports` and `/accounts/ledger` need it.

**The landing page gates figures, not the route.** `/accounts` is the group's locked
entry point, so it cannot be closed by role — but it was showing today's profit, the
cash and bank balances, supplier cost, gross and net profit, and a ten-day table with
Cost and Gross profit columns. The route stays open to every role and the *figures*
are what disappear: someone without `books_financials` keeps today's sales, what
customers owe and what suppliers are owed, and loses cost, margin and the treasury
position.

**Three lists of the same modules, all three filtered.** The nav, the quick-action
tiles on the landing, and the mobile menu each render the module list. Filtering the
nav alone left Financials, Reports and General ledger sitting on the landing as tiles
for a Sales Executive — clickable, and bounced. A link somebody cannot open reads as a
broken product rather than a permission, and it also tells them exactly what is being
kept from them.

### Refused, and what they see

A refused request lands on `/signin`, which is a route of its own and outside both
guarded groups — it has to be, or the guard that sent them there would catch it.

- **Anonymous** → "Sign in to open the book", with a link to the portal. Not a login
  form: the portal is the only place a password is checked.
- **Signed in, wrong role** → "Your role does not include this."
- **The path that was refused is shown**, so the person knows what to ask for. Only if
  it is a local path — an absolute URL in `next=` is neither rendered nor linked,
  because a phishing URL printed on a page that looks like ours borrows our
  credibility.

**A switched-off module 404s first, before the session is even looked at.** That
ordering is deliberate: answering "sign in to see this" for a module the installation
was never sold would confirm the module exists, and an outsider could enumerate which
modules an agency bought by reading the difference.

**Signing out happens on the portal.** The portal's `/logout` is a POST with a CSRF
token. The app could mint one — it has the secret and the session — but doing so would
make the app a second place that can *act* on a session rather than only read one, and
verifying-without-issuing is the entire reason there is exactly one issuer. So the
nav links to the portal, where the button already is, and says so.

### What `verify-auth.mjs` actually proves

39 checks. **Every assertion reads the response body, not the status** — because the
first two versions of this guard both returned a believable status while leaking, and
a check that read only the status passed both times.

- Eight guarded paths, anonymous: refused, and the body contains nothing from the book
  or the CRM.
- `super_admin` and `accountant` open Financials and the book really is there — a guard
  that refuses everybody is not a working guard.
- `sales_exec` and `read_only` are refused Financials, Reports and Ledger; still open
  Sales; see the landing with no cost, margin, cash or bank balance; and are not
  offered a link they cannot use.
- A signature with one character changed, a truncated signature, a signature removed
  altogether, and an expiry moved into the past — all refused.
- **A live session dies the moment `tokenVersion` is bumped**, asserted as `200`
  before and refused after with the same cookie.
- A switched-off module 404s for an anonymous caller *and* for a Super Admin.
- The `/api` routes still serve on loopback with no cookie, so moving the guard did not
  quietly break the export buttons.
- All twenty-five pages in the guarded groups read through a guarded reader.
- `content/users.json` comes back byte for byte. Probe accounts are created per role
  with a random password that never leaves the process, and removed on exit including
  on a crash. **No test password is committed anywhere.**

`scripts/lib/probe-session.mjs` holds that scaffolding once rather than three times,
because it writes to the file that holds the real accounts' password hashes and a copy
with the restore logic slightly wrong is not a flaky test — it is a lost account.

## Roles, enforced

Six roles from the accounting specification. They used to be described on a
settings page and not enforced — one login could do everything. `admin/roles.js`
is the enforcement, and two rules matter:

**Guarding happens at the route, not in the sidebar.** Hiding a link stops
somebody clicking it; it does not stop them typing the URL or replaying a form
post. Every request is checked before any handler runs.

In the *app* the same rule needed one more step, because a Next.js layout cannot
stop the page beneath it from rendering — so there the check is inside the function
that opens the data. Same principle, one level lower; the reasoning and the
measurements are in [Signing in to the app](#signing-in-to-the-app).

**Anything not explicitly allowed is denied.** A new route is inaccessible to
every non-super-admin until somebody maps it on purpose, which is the safe
direction for a mistake to fall.

| Role | Can | Sees the P&L, ledger and margin | Posts a journal voucher |
|---|---|---|---|
| Super Admin | Everything, including settings and user management | yes | yes |
| Accountant | All vouchers, credit notes, reports, statements and the audit log. No settings, no users | yes | yes |
| Sales Executive | Prospect queue, invoices and customer receipts | **no** | no |
| Operations Staff | Supplier bookings, bills, payments and stock only | **no** | no |
| Manager | Read everything, reassign leads, approve cancellations, read the audit log | yes | **no** |
| Read Only | Statements, customer balances and the records. Nothing editable anywhere | **no** | no |

The third column is the `books_financials` capability, split out of `books_read` once
the same capability started gating both "may open the invoice list" and "may read what
we pay our consolidator" — see [Signing in to the app](#signing-in-to-the-app). The
fourth is `books_journal`; a Manager is deliberately excluded, because the person who
reviews the numbers should not be the person who can adjust them. See
[Journal vouchers](#journal-vouchers-and-what-they-cost-the-reconciliation).

**A Sales Executive can raise an invoice but cannot reverse one.** Credit notes
are a separate capability held by Accountant, Manager and Super Admin, because
the person who made the sale should not be the person who cancels it.

**Your own account is not an administrative privilege.** `/account` needs no
capability at all: any signed-in person can change their own password, having
proved they know the current one. Putting it behind the `users` capability would
have recreated the exact bug it was added to fix — an Accountant unable to rotate
their own credentials, and only a Super Admin able to.

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

> **Pick one. Do not run both against the same database.**
>
> `prisma/schema.prisma` and `db/schema.sql` are two hand-written mirrors of the
> same ten entities. They are not generated from each other, so their constraint
> names and column details differ, and Prisma will offer to **drop and recreate
> all ten tables** if it is pointed at a database that `schema.sql` built. Check
> before you apply anything:
>
> ```bash
> npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
> ```
>
> The three reporting views exist only in the SQL file — Prisma does not model
> views, so a Prisma-managed database will not have them.

**Option A — Prisma**

```bash
cp .env.example .env          # point DATABASE_URL at your MySQL
npx prisma migrate dev --name init
npx prisma studio             # browse/edit records in a GUI
```

Needs **Prisma 7 or newer**, which is pinned in `devDependencies`. Prisma 7
removed `url = env("DATABASE_URL")` from the schema file, so the connection
string lives in `prisma.config.ts`. Before that was fixed the documented command
above failed on every machine — nothing in this app runs Prisma, so nothing
caught it until the schema was validated on purpose.

**Option B — straight into the existing OTAPlatform MySQL container**

```bash
# run from the OTAPlatform folder — root password is 'root', host port is 3307
docker compose exec -T mysql mysql -uroot -proot < db/schema.sql
```

This creates a separate `ota_market_intel` database and leaves `otaplatform`
untouched. Verified: 10 tables and 3 views.

---

## Docker

```bash
docker compose up -d --build
```

Open **http://localhost:3003**. Runs alongside the OTAPlatform stack with no port
collision, and reaches `otaplatform_mysql:3306` by container name over the shared
network.

**This had never built until 3 August 2026.** The Dockerfile copied a `public/`
directory that does not exist in this project, so the build failed two steps
after a successful compile — `docker compose up --build` was documented in two
places as the way to run this and had never once worked. See DOCKER.md for what
else that fix needed: `content/` is a bind mount rather than baked into the image,
because the admin portal writes those same files from the host, and the port is
published on loopback only.

Three reporting views ship with the DDL:

- `v_credential_summary` — the headline dashboard numbers in one row
- `v_cluster_rollup` — agencies, A/B/C split and IATA count per cluster
- `v_call_sheet` — the dial-ready list: A and B priority, no existing platform

Once the DB is live, swap the file reads in `lib/agencies.ts` for Prisma queries.
Every page and the API route go through that one module, so nothing else changes — the schema is
identical.

---

## Multi-currency, and settling in a foreign currency

Any invoice or bill can name a currency and the rate it was raised at. Line
amounts stay in the document currency — exactly what the customer sees — and
everything the book totals is converted at the document's own stored rate.

The rate is copied onto the document and never looked up again. A rate that
moves next month must not restate a sale that was already made and already paid,
which is the whole reason it lives on the document rather than being read from
the Currencies master at display time.

A **receipt** carries its own currency and rate, because the rate on the day the
money arrives is rarely the rate the invoice was raised at, and the gap between
them is a real gain or loss the agency takes. `lib/fx.ts` splits one settlement
into three parts — what it relieved, what the rate moved, and what was simply too
much — and the journal and the control-side derivations both call it, so there is
one answer to "how much did this clear" rather than two.

### It had never run

That engine had an `allocate()`, a `settlements()`, an `fxGain()`, a
`customerCredit()`, an account in the chart, a branch in the journal and a pair of
checks in the suite. Not one of the book's 111 receipts carried a currency, so
every one of those functions returned an empty list. The checks passed by grepping
the source for the strings it contained. A grep cannot tell a function that works
from a function that has never been called.

Three receipts through the portal — a USD settlement at a better rate, a USD
settlement at a worse one, and a customer who rounded ৳9,600 up to ৳10,000 —
found three defects.

**The engine could report a gain and not a loss.** `allocate()` asked whether cash
was left over once the debt was cleared, and that is only true when the rate moved
in the agency's favour. Everything downstream had been built for both directions:
`Allocation.fx` is documented as "gain (positive) or loss (negative)", `fxGain()`
says "net of loss", the account is called Exchange gain / (loss), and the journal
has had a `fxPart < 0` debit branch the whole time. The one function that decides
was the only one that could not. It now works in the foreign currency instead —
the dollars received clear the dollars owed, and the gap between what those dollars
cost and what the debt was carried at is the rate movement, whichever way it went.

**A customer who had paid in full was left owing money.** SFT-INV-0121 was raised
for USD 3,000 at 123 and carried at ৳3,69,000. FlyTrek paid all 3,000 dollars when
the rate was 120, so ৳3,60,000 arrived — and `invoiceTotals()` subtracted the
**cash**, leaving ৳9,000 owing by somebody who owed nothing. It aged, it sat in
Accounts receivable, and it appeared on the reminders screen as a debt to chase.
The ৳9,000 was an exchange loss the agency had taken, recorded as a receivable.

The mirror case had been hiding for the opposite reason. Paid at 124 the cash was
৳5,95,200 against ৳5,88,000 carried, `total - credited - paid` came to −7,200, and
`Math.max(0, ...)` turned it into the right answer for the wrong reason. That floor
is why nobody found this by reading the code — and it is the same floor this
README already describes as the original defect, still in place in the one function
that had not been converted. **Both derivations called it, so both were wrong by
the same ৳9,000 and the reconciliation showed a difference of zero.** A shared
misreading is exactly what a two-derivation check cannot catch, which is worth
remembering before trusting one.

**VAT on a foreign invoice was added before it was converted.** `settlements()`
kept its own copy of the carrying value and put 15% of a dollar figure into a taka
one. It has never bitten, because both foreign invoices here are zero-rated. It was
found by putting the two carrying values side by side, and the two are now one.

### What the book says now

| | Control | Ledger | Difference |
|---|---|---|---|
| Exchange gain / (loss) | −৳1,800 | −৳1,800 | ৳0 |
| Customer credit balances | ৳400 | ৳400 | ৳0 |
| Accounts receivable | ৳37,88,778 | ৳37,88,778 | ৳0 |

The exchange account carries ৳9,000 of debits and ৳7,200 of credits — losses and
gains both reach it. The ৳400 is in a **liability**, not in income: a customer who
sends too much is owed it back, and booking that as a gain would report profit the
agency does not have. Telling the two apart is the only thing the settlement rate
is for, and without one the safer reading applies.

### The checks that missed it have been rewritten

The two suite checks that guarded this read `lib/fx.ts` for source strings. They
now measure the book, and **fail when there is nothing to measure** — one of them
refuses to pass unless a settlement exists whose relief is not its cash, because a
check that passes on an empty set is the thing being guarded against.

One of the new checks did the same thing to itself on the first run: it looked for
the old expression `total - credited - paid` in `invoiceTotals()` and found it in
the doc comment explaining the bug. Comments are stripped before the match now.

---
## Supplier credit notes, and eight copies of a test

A supplier credit note settles two ways: the credit sits against the bill, or the supplier
sends the money back. Every one of the eight in the book was the first kind. The second —
a branch in the validator, a leg in the journal, a place in the bank movements — had never
been taken by any record.

### The eight

They were the same note. Same day, same bill, same ৳5,000, same text: *Audit probe —
overbilling reversed*. `verify-admin.mjs` creates one and deletes it at the end, and runs
that died before the delete left theirs behind, one at a time, until there were eight —
৳40,000 of fictitious supplier credit against SFT-BIL-0127, committed to the repo.

Nothing complained, because nothing was arithmetically wrong: the bill is ৳2,55,000 and
still showed ৳87,500 owing. The book balanced with ৳40,000 of invented credit in it. This
is the demo book an agency is shown, so seven are gone, the survivor describes a real
reversal, and a check now fails if any collection contains a probe marker at all.

The suite does clean up now — the count held at eight across a fresh run — so this was old
damage, not an active leak. The README already warns about tests with side effects on
production data; this is what the warning looks like a few months later.

### A bill was being valued at its face amount

Found by exercising the refund path. `SFT-BIL-0163` is **USD 4,360 at 122.5 — ৳5,34,100**,
and crediting ৳5,000 against it came back:

```
That would credit more than SFT-BIL-0163 is worth. At most 4360 is left to credit.
```

Three validators compared a taka figure against `bill.amount`, which is in the **document**
currency. A bill worth over five lakh would not accept a five-thousand-taka credit note,
and would have accepted a four-thousand one as though it had eaten 4,000 of a 4,360
allowance. Same family as the overdue alert that valued a USD 4,800 invoice at ৳4,800:
anywhere a document amount meets a book amount, one of them has to be converted, and the
conversion now happens in one `billBase()` rather than at each comparison.

The dropdown had the same problem in a quieter way. It listed that bill as `4360` beside
nine bills whose numbers were taka, so the largest bill in the list looked like the
smallest. It now reads `USD 4,360 · ৳5,34,100`, and taka bills are unchanged.

### What runs now

Qatar Airways refunding ৳25,000 into Dutch-Bangla against SFT-BIL-0127 — the first supplier
credit note in the book that is money rather than an offset — plus the three refusals that
had never been triggered: crediting more than the bill is worth, taking back more than was
ever paid out, and a refund that names no bank. All twelve reconciliation rows stay at zero.

---

## The decision a person makes, run for the first time

When one statement line fits two book entries equally well, the matcher refuses to choose
and asks. `/bank-statements/decide` records the answer, the reconciliation applies it, and
the entry that was not chosen stays outstanding. None of that had ever run.

### The generator advertised a case it did not create

`scripts/make-bank-statement.mjs` documents seven things it deliberately does to a
statement, and one of them is:

```
AMBIGUOUS    two book payments of the same amount inside the drift window, so one
             statement line fits both. Must NOT auto-match either.
```

It found the pair, wrote that note — and then printed a line for **each** of them, so the
matcher paired them off one-to-one and reported nothing ambiguous. Every import this repo
could produce came back `0 need a decision`. The route, its form, and the fifty lines that
apply a decision were unreachable from any statement the project could generate.

Two things were needed to make a real one. The twin has to be **absent** from the
statement, and the surviving line has to fall **between** the two dates — the matcher runs
an `exact_date` pass before its `within_window` one, so a line sitting on either payment's
own date matches that payment cleanly and the other never gets a look in. The first attempt
at this fix put the line on the earlier payment's date and came back cleanly matched.

Now: SFT-PAY-0061 (7 July) and SFT-PAY-0064 (8 July) are both ৳30,500, one line dated
9 July says only `TFR TO BENEFICIARY`, and the screen asks. The nearer of the two was
chosen; SFT-PAY-0061 stays outstanding, which it should, because it was a real payment the
bank has not shown yet.

### The other hand decision: a deposit the bank banked as one line

Three customer cheques handed over the counter together come back as a single inward
clearing for their total. Nothing in the book matches the aggregate, all three receipts are
left outstanding, and the two cancel out — **so the difference stays at zero while four rows
are wrong.** Call the line a bank charge and money already in the book is posted a second
time.

That is what `/bank-statements/group` is for, and the generator had never made one either.

It now banks three deposits together — distinct amounts, within four days, the line dated on
the last of them so every member sits inside the matcher's window — and the portal offers
the grouping. Confirming it records **one decision per member**, not one for the line.

A confirmed grouping still has to add up exactly. A person asking for it is not a licence to
close a gap: a set that does not sum to the line is refused with the shortfall named, rather
than buried inside a matched pair.

On the July statement: `SFT-RCP-0032 + SFT-RCP-0033 + SFT-RCP-0042` = ৳4,97,900 against one
line, confirmed by hand, and the period signs off at zero.

### Two copies of the code that applies your decision

`lib/bankrec.ts` had one for the screen and `admin/server.js` had one for the portal —
thirty lines of judgement about somebody's money, written twice. **They had already
drifted.** The screen recounted `unmatched` and `groupCandidate` after applying a decision
and the portal did not; the portal recounted `unknownToBook` and the screen did not. So a
line a person had just decided still counted as one that "looks grouped" in the portal's
summary — and the portal is where a period gets signed off.

Neither copy was wrong on its own, which is what makes the shape dangerous. There is now
one `applyDecisions()` in `lib/bank-match.js`, it refreshes every count rather than the
subset each caller happened to remember, and all three callers use it — the screen, the
portal, and the suite, which had been re-implementing the classification loop as a third
copy inside a fixture.

### The opening balance was a fortnight late

Found while trying to reconcile June. The journal posts opening balances dated at the
financial year start, 2026-07-01 — and **176 of the book's documents are dated in the June
before it**, because the data straddles a year end that was never closed. Bangladesh's
fiscal year runs July to June, so June 2026 belongs to the year before.

The ledger therefore spent a fortnight spending money it had not been given:

| General ledger as at | Cash | Dutch-Bangla |
|---|---|---|
| 2026-06-30, before | −৳81,320 | −৳62,23,400 |
| 2026-06-30, after | ৳11,18,680 | ৳1,00,76,600 |
| 2026-07-31, either | ৳3,50,780 | ৳7,02,776 |

Any report cut at a June date showed the agency sixty-two lakh overdrawn holding no equity.
By 31 July it added up again — the opening posting was present, merely late — so only a
report that stopped in between could see it, and nothing stopped in between.

The suite could not see it either. *"No cash or bank account ever goes negative"* walks the
records forward from `bank.openingBalance` and never reads the journal, so it was checking
the one derivation that was right. There is now a second check that asks the **journal** the
same question at every month end.

The opening entry is now dated no later than the first thing it funds. The financial year
start is still what the year is called; it is not what the book begins on, and using it as
though it were is what put the balance a fortnight late.

### Still open: the year boundary is enforced in exactly one place

A journal voucher dated 2026-06-30 is refused — *"before the financial year starts"*. An
invoice, a receipt, a bill, a payment, an expense, a supplier deposit and a transfer on that
date are all accepted, and 176 of them exist. So a June bank statement can be imported and
matched but never signed off: its bank charges cannot be posted.

That is not fixed here. Retro-validating the other collections would make 176 existing
records unsaveable, and the real answer is a **year-end close** — carrying June out and
bringing it back in as an opening position — which this project does not have yet and which
is listed among the gaps below. The June import was rolled back rather than left in the book
as a reconciliation nobody can finish.

---

## Two BSP verdicts that could not happen

`lib/bsp.ts` does a three-way match — what the GDS sold, what the book recorded, what IATA
will bill — and sorts every row into one of five buckets: `exact`, `disputed`, `onlyInBsp`,
`onlyInBook`, `provisional`. The book could only ever produce three of them.

The match is keyed on the document number. **All 63 documents carried `documentNo: null`**,
so the matcher's `byNumber` map was empty, and `exact` and `disputed` were unreachable by
construction. *Amounts in dispute* — the one figure on that screen an agency most wants to
watch go down — could never be anything but ৳0, and nothing said why.

### The field could not be typed into

It was null because there was nowhere to enter it. The generic editor builds its fields
from the record it is handed — the boolean branch wants a boolean, the number branch a
number, the string branch a string — and `null` belongs to no branch, so no input was
rendered.

`withOptionalFields()` exists for exactly this: it puts a field on the form that the record
does not have yet. It was called on save, and on a freshly created blank, and **never on
the record the form renders.** So it worked for new records and for nothing already in the
book. The comment beside `creditLimit` says *"defaulting it to 0 here puts the box on the
form"* — it did not; that box was absent from all eight customers. Fixed in one line on the
render path, which brings back `creditLimit`, `againstDocumentNo`, `reason`, and the
ticketing fields together.

`baseFare` is deliberately still not surfaced. An empty fare box has to store something,
and `0` means the ticket was free while `null` means nobody recorded what it cost —
`documentGross()` returns null for that reason. Giving a fareless document a fare needs a
typed-empty number input the editor does not have.

### A row with no document number vanished

`parseBspCsv` ends with `.filter((r) => r.documentNo)`. A real billing file carries such
rows — a mis-keyed line, a subtotal the export left in — and they were dropped in silence:
the tile read *"5 row(s) on the file"* over a file with six, the missing one in no total and
named nowhere. An agency remits what IATA asks and reconciles against a figure that quietly
excludes a row, which is the exact shape of gap the screen exists to close. The parse now
returns a `skipped` count, the tile reads *"5 of 6 row(s) — 1 had no document number"*, and
the panel above says so in words.

### What runs now

Two documents issued by hand from the airline confirmation — Travelport ticketing is
entitlement-blocked, so that is what an agency actually does — and a file covering the
whole matrix:

| Verdict | How |
|---|---|
| `exact` | ticket `0571234567899` billed at exactly its ৳34,786 payable |
| `disputed` | ticket `0571234567907` billed ৳400 over its ৳36,295 |
| `onlyInBsp` | a number the book has never seen, and an ADM against a ticket |
| `onlyInBook` | an issued document left off the billing |
| `provisional` | two PNR matches, one with a ৳1,200 gap shown but **not** called a dispute |

The suite fixture now states what the book must contain to produce every verdict and fails
when it cannot, rather than passing quietly over a book that has nothing to match.

---

## The biggest number in the product had no assertions

The stock register shows **৳2.58 crore committed** and **৳1.55 crore unsold at cost**. It is
the largest figure anywhere in the app — larger than the balance sheet it sits beside — and
not one suite had ever checked a single number on it. Six blocks, four tiles, eleven derived
columns, all of it rendering and none of it verified.

### It is not in the accounts, and the screen did not say so

| | |
|---|---|
| Committed to stock | ৳2,57,58,000 |
| Total assets on the balance sheet | ৳2,39,24,824 |

**No supplier bill in the book is linked to a block.** So none of the committed cost is in
Accounts payable, the unsold cost is not an asset, and the margins on that screen are not
the margins in the profit & loss. `lib/accounting.ts` has said as much in a comment since
the P&L reconciliation was written — *"`book.inventory` never touches a bill or a posting"* —
but the screen showed ৳2.58 crore beside a ৳2.39 crore balance sheet with nothing anywhere
relating the two, and an owner reading both pages would reasonably take the stock to be
inside the assets.

The page now says it, with both figures named, and `inventory()` returns
`postedToLedger` / `unpostedToLedger` so the disclosure is derived rather than written into
the markup. It is a filter over an `inventoryId` that bills do not carry yet — deliberately,
so the notice shrinks on its own the day the link exists instead of having to be remembered.

### And the arithmetic is now checked

Three checks: every derived column against its own inputs (`remaining`, `cost committed`,
`value at risk`, both margins, and that nothing is sold beyond what was bought); the four
tiles against the sum of the rows they sit above, read off the rendered page rather than
recomputed from the function that drew it; and the disclosure itself.

The first version of the parser split the CSV on commas. Block names contain commas and
every cell is quoted, so it read `NaN` for every number and reported the whole register
inconsistent — a test failing on its own bug, which is the cheapest kind to mistake for a
finding.

---

## A balance sheet that meets and is still wrong

*Difference — must be zero: ৳0.* That says every voucher balances. It says nothing about
whether a voucher should have existed, and two accounts in the seeded book hold balances
that only a missing entry can explain.

| Account | Balance | What it means |
|---|---|---|
| Prepaid expenses | **−৳12,500** | a monthly release of an annual IATA licence has been running against an advance that was never posted |
| Accumulated depreciation — office equipment | ৳8,750 | charged monthly against *Office equipment — at cost*, which carries nothing |

A **negative asset** on the screen an owner decides from reads as owning minus twelve
thousand taka of licence. It is not netted away and not floored at zero: the floor would
hide the only useful fact, and this repo has already been bitten once by a floor that turned
a wrong number into the right answer — see the exchange loss in `invoiceTotals`. So the
statement names them instead, each with the reason, derived from the ledger rather than
written into the markup.

`ACCDEP` is grouped as a liability deliberately; its own note in the chart says it is *"held
as a liability group so the balance sheet nets it against the cost above"*. It does not net
it — it lists it under Liabilities beside Accrued expenses — so with the cost at zero the
statement shows depreciation on equipment that appears nowhere. The grouping is left alone,
because moving a contra-asset is a decision for whoever owns the chart; what changed is that
the statement no longer stays quiet about the consequence.

**The repair is an opening-balance import**, not an adjustment on this screen: the equipment
brought forward at cost, the licence prepayment brought forward as an asset. That is a gap
this project still has, and it is listed as one. Inventing the two vouchers here would move
৳4,65,000 through a demo book on figures nobody supplied, and would make the statement tidy
while making the history wrong.

---

## Two screens that had only ever been opened empty

### Statements

The statements screen takes `kind`, `party`, `period`, `from` and `to`. It had only ever
been rendered with **none of them** — which is the one case that proves nothing, because
with no period it shows the whole book and the brought-forward is trivially zero and
omitted. Six presets, a custom range, a customer side and a supplier side: ten combinations,
not one of them asked for once.

All ten work, and the arithmetic ties out to the taka:

| | |
|---|---|
| Rodela International, 1–31 Aug | brought forward ৳1,19,500 + invoice ৳85,800 = **৳2,05,300** |
| Balance from the vouchers as at 31 Jul | **৳1,19,500** |
| Quarter from 1 Jul, brought forward | ৳0 — and the balance at 30 Jun really is ৳0 |

The check that guards this got the supplier side wrong first. A receivable grows on a
**debit** and shrinks on a credit; a payable is the mirror, so the balance owed grows with
**credits**. Applying the customer convention to both reported the supplier statement out by
twice its own balance — the page was right and the check was wrong, which is the failure
mode worth being slow about.

### The reminder letter

Reachable only through `?show=<invoiceId>`, and no test had ever passed that parameter.
Twenty-three invoices offer a draft; not one had been rendered by anything but a person
clicking. They come out right — customer, invoice number and date, PNR, what is outstanding
against what was billed, what has been received, how many days past terms, and who is
asking.

**Only two of the ten customers carry an email**, so the `mailto:` branch had never rendered
at all — every draft anybody had ever seen offered WhatsApp and nothing else. Both branches
are now checked against the customer record: the channel is offered when the contact exists
and not when it does not.

The three stages partition the list exactly — `watch 0 + chase 2 + escalate 21 = 23` — which
is worth asserting, because a filter returning more rows than the list it filters is how a
chase list gets worked twice.

---

## Treasury and credit notes, asserted rather than assumed

Eight transfers and three credit notes were in the book from the start, appeared on the
screens, and had never had a property checked. Both turned out to be right — which is worth
recording, because "we ran it and it was correct" is a different statement from "nobody has
looked".

**Banking the day's takings is not income, and drawing an office float is not an expense.**
Both legs of a transfer must be funds accounts; the moment one is not, the day a cashier
banks eight lakh it lands in the profit and loss and every margin on every screen moves with
it. All eight transfers post two legs, both `CASH` or `BANK:*`, equal and opposite, never
the same account twice — ৳49,70,000 moved and none created.

**A credit note settles exactly one way.** `credit_balance` relieves the receivable and
moves no money; any other value is a pay method and takes the money back out of that
account. Never both, because booking both would refund a customer and forgive the debt at
the same time. All three values are in the book and each does only its own thing.

The supplier leg is a third thing again, and easy to misread from its name: a
`supplierRefund` on a customer credit note **credits the bill** rather than sending money.
Money actually coming back from a supplier is a `supplierCreditNote` with a pay method — the
path exercised further up. Both reduce what is owed and only one of them touches the bank.

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
