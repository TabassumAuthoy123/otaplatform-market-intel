/**
 * Sabre — token auth plus Bargain Finder Max search.
 *
 * THE AUTH HEADER IS DOUBLE BASE64 AND THAT IS THE WHOLE TRICK
 * -----------------------------------------------------------
 *   Authorization: Basic base64( base64(userId) + ":" + base64(password) )
 *
 * User and password are base64'd SEPARATELY, joined with a colon, and the whole
 * thing base64'd again. Assembling it the ordinary way — base64("user:pass") —
 * gets a 401 that looks exactly like bad credentials, which is how integrators
 * lose a day to it. Build it here and nowhere else.
 *
 * Credentials come from the environment, mirrored out of the OTAPlatform Laravel
 * DB table sabre_gds_configs. That project keeps GDS credentials in the database
 * rather than in .env, so if these ever disagree, the database row is the one the
 * Laravel app is actually using.
 *
 * WHAT WORKS ON THE CURRENT SANDBOX ACCOUNT
 *   POST /v2/auth/token                 token          works
 *   POST /v5/offers/shop                BFM search     works
 *   POST /v5/shop/flights/revalidate    revalidate     works
 *   POST /v1/trip/orders/createBooking  create PNR     UNAUTHORIZED_ACCESS on PassengerDetailsRQ
 *
 *   /v2.5.0/passenger/records is NOT a path on this host — it answers 404, and
 *   so does /v2.4.0. Only /v2.3.0 exists, and that one answers 403. This file
 *   claimed the 2.5.0 path was refused on entitlement for weeks; it was never
 *   reached at all. The endpoint above was found by enumerating the host, and
 *   its refusal arrives inside an HTTP 200 with an `errors` array.
 *
 * Booking is not entitled on this account, so create/ticket/void are not wired.
 * That is a Sabre-side entitlement, not a payload problem — the same is true of
 * Travelport's AirCreateReservationReq, which answers uAPI 1201 on that account.
 */

export type SabreStatus = { configured: boolean; missing: string[]; production: boolean; pcc: string | null };

export type SabreAttempt = {
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
  /** Sabre error envelope, when it sends one. */
  fault?: { code?: string; message?: string; diagnosis?: string };
};

type TaxDesc = { id?: number; code?: string; amount?: number; description?: string };

export type SabreOffer = {
  sig: string;
  currency: string;
  amount: number;
  base: number;
  taxes: number;
  /**
   * Taxes itemised by code, resolved out of the response's `taxDescs` dictionary.
   *
   * Sabre returns codes with human descriptions — UT3 "TRAVEL TAX", P8 "PASSENGER
   * SECURITY FEE", ZR the advance-passenger-information fee — and the
   * per-passenger `taxes` array holds only `{ref}` pointers into that dictionary.
   * Both halves were being discarded in favour of one summed number.
   */
  taxBreakdown: { code: string; amount: number; description: string }[];
  cabin: string;
  seatsLeft: number | null;
  segments: {
    carrier: string; flightNumber: string; origin: string; destination: string;
    departure: string; arrival: string; minutes: number; equipment: string;
  }[];
};

const KEYS = ['SABRE_BASE_URL', 'SABRE_USER_ID', 'SABRE_PASSWORD'] as const;

export function sabreStatus(): SabreStatus {
  const missing = KEYS.filter((k) => !process.env[k]);
  return {
    configured: missing.length === 0,
    missing: [...missing],
    production: process.env.SABRE_IS_PRODUCTION === '1',
    pcc: process.env.SABRE_PCC ?? null
  };
}

/** base64( base64(user) : base64(pass) ) — see the note at the top. */
function basicHeader(user: string, pass: string): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return Buffer.from(`${b64(user)}:${b64(pass)}`, 'utf8').toString('base64');
}

/**
 * Token cache. Sabre tokens are shared across callers and last ~7 days, so
 * fetching one per search burns quota for nothing. Expiry is held 60s short of
 * what Sabre reports, so a token can never be used in the second it dies.
 */
