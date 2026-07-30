// ============================================================================
//  OTA Platform — Market Intelligence  ·  CANONICAL DATA SCHEMA
//  This file is the single source of truth. prisma/schema.prisma and
//  db/schema.sql mirror it exactly. Change here first, then mirror.
// ============================================================================

/** Verification state of any credential. Never show a number we have not seen. */
export type CredentialState =
  | 'verified'   // number published by the agency or confirmed on an official portal
  | 'inferred'   // strong public signal (reviews / own marketing) but not yet confirmed
  | 'unknown'    // not established — must be asked on the qualifying call
  | 'none';      // confirmed absent

/** Commercial segment. S1 is the primary target. */
export type SegmentCode = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

/** Outreach priority. X = do not pitch the standard package. */
export type Priority = 'A' | 'B' | 'C' | 'X';

/** Why an X-rated record is excluded. */
export type ExclusionReason =
  | 'has_own_platform'
  | 'building_in_house'
  | 'is_competitor'
  | 'compliance_risk'
  | null;

/** How the agency sells today — the core qualifying axis. */
export type SalesMode =
  | 'manual'        // WhatsApp / phone / walk-in only
  | 'sub_agent'     // issues on another agency's IATA + B2B panel
  | 'own_platform'  // already has a booking site or app
  | 'unknown';

export interface Agency {
  id: string;
  name: string;
  clusterId: string;
  district: string;
  division: string;
  address: string;
  /** Business line as publicly listed. null = not published, collect on call. */
  phone: string | null;
  /** Extra published numbers. */
  altPhones?: string[];
  website: string | null;
  facebook: string | null;
  email: string | null;

  segment: SegmentCode;
  /** Secondary segment where an agency spans two (e.g. IATA + Hajj). */
  segmentSecondary?: SegmentCode;
  priority: Priority;
  exclusionReason: ExclusionReason;

  // ---- credentials -------------------------------------------------------
  /** Ministry of Civil Aviation & Tourism travel-agency licence (TAMS).
   *  Colloquially "Civil Aviation certificate". */
  caabLicence: CredentialState;
  caabLicenceNo: string | null;
  iata: CredentialState;
  iataNo: string | null;
  atab: CredentialState;
  atabNo: string | null;
  /** Ministry of Religious Affairs Hajj approval. */
  hajjLicence: CredentialState;

  // ---- commercial signals ------------------------------------------------
  salesMode: SalesMode;
  hasOwnPlatform: boolean;
  /** Public review count — our only available proxy for scale. */
  reviewCount: number | null;
  rating: number | null;
  open247: boolean;
  /** One-line reason this record is on the list. Shown in the UI. */
  signal: string;
  /** Estimated monthly bookings, once qualified. null until asked. */
  monthlyBookings: number | null;
  /** Recommended tier from the pricing framework. */
  suggestedTier: 'Starter' | 'Growth' | 'Professional' | 'Hajj' | 'Enterprise' | null;

  // ---- CRM state ---------------------------------------------------------
  stage: PipelineStage;
  lastContactedAt: string | null;
  nextActionAt: string | null;
  ownerRep: string | null;
}

export type PipelineStage =
  | 'not_contacted'
  | 'attempted'
  | 'discovery'
  | 'demo_booked'
  | 'demo_done'
  | 'proposal_sent'
  | 'negotiation'
  | 'won'
  | 'lost'
  | 'disqualified';

export interface Cluster {
  id: string;
  name: string;
  district: string;
  division: string;
  /** Named buildings — used for the walk-the-floors field plan. */
  landmarks: string[];
  phase: 1 | 2 | 3;
  note: string;
}

export interface Segment {
  code: SegmentCode;
  name: string;
  shortName: string;
  description: string;
  priorityRank: number;
  tierHint: string;
}

// ---- reference tables ------------------------------------------------------

