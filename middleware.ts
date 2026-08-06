import { NextResponse, type NextRequest } from 'next/server';

/**
 * Gate on the data endpoints.
 *
 * WHY THIS EXISTS
 *
 * `next dev` binds 0.0.0.0 by default, and every route under /api was open.
 * On an office network that meant anyone — a colleague, a contractor, any
 * compromised phone on the same wifi — could fetch
 * `http://<laptop-ip>:3002/api/accounts/export?format=xlsx` and walk away with
 * the entire accounting book, or `/api/crm/export` and walk away with all 400
 * prospects including named decision makers and their mobile numbers. Both were
 * verified working from the LAN address before this was added.
 *
 * TWO LAYERS, because either alone is thin
 *
 * 1. The dev and start scripts now bind 127.0.0.1, which removes the network
 *    path altogether. That is the real protection.
 * 2. This middleware is what stands up when somebody deliberately exposes the
 *    app — `npm run dev:lan`, a tunnel, a reverse proxy. It refuses any request
 *    to a data route that did not arrive on a loopback Host, unless it carries
 *    the key from APP_ACCESS_KEY.
 *
 * The Host header is spoofable, so layer 2 on its own is not a security
 * boundary — it is a guard rail that turns an accidental exposure into a 401
 * instead of a silent download. Anything genuinely public needs a real
 * authenticated session, which is a different piece of work and is called out
 * in README.
 */

/** Routes that hand out data worth protecting. */
const GUARDED = ['/api/accounts', '/api/crm', '/api/agencies', '/api/gds', '/api/sabre', '/api/ticketing'];

/** Routes the storefront needs from a browser that may not be on loopback. */
const PUBLIC = ['/api/enquiry'];

const isLoopbackHost = (host: string | null) => {
  if (!host) return false;
  const name = host.split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
};

/**
 * Stamp the path onto the request so a server layout can read it.
 *
 * A layout is not given the pathname, and a layout is the only place the
 * module-enabled check can run once for sixteen pages instead of sixteen times.
 * Middleware cannot make that decision itself: it runs on the Edge runtime, and
 * the on/off state lives in `content/site.json`, which needs a filesystem. So the
 * work is split — middleware does the part that needs the request, the layout does
 * the part that needs the file. See lib/panelMenus.ts.
 *
 * Neither half is useful alone. Deleting this line does not break a build or a
 * test that looks at the nav; it silently stops every disabled route from
 * returning 404 while the links stay hidden, which is precisely the half-working
 * state this was built to avoid.
 */
function withPath(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-panel-path', req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!GUARDED.some((p) => pathname.startsWith(p))) return withPath(req);

  if (isLoopbackHost(req.headers.get('host'))) return NextResponse.next();

  const key = process.env.APP_ACCESS_KEY;
  const offered = req.headers.get('x-app-key') ?? searchParams.get('key');
  if (key && offered && offered === key) return NextResponse.next();

  return NextResponse.json(
    {
      ok: false,
      error: 'This endpoint is only served to localhost.',
      detail: key
        ? 'Pass the APP_ACCESS_KEY value as an x-app-key header or a ?key= parameter.'
        : 'Set APP_ACCESS_KEY in .env and pass it as an x-app-key header or ?key= to reach this from another machine.'
    },
    { status: 401, headers: { 'cache-control': 'no-store' } }
  );
}

/**
 * The API matcher was the whole list until the panel toggles needed a pathname on
 * page requests too. `/api/:path*` alone meant `withPath` never ran for
 * `/accounts/inventory`, the layout read a null path, and every module stayed
 * reachable however the toggles were set.
 *
 * Everything except Next's own assets and the storefront, which has its own
 * separate section and nav toggles in `site.json` and is not part of this.
 */
export const config = {
  matcher: ['/api/:path*', '/', '/accounts/:path*', '/agencies/:path*', '/competitors/:path*', '/segments/:path*']
};