let cached: { token: string; expiresAt: number } | null = null;

export async function getToken(baseUrl: string, user: string, pass: string, timeoutMs: number): Promise<
  { ok: true; token: string } | { ok: false; status?: number; body?: unknown; error?: string }
> {
  if (cached && cached.expiresAt > Date.now()) return { ok: true, token: cached.token };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v2/auth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicHeader(user, pass)}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }

    if (!res.ok) return { ok: false, status: res.status, body };

    const j = body as { access_token?: string; expires_in?: number };
    if (!j.access_token) return { ok: false, status: res.status, body };

    cached = {
      token: j.access_token,
      expiresAt: Date.now() + Math.max(60, (j.expires_in ?? 604800) - 60) * 1000
    };
    return { ok: true, token: cached.token };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err instanceof Error ? err.message : 'token transport error' };
  }
}

const DIAGNOSIS: Record<string, string> = {
  'ERR.2SG.SEC.NOT_AUTHORIZED':
    'The credentials are fine — this account is not entitled to that service. Booking and ticketing have to be ' +
    'switched on by Sabre for the PCC; there is nothing to fix in the request.',
  'ERR.2SG.SEC.INVALID_CREDENTIALS':
    'Sabre rejected the credentials. The usual cause is the auth header: it must be ' +
    'base64(base64(user):base64(pass)), not base64(user:pass).',
  'ERR.2SG.CLIENT.VALIDATION_FAILED': 'Sabre parsed the request but rejected a field. The response body names it.'
};

function parseFault(body: unknown): SabreAttempt['fault'] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const code =
    (b.errorCode as string) ??
    ((b.error as Record<string, unknown>)?.code as string) ??
    (Array.isArray(b.errors) ? ((b.errors[0] as Record<string, unknown>)?.code as string) : undefined);
  const message =
    (b.message as string) ??
    (b.error_description as string) ??
    ((b.error as Record<string, unknown>)?.message as string);
  if (!code && !message) return undefined;
  return { code, message, diagnosis: code ? DIAGNOSIS[code] : undefined };
}

export type SabreQuery = { from: string; to: string; date: string; adults: string };

