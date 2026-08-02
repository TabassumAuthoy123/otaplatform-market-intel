/**
 * Imports the GTM package's 400 researched prospects into content/crm-leads.json.
 *
 *   node scripts/import-crm-leads.mjs <path-to-leads_master.json>
 *
 * Idempotent by lead_id, exactly as 06_SRS_CRM_MODULE.md section 8 requires:
 * re-running updates the RESEARCH fields only and never touches CRM progress
 * (assigned_to, call_status, disposition, notes …). Safe to re-run after the
 * reps have started calling.
 *
 * Data-quality artefacts from 05_DATA_DICTIONARY.md are preserved deliberately:
 * legacy 6–7 digit Dhaka landlines, emails with a comma instead of a dot or no
 * TLD at all, backslashes in addresses. They are printed that way in the
 * government registers. Nothing here trims, reformats or "fixes" them.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node scripts/import-crm-leads.mjs <path-to-leads_master.json>');
  process.exit(1);
}

const CONTENT = path.join(process.cwd(), 'content');
const LEADS_FILE = path.join(CONTENT, 'crm-leads.json');
const USERS_FILE = path.join(CONTENT, 'crm-users.json');
const ACTIVITY_FILE = path.join(CONTENT, 'crm-activities.json');

/** Research fields come from the source. Everything else is the rep's work. */
const RESEARCH_FIELDS = [
  'priority', 'tier', 'segment', 'company', 'decision_maker', 'address', 'city',
  'phone', 'mobile', 'email', 'website', 'facebook', 'licence_ref',
  'booking_engine', 'prospect_note', 'data_source', 'source_url'
];

const CRM_DEFAULTS = {
  assigned_to: null,
  call_status: 'not_started',
  last_call_date: null,
  disposition: null,
  interest_level: null,
  demo_scheduled: null,
  next_action: null,
  next_action_date: null,
  notes: null,
  do_not_call_reason: null,
  deal: null,
  updated_at: null,
  updated_by: null
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const src = JSON.parse(await readFile(SRC, 'utf8'));
if (!Array.isArray(src)) {
  console.error('expected a JSON array of leads');
  process.exit(1);
}

await mkdir(CONTENT, { recursive: true });

const existing = await readJson(LEADS_FILE, []);
const byId = new Map(existing.map((l) => [l.lead_id, l]));

let added = 0;
let updated = 0;

for (const row of src) {
  const id = row.lead_id;
  if (!id) continue;

  const research = {};
  for (const f of RESEARCH_FIELDS) research[f] = row[f] ?? '';

  const prior = byId.get(id);
  if (prior) {
    // research only — CRM progress survives a re-import
    Object.assign(prior, research);
    updated += 1;
  } else {
    byId.set(id, { lead_id: id, ...research, ...CRM_DEFAULTS });
    added += 1;
  }
}

const leads = Array.from(byId.values()).sort((a, b) => a.lead_id.localeCompare(b.lead_id));
await writeFile(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');

// reps — the roster from 05_DATA_DICTIONARY.md
const users = await readJson(USERS_FILE, null);
if (!users) {
  await writeFile(
    USERS_FILE,
    JSON.stringify(
      [
        { id: 'U1', name: 'Tabassum Authoy', role: 'bd_manager', active: true },
        { id: 'U2', name: 'Sales Rep 2', role: 'sales_rep', active: true },
        { id: 'U3', name: 'Sales Rep 3', role: 'sales_rep', active: true },
        { id: 'U4', name: 'Sales Rep 4', role: 'sales_rep', active: true }
      ],
      null,
      2
    ),
    'utf8'
  );
}

if (!(await readJson(ACTIVITY_FILE, null))) {
  await writeFile(ACTIVITY_FILE, '[]', 'utf8');
}

// counts the SRS asks you to verify at step 1 of the build order
const byPriority = {};
const byCity = {};
const byTier = {};
for (const l of leads) {
  byPriority[l.priority] = (byPriority[l.priority] ?? 0) + 1;
  byCity[l.city] = (byCity[l.city] ?? 0) + 1;
  byTier[l.tier] = (byTier[l.tier] ?? 0) + 1;
}

console.log(`wrote ${LEADS_FILE}`);
console.log(`  ${added} added · ${updated} research-updated · ${leads.length} total`);
console.log(`  priority: ${Object.entries(byPriority).sort().map(([k, v]) => `${k}=${v}`).join(' · ')}`);
console.log(`  tiers: ${Object.keys(byTier).length} · cities: ${Object.keys(byCity).length}`);
console.log(`  with mobile: ${leads.filter((l) => l.mobile).length} · with phone: ${leads.filter((l) => l.phone).length} · with email: ${leads.filter((l) => l.email).length}`);
console.log(`  IATA-accredited tier: ${leads.filter((l) => /IATA/i.test(l.tier)).length}`);
