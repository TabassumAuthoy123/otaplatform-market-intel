/**
 * GDS transport. One place that knows how to reach Travelport, used by both
 * /api/gds/search and the /portal/flights page.
 *
 * WHY THE REQUEST IS CONFIGURABLE RATHER THAN HARDCODED
 * -----------------------------------------------------
 * Travelport sells more than one air-shopping product. The JSON APIs and the
 * older uAPI SOAP services take different paths, different payloads and
 * different auth headers, and which one an agency may call depends on what it
 * is provisioned for. Guessing the contract would produce code that looks
 * finished and fails on contact.
 *
 * So: the host, path, HTTP method and request body all come from the
 * environment. This module supplies auth, timeout, transport and error
 * handling, and hands back exactly what the upstream said. Read the endpoint
 * off your own Travelport API documentation, put it in .env, and it works.
 *
 * The password is read here and sent upstream. It is never logged, never
 * returned to a browser, and never written to disk.
 */

export type GdsConfig = {
  baseUrl: string;
  username: string;
  password: string;
  accept: string;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
};

export type GdsAttempt = {
  configured: boolean;
  missing: string[];
  attempted: boolean;
  upstreamStatus?: number;
  upstreamOk?: boolean;
  elapsedMs?: number;
  endpointHost?: string;
  data?: unknown;
  error?: string;
  message?: string;
  /** Parsed out of a SOAP fault, when the upstream returns one. */
  fault?: { code?: string; description?: string; faultString?: string; diagnosis?: string };
};

/**
 * Travelport answers a rejected call with a SOAP fault rather than a clean
 * status, so the useful information is inside the XML. Pull the numeric error
 * code and the description out, and translate the codes we have actually seen
 * into something a non-integrator can act on.
 */
function parseSoapFault(xml: string): GdsAttempt['fault'] | undefined {
  if (typeof xml !== 'string' || !/fault|ErrorInfo/i.test(xml)) return undefined;

  const pick = (re: RegExp) => {
    const m = xml.match(re);
    return m ? m[1].trim() : undefined;
  };

  // uAPI returns SOAP 1.1 faults as <SOAP-ENV:faultcode>76</SOAP-ENV:faultcode>,
  // so faultcode has to be tried before the generic *Code element.
  const code =
    pick(/<[\w-]*:?faultcode>\s*([^<]+?)\s*<\/[\w-]*:?faultcode>/i) ??
    pick(/<[\w:]*Code>\s*([^<]+?)\s*<\/[\w:]*Code>/i) ??
    pick(/ErrorCode="([^"]+)"/i);
  const description =
    pick(/<[\w:]*Description>\s*([^<]+?)\s*<\/[\w:]*Description>/i) ??
    pick(/<[\w:]*Message>\s*([^<]+?)\s*<\/[\w:]*Message>/i);
  const faultString = pick(/<[\w-]*:?faultstring>\s*([\s\S]+?)\s*<\/[\w-]*:?faultstring>/i);

  if (!code && !description && !faultString) return undefined;

  const DIAGNOSIS: Record<string, string> = {
    '76':
      'Travelport rejected the credentials themselves. This is provisioning on their side, not a bug here: ' +
      'the account has to be enabled for programmatic uAPI SOAP access, and the PCC and Target Branch have to be ' +
      'linked to it in Agency Manager. A credential that works in the developer web portal is not the same ' +
      'grant as SOAP API access.',
    '77': 'The credential is known but not authorised for this service. Ask Travelport which services the account is provisioned for.',
    '1002': 'The Target Branch does not match the credential. Check the branch code with Travelport.'
  };

  return { code, description, faultString, diagnosis: code ? DIAGNOSIS[code] : undefined };
}

const BASE_KEYS = ['GDS_BASE_URL', 'GDS_USERNAME', 'GDS_PASSWORD'] as const;

function baseConfig(): { config: GdsConfig | null; missing: string[] } {
  const missing = BASE_KEYS.filter((k) => !process.env[k]);
  if (missing.length) return { config: null, missing: [...missing] };

  let extraHeaders: Record<string, string> = {};
  if (process.env.GDS_EXTRA_HEADERS) {
    try {
      extraHeaders = JSON.parse(process.env.GDS_EXTRA_HEADERS);
    } catch {
      // a malformed header blob must not take the whole lookup down
    }
  }

  return {
    config: {
      baseUrl: process.env.GDS_BASE_URL!.replace(/\/+$/, ''),
      username: process.env.GDS_USERNAME!,
      password: process.env.GDS_PASSWORD!,
      accept: process.env.GDS_ACCEPT || 'application/json',
      extraHeaders,
      timeoutMs: Number(process.env.GDS_TIMEOUT_MS || 20000)
    },
    missing: []
  };
}