export async function sabreSearch(q: SabreQuery): Promise<SabreAttempt> {
  const status = sabreStatus();
  if (!status.configured) {
    return {
      configured: false,
      missing: status.missing,
      attempted: false,
      message: 'No Sabre credentials in the environment, so no call was attempted.'
    };
  }

  const baseUrl = process.env.SABRE_BASE_URL!.replace(/\/+$/, '');
  /**
   * ONE budget for the whole Sabre path, not one per call.
   *
   * A Sabre search is two sequential HTTP calls — token, then shop — and each
   * used to get the full `timeoutMs` of its own. With the default 30000 that made
   * the real worst case 60s, a number nobody configured and nothing documented:
   * it just emerged from two independent AbortControllers. Since Travelport runs
   * in parallel at GDS_TIMEOUT_MS, the storefront's actual worst case was
   * max(travelport, 60s) while every comment in the codebase said the search was
   * bounded by a single setting. A live run took 36.7s and tripped a check that
   * expected 30s, which is how this surfaced.
   *
   * Now `SABRE_TIMEOUT_MS` means what it says: the deadline for the whole
   * attempt. Whatever the token spends, the shop call cannot spend again.
   */
  const timeoutMs = Number(process.env.SABRE_TIMEOUT_MS || 30000);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return 'invalid SABRE_BASE_URL';
    }
  })();

  const started = Date.now();
  const tok = await getToken(baseUrl, process.env.SABRE_USER_ID!, process.env.SABRE_PASSWORD!, remaining());
  if (!tok.ok) {
    return {
      configured: true, missing: [], attempted: true, upstreamOk: false,
      upstreamStatus: tok.status, elapsedMs: Date.now() - started, endpointHost: host,
      error: tok.error ?? 'Sabre would not issue a token',
      fault: parseFault(tok.body),
      data: tok.body
    };
  }

  // Bargain Finder Max, one-way, lowest fares first
  const payload = {
    OTA_AirLowFareSearchRQ: {
      Version: '5',
      POS: {
        Source: [{ PseudoCityCode: process.env.SABRE_PCC ?? undefined, RequestorID: { Type: '1', ID: '1', CompanyName: { Code: 'TN' } } }]
      },
      OriginDestinationInformation: [{
        RPH: '1',
        DepartureDateTime: `${q.date}T00:00:00`,
        OriginLocation: { LocationCode: q.from },
        DestinationLocation: { LocationCode: q.to }
      }],
      TravelPreferences: { TPA_Extensions: { NumTrips: { Number: 20 } } },
      TravelerInfoSummary: {
        SeatsRequested: [Number(q.adults) || 1],
        AirTravelerAvail: [{ PassengerTypeQuantity: [{ Code: 'ADT', Quantity: Number(q.adults) || 1 }] }]
      },
      TPA_Extensions: { IntelliSellTransaction: { RequestType: { Name: '50ITINS' } } }
    }
  };

  try {
    const controller = new AbortController();
    // Whatever the token spent is gone; the shop call gets what is left.
    const timer = setTimeout(() => controller.abort(), remaining());
    const res = await fetch(`${baseUrl}/v5/offers/shop`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);

    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw */
    }

    return {
      configured: true, missing: [], attempted: true,
      upstreamStatus: res.status, upstreamOk: res.ok,
      elapsedMs: Date.now() - started, endpointHost: host,
      data, fault: res.ok ? undefined : parseFault(data)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'transport error';
    return {
      configured: true, missing: [], attempted: true, upstreamOk: false,
      elapsedMs: Date.now() - started, endpointHost: host,
      error: /abort/i.test(message) ? `No response within ${timeoutMs}ms.` : message
    };
  }
}

/**
 * Pull priced itineraries out of a BFM response.
 *
 * BFM nests deeply and the shape shifts between versions, so every step is
 * guarded and anything unreadable is skipped rather than guessed at. Returns []
 * for a response this cannot understand.
 */
