import { SignInRequired } from '@/components/accounts/SignInRequired';

/**
 * The sign-in prompt, as a route of its own rather than something a layout renders
 * in place of the page.
 *
 * WHY IT IS A ROUTE, AND WHY THAT IS NOT A STYLE CHOICE
 *
 * The first version of the guard did `if (!who) return <SignInRequired/>` inside
 * the two group layouts. It looked right and it was not: a layout and its page
 * render in PARALLEL in the App Router, so returning something else from the layout
 * does not stop the page underneath from running. An anonymous
 * `GET /accounts/financials` still executed the financials page, and its partial
 * output was serialised into the RSC flight payload alongside the sign-in screen.
 * Measured on the running dev server, that request handed back the chart of account
 * names — `Accounts receivable`, `Retained ...`, `Trial balance - control basis` —
 * with the sign-in card rendered on top of them.
 *
 * No figures came out in that particular run, and that is the part worth being
 * uneasy about: how far the page gets before the stream is cut is a matter of
 * timing, not of the guard. A slower render, a warmer file cache or a smaller book
 * changes the answer. A leak that depends on a race is not a smaller leak, it is
 * one that passes a test.
 *
 * `redirect()` throws. That unwinds the whole render, so the response is a 307 with
 * an empty body and nothing under it ever reaches the client. The prompt therefore
 * has to live somewhere the guard can point at, which is here — outside both guarded
 * groups, so it cannot be caught by the check that sent people to it.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in — OTA Platform', robots: { index: false, follow: false } };

const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL || process.env.ADMIN_URL || 'http://localhost:4001';

export default function SignInPage({
  searchParams
}: {
  searchParams?: { reason?: string; next?: string };
}) {
  const reason = searchParams?.reason === 'forbidden' ? 'forbidden' : 'anonymous';
  /**
   * Only ever displayed, never redirected to, and only when it is a local path.
   * Reflecting an attacker-chosen absolute URL into the page would read as a link
   * to somewhere we vouch for, and there is no case where this needs to hold one.
   */
  const raw = searchParams?.next ?? '';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : undefined;
  return <SignInRequired adminUrl={ADMIN_URL} reason={reason} next={next} />;
}
