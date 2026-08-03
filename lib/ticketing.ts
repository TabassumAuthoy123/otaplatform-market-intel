import type { Booking, Passenger } from '@/lib/bookings';
import { searchConfigStatus } from '@/lib/gds';
import { getToken, sabreStatus } from '@/lib/sabre';
import type { Supplier } from '@/lib/offers';

/**
 * Create a PNR, issue a ticket, void it, refund it — on either GDS.
 *
 * WHY THIS EXISTS EVEN THOUGH IT CANNOT SUCCEED TODAY
 *
 * Neither account is entitled to book. Travelport answers uAPI 1201 on
 * AirCreateReservationReq; Sabre answers ERR.2SG.SEC.NOT_AUTHORIZED on
 * /v2.5.0/passenger/records. No payload fixes that — the suppliers have to
 * switch booking on for PCC 3BX8 (branch P7251392) and PCC S00L.
 *
 * The previous state of this codebase was a comment in bookings.ts saying
 * ticketing "is not wired yet". That is worse than useless: it means nobody can
 * tell whether the block is provisioning or a missing implementation, the day
 * the entitlement arrives somebody starts from nothing, and the claim itself
 * ages badly because nothing re-tests it.
 *
 * So the calls are built properly, they run for real, and they report exactly
 * what the supplier said. `diagnose()` turns the two known refusals into a
 * plain sentence naming the PCC and what has to change. When entitlement is
 * granted the same code issues a ticket with no further work — and until then,
 * /accounts/gds proves the block live rather than repeating it from memory.
 *
 * NOTHING HERE IS CALLED DURING A CUSTOMER BOOKING. A storefront booking is a
 * held sale and says so. Ticketing is an explicit, separate action.
 */

export type TicketAction = 'create_pnr' | 'issue' | 'void' | 'refund';

export type TicketResult = {
  supplier: Supplier;
  action: TicketAction;
  ok: boolean;
  /** True when the supplier answered but refused on entitlement rather than payload. */
  entitlementBlocked: boolean;
  httpStatus?: number;
  elapsedMs: number;
  endpointHost?: string;
  /** The supplier's own code — uAPI 1201, ERR.2SG.SEC.NOT_AUTHORIZED, etc. */
  code?: string;
  /** The supplier's own message, untouched. */
  supplierMessage?: string;
  /** What a human should do about it. */
  diagnosis: string;
  /** PNR / record locator, when one is actually created. */
  locator?: string;
  ticketNumbers?: string[];
  /** Trimmed raw answer, for the screen and for a support ticket. */
  raw?: string;
};

const TP_TIMEOUT = Number(process.env.GDS_TIMEOUT_MS || 20000);
const SB_TIMEOUT = Number(process.env.SABRE_TIMEOUT_MS || 20000);

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

const clip = (s: string, n = 1800) => (s.length > n ? `${s.slice(0, n)}\n… ${s.length - n} more characters` : s);

/* ------------------------------------------------------------------ status */

export type TicketingStatus = {
  supplier: Supplier;
  configured: boolean;
  missing: string[];
  pcc: string | null;
  /** Production credentials, as opposed to the certification sandbox. */
  production: boolean;
};

export function ticketingStatus(): TicketingStatus[] {
  const tp = searchConfigStatus();
  const sb = sabreStatus();
  return [
    {
      supplier: 'travelport',
      configured: tp.configured,
      missing: tp.missing,
      pcc: process.env.GDS_PCC ?? null,
      production: process.env.GDS_IS_PRODUCTION === '1'
    },
    {
      supplier: 'sabre',
      configured: sb.configured,
      missing: sb.missing,
      pcc: sb.pcc,
      production: sb.production
    }
  ];
}

/* --------------------------------------------------------------- diagnosis */

/**
 * Turn a supplier refusal into something a person can act on.
 *
 * The two entitlement errors are named explicitly because they are the ones
 * standing between this platform and a live ticket, and because "1201" on its
 * own tells nobody anything. Everything else is reported as-is rather than
 * guessed at — a wrong diagnosis is worse than none.
 */
