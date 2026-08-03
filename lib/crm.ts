import { readJsonCached } from '@/lib/jsonStore';
import path from 'node:path';
import { todayIn } from '@/lib/clock';

/**
 * Sales CRM over the 400 researched prospects.
 *
 * Vocabularies and validation rules are taken from the GTM package's
 * 05_DATA_DICTIONARY.md and 06_SRS_CRM_MODULE.md. Where the two differ in
 * wording, the machine values below are the canonical stored form and the
 * labels are what a human sees.
 *
 * Research fields are immutable through the rep UI by design — a rep who finds
 * a wrong number writes it into `notes` and an admin corrects it centrally.
 */

const CONTENT = process.cwd();
const LEADS_FILE = path.join(CONTENT, 'content', 'crm-leads.json');
const USERS_FILE = path.join(CONTENT, 'content', 'crm-users.json');
const ACTIVITIES_FILE = path.join(CONTENT, 'content', 'crm-activities.json');

/* ---------------------------------------------------------------- vocab */

export const CALL_STATUS: Record<string, string> = {
  not_started: 'Not started',
  attempted_no_answer: 'Attempted — no answer',
  attempted_wrong_number: 'Attempted — wrong number',
  contacted_gatekeeper: 'Contacted — gatekeeper',
  contacted_dm: 'Contacted — decision maker',
  demo_scheduled: 'Demo scheduled',
  demo_done: 'Demo done',
  proposal_sent: 'Proposal sent',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
  do_not_call: 'Do not call'
};

/** Order used by the funnel and the kanban. */
export const FUNNEL_ORDER = [
  'not_started', 'attempted_no_answer', 'attempted_wrong_number',
  'contacted_gatekeeper', 'contacted_dm', 'demo_scheduled', 'demo_done',
  'proposal_sent', 'negotiation', 'won', 'lost', 'do_not_call'
];

export const DISPOSITION: Record<string, string> = {
  interested_hot: 'Interested — hot',
  interested_follow_up: 'Interested — needs follow up',
  curious_early: 'Curious — early',
  not_interested_now: 'Not interested now',
  not_interested_has_software: 'Not interested — has software',
  not_interested_no_budget: 'Not interested — no budget',
  not_relevant: 'Not relevant / wrong segment',
  unreachable: 'Unreachable'
};

export const INTEREST: Record<string, string> = {
  '5': '5 — Ready to buy',
  '4': '4 — High',
  '3': '3 — Medium',
  '2': '2 — Low',
  '1': '1 — None'
};

export const DEMO: Record<string, string> = { yes: 'Yes', no: 'No', rescheduled: 'Rescheduled' };

export const PRIORITY_HINT: Record<string, string> = {
  P1: 'Tier 1 — call first',
  P2: 'Hajj, ATAB and BAIRA',
  P3: 'TOAB and regional',
  P4: 'Already has a live engine',
  P5: 'Reference only — do not pitch'
};

/** Statuses that mean the lead is out of the calling queue for good. */
export const CLOSED = new Set(['won', 'lost', 'do_not_call']);
/** Statuses that mean someone has actually spoken to a human. */
export const CONTACTED = new Set([
  'contacted_gatekeeper', 'contacted_dm', 'demo_scheduled', 'demo_done',
  'proposal_sent', 'negotiation', 'won'
]);

export const RESEARCH_FIELDS = [
  'priority', 'tier', 'segment', 'company', 'decision_maker', 'address', 'city',
  'phone', 'mobile', 'email', 'website', 'facebook', 'licence_ref',
  'booking_engine', 'prospect_note', 'data_source', 'source_url'
] as const;

export const CRM_FIELDS = [
  'assigned_to', 'call_status', 'last_call_date', 'disposition', 'interest_level',
  'demo_scheduled', 'next_action', 'next_action_date', 'notes', 'do_not_call_reason'
] as const;

/* ---------------------------------------------------------------- types */

export type Lead = {
  lead_id: string;
  priority: string; tier: string; segment: string; company: string;
  decision_maker: string; address: string; city: string;
  phone: string; mobile: string; email: string; website: string; facebook: string;
  licence_ref: string; booking_engine: string; prospect_note: string;
  data_source: string; source_url: string;
  assigned_to: string | null;
  call_status: string;
  last_call_date: string | null;
  disposition: string | null;
  interest_level: string | null;
  demo_scheduled: string | null;
  next_action: string | null;
  next_action_date: string | null;
  notes: string | null;
  do_not_call_reason: string | null;
  deal: { plan: string; monthly_bdt: number; onboarding_bdt: number } | null;
  updated_at: string | null;
  updated_by: string | null;
};

