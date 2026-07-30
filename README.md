# OTA Platform — Bangladesh Market Intelligence Dashboard

Lead-intelligence dashboard for **Softifybd OTA Platform**. Built to be shown to the CEO
and used on the phone the same day.

**114 records · 104 targets · 10 excluded · 16 clusters · 9 districts**

---

## Run it locally (2 commands)

```bash
npm install
npm run dev
```

Open **http://localhost:3000**

No database, no API key, no Docker needed to demo — the dataset ships as typed TypeScript
so the dashboard works offline out of the box.

```bash
npm run build && npm start   # production build
```

---

## What the CEO sees

| Page | Route | Purpose |
|---|---|---|
| **Dashboard** | `/` | Headline credential counts, verified-vs-inferred donuts, cluster and district rollups, top 10 calls, exclusion list, scale-up sources |
| **Agency Database** | `/agencies` | All 114 records. Live filters on priority, segment, cluster, district, free text. Click-to-dial and click-to-WhatsApp. CSV export of the current filter |
| **Segments** | `/segments` | S1–S6 explained with live counts and the disqualification rules |
| **API** | `/api/agencies` | JSON + CSV for anyone who wants the raw data |

The two numbers the CEO asks for are the first two tiles in the hero:
**Civil Aviation certificate holders** and **IATA registered**.

### Deep links that work as menu items

```
/agencies?priority=A            # the 42 call-first targets
/agencies?segment=S2            # Hajj / Umrah
/agencies?cluster=paltan        # Naya Paltan / Purana Paltan / Bijoynagar
/agencies?district=Rajshahi
/api/agencies?format=csv&targetsOnly=1
/api/agencies?stats=1
```

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
data/schema.ts        <- CANONICAL data schema. Types, segments, clusters. Change here first.
data/agencies.ts      <- the 114-record dataset + derived STATS / PIPELINE aggregates
prisma/schema.prisma  <- Prisma mirror (MySQL 8): agencies, contacts, activities, deals, data_sources
db/schema.sql         <- plain MySQL DDL + 3 reporting views, for the dev/DBA team
app/page.tsx          <- dashboard
app/agencies/         <- database page
app/segments/         <- segment explainer
app/api/agencies/     <- JSON + CSV endpoint
components/           <- Nav, AgencyTable, ui primitives (StatCard, Donut, BarRow, chips)
docs/                 <- source documents: market pack (docx), deck brief (md), rendered deck (pdf), Sabre API logs
```

---

## Wiring the real database

The dataset is static TypeScript so the demo cannot break. When you want it live:

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

Once the DB is live, replace the `AGENCIES` import in `app/page.tsx` and
`app/agencies/page.tsx` with a Prisma query. Nothing else changes — the schema is
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