export function parseSabreOffers(data: unknown): SabreOffer[] {
  const root = (data as Record<string, never>)?.['groupedItineraryResponse'] as unknown as
    | { itineraryGroups?: unknown[]; legDescs?: unknown[]; scheduleDescs?: unknown[]; taxDescs?: unknown[] }
    | undefined;
  if (!root?.itineraryGroups) return [];

  /**
   * Field names taken off a real cert response, because they are not where you
   * would guess: the flight number and the aircraft live INSIDE `carrier`, as
   * marketingFlightNumber and equipment.code. There is no top-level
   * `flightNumber` and no top-level `equipment`.
   */
  type Sched = {
    id?: number;
    carrier?: {
      marketing?: string; operating?: string;
      marketingFlightNumber?: number | string; operatingFlightNumber?: number | string;
      equipment?: { code?: string };
    };
    departure?: { airport?: string; time?: string };
    arrival?: { airport?: string; time?: string };
    elapsedTime?: number;
  };

  const scheds = new Map<number, Sched>();
  for (const s of (root.scheduleDescs ?? []) as Sched[]) if (typeof s.id === 'number') scheds.set(s.id, s);

  type Leg = { id?: number; schedules?: { ref?: number }[] };
  const legs = new Map<number, Leg>();
  for (const l of (root.legDescs ?? []) as Leg[]) if (typeof l.id === 'number') legs.set(l.id, l);

  /**
   * The tax dictionary, built once per response.
   *
   * `taxDescs` is a flat list of every tax mentioned anywhere in the answer, and
   * each priced itinerary refers into it by id. Resolving per offer would rebuild
   * this map for every fare on the page.
   */
  const taxDescs = new Map<number, TaxDesc>();
  for (const t of (root.taxDescs ?? []) as TaxDesc[]) if (typeof t.id === 'number') taxDescs.set(t.id, t);

  const offers: SabreOffer[] = [];

  for (const grp of root.itineraryGroups as { itineraries?: unknown[] }[]) {
    for (const it of (grp.itineraries ?? []) as {
      legs?: { ref?: number }[];
      pricingInformation?: { fare?: { totalFare?: { totalPrice?: number; baseFareAmount?: number; totalTaxAmount?: number; currency?: string }; passengerInfoList?: { passengerInfo?: { taxes?: { ref?: number }[] } }[] } }[];
    }[]) {
      const price = it.pricingInformation?.[0]?.fare?.totalFare;
      if (!price?.totalPrice) continue;

      /**
       * Do NOT use baseFareAmount as the base. Sabre quotes it in the fare
       * CONSTRUCTION currency — a DAC–DXB itinerary came back as base 143 with
       * tax 16,663 against a total of 34,300, because the 143 was USD and the
       * rest was BDT. Adding those two gives a number that is simply wrong, and
       * feeding it into an accounting system produces a fictional margin.
       *
       * total − tax is in one currency by definition, so it always reconciles.
       */
      const totalNum = Number(price.totalPrice);
      const taxNum = Number(price.totalTaxAmount) || 0;
      const baseNum = Math.max(0, totalNum - taxNum);

      /**
       * Resolve this itinerary's tax refs against the dictionary.
       *
       * `passengerInfo.taxes` is the full itemisation; `taxSummaries` is a shorter
       * roll-up of the same thing. Taking the first means a document records every
       * code the airline charged rather than a grouped subset — and BSP bills at
       * the code level, so the grouped version cannot be reconciled against it.
       */
      const paxInfo = (it.pricingInformation?.[0]?.fare?.passengerInfoList?.[0]?.passengerInfo ?? {}) as {
        taxes?: { ref?: number }[];
      };
      const taxBreakdown = (paxInfo.taxes ?? [])
        .map((r) => taxDescs.get(r.ref as number))
        .filter((t): t is TaxDesc => Boolean(t))
        .map((t) => ({
          code: String(t.code ?? ''),
          amount: Math.round(Number(t.amount) || 0),
          description: String(t.description ?? '')
        }))
        .filter((t) => t.code && t.amount > 0);

      const segments: SabreOffer['segments'] = [];
      for (const legRef of it.legs ?? []) {
        const leg = legs.get(legRef.ref as number);
        for (const sref of leg?.schedules ?? []) {
          const s = scheds.get(sref.ref as number);
          if (!s) continue;
          segments.push({
            carrier: s.carrier?.marketing ?? s.carrier?.operating ?? '',
            flightNumber: String(s.carrier?.marketingFlightNumber ?? s.carrier?.operatingFlightNumber ?? ''),
            origin: s.departure?.airport ?? '',
            destination: s.arrival?.airport ?? '',
            // Sabre gives a time with offset but no date — the date is the one
            // that was searched for, so the caller supplies it.
            departure: s.departure?.time ?? '',
            arrival: s.arrival?.time ?? '',
            minutes: Number(s.elapsedTime) || 0,
            equipment: s.carrier?.equipment?.code ?? ''
          });
        }
      }
      if (!segments.length) continue;

      const amount = Number(price.totalPrice);
      const sig = Buffer.from(
        segments.map((s) => `${s.carrier}${s.flightNumber}@${s.departure}`).join('|') + `#${amount}`
      ).toString('base64url');

      offers.push({
        sig,
        currency: price.currency ?? 'BDT',
        amount,
        base: baseNum,
        taxes: taxNum,
        taxBreakdown,
        cabin: '',
        seatsLeft: null,
        segments
      });
    }
  }

  const seen = new Set<string>();
  return offers
    .sort((a, b) => a.amount - b.amount)
    .filter((o) => (seen.has(o.sig) ? false : (seen.add(o.sig), true)));
}
