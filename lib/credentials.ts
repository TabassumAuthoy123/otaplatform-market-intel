import { createHash } from 'node:crypto';

/**
 * One declared inventory of every environment variable this platform reads.
 *
 * WHY THIS FILE EXISTS
 *
 * Three separate places used to describe the environment and all three were
 * wrong in different ways. `/accounts/gds` listed seven variables and said
 * GDS_TIMEOUT_MS defaults to 15000 (it is 20000); `.env.example` had drifted; the
 * README had its own prose. None of them mentioned GDS_TARGET_BRANCH — the
 * variable whose absence made every Travelport booking come back as uAPI 8236 and
 * get reported as an entitlement block for weeks. A setup page that omits a
 * required variable is worse than no setup page, because it is read as complete.
 *
 * So the list lives here once, the screen and the checks derive from it, and a new
 * variable is added in one place or it is not added at all.
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * It never returns a secret value — not to a page, not to an API response, not to
 * a log. The repository is public, and a "just for checking" copy of a password in
 * a rendered page is a password in a browser cache, a screenshot and a support
 * ticket. What you actually need in order to check a credential is whether it is
 * present, how long it is, and whether the value in front of you is the same one
 * the app is using. All three are answerable without printing it:
 *
 *   - `present`     — the variable is set and not empty
 *   - `length`      — catches a truncated paste, the single most common mistake
 *   - `fingerprint` — first 12 hex of sha256(value)
 *
 * The fingerprint is the useful one. Hash the value you have and compare; equal
 * fingerprints mean equal values, and the hash reveals nothing. That is a better
 * check than eyeballing a printed password, because it catches a trailing space or
 * a smart quote that looks identical on screen.
 *
 * Identifiers are shown in full. A PCC, a branch code, a host name and a provider
 * code are not secrets — they are useless without the password, they appear in
 * supplier emails, and hiding them is what made the 8236 diagnosis take weeks.
 */

export type CredentialGroup = 'travelport' | 'sabre' | 'app' | 'admin';

type Declared = {
  name: string;
  group: CredentialGroup;
  purpose: string;
  /** Missing this stops the feature working. */
  required: boolean;
  /** Never rendered. Reported as length + fingerprint. */
  secret: boolean;
  /** What the code falls back to when it is unset. */
  fallback?: string;
};

/**
 * Every variable, in the order somebody setting this up would fill them.
 *
 * `required: true` means the feature named in `purpose` does not work without it.
 * The list is deliberately exhaustive rather than curated — the omission of one
 * optional-looking variable is exactly what cost weeks.
 */
