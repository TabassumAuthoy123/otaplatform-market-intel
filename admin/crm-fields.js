'use strict';

/**
 * CRM vocabularies and validation, mirroring lib/crm.ts.
 *
 * Admin is plain Node and cannot import the TypeScript, so this is a hand-kept
 * copy. If you add a call status or a disposition in lib/crm.ts, add it here
 * too — the two are read by different processes and will not warn you.
 *
 * Source of truth for the vocabulary is the GTM package's
 * 05_DATA_DICTIONARY.md; the rules below are its section
 * "Validation rules to enforce in software".
 */

const CALL_STATUS = {
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

const FUNNEL_ORDER = Object.keys(CALL_STATUS);

const DISPOSITION = {
  interested_hot: 'Interested — hot',
  interested_follow_up: 'Interested — needs follow up',
  curious_early: 'Curious — early',
  not_interested_now: 'Not interested now',
  not_interested_has_software: 'Not interested — has software',
  not_interested_no_budget: 'Not interested — no budget',
  not_relevant: 'Not relevant / wrong segment',
  unreachable: 'Unreachable'
};

const INTEREST = {
  5: '5 — Ready to buy',
  4: '4 — High',
  3: '3 — Medium',
  2: '2 — Low',
  1: '1 — None'
};

const DEMO = { yes: 'Yes', no: 'No', rescheduled: 'Rescheduled' };

const ACTIVITY_TYPE = {
  call: 'Call',
  whatsapp: 'WhatsApp',
  email: 'Email',
  meeting: 'Meeting',
  demo: 'Demo',
  note: 'Note',
  status_change: 'Status change'
};

const PRIORITY_HINT = {
  P1: 'Tier 1 — call first',
  P2: 'Hajj, ATAB and BAIRA',
  P3: 'TOAB and regional',
  P4: 'Already has a live engine',
  P5: 'Reference only — do not pitch'
};

const CLOSED = new Set(['won', 'lost', 'do_not_call']);
const CONTACTED = new Set([
  'contacted_gatekeeper', 'contacted_dm', 'demo_scheduled', 'demo_done',
  'proposal_sent', 'negotiation', 'won'
]);

/** Fields a rep may write. Everything else is research and is rejected. */
const EDITABLE = [
  'assigned_to', 'call_status', 'last_call_date', 'disposition', 'interest_level',
  'demo_scheduled', 'next_action', 'next_action_date', 'notes', 'do_not_call_reason'
];

const SAVED_VIEWS = [
  { key: '', label: 'All leads' },
  { key: 'p1_queue', label: 'P1 queue (open)' },
  { key: 'due_today', label: 'Due today or overdue' },
  { key: 'untouched', label: 'Never touched' },
  { key: 'no_next_action', label: 'Abandoned — no next action' },
  { key: 'hot', label: 'Hot leads' }
];

/**
 * Returns an array of human-readable errors. Empty array means the record is
 * acceptable. Kept identical to validateLead() in lib/crm.ts.
 */
function validateLead(next, today) {
  const errors = [];
  // Dhaka's date — a call logged at 1am must not validate against yesterday.
  const t = today || require('./clock.js').todayIn();

  if (next.disposition && (!next.next_action || !next.next_action_date)) {
    errors.push('A disposition is set, so “next action” and “next action date” are both required.');
  }
  if (next.next_action && !next.next_action_date) {
    errors.push('“Next action date” is required whenever a next action is written.');
  }
  if ((next.call_status === 'demo_scheduled' || next.call_status === 'demo_done') && next.demo_scheduled !== 'yes') {
    errors.push('Call status is a demo stage, so “demo scheduled” must be Yes.');
  }
  if (next.call_status === 'won' && String(next.interest_level) !== '5') {
    errors.push('A won lead must have interest level “5 — Ready to buy”.');
  }
  if (next.call_status === 'do_not_call' && !next.do_not_call_reason && !next.notes) {
    errors.push('“Do not call” permanently removes the lead from every queue — give a reason.');
  }
  if (next.last_call_date && next.last_call_date > t) {
    errors.push('“Last call date” cannot be in the future.');
  }
  if (next.next_action_date && next.last_call_date && next.next_action_date < next.last_call_date) {
    errors.push('“Next action date” cannot be before the last call date.');
  }
  return errors;
}

/** Queue order for Call Mode: priority, then overdue, then untouched. */
function queueRank(lead, today) {
  const p = Number(String(lead.priority || 'P9').replace('P', '')) || 9;
  const due = lead.next_action_date && lead.next_action_date <= today ? 0 : 1;
  const fresh = lead.call_status === 'not_started' ? 0 : 1;
  return p * 100 + due * 10 + fresh;
}

/** First BD mobile in the field, as a wa.me number. */
function waNumber(lead) {
  const m = String(lead.mobile || lead.phone || '').match(/01\d[\d\s-]{7,}/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  return digits.length >= 11 ? `88${digits.slice(0, 11)}` : null;
}

/** First dialable number, for the tel: link. */
function telNumber(lead) {
  const m = String(lead.mobile || lead.phone || '').match(/[\d][\d\s\-+]{5,}/);
  return m ? m[0].replace(/[^\d+]/g, '') : null;
}

module.exports = {
  CALL_STATUS, FUNNEL_ORDER, DISPOSITION, INTEREST, DEMO, ACTIVITY_TYPE,
  PRIORITY_HINT, CLOSED, CONTACTED, EDITABLE, SAVED_VIEWS,
  validateLead, queueRank, waNumber, telNumber
};