export type CrmUser = { id: string; name: string; role: string; active: boolean };

export type Activity = {
  id: string; lead_id: string; user_id: string | null;
  activity_type: 'call' | 'whatsapp' | 'email' | 'meeting' | 'demo' | 'note' | 'status_change';
  outcome: string; body: string; occurred_at: string;
};

/* --------------------------------------------------------------- loaders */

/**
 * Parsed once per file version rather than once per request.
 *
 * crm-leads.json is 421 KB for 400 leads and the spec asks for 5,800. The cache
 * key is the file's mtime and size, so an admin write still shows on the very
 * next page load — the freshness rule is unchanged, only the waste is gone.
 */
const readJson = readJsonCached;

export const getLeads = () => readJson<Lead[]>(LEADS_FILE, []);
export const getUsers = () => readJson<CrmUser[]>(USERS_FILE, []);
export const getActivities = () => readJson<Activity[]>(ACTIVITIES_FILE, []);

/* ------------------------------------------------------------ derivations */

export function filterLeads(
  leads: Lead[],
  q: { q?: string; priority?: string; tier?: string; city?: string; status?: string;
       disposition?: string; assigned?: string; hasWebsite?: string; hasMobile?: string; view?: string },
  today = todayIn()
): Lead[] {
  let rows = leads;

  const term = (q.q ?? '').trim().toLowerCase();
  if (term) {
    rows = rows.filter((l) =>
      [l.company, l.decision_maker, l.phone, l.mobile, l.email, l.lead_id, l.address, l.segment]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term))
    );
  }
  if (q.priority) rows = rows.filter((l) => l.priority === q.priority);
  if (q.tier) rows = rows.filter((l) => l.tier === q.tier);
  if (q.city) rows = rows.filter((l) => l.city === q.city);
  if (q.status) rows = rows.filter((l) => l.call_status === q.status);
  if (q.disposition) rows = rows.filter((l) => l.disposition === q.disposition);
  if (q.assigned) rows = rows.filter((l) => (q.assigned === 'unassigned' ? !l.assigned_to : l.assigned_to === q.assigned));
  if (q.hasWebsite === 'yes') rows = rows.filter((l) => !!l.website);
  if (q.hasWebsite === 'no') rows = rows.filter((l) => !l.website);
  if (q.hasMobile === 'yes') rows = rows.filter((l) => !!l.mobile);
  if (q.hasMobile === 'no') rows = rows.filter((l) => !l.mobile);

  // saved views from the SRS
  switch (q.view) {
    case 'due_today':
      rows = rows.filter((l) => l.next_action_date && l.next_action_date <= today && !CLOSED.has(l.call_status));
      break;
    case 'untouched':
      rows = rows.filter((l) => l.call_status === 'not_started');
      break;
    case 'no_next_action':
      // the "abandoned" list — worked once, then dropped
      rows = rows.filter((l) => l.disposition && !l.next_action && !CLOSED.has(l.call_status));
      break;
    case 'p1_queue':
      rows = rows.filter((l) => l.priority === 'P1' && !CLOSED.has(l.call_status));
      break;
    case 'hot':
      rows = rows.filter((l) => l.disposition === 'interested_hot' || l.interest_level === '5');
      break;
  }
  return rows;
}

/** Queue order for Call Mode: priority, then anything overdue, then untouched. */
export function queueOrder(rows: Lead[], today = todayIn()): Lead[] {
  const rank = (l: Lead) => {
    const p = Number(l.priority.replace('P', '')) || 9;
    const due = l.next_action_date && l.next_action_date <= today ? 0 : 1;
    const fresh = l.call_status === 'not_started' ? 0 : 1;
    return p * 100 + due * 10 + fresh;
  };
  return [...rows].filter((l) => !CLOSED.has(l.call_status)).sort((a, b) => rank(a) - rank(b) || a.lead_id.localeCompare(b.lead_id));
}