const DECLARED: Declared[] = [
  /* ------------------------------------------------------------- Travelport */
  { name: 'GDS_BASE_URL', group: 'travelport', purpose: 'uAPI host, e.g. https://apac.universal-api.pp.travelport.com', required: true, secret: false },
  { name: 'GDS_USERNAME', group: 'travelport', purpose: 'uAPI user. Needs the "Universal API/" prefix — without it every call is a 401 that looks like a wrong password', required: true, secret: true },
  { name: 'GDS_PASSWORD', group: 'travelport', purpose: 'uAPI password, used as HTTP Basic', required: true, secret: true },
  { name: 'GDS_TARGET_BRANCH', group: 'travelport', purpose: 'Branch every booking call is made against. THE ONE THAT WAS MISSING: without it uAPI answers 8236, which reads as an entitlement refusal and is not one', required: true, secret: false },
  { name: 'GDS_PROVIDER_CODE', group: 'travelport', purpose: 'Host to book through — 1G is Galileo. uAPI fronts several and the request must name one', required: false, secret: false, fallback: '1G' },
  { name: 'GDS_PCC', group: 'travelport', purpose: 'Pseudo city code. Quote this to Travelport support', required: false, secret: false },
  { name: 'GDS_IS_PRODUCTION', group: 'travelport', purpose: 'Set only when these are production credentials. Guards the booking probe', required: false, secret: false, fallback: 'unset = certification' },
  { name: 'GDS_SEARCH_PATH', group: 'travelport', purpose: 'AirService path for search and booking', required: false, secret: false, fallback: '/B2BGateway/connect/uAPI/AirService' },
  { name: 'GDS_SEARCH_BODY', group: 'travelport', purpose: 'LowFareSearch SOAP body with {from} {to} {date} placeholders', required: true, secret: false },
  { name: 'GDS_PNR_PATH', group: 'travelport', purpose: 'UniversalRecordService path for retrieve', required: false, secret: false, fallback: '/B2BGateway/connect/uAPI/UniversalRecordService' },
  { name: 'GDS_PNR_BODY', group: 'travelport', purpose: 'UniversalRecordRetrieve body with a {locator} placeholder', required: false, secret: false },
  { name: 'GDS_BOOK_PATH', group: 'travelport', purpose: 'Override for AirCreateReservationReq', required: false, secret: false, fallback: 'GDS_SEARCH_PATH' },
  { name: 'GDS_TICKET_PATH', group: 'travelport', purpose: 'Override for AirTicketingReq, VoidDocumentReq, AirRefundReq', required: false, secret: false, fallback: 'GDS_SEARCH_PATH' },
  { name: 'GDS_CANCEL_PATH', group: 'travelport', purpose: 'UniversalRecordCancelReq path', required: false, secret: false, fallback: '/B2BGateway/connect/uAPI/UniversalRecordService' },
  { name: 'GDS_TIMEOUT_MS', group: 'travelport', purpose: 'Deadline for a WHOLE Travelport attempt, not per HTTP call', required: false, secret: false, fallback: '20000' },
  { name: 'GDS_CACHE_TTL_MS', group: 'travelport', purpose: 'How long a merged fare list may be reused', required: false, secret: false, fallback: '90000' },
  { name: 'GDS_DEBUG_DUMP', group: 'travelport', purpose: 'Set to 1 to write every request and response to content/gds-debug/. Off by default — the bodies carry passenger names', required: false, secret: false, fallback: 'off' },

  /* ------------------------------------------------------------------ Sabre */
  { name: 'SABRE_BASE_URL', group: 'sabre', purpose: 'Sabre host, e.g. https://api.cert.platform.sabre.com', required: true, secret: false },
  { name: 'SABRE_USER_ID', group: 'sabre', purpose: 'Sabre user id', required: true, secret: true },
  { name: 'SABRE_PASSWORD', group: 'sabre', purpose: 'Sabre password. The auth header is base64(base64(user):base64(pass)) — the single-base64 form fails with INVALID_CREDENTIALS', required: true, secret: true },
  { name: 'SABRE_PCC', group: 'sabre', purpose: 'Sabre PCC. Quote this to Sabre support', required: false, secret: false },
  { name: 'SABRE_IS_PRODUCTION', group: 'sabre', purpose: 'Set only when these are production credentials', required: false, secret: false, fallback: 'unset = certification' },
  { name: 'SABRE_TIMEOUT_MS', group: 'sabre', purpose: 'Deadline for a WHOLE Sabre attempt — token plus call share it, so this is not doubled', required: false, secret: false, fallback: '30000' },
  { name: 'SABRE_BOOK_PATH', group: 'sabre', purpose: 'createBooking path', required: false, secret: false, fallback: '/v1/trip/orders/createBooking' },
  { name: 'SABRE_TICKET_PATH', group: 'sabre', purpose: 'Ticketing path', required: false, secret: false, fallback: '/v1.3.0/air/ticket' },
  { name: 'SABRE_VOID_PATH', group: 'sabre', purpose: 'Void path', required: false, secret: false },
  { name: 'SABRE_REFUND_PATH', group: 'sabre', purpose: 'Refund path', required: false, secret: false },

  /* -------------------------------------------------------------------- app */
  { name: 'APP_URL', group: 'app', purpose: 'Where the storefront answers. The scheduler calls itself through this', required: false, secret: false, fallback: 'http://127.0.0.1:3002' },
  { name: 'APP_ACCESS_KEY', group: 'app', purpose: 'Required to reach /api/accounts, /api/crm, /api/agencies, /api/gds, /api/sabre, /api/ticketing from a non-loopback Host. Without it those routes are loopback-only', required: false, secret: true },
  { name: 'TICKETING_PROBE_ON_PRODUCTION', group: 'app', purpose: 'Set to 1 to let the booking probe run against production credentials. Off by default: the probe creates a real PNR, and on a production PCC that is real inventory held by a page refresh', required: false, secret: false, fallback: 'off' },
  { name: 'FX_MAX_AGE_DAYS', group: 'app', purpose: 'How old a hand-typed currency rate may get before it raises an alert', required: false, secret: false, fallback: '7' },

  /* ------------------------------------------------------------------ admin */
  { name: 'ADMIN_PORT', group: 'admin', purpose: 'Port the admin portal listens on', required: false, secret: false, fallback: '4001' },
  { name: 'ADMIN_URL', group: 'admin', purpose: 'Where the admin portal answers', required: false, secret: false, fallback: 'http://127.0.0.1:4001' },
  { name: 'ADMIN_EMAIL', group: 'admin', purpose: 'Seeds the first Super Admin on an empty users file. Ignored once a user exists', required: false, secret: false },
  { name: 'ADMIN_PASSWORD', group: 'admin', purpose: 'Password for that seeded account. Change it in the portal after first login — it is stored scrypt-hashed, never in plain text', required: false, secret: true }
];

export type CredentialReport = {
  name: string;
  group: CredentialGroup;
  purpose: string;
  required: boolean;
  secret: boolean;
  present: boolean;
  /** Set only when the variable is unset and the code has a fallback. */
  fallback?: string;
  /** Identifiers only. Undefined for every secret, always. */
  value?: string;
  /** Secrets only. Catches a truncated paste. */
  length?: number;
  /** Secrets only. sha256 prefix — compare without revealing. */
  fingerprint?: string;
};

/** sha256 prefix. Long enough that a collision is not a practical concern here. */
function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Report the environment without leaking it.
 *
 * Note what happens to a secret: `value` is not set to a masked string, it is
 * never set at all. A masked string is still a shape somebody will try to
 * unmask, and an object with a `value` key invites a later edit that fills it in.
 * The type makes the leak impossible rather than merely discouraged.
 */
export function credentialInventory(): CredentialReport[] {
  return DECLARED.map((d) => {
    const raw = process.env[d.name];
    const present = typeof raw === 'string' && raw.trim().length > 0;
    const base: CredentialReport = {
      name: d.name,
      group: d.group,
      purpose: d.purpose,
      required: d.required,
      secret: d.secret,
      present,
      fallback: present ? undefined : d.fallback
    };
    if (!present) return base;
    if (d.secret) return { ...base, length: raw!.length, fingerprint: fingerprintOf(raw!) };
    // Bodies are multi-kilobyte SOAP templates — say so rather than printing one.
    const v = raw!.trim();
    return { ...base, value: v.length > 120 ? `${v.length} characters of template` : v };
  });
}

/** What is missing that actually stops something working. */
export function missingRequired(): string[] {
  return credentialInventory().filter((c) => c.required && !c.present).map((c) => c.name);
}

export const CREDENTIAL_GROUP_LABEL: Record<CredentialGroup, string> = {
  travelport: 'Travelport uAPI',
  sabre: 'Sabre',
  app: 'Storefront and API',
  admin: 'Admin portal'
};