/** What the search half needs on top of the shared credentials. */
export function searchConfigStatus(): { configured: boolean; missing: string[] } {
  const { missing } = baseConfig();
  const all = [...missing];
  if (!process.env.GDS_SEARCH_PATH) all.push('GDS_SEARCH_PATH');
  return { configured: all.length === 0, missing: all };
}

/** What the PNR half needs. */
export function pnrConfigStatus(): { configured: boolean; missing: string[] } {
  const { missing } = baseConfig();
  const all = [...missing];
  if (!process.env.GDS_PNR_PATH) all.push('GDS_PNR_PATH');
  return { configured: all.length === 0, missing: all };
}

export type SearchQuery = { from: string; to: string; date?: string; adults?: string; cabin?: string };

/** Substitutes {from} {to} {date} {adults} {cabin} in a path or body template. */
function fill(template: string, q: SearchQuery): string {
  return template
    .replace(/\{from\}/g, encodeURIComponent(q.from))
    .replace(/\{to\}/g, encodeURIComponent(q.to))
    .replace(/\{date\}/g, encodeURIComponent(q.date ?? ''))
    .replace(/\{adults\}/g, encodeURIComponent(q.adults ?? '1'))
    .replace(/\{cabin\}/g, encodeURIComponent(q.cabin ?? 'Economy'));
}

async function call(path: string, method: string, body: string | undefined, config: GdsConfig): Promise<GdsAttempt> {
  const url = `${config.baseUrl}${path}`;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const started = Date.now();

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'invalid GDS_BASE_URL';
    }
  })();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    const upstream = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        accept: config.accept,
        ...(body ? { 'content-type': process.env.GDS_CONTENT_TYPE || 'application/json' } : {}),
        // uAPI is SOAP 1.1: it expects the header even when the value is empty
        ...(process.env.GDS_SOAP_ACTION !== undefined ? { soapaction: process.env.GDS_SOAP_ACTION } : {}),
        ...config.extraHeaders
      },
      body,
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);

    const text = await upstream.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // uAPI answers XML — hand it back rather than mangling it
    }

    return {
      configured: true, missing: [], attempted: true,
      upstreamStatus: upstream.status, upstreamOk: upstream.ok,
      elapsedMs: Date.now() - started, endpointHost: host, data,
      fault: parseSoapFault(text)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown transport error';
    return {
      configured: true, missing: [], attempted: true, upstreamOk: false,
      elapsedMs: Date.now() - started, endpointHost: host,
      error:
        message === 'The operation was aborted.' || /abort/i.test(message)
          ? `No response within ${config.timeoutMs}ms — the endpoint is unreachable, or your IP is not whitelisted with Travelport.`
          : message
    };
  }
}

export async function searchFlights(q: SearchQuery): Promise<GdsAttempt> {
  const status = searchConfigStatus();
  if (!status.configured) {
    return {
      configured: false,
      missing: status.missing,
      attempted: false,
      message:
        'No GDS search endpoint in the environment, so no live call was attempted. ' +
        'Set the variables listed in missing[] in .env and restart the app.'
    };
  }
  const { config } = baseConfig();
  const method = (process.env.GDS_SEARCH_METHOD || 'POST').toUpperCase();
  const path = fill(process.env.GDS_SEARCH_PATH!, q);
  const bodyTemplate = process.env.GDS_SEARCH_BODY;
  const body = method === 'GET' || !bodyTemplate ? undefined : fill(bodyTemplate, q);
  return call(path, method, body, config!);
}

