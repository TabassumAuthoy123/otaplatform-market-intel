import { NextResponse } from 'next/server';
import { getBook, invoiceTotals } from '@/lib/accounting';

/**
 * PNR lookup — two halves, deliberately separate.
 *
 *  local  always works. Finds the PNR on an invoice line in content/accounting.json
 *         and returns the commercial picture: customer, sale, supplier cost, margin,
 *         payment status. This is our own book, not the GDS.
 *
 *  live   calls the configured GDS endpoint. Off unless the environment is set.
 *         The request path and body are NOT hardcoded to a guessed Travelport
 *         schema — they come from env, because the exact contract depends on
 *         which Travelport product you are provisioned for (JSON API vs uAPI)
 *         and that has to be read off your own API documentation, not assumed.
 *
 * Environment (put these in .env, never in git — see .env.example):
 *   GDS_BASE_URL              e.g. https://api.pp.travelport.com
 *   GDS_PNR_PATH              path template, {locator} is substituted
 *                             e.g. /v1/reservation/{locator}
 *   GDS_USERNAME              Travelport login id
 *   GDS_PASSWORD              Travelport password
 *   GDS_ACCEPT                optional Accept header, defaults to application/json
 *   GDS_EXTRA_HEADERS         optional JSON object of additional headers
 *   GDS_TIMEOUT_MS            optional, defaults to 15000
 *
 * The password is read here and sent upstream. It is never logged, never echoed
 * in a response, and never included in the diagnostics below.
 */

export const dynamic = 'force-dynamic';

type Config = {
  baseUrl: string;
  pathTemplate: string;
  username: string;
  password: string;
  accept: string;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
};

function readConfig(): { config: Config | null; missing: string[] } {
  const required = {
    GDS_BASE_URL: process.env.GDS_BASE_URL,
    GDS_PNR_PATH: process.env.GDS_PNR_PATH,
    GDS_USERNAME: process.env.GDS_USERNAME,
    GDS_PASSWORD: process.env.GDS_PASSWORD
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) return { config: null, missing };

  let extraHeaders: Record<string, string> = {};
  if (process.env.GDS_EXTRA_HEADERS) {
    try {
      extraHeaders = JSON.parse(process.env.GDS_EXTRA_HEADERS);
    } catch {
      // a malformed header blob should not take the whole lookup down
    }
  }

  return {
    config: {
      baseUrl: required.GDS_BASE_URL!.replace(/\/+$/, ''),
      pathTemplate: required.GDS_PNR_PATH!,
      username: required.GDS_USERNAME!,
      password: required.GDS_PASSWORD!,
      accept: process.env.GDS_ACCEPT || 'application/json',
      extraHeaders,
      timeoutMs: Number(process.env.GDS_TIMEOUT_MS || 15000)
    },
    missing: []
  };
}

async function localLookup(locator: string) {
  const book = await getBook();
  const hits: unknown[] = [];

  for (const inv of book.invoices) {
    const lines = inv.lines.filter((l) => l.pnr && l.pnr.toUpperCase() === locator);
    if (!lines.length) continue;
    const t = invoiceTotals(inv, book.receipts);
    hits.push({
      invoiceNo: inv.no,
      date: inv.date,
      customer: book.customers.find((c) => c.id === inv.customerId)?.name ?? inv.customerId,
      status: t.effectiveStatus,
      lines: lines.map((l) => ({
        description: l.description,
        pax: l.pax,
        sale: l.qty * l.unitPrice,
        supplierCost: l.qty * l.supplierCost,
        margin: l.qty * (l.unitPrice - l.supplierCost),
        supplier: book.suppliers.find((s) => s.id === l.supplierId)?.name ?? l.supplierId
      })),
      invoiceTotal: t.total,
      paid: t.paid,
      due: t.due,
      grossProfit: t.profit
    });
  }
  return hits;
}

export async function GET(req: Request) {
  const locator = (new URL(req.url).searchParams.get('locator') ?? '').trim().toUpperCase();

  if (!/^[A-Z0-9]{5,8}$/.test(locator)) {
    return NextResponse.json(
      { ok: false, error: 'Give a record locator of 5–8 letters or digits.' },
      { status: 422 }
    );
  }

  const local = await localLookup(locator);
  const { config, missing } = readConfig();

  if (!config) {
    return NextResponse.json({
      ok: true,
      locator,
      local,
      live: {
        configured: false,
        missing,
        message:
          'No GDS credentials in the environment, so no live call was attempted. Set the variables listed in missing[] in .env and restart the app.'
      }
    });
  }

  const url = `${config.baseUrl}${config.pathTemplate.replace('{locator}', encodeURIComponent(locator))}`;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const started = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Basic ${auth}`,
        accept: config.accept,
        ...config.extraHeaders
      },
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);

    const text = await upstream.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // upstream may answer XML — hand it back as-is rather than mangling it
    }

    return NextResponse.json({
      ok: true,
      locator,
      local,
      live: {
        configured: true,
        attempted: true,
        upstreamStatus: upstream.status,
        upstreamOk: upstream.ok,
        elapsedMs: Date.now() - started,
        // host only — never the credentials or the full query
        endpointHost: new URL(url).host,
        data
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown transport error';
    return NextResponse.json({
      ok: true,
      locator,
      local,
      live: {
        configured: true,
        attempted: true,
        upstreamOk: false,
        elapsedMs: Date.now() - started,
        endpointHost: (() => {
          try {
            return new URL(url).host;
          } catch {
            return 'invalid GDS_BASE_URL';
          }
        })(),
        error: message
      }
    });
  }
}