export const SEGMENTS: Segment[] = [
  {
    code: 'S1',
    name: 'Licensed non-IATA agency on another agency\u2019s B2B panel',
    shortName: 'Sub-agent / manual',
    description:
      'Trades legally on a Ministry licence but issues through someone else\u2019s IATA. No brand, no margin control, no customer data. Largest volume, sharpest pain, shortest cycle.',
    priorityRank: 1,
    tierHint: 'Starter \u2192 Growth'
  },
  {
    code: 'S2',
    name: 'Hajj / Umrah specialist',
    shortName: 'Hajj / Umrah',
    description:
      'Lakh-taka packages sold on 6\u201312 month instalments. Group, passport, visa and hotel-allocation complexity handled on paper. ~750 licensed for the 2026 season.',
    priorityRank: 2,
    tierHint: 'Hajj module'
  },
  {
    code: 'S3',
    name: 'IATA-accredited agency without a digital storefront',
    shortName: 'IATA, no storefront',
    description:
      'Already has issuing authority and trained staff. Lacks a consumer-facing site and a sub-agent distribution channel. Highest contract value.',
    priorityRank: 3,
    tierHint: 'Growth \u2192 Professional'
  },
  {
    code: 'S4',
    name: 'Consolidator / wholesaler',
    shortName: 'Consolidator',
    description:
      'Supplies tickets to hundreds of smaller agencies. Long technical evaluation, very high value, flagship reference potential.',
    priorityRank: 4,
    tierHint: 'Professional \u2192 Enterprise'
  },
  {
    code: 'S5',
    name: 'Regional agency outside the metro core',
    shortName: 'Regional',
    description:
      'Chattogram, Sylhet, Narayanganj, Cumilla, Brahmanbaria, Khulna, Rajshahi, Bogura. Zero vendor competition \u2014 offshore vendors do not sell here.',
    priorityRank: 5,
    tierHint: 'Starter \u2192 Growth'
  },
  {
    code: 'S6',
    name: 'New entrant / small counter operation',
    shortName: 'New entrant',
    description:
      'Recently licensed or very small. Low value individually, useful for volume and for early case studies. Many come out of travel-business training courses.',
    priorityRank: 6,
    tierHint: 'Starter'
  }
];

