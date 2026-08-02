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
