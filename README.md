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

### Ticketing — built, and refused

`lib/ticketing.ts` creates the PNR, issues the ticket, voids it and refunds it,
on either supplier. It is real code that runs against the real endpoints, and
`/accounts/gds` executes it on every page load so the status below can never go
stale.

Both suppliers refuse, and the refusals are the point:

| | Call | Answer |
|---|---|---|
| Travelport | `AirCreateReservationReq` on `/uAPI/AirService` | uAPI **8236** — *"No provider/supplier is configured for this user for the requested transaction"* |
| Sabre | `POST /v1/trip/orders/createBooking` | HTTP 200 with **UNAUTHORIZED_ACCESS** in the body — *"the service PassengerDetailsRQ returned an authorization failure"* |

8236 is the useful one, and it is now proven rather than assumed: a deliberately
broken request gets **1201**, a marshalling exception, and so does an empty
skeleton. 8236 is only reachable by a request that has already parsed, routed and
validated. The payload is right; the account has no booking provider.

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

To unblock: **Travelport** must enable a booking provider for PCC `3BX8` on
branch `P7251392`; **Sabre** must enable `PassengerDetailsRQ` and
`/v1.3.0/air/ticket` on PCC `S00L`. Both of those Sabre paths already exist on the
host — they answer 403, not 404 — so the integration is correct and only the
account has to change.
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
node scripts/verify-srs.mjs      # 112 checks — specification, hardening, automation
node scripts/verify-admin.mjs    # 34 checks — the admin portal, signed in
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

Seventy checks against the running app: each one loads the page and looks for
the feature the specification asks for, or reads the book and tests that an
identity holds. It is there because "it is all done" is not a claim anybody
should accept on trust, including from me. It currently reports **70 passed, 0
failed**, and it fails loudly if a page stops carrying what it claims.

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
