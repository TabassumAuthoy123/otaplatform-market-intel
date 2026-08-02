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
};

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
      // upstream may answer XML — hand it back rather than mangling it
    }

    return {
      configured: true, missing: [], attempted: true,
      upstreamStatus: upstream.status, upstreamOk: upstream.ok,
      elapsedMs: Date.now() - started, endpointHost: host, data
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
  const path = process.env.GDS_PNR_PATH!.replace(/\{locator\}/g, encodeURIComponent(locator));
  const method = (process.env.GDS_PNR_METHOD || 'GET').toUpperCase();
  return call(path, method, undefined, config!);
}