/**
 * Sabre says "not entitled" in several different vocabularies depending on which
 * service refused. All of them mean the same thing to whoever has to send the
 * email, so all of them are recognised.
 */
const SABRE_ENTITLEMENT_MARKERS = [
  'ERR.2SG.SEC.NOT_AUTHORIZED',
  'UNAUTHORIZED_ACCESS',
  'no access privileges',
  'authorization failure',
  'authorization failed'
];

function diagnose(supplier: Supplier, code: string | undefined, message: string | undefined, httpStatus?: number): {
  entitlementBlocked: boolean;
  diagnosis: string;
} {
  const pccTp = process.env.GDS_PCC ?? '3BX8';
  const branchTp = process.env.GDS_BRANCH ?? 'P7251392';
  const pccSb = process.env.SABRE_PCC ?? 'S00L';
  const text = `${code ?? ''} ${message ?? ''}`.toUpperCase();

  /**
   * Travelport states the booking block two ways depending on how far the
   * request gets.
   *
   *   1201  the service is not routable for this account at all
   *   8236  it routed, parsed and validated, and then: "no provider/supplier
   *         is configured for this user for the requested transaction"
   *
   * 8236 is the more useful of the two because it can only be reached by a
   * request that is otherwise correct — it is proof the payload is right and
   * the entitlement is not.
   */
  if (
    supplier === 'travelport' &&
    (code === '1201' || code === '8236' || text.includes('NOT ROUTABLE') || text.includes('NO PROVIDER/SUPPLIER IS CONFIGURED'))
  ) {
    return {
      entitlementBlocked: true,
      diagnosis:
        `Travelport uAPI ${code ?? 'entitlement error'} — the request reached the booking service, parsed and ` +
        `validated, and was then refused because no provider is configured for this account to book with. ` +
        `Travelport must enable a booking provider for PCC ${pccTp} on branch ${branchTp}. No change to this code ` +
        `will get past it.`
    };
  }

  /**
   * Sabre words the same refusal several ways depending on which internal
   * service turned it down, and `createBooking` refuses inside an HTTP 200. The
   * marker list is what stops one of those phrasings being read as a success.
   */
  if (
    supplier === 'sabre' &&
    (SABRE_ENTITLEMENT_MARKERS.some((mk) => text.includes(mk.toUpperCase())) || httpStatus === 403)
  ) {
    // createBooking orchestrates PassengerDetailsRQ, and that is the service
    // name Sabre's own answer gives — so it is the one to quote to them. "Booking
    // does not work" is not something an account manager can act on.
    const service = text.includes('PASSENGERDETAILSRQ') ? 'PassengerDetailsRQ' : null;
    return {
      entitlementBlocked: true,
      diagnosis:
        `Sabre refused on entitlement${service ? ` — the service it named is ${service}` : ''}. The credentials ` +
        `authenticate and search works on them all day, so this is not authentication. Sabre must enable, on PCC ` +
        `${pccSb}: ${service ?? 'PassengerDetailsRQ'} (which /v1/trip/orders/createBooking calls internally), and ` +
        `/v1.3.0/air/ticket for issue. Both of those paths EXIST on this host — they answer 403, not 404 — so the ` +
        `integration is correct and only the account has to change.`
    };
  }

  if (httpStatus === 401) {
    return {
      entitlementBlocked: false,
      diagnosis:
        supplier === 'travelport'
          ? `HTTP 401. Check the username carries the "Universal API/" prefix — without it Travelport returns 401 ` +
            `with SOAP faultcode 76 even though the password is right.`
          : `HTTP 401. Sabre's token request is DOUBLE base64: base64(base64(user):base64(pass)). A single encoding ` +
            `authenticates nothing.`
    };
  }

  /**
   * 1005 is our document, never their entitlement.
   *
   * The first version of this integration sent AuthorizedBy="OTA Platform" and
   * got 1005 back; the fault text underneath said "AuthorizedBy field may only
   * contain letters and numbers". Read as a refusal it would have looked like
   * the booking block, and somebody would have emailed Travelport about a space
   * in a string. The raw answer is kept on the result for exactly this reason.
   */
  if (code === '1005' || (message ?? '').toLowerCase().includes('unable to parse xml')) {
    return {
      entitlementBlocked: false,
      diagnosis:
        `Travelport uAPI 1005 — the endpoint is reachable and answering, but it could not map our request. This is ` +
        `our payload, not their entitlement. Read the raw fault below: it names the offending field. Do NOT report ` +
        `this as the booking block.`
    };
  }

  if (httpStatus === 404) {
    return {
      entitlementBlocked: false,
      diagnosis:
        `HTTP 404 — that endpoint path does not exist on this host. This is a configuration mistake on our side, ` +
        `not a refusal by ${supplier}. Check GDS_BOOK_PATH / GDS_TICKET_PATH against the paths that search already ` +
        `uses successfully.`
    };
  }

  if (!code && !message) {
    return { entitlementBlocked: false, diagnosis: `No usable answer from ${supplier}${httpStatus ? ` (HTTP ${httpStatus})` : ''}.` };
  }

  return {
    entitlementBlocked: false,
    diagnosis: `${supplier} refused: ${code ?? ''} ${message ?? ''}`.trim() + '. Reported verbatim — not interpreted.'
  };
}