export const CLUSTERS: Cluster[] = [
  {
    id: 'paltan',
    name: 'Naya Paltan / Purana Paltan / Bijoynagar',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: [
      'Paltan China Town',
      'Sattara Centre (ATAB + HAAB + Training Institute)',
      'City Heart Shopping Complex',
      'Eastern View',
      'Paltan Tower',
      'Suleman Plaza',
      'Tropicana Tower',
      'Baitul View Tower',
      'Noakhali Tower',
      'Trident Tower'
    ],
    phase: 1,
    note: 'Densest cluster in the country. Multiple agencies per floor. One building = ten conversations.'
  },
  {
    id: 'motijheel',
    name: 'Motijheel C/A',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['Globe Chamber', 'Red Crescent House', 'Toyenbee Circular Road', 'Bhuiyan Mansion', 'Baitul Haque'],
    phase: 1,
    note: 'Older corporate cluster. Landlines, corporate accounts, more IATA holders. Higher value, slower decisions.'
  },
  {
    id: 'gulistan',
    name: 'Gulistan / Old Dhaka',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['Sundarban Square Super Market'],
    phase: 1,
    note: 'Retail-counter density. Small operators, cash business, entirely offline.'
  },
  {
    id: 'gulshan',
    name: 'Gulshan / Banani',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['Landmark Tower', 'Taj Cassilina', 'RM Centre', 'NI Tower', 'Habib Super Market'],
    phase: 1,
    note: 'Highest ability to pay, longest cycles. Several of the oldest IATA houses still run fully offline.'
  },
  {
    id: 'uttara',
    name: 'Uttara',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['HM Plaza', 'Rajlaxmi Complex', 'Begum Zahura Market', 'Sectors 3 & 7'],
    phase: 1,
    note: 'Younger, owner-operated, mobile-first. Fastest cycles \u2014 often demo the same week. Best place for first references.'
  },
  {
    id: 'dhanmondi',
    name: 'Dhanmondi / Mohammadpur / Shyamoli / Lalmatia',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['Orchid Plaza', 'Shyamoli Blossom Market', 'Nest Osmium Tower', 'Lalmatia Shopping Complex', 'Momtaz Plaza'],
    phase: 1,
    note: 'Largest single cluster by count. Heavy 24-hour operations \u2014 automation ROI lands hardest here.'
  },
  {
    id: 'banasree',
    name: 'Banasree / Rampura / Badda',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['Banasree Main Road blocks A\u2013H', 'E-Housing'],
    phase: 1,
    note: 'Most overlooked cluster in Dhaka. Almost entirely owner-operated, WhatsApp-driven and platform-free. Highest ICP purity per call.'
  },
  {
    id: 'hajj-dhaka',
    name: 'Hajj & Umrah specialists (Dhaka)',
    district: 'Dhaka',
    division: 'Dhaka',
    landmarks: ['CPDL Ahmed Forum', 'Noakhali Tower', 'Akram Tower', 'Pritom Bhaban'],
    phase: 1,
    note: 'Verify every agency against the Ministry of Religious Affairs 2026 approved list on hajj.gov.bd before pitching.'
  },
  {
    id: 'chattogram',
    name: 'Chattogram \u2014 Agrabad C/A',
    district: 'Chattogram',
    division: 'Chattogram',
    landmarks: ['Hotel Agrabad', 'Hotel Agrabad Arcade', 'C&F Tower', 'Makkah Madina Trade Centre'],
    phase: 2,
    note: 'Buys face to face. Book meetings before travelling. Strong Middle East labour corridor.'
  },
  {
    id: 'sylhet',
    name: 'Sylhet \u2014 Zindabazar',
    district: 'Sylhet',
    division: 'Sylhet',
    landmarks: ['RB Complex', 'Surma Tower', 'Overseas Centre', 'West World Shopping City', 'Liyakot Bhaban'],
    phase: 2,
    note: 'Heavily UK-diaspora and Umrah oriented. Extremely referral-driven \u2014 one trusted reference opens the cluster.'
  },
  {
    id: 'narayanganj',
    name: 'Narayanganj',
    district: 'Narayanganj',
    division: 'Dhaka',
    landmarks: ['Club Market', 'Sufiya Plaza', 'Rauf Tower', 'B.B. Road'],
    phase: 2,
    note: 'Industrial belt plus migrant traffic. Softifybd already has a Narayanganj dev & support office \u2014 use it.'
  },
  {
    id: 'cumilla',
    name: 'Cumilla',
    district: 'Cumilla',
    division: 'Chattogram',
    landmarks: ['Chowk Bazar Road', 'Nahar Plaza', 'Laksham Road', 'Nazrul Avenue'],
    phase: 2,
    note: 'Qatar and Gulf remittance corridor. Zero vendor competition.'
  },
  {
    id: 'brahmanbaria',
    name: 'Brahmanbaria',
    district: 'Brahmanbaria',
    division: 'Chattogram',
    landmarks: ['Masjid Road', 'Kumarshil Moor', 'Bhuiyan Mansion'],
    phase: 3,
    note: 'Heavy Middle East migrant corridor. One agency publicly cannot book foreign domestic sectors \u2014 a direct GDS capability gap.'
  },
  {
    id: 'khulna',
    name: 'Khulna',
    district: 'Khulna',
    division: 'Khulna',
    landmarks: ['Jalal Complex', 'KDA Avenue', 'Majid Sarani', 'NS Towers'],
    phase: 3,
    note: 'India visa and rail traffic plus Sundarban inbound. No local software vendor presence at all.'
  },
  {
    id: 'rajshahi',
    name: 'Rajshahi',
    district: 'Rajshahi',
    division: 'Rajshahi',
    landmarks: ['Court Station Mor (Hold 77)', 'Airport Road / Thana Mor', 'Shershah Road', 'Bornali Mor'],
    phase: 3,
    note: 'Reputation-led market \u2014 reviews here explicitly praise licence-holding. Two targets share one building.'
  },
  {
    id: 'bogura',
    name: 'Bogura',
    district: 'Bogura',
    division: 'Rajshahi',
    landmarks: ['Merina Road'],
    phase: 3,
    note: 'Largest single agency footprint outside the metros, still with no platform.'
  }
];

// ---- labels ----------------------------------------------------------------

export const STAGE_LABEL: Record<PipelineStage, string> = {
  not_contacted: 'Not contacted',
  attempted: 'Attempted',
  discovery: 'Discovery',
  demo_booked: 'Demo booked',
  demo_done: 'Demo done',
  proposal_sent: 'Proposal sent',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
  disqualified: 'Disqualified'
};

export const CRED_LABEL: Record<CredentialState, string> = {
  verified: 'Verified',
  inferred: 'Inferred',
  unknown: 'Unknown',
  none: 'None'
};

export const SALES_MODE_LABEL: Record<SalesMode, string> = {
  manual: 'Manual (WhatsApp / phone)',
  sub_agent: 'Sub-agent on another panel',
  own_platform: 'Has own platform',
  unknown: 'Unknown'
};

export const EXCLUSION_LABEL: Record<string, string> = {
  has_own_platform: 'Already has own platform',
  building_in_house: 'Building in-house',
  is_competitor: 'Competitor',
  compliance_risk: 'Compliance risk'
};