export function dashboard(leads: Lead[], users: CrmUser[], activities: Activity[], today = todayIn()) {
  const total = leads.length;
  const touched = leads.filter((l) => l.call_status !== 'not_started').length;
  const contacted = leads.filter((l) => CONTACTED.has(l.call_status)).length;

  const funnel = FUNNEL_ORDER.map((s) => ({
    status: s,
    label: CALL_STATUS[s],
    count: leads.filter((l) => l.call_status === s).length
  })).filter((r) => r.count > 0 || ['not_started', 'contacted_dm', 'demo_scheduled', 'won'].includes(r.status));

  const dispositions = Object.keys(DISPOSITION)
    .map((d) => ({ key: d, label: DISPOSITION[d], count: leads.filter((l) => l.disposition === d).length }))
    .filter((r) => r.count > 0);

  const perRep = users.map((u) => {
    const mine = leads.filter((l) => l.assigned_to === u.id);
    return {
      user: u,
      assigned: mine.length,
      called: mine.filter((l) => l.call_status !== 'not_started').length,
      contacted: mine.filter((l) => CONTACTED.has(l.call_status)).length,
      demos: mine.filter((l) => l.demo_scheduled === 'yes').length,
      won: mine.filter((l) => l.call_status === 'won').length,
      hot: mine.filter((l) => l.disposition === 'interested_hot').length,
      activities: activities.filter((a) => a.user_id === u.id).length
    };
  });

  const byPriority = ['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => {
    const rows = leads.filter((l) => l.priority === p);
    return {
      priority: p,
      hint: PRIORITY_HINT[p],
      total: rows.length,
      touched: rows.filter((l) => l.call_status !== 'not_started').length,
      untouched: rows.filter((l) => l.call_status === 'not_started').length
    };
  }).filter((r) => r.total > 0);

  const byTier = Array.from(new Set(leads.map((l) => l.tier))).map((t) => {
    const rows = leads.filter((l) => l.tier === t);
    return {
      tier: t,
      total: rows.length,
      touched: rows.filter((l) => l.call_status !== 'not_started').length
    };
  }).sort((a, b) => b.total - a.total);

  // leads with a disposition but nothing scheduled next — the ones that quietly die
  const abandoned = leads.filter((l) => l.disposition && !l.next_action && !CLOSED.has(l.call_status));
  const dueToday = leads.filter((l) => l.next_action_date && l.next_action_date <= today && !CLOSED.has(l.call_status));
  const unassigned = leads.filter((l) => !l.assigned_to);

  // activity volume, last 14 days
  const days: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ date: iso, count: activities.filter((a) => a.occurred_at.slice(0, 10) === iso).length });
  }

  return {
    total, touched, contacted,
    coveragePct: total ? (touched / total) * 100 : 0,
    p1Untouched: leads.filter((l) => l.priority === 'P1' && l.call_status === 'not_started').length,
    funnel, dispositions, perRep, byPriority, byTier,
    abandoned, dueToday, unassigned,
    activityDays: days,
    totalActivities: activities.length,
    won: leads.filter((l) => l.call_status === 'won').length,
    demos: leads.filter((l) => l.demo_scheduled === 'yes').length
  };
}

/** Distinct values for the filter dropdowns, taken from the data itself. */
export function vocab(leads: Lead[]) {
  const uniq = (k: keyof Lead) =>
    Array.from(new Set(leads.map((l) => String(l[k] ?? '')).filter(Boolean))).sort();
  return { tiers: uniq('tier'), cities: uniq('city'), segments: uniq('segment'), sources: uniq('data_source') };
}

/**
 * Server-side validation, straight from 05_DATA_DICTIONARY.md section
 * "Validation rules to enforce in software". Returns human-readable errors.
 */
export function validateLead(next: Partial<Lead>, today = todayIn()): string[] {
  const errors: string[] = [];

  if (next.disposition && (!next.next_action || !next.next_action_date)) {
    errors.push('A disposition is set, so “next action” and “next action date” are both required.');
  }
  if (next.next_action && !next.next_action_date) {
    errors.push('“Next action date” is required whenever a next action is written.');
  }
  if ((next.call_status === 'demo_scheduled' || next.call_status === 'demo_done') && next.demo_scheduled !== 'yes') {
    errors.push('Call status is a demo stage, so “demo scheduled” must be Yes.');
  }
  if (next.call_status === 'won' && next.interest_level !== '5') {
    errors.push('A won lead must have interest level “5 — Ready to buy”.');
  }
  if (next.call_status === 'do_not_call' && !next.do_not_call_reason && !next.notes) {
    errors.push('“Do not call” permanently removes the lead from every queue — give a reason.');
  }
  if (next.last_call_date && next.last_call_date > today) {
    errors.push('“Last call date” cannot be in the future.');
  }
  if (next.next_action_date && next.last_call_date && next.next_action_date < next.last_call_date) {
    errors.push('“Next action date” cannot be before the last call date.');
  }
  return errors;
}

export const userName = (users: CrmUser[], id: string | null) =>
  (id && users.find((u) => u.id === id)?.name) || 'Unassigned';

/** First mobile number, digits only — for building a wa.me link. */
export function waNumber(lead: Lead): string | null {
  const raw = (lead.mobile || lead.phone || '').match(/01\d[\d\s-]{7,}/);
  if (!raw) return null;
  const digits = raw[0].replace(/\D/g, '');
  return digits.length >= 11 ? `88${digits.slice(0, 11)}` : null;
}