/* -------------------------------------------------------------- Travelport */

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)<`, 'i').exec(xml);
  return m ? m[1].trim() : undefined;
};

const attr = (xml: string, el: string, a: string): string | undefined => {
  const m = new RegExp(`<(?:\\w+:)?${el}\\b[^>]*\\b${a}="([^"]*)"`, 'i').exec(xml);
  return m ? m[1] : undefined;
};

/**
 * uAPI SOAP envelope.
 *
 * Written by hand rather than through a generated client because the whole
 * Travelport surface used here is three calls, and a code generator would add
 * a build step and a schema to keep current for no gain.
 */
function tpEnvelope(inner: string, service: string): string {
  const target = process.env.GDS_TARGET_BRANCH ?? process.env.GDS_BRANCH ?? '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:univ="http://www.travelport.com/schema/universal_v52_0"
  xmlns:com="http://www.travelport.com/schema/common_v52_0"
  xmlns:air="http://www.travelport.com/schema/air_v52_0">
  <soap:Header/>
  <soap:Body>
    ${inner.replace('{TARGET}', xmlEscape(target)).replace('{SERVICE}', service)}
  </soap:Body>
</soap:Envelope>`;
}

async function travelportCall(action: TicketAction, path: string, body: string): Promise<TicketResult> {
  const base = (process.env.GDS_BASE_URL ?? '').replace(/\/+$/, '');
  const url = `${base}${path}`;
  const started = Date.now();
  const auth = Buffer.from(`${process.env.GDS_USERNAME}:${process.env.GDS_PASSWORD}`).toString('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TP_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'text/xml; charset=utf-8',
        accept: 'text/xml',
        soapaction: ''
      },
      body,
      signal: controller.signal
    });
    const text = await res.text();
    const elapsedMs = Date.now() - started;

    // uAPI puts the useful code in ErrorInfo, and the transport fault beside it
    const code = tag(text, 'Code') ?? tag(text, 'faultcode');
    const message = tag(text, 'Description') ?? tag(text, 'faultstring') ?? tag(text, 'Message');
    const locator = attr(text, 'UniversalRecord', 'LocatorCode') ?? attr(text, 'AirReservation', 'LocatorCode');
    const ticketNumbers = [...text.matchAll(/TicketNumber="([^"]+)"/gi)].map((m) => m[1]);
    const ok = res.ok && !code && Boolean(locator || ticketNumbers.length || action === 'void');

    const d = diagnose('travelport', code, message, res.status);
    return {
      supplier: 'travelport', action, ok,
      entitlementBlocked: d.entitlementBlocked,
      httpStatus: res.status, elapsedMs, endpointHost: hostOf(url),
      code, supplierMessage: message,
      diagnosis: ok ? `Travelport accepted the ${action.replace('_', ' ')}.` : d.diagnosis,
      locator, ticketNumbers: ticketNumbers.length ? ticketNumbers : undefined,
      raw: clip(text)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      supplier: 'travelport', action, ok: false, entitlementBlocked: false,
      elapsedMs: Date.now() - started, endpointHost: hostOf(url),
      supplierMessage: message,
      diagnosis: `Could not reach Travelport: ${message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

function tpPassenger(p: Passenger, i: number): string {
  return `<com:BookingTraveler Key="T${i + 1}" TravelerType="ADT" DOB="${xmlEscape(p.dob)}" Nationality="${xmlEscape(p.nationality)}">
        <com:BookingTravelerName Prefix="${xmlEscape(p.title)}" First="${xmlEscape(p.firstName)}" Last="${xmlEscape(p.lastName)}"/>
        ${p.passport ? `<com:SSR Type="DOCS" Status="HK" FreeText="P/${xmlEscape(p.nationality)}/${xmlEscape(p.passport)}"/>` : ''}
      </com:BookingTraveler>`;
}

async function travelportCreatePnr(b: Booking): Promise<TicketResult> {
  const segments = b.itinerary
    .map(
      (s, i) => `<air:AirSegment Key="S${i + 1}" Group="0" Carrier="${xmlEscape(s.carrier)}" FlightNumber="${xmlEscape(s.flightNumber)}"
          Origin="${xmlEscape(s.origin)}" Destination="${xmlEscape(s.destination)}"
          DepartureTime="${xmlEscape(s.departure)}" ArrivalTime="${xmlEscape(s.arrival)}"
          ClassOfService="${xmlEscape(b.fare.bookingCode || 'Y')}"/>`
    )
    .join('\n        ');

  const inner = `<univ:AirCreateReservationReq TargetBranch="{TARGET}" AuthorizedBy="OTAPlatform" RetainReservation="Both">
      <com:BillingPointOfSaleInfo OriginApplication="uAPI"/>
      ${b.passengers.map(tpPassenger).join('\n      ')}
      <air:AirPricingSolution Key="P1">
        ${segments}
      </air:AirPricingSolution>
      <com:ActionStatus Type="TAW" TicketDate="${new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)}"/>
    </univ:AirCreateReservationReq>`;

  /**
   * AirCreateReservationReq goes to AirService, not UniversalRecordService.
   *
   * Both hosts answer, which is what made this worth checking rather than
   * assuming: UniversalRecordService returns a Tomcat 404 page for this
   * document, while AirService parses it and validates it properly — the first
   * useful answer from it was 7228 "Action status is required", which is a
   * business rule, not a routing failure. UniversalRecordService is for
   * retrieving and cancelling an existing record.
   */
  return travelportCall(
    'create_pnr',
    process.env.GDS_BOOK_PATH ?? process.env.GDS_SEARCH_PATH ?? '/B2BGateway/connect/uAPI/AirService',
    tpEnvelope(inner, 'AirCreateReservation')
  );
}

async function travelportIssue(locator: string): Promise<TicketResult> {
  const inner = `<air:AirTicketingReq TargetBranch="{TARGET}" AuthorizedBy="OTAPlatform">
      <com:BillingPointOfSaleInfo OriginApplication="uAPI"/>
      <air:AirReservationLocatorCode>${xmlEscape(locator)}</air:AirReservationLocatorCode>
    </air:AirTicketingReq>`;
  return travelportCall(
    'issue',
    process.env.GDS_TICKET_PATH ?? process.env.GDS_SEARCH_PATH ?? '/B2BGateway/connect/uAPI/AirService',
    tpEnvelope(inner, 'AirTicketing')
  );
}

async function travelportVoidOrRefund(action: 'void' | 'refund', ticketNumber: string): Promise<TicketResult> {
  const inner =
    action === 'void'
      ? `<air:VoidDocumentReq TargetBranch="{TARGET}" AuthorizedBy="OTAPlatform">
      <com:BillingPointOfSaleInfo OriginApplication="uAPI"/>
      <air:AirTicketingSpecificDocument Number="${xmlEscape(ticketNumber)}"/>
    </air:VoidDocumentReq>`
      : `<air:AirRefundReq TargetBranch="{TARGET}" AuthorizedBy="OTA Platform">
      <com:BillingPointOfSaleInfo OriginApplication="uAPI"/>
      <air:AirRefundTicket Number="${xmlEscape(ticketNumber)}"/>
    </air:AirRefundReq>`;
  return travelportCall(
    action,
    process.env.GDS_TICKET_PATH ?? process.env.GDS_SEARCH_PATH ?? '/B2BGateway/connect/uAPI/AirService',
    tpEnvelope(inner, action === 'void' ? 'VoidDocument' : 'AirRefund')
  );
}

/* -------------------------------------------------------------------- Sabre */

/**
 * Sabre's token, from the one implementation that already works.
 *
 * This function first grew its own copy of the auth handshake, invented the
 * variable names SABRE_CLIENT_ID and SABRE_CLIENT_SECRET — which do not exist
 * — and 401'd on credentials that search uses successfully all day. Two copies
 * of an auth routine means one of them is wrong and you find out at the worst
 * moment. lib/sabre.ts owns it, including the double-base64 header and the
 * shared token cache.
 */
async function sabreToken(): Promise<{ ok: true; token: string } | { ok: false; status?: number; message: string }> {
  const base = (process.env.SABRE_BASE_URL ?? '').replace(/\/+$/, '');
  const r = await getToken(base, process.env.SABRE_USER_ID ?? '', process.env.SABRE_PASSWORD ?? '', SB_TIMEOUT);
  if (r.ok) return { ok: true, token: r.token };
  const body = r.body as { error_description?: string; error?: string } | undefined;
  return {
    ok: false,
    status: r.status,
    message: body?.error_description ?? body?.error ?? r.error ?? `token request returned HTTP ${r.status}`
  };
}

/**
 * Sabre's certification gateway intermittently answers 404 on a path that
 * exists, then 403 with the real entitlement error three seconds later. A path
 * does not stop existing between two calls, so a lone 404 is treated as
 * transport noise and retried once rather than being reported as "we have the
 * URL wrong" — which is what the 404 diagnosis would otherwise say, and it
 * would send somebody looking for a bug that is not there.
 *
 * One retry, not a loop: if it 404s twice the path really is suspect.
 */
async function sabreCall(action: TicketAction, path: string, payload: unknown): Promise<TicketResult> {
  const first = await sabreCallOnce(action, path, payload);
  if (first.httpStatus === 404 || (first.httpStatus ?? 0) >= 500) {
    await new Promise((r) => setTimeout(r, 800));
    const second = await sabreCallOnce(action, path, payload);
    if (second.httpStatus !== first.httpStatus || second.entitlementBlocked) return second;
    return {
      ...second,
      diagnosis: `${second.diagnosis} Retried once and got the same answer, so this is not transient.`
    };
  }
  return first;
}

async function sabreCallOnce(action: TicketAction, path: string, payload: unknown): Promise<TicketResult> {
  const base = (process.env.SABRE_BASE_URL ?? '').replace(/\/+$/, '');
  const url = `${base}${path}`;
  const started = Date.now();

  const tok = await sabreToken();
  if (!tok.ok) {
    const d = diagnose('sabre', undefined, tok.message, tok.status);
    return {
      supplier: 'sabre', action, ok: false, entitlementBlocked: d.entitlementBlocked,
      httpStatus: tok.status, elapsedMs: Date.now() - started, endpointHost: hostOf(url),
      supplierMessage: tok.message, diagnosis: d.diagnosis
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SB_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Sabre returns HTML on some gateway errors; the raw text is still useful
    }

    /**
     * SABRE RETURNS HTTP 200 WITH THE ERRORS INSIDE THE BODY.
     *
     * Offers and Orders answers 200 and puts the problem in an `errors` array
     * whose entries are shaped { category, type, description, fieldName } — not
     * { code, message }, which is what the older services use and what this
     * code read. `code` therefore came back undefined, `ok = res.ok && !code`
     * evaluated to TRUE, and a request Sabre had refused outright was reported
     * as "Sabre accepted the create pnr" with the verdict "ticketing entitlement
     * has been granted".
     *
     * That is the worst failure this file could have: a platform telling an
     * agency a booking exists when the supplier said no. Both error shapes are
     * read now, and a booking is only ok when the body carries no errors AND a
     * confirmation actually came back.
     */
    const errs = (json.errors ?? json.Errors) as
      | { code?: string; message?: string; category?: string; type?: string; description?: string; fieldName?: string }[]
      | undefined;
    const firstErr = errs?.[0];

    const code =
      (firstErr?.code as string | undefined) ??
      (firstErr?.type as string | undefined) ??
      (firstErr?.category as string | undefined) ??
      (json.errorCode as string | undefined) ??
      ((json.status === 'NotProcessed' ? 'NotProcessed' : undefined) as string | undefined);

    const message =
      (firstErr?.message as string | undefined) ??
      (firstErr?.description as string | undefined) ??
      (json.message as string | undefined) ??
      (json.error_description as string | undefined);

    const locator =
      ((json.confirmationId ?? json.ConfirmationID) as string | undefined) ??
      ((json.booking as Record<string, unknown>)?.confirmationId as string | undefined) ??
      (((json.CreatePassengerNameRecordRS as Record<string, unknown>)?.ItineraryRef as Record<string, unknown>)?.ID as string | undefined);
    const ticketNumbers = [...text.matchAll(/"ticketNumber"\s*:\s*"([^"]+)"/gi)].map((m) => m[1]);

    /**
     * A create-PNR with no confirmation id is not a success, whatever the status
     * line says. Nothing downstream may treat a booking as real without the
     * locator it would need to retrieve, change or cancel it.
     */
    const hasErrors = Array.isArray(errs) && errs.length > 0;
    const ok =
      res.ok &&
      !hasErrors &&
      !code &&
      (action === 'create_pnr' ? Boolean(locator) : true);
    const d = diagnose('sabre', code, message ?? (res.ok ? undefined : text.slice(0, 200)), res.status);

    return {
      supplier: 'sabre', action, ok,
      entitlementBlocked: d.entitlementBlocked,
      httpStatus: res.status, elapsedMs: Date.now() - started, endpointHost: hostOf(url),
      code, supplierMessage: message,
      diagnosis: ok
        ? `Sabre accepted the ${action.replace('_', ' ')}${locator ? ` — confirmation ${locator}` : ''}.`
        : hasErrors && !d.entitlementBlocked && res.ok
          ? `Sabre answered HTTP 200 and refused in the body: ${errs.map((e) => `${e.type ?? e.category ?? e.code ?? ''} ${e.description ?? e.message ?? ''}${e.fieldName ? ` (${e.fieldName})` : ''}`.trim()).slice(0, 3).join(' | ')}`
          : d.diagnosis,
      locator, ticketNumbers: ticketNumbers.length ? ticketNumbers : undefined,
      raw: clip(text)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      supplier: 'sabre', action, ok: false, entitlementBlocked: false,
      elapsedMs: Date.now() - started, endpointHost: hostOf(url),
      supplierMessage: message, diagnosis: `Could not reach Sabre: ${message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Sabre booking through Offers and Orders.
 *
 * THIS WAS POINTED AT AN ENDPOINT THAT DOES NOT EXIST.
 *
 * The previous version posted CreatePassengerNameRecordRQ to
 * `/v2.5.0/passenger/records`, which answers **404** on
 * api.cert.platform.sabre.com — the path is simply not there. `/v2.3.0` is, and
 * `/v2.4.0` and `/v2.5.0` are not. A 404 was being reported as an entitlement
 * refusal for weeks, which is a different problem with a different fix, and it
 * sent the wrong request to Sabre's support desk.
 *
 * Enumerating the host settled it: `POST /v1/trip/orders/createBooking` exists
 * and is reachable on these credentials. The payload below was built by posting
 * to it and reading the validation errors back one at a time — the API names the
 * field it wants, so guessing was never necessary:
 *
 *   destination/origin        ->  toAirportCode / fromAirportCode
 *   departureTime "22:40:00+06:00"  ->  must match ^([0-1]\d|2[0-3]):[0-5]\d$
 *   flightStatusCode          ->  required, "NN" for a new sell
 *   contactInfo.phones[]      ->  plain strings, not { number, label }
 *   agency.address            ->  requires stateProvince as well as countryCode
 *
 * With every one of those fixed the request validates and Sabre answers:
 *
 *   UNAUTHORIZED_ACCESS — The service PassengerDetailsRQ returned an
 *   authorization failure. Please verify the used credentials with your account
 *   manager.
 *
 * That is the real block, and it is worth having precisely: `createBooking`
 * orchestrates PassengerDetailsRQ internally, so PassengerDetailsRQ is the
 * service name to put in the email to Sabre. "Booking does not work" would not
 * have been actionable.
 */
async function sabreCreatePnr(b: Booking): Promise<TicketResult> {
  const pcc = process.env.SABRE_PCC ?? '';

  /** Sabre wants HH:MM. Our itinerary carries a full offset timestamp. */
  const hhmm = (iso: string) => {
    const m = /T(\d{2}:\d{2})/.exec(iso) ?? /^(\d{2}:\d{2})/.exec(iso);
    return m ? m[1] : '00:00';
  };
  const dateOf = (iso: string) => (iso.includes('T') ? iso.slice(0, 10) : iso);

  const payload = {
    flightDetails: {
      flights: b.itinerary.map((s) => ({
        flightNumber: Number(String(s.flightNumber).replace(/\D/g, '')) || 0,
        airlineCode: s.carrier,
        fromAirportCode: s.origin,
        toAirportCode: s.destination,
        departureDate: dateOf(s.departure),
        departureTime: hhmm(s.departure),
        arrivalTime: hhmm(s.arrival),
        bookingClass: b.fare.bookingCode || 'Y',
        // NN is "need, sell requested" — the status a new booking asks for.
        flightStatusCode: 'NN',
        quantity: Math.max(1, b.passengers.length)
      }))
    },
    travelers: b.passengers.map((p) => ({
      givenName: p.firstName,
      surname: p.lastName,
      passengerCode: 'ADT'
    })),
    agency: {
      address: {
        name: 'SOFTIFYBD LIMITED',
        street: '54 Gulshan Avenue, Tower of Aakash, Level 18',
        city: 'DHAKA',
        // Bangladesh has no states; Sabre validates the field's presence, not
        // its meaning, and rejects the address without it.
        stateProvince: 'BD',
        postalCode: '1212',
        countryCode: 'BD'
      }
    },
    contactInfo: {
      phones: [String(b.contact.phone || '').replace(/\D/g, '')].filter(Boolean),
      emails: [b.contact.email].filter(Boolean)
    },
    receivedFrom: 'SOFTIFYBD OTA PLATFORM',
    targetCity: pcc,
    retrieveBooking: true
  };

  return sabreCall('create_pnr', process.env.SABRE_BOOK_PATH ?? '/v1/trip/orders/createBooking', payload);
}

/**
 * Issue the ticket.
 *
 * `/v1.3.0/air/ticket` exists — it answers 403 ERR.2SG.SEC.NOT_AUTHORIZED rather
 * than 404, which is the difference between a wrong path and an unentitled one.
 * So this endpoint is correct and stays; only the account has to change.
 */
async function sabreIssue(locator: string): Promise<TicketResult> {
  const payload = {
    AirTicketRQ: {
      version: '1.3.0',
      DesignatePrinter: { Printers: { Ticket: { CountryCode: 'BD' } } },
      Itinerary: { ID: locator },
      Ticketing: [{ TicketType: 'ETR' }],
      PostProcessing: { EndTransaction: { Source: { ReceivedFrom: 'OTA PLATFORM' } } }
    }
  };
  return sabreCall('issue', process.env.SABRE_TICKET_PATH ?? '/v1.3.0/air/ticket', payload);
}

async function sabreVoidOrRefund(action: 'void' | 'refund', locator: string, ticketNumber: string): Promise<TicketResult> {
  const path =
    action === 'void'
      ? process.env.SABRE_VOID_PATH ?? '/v1.1.0/air/order/voidTicket'
      : process.env.SABRE_REFUND_PATH ?? '/v1.1.0/air/order/refundTicket';
  return sabreCall(action, path, {
    confirmationId: locator,
    ticketNumber,
    receivedFrom: 'OTA PLATFORM'
  });
}

/* -------------------------------------------------------- supplier-agnostic */

const notConfigured = (supplier: Supplier, action: TicketAction, missing: string[]): TicketResult => ({
  supplier, action, ok: false, entitlementBlocked: false, elapsedMs: 0,
  diagnosis: `${supplier} is not configured — missing ${missing.join(', ')}. Set them in .env and restart.`
});

/** Create the PNR for a held booking on whichever GDS quoted the fare. */
export async function createReservation(booking: Booking): Promise<TicketResult> {
  const status = ticketingStatus().find((s) => s.supplier === booking.supplier)!;
  if (!status.configured) return notConfigured(booking.supplier, 'create_pnr', status.missing);
  return booking.supplier === 'travelport' ? travelportCreatePnr(booking) : sabreCreatePnr(booking);
}

/** Issue the ticket against a PNR that already exists. */
export async function issueTicket(supplier: Supplier, locator: string): Promise<TicketResult> {
  const status = ticketingStatus().find((s) => s.supplier === supplier)!;
  if (!status.configured) return notConfigured(supplier, 'issue', status.missing);
  return supplier === 'travelport' ? travelportIssue(locator) : sabreIssue(locator);
}

/**
 * Void or refund an issued ticket.
 *
 * Void and refund are not interchangeable and the difference is money: a void
 * cancels a ticket before the airline reports it and costs nothing, a refund
 * runs after and carries the carrier's penalty. They are separate actions here
 * so nobody can pick the wrong one by leaving a flag at its default.
 */
export async function voidTicket(supplier: Supplier, locator: string, ticketNumber: string): Promise<TicketResult> {
  const status = ticketingStatus().find((s) => s.supplier === supplier)!;
  if (!status.configured) return notConfigured(supplier, 'void', status.missing);
  return supplier === 'travelport'
    ? travelportVoidOrRefund('void', ticketNumber)
    : sabreVoidOrRefund('void', locator, ticketNumber);
}

export async function refundTicket(supplier: Supplier, locator: string, ticketNumber: string): Promise<TicketResult> {
  const status = ticketingStatus().find((s) => s.supplier === supplier)!;
  if (!status.configured) return notConfigured(supplier, 'refund', status.missing);
  return supplier === 'travelport'
    ? travelportVoidOrRefund('refund', ticketNumber)
    : sabreVoidOrRefund('refund', locator, ticketNumber);
}

/**
 * Ask both suppliers to create a PNR from a minimal probe itinerary and report
 * what they say.
 *
 * This is the live entitlement test. It is the difference between "ticketing is
 * blocked" as a remembered claim and as something the screen just proved.
 */
export async function probeTicketing(): Promise<TicketResult[]> {
  const today = new Date();
  const depart = new Date(today.getTime() + 45 * 86400000).toISOString().slice(0, 19);
  const arrive = new Date(today.getTime() + 45 * 86400000 + 5 * 3600000).toISOString().slice(0, 19);

  const probe: Booking = {
    ref: 'PROBE',
    createdAt: today.toISOString(),
    status: 'held',
    ticketed: false,
    contact: { name: 'Entitlement probe', email: 'noreply@softifybd.com', phone: '+8809610000000' },
    passengers: [
      { title: 'MR', firstName: 'TEST', lastName: 'PROBE', dob: '1990-01-01', passport: '', nationality: 'BD' }
    ],
    itinerary: [
      {
        carrier: 'EK', flightNumber: '585', origin: 'DAC', destination: 'DXB',
        departure: depart, arrival: arrive, minutes: 300
      }
    ],
    fare: {
      currency: 'BDT', total: 0, base: 'BDT0', taxes: 'BDT0',
      cabin: 'Economy', bookingCode: 'Y', platingCarrier: 'EK', refundable: false,
      // The probe never becomes a real hold, so it carries no deadline.
      latestTicketing: ''
    },
    serviceCharge: 0,
    grandTotal: 0,
    invoiceNo: null,
    supplier: 'travelport'
  };

  const [tp, sb] = await Promise.all([
    createReservation({ ...probe, supplier: 'travelport' }),
    createReservation({ ...probe, supplier: 'sabre' })
  ]);
  return [tp, sb];
}
