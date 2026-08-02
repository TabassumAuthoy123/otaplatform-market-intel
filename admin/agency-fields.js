'use strict';

/**
 * Field specification for the agency record editor.
 *
 * This is a hand-kept mirror of the `Agency` interface and the enums in
 * data/schema.ts. Admin is plain Node and cannot import the TypeScript, so if
 * you add a field or an enum value there, add it here too — otherwise the
 * editor silently will not show it.
 *
 * Cluster options are not listed here: they are derived at render time from the
 * clusterId values present in content/agencies.json, so they stay in step with
 * the dataset without a second copy of CLUSTERS.
 */

const CREDENTIAL_STATES = ['verified', 'inferred', 'unknown', 'none'];
const SEGMENTS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const PRIORITIES = ['A', 'B', 'C', 'X'];
const EXCLUSION_REASONS = ['', 'has_own_platform', 'building_in_house', 'is_competitor', 'compliance_risk'];
const SALES_MODES = ['manual', 'sub_agent', 'own_platform', 'unknown'];
const TIERS = ['', 'Starter', 'Growth', 'Professional', 'Hajj', 'Enterprise'];
const STAGES = [
  'not_contacted', 'attempted', 'discovery', 'demo_booked', 'demo_done',
  'proposal_sent', 'negotiation', 'won', 'lost', 'disqualified'
];

/**
 * type:
 *   text | textarea | number | bool | select | cluster | lines
 * nullable: empty input is stored as null rather than ''
 */
const GROUPS = [
  {
    title: 'Identity',
    fields: [
      { key: 'id', label: 'Record ID', type: 'text', readonly: true },
      { key: 'name', label: 'Agency name', type: 'text' },
      { key: 'signal', label: 'Signal — why this record is on the list', type: 'textarea' }
    ]
  },
  {
    title: 'Location',
    fields: [
      { key: 'clusterId', label: 'Cluster', type: 'cluster' },
      { key: 'district', label: 'District', type: 'text' },
      { key: 'division', label: 'Division', type: 'text' },
      { key: 'address', label: 'Address', type: 'textarea' }
    ]
  },
  {
    title: 'Contact',
    fields: [
      { key: 'phone', label: 'Phone', type: 'text', nullable: true },
      { key: 'altPhones', label: 'Alternate phones', type: 'lines' },
      { key: 'website', label: 'Website', type: 'text', nullable: true },
      { key: 'facebook', label: 'Facebook', type: 'text', nullable: true },
      { key: 'email', label: 'Email', type: 'text', nullable: true }
    ]
  },
  {
    title: 'Segment & priority',
    fields: [
      { key: 'segment', label: 'Segment', type: 'select', options: SEGMENTS },
      { key: 'segmentSecondary', label: 'Secondary segment', type: 'select', options: ['', ...SEGMENTS], nullable: true },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { key: 'exclusionReason', label: 'Exclusion reason (X only)', type: 'select', options: EXCLUSION_REASONS, nullable: true }
    ]
  },
  {
    title: 'Credentials',
    fields: [
      { key: 'caabLicence', label: 'Civil Aviation licence (TAMS)', type: 'select', options: CREDENTIAL_STATES },
      { key: 'caabLicenceNo', label: 'Civil Aviation number', type: 'text', nullable: true },
      { key: 'iata', label: 'IATA', type: 'select', options: CREDENTIAL_STATES },
      { key: 'iataNo', label: 'IATA number', type: 'text', nullable: true },
      { key: 'atab', label: 'ATAB', type: 'select', options: CREDENTIAL_STATES },
      { key: 'atabNo', label: 'ATAB number', type: 'text', nullable: true },
      { key: 'hajjLicence', label: 'Hajj licence', type: 'select', options: CREDENTIAL_STATES }
    ]
  },
  {
    title: 'Commercial',
    fields: [
      { key: 'salesMode', label: 'Sales mode', type: 'select', options: SALES_MODES },
      { key: 'hasOwnPlatform', label: 'Already has its own platform', type: 'bool' },
      { key: 'open247', label: 'Open 24/7', type: 'bool' },
      { key: 'reviewCount', label: 'Public review count', type: 'number', nullable: true },
      { key: 'rating', label: 'Rating', type: 'number', nullable: true },
      { key: 'monthlyBookings', label: 'Monthly bookings', type: 'number', nullable: true },
      { key: 'suggestedTier', label: 'Suggested tier', type: 'select', options: TIERS, nullable: true }
    ]
  },
  {
    title: 'CRM state',
    fields: [
      { key: 'stage', label: 'Pipeline stage', type: 'select', options: STAGES },
      { key: 'lastContactedAt', label: 'Last contacted (YYYY-MM-DD)', type: 'text', nullable: true },
      { key: 'nextActionAt', label: 'Next action (YYYY-MM-DD)', type: 'text', nullable: true },
      { key: 'ownerRep', label: 'Owner rep', type: 'text', nullable: true }
    ]
  }
];

/** Flat lookup, for applying a submitted form back onto a record. */
const FIELDS = GROUPS.flatMap((g) => g.fields);
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/** A new record, with the same shape the dataset already uses. */
function blankAgency(nextId) {
  return {
    id: nextId,
    name: '',
    clusterId: '',
    district: '',
    division: '',
    address: '',
    phone: null,
    website: null,
    facebook: null,
    email: null,
    segment: 'S1',
    priority: 'C',
    exclusionReason: null,
    caabLicence: 'unknown',
    caabLicenceNo: null,
    iata: 'unknown',
    iataNo: null,
    atab: 'unknown',
    atabNo: null,
    hajjLicence: 'unknown',
    salesMode: 'unknown',
    hasOwnPlatform: false,
    reviewCount: null,
    rating: null,
    open247: false,
    signal: '',
    monthlyBookings: null,
    suggestedTier: null,
    stage: 'not_contacted',
    lastContactedAt: null,
    nextActionAt: null,
    ownerRep: null
  };
}

module.exports = {
  GROUPS,
  FIELDS,
  FIELD_BY_KEY,
  PRIORITIES,
  SEGMENTS,
  STAGES,
  blankAgency
};