export async function retrievePnr(locator: string): Promise<GdsAttempt> {
  const status = pnrConfigStatus();
  if (!status.configured) {
    return {
      configured: false,
      missing: status.missing,
      attempted: false,
      message:
        'No GDS reservation endpoint in the environment, so no live call was attempted. ' +
        'Set the variables listed in missing[] in .env and restart the app.'
    };
  }
  const { config } = baseConfig();
  // The locator goes into XML, not a URL, so it must NOT be percent-encoded
  // there. Path substitution stays encoded; body substitution does not.
  const path = process.env.GDS_PNR_PATH!.replace(/\{locator\}/g, encodeURIComponent(locator));
  const method = (process.env.GDS_PNR_METHOD || 'GET').toUpperCase();
  const bodyTemplate = process.env.GDS_PNR_BODY;
  const body =
    method === 'GET' || !bodyTemplate
      ? undefined
      : bodyTemplate.replace(/\{locator\}/g, locator.replace(/[<>&"']/g, ''));
  return call(path, method, body, config!);
}

/* ------------------------------------------------- uAPI LowFareSearch parse */

export type FareOffer = {
  /** Travelport's key. Transaction-scoped: a new search mints new keys. */
  key: string;
  /**
   * Stable identifier for the same flights at the same price. Travelport's own
   * key cannot be used to re-find an offer after a fresh search, so selecting a
   * fare and then re-pricing it has to match on the itinerary instead.
   */
  sig: string;
  totalPrice: string;
  basePrice: string;
  taxes: string;
  currency: string;
  amount: number;
  refundable: boolean;
  platingCarrier: string;
  latestTicketing: string;
  cabin: string;
  bookingCode: string;
  segments: {
    carrier: string; flightNumber: string; origin: string; destination: string;
    departure: string; arrival: string; minutes: number; equipment: string;
  }[];
};

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
};

/**
 * Turn a LowFareSearchRsp into bookable-looking offers.
 *
 * Written against a real sandbox response, not a guess: AirPricePoint carries
 * the money, the AirPricingInfo inside it carries the fare conditions, and its
 * BookingInfo rows point at AirSegment keys by SegmentRef. Segments live in a
 * flat AirSegmentList at the top, so they are indexed by Key first.
 *
 * Returns [] for anything that is not a LowFareSearchRsp, so a caller can hand
 * it any upstream body safely.
 */
export function parseLowFareSearch(xml: unknown): FareOffer[] {
  if (typeof xml !== 'string' || !xml.includes('LowFareSearchRsp')) return [];

  const segments = new Map<string, FareOffer['segments'][number]>();
  for (const m of xml.matchAll(/<air:AirSegment\b([^>]*)>/g)) {
    const t = m[1];
    const key = attr(t, 'Key');
    if (!key) continue;
    segments.set(key, {
      carrier: attr(t, 'Carrier'),
      flightNumber: attr(t, 'FlightNumber'),
      origin: attr(t, 'Origin'),
      destination: attr(t, 'Destination'),
      departure: attr(t, 'DepartureTime'),
      arrival: attr(t, 'ArrivalTime'),
      minutes: Number(attr(t, 'FlightTime')) || 0,
      equipment: attr(t, 'Equipment')
    });
  }

  const offers: FareOffer[] = [];
  // One AirPricePoint can hold SEVERAL AirPricingInfo blocks — the same money
  // for different flight combinations. Each AirPricingInfo is one itinerary, so
  // iterate those rather than the price point. Reading BookingInfo across the
  // whole price point instead makes every offer carry every leg of every
  // option, which is what this once did.
  for (const pp of xml.matchAll(/<air:AirPricePoint\b([^>]*)>([\s\S]*?)<\/air:AirPricePoint>/g)) {
    const head = pp[1];
    const ppBody = pp[2];

    const total = attr(head, 'TotalPrice');
    const currency = total.slice(0, 3);

    for (const pi of ppBody.matchAll(/<air:AirPricingInfo\b([^>]*)>([\s\S]*?)<\/air:AirPricingInfo>/g)) {
    const infoTag = pi[1];
    const infoBody = pi[2];
    const totalHere = attr(infoTag, 'TotalPrice') || total;
    const amount = Number(totalHere.slice(3)) || 0;
    const bookings = Array.from(infoBody.matchAll(/<air:BookingInfo\b([^>]*)\/>/g)).map((b) => b[1]);

    const segs = bookings
      .map((b) => segments.get(attr(b, 'SegmentRef')))
      .filter((s): s is FareOffer['segments'][number] => Boolean(s));

    if (!segs.length) continue;

    /**
     * A one-way LowFareSearch commonly returns one fare that applies to several
     * departures — same money, pick your time. Those segments are ALTERNATIVES,
     * not a connection, and showing them as one itinerary produces a card that
     * claims the passenger flies DAC–CGP six times.
     *
     * Detect it: if every segment shares the same origin and destination, they
     * are alternatives, so emit one offer each. Anything else is a genuine
     * multi-leg itinerary and stays together.
     */
    const sameOD =
      segs.length > 1 &&
      segs.every((s) => s.origin === segs[0].origin && s.destination === segs[0].destination);
    const groups = sameOD ? segs.map((s) => [s]) : [segs];

    for (const group of groups) {
      const sig = group.map((s) => `${s.carrier}${s.flightNumber}@${s.departure}`).join('|') + `#${amount}`;
      offers.push({
        key: attr(infoTag, 'Key') || attr(head, 'Key'),
        sig: Buffer.from(sig).toString('base64url'),
        totalPrice: totalHere,
        basePrice: attr(infoTag, 'BasePrice') || attr(head, 'BasePrice'),
        taxes: attr(infoTag, 'Taxes') || attr(head, 'Taxes'),
        currency,
        amount,
        refundable: attr(infoTag, 'Refundable') === 'true',
        platingCarrier: attr(infoTag, 'PlatingCarrier'),
        latestTicketing: attr(infoTag, 'LatestTicketingTime'),
        cabin: attr(bookings[0] ?? '', 'CabinClass'),
        bookingCode: attr(bookings[0] ?? '', 'BookingCode'),
        segments: group
      });
    }
    }
  }

  // cheapest first, then de-duplicate identical flight+price combinations
  const seen = new Set<string>();
  return offers
    .sort((a, b) => a.amount - b.amount)
    .filter((o) => {
      if (seen.has(o.sig)) return false;
      seen.add(o.sig);
      return true;
    });
}
