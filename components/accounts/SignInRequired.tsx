/**
 * What an unauthenticated request gets instead of the book.
 *
 * Not a login form. The admin portal is the only issuer of a session and the only
 * place a password is checked, so this sends people there and comes back — a second
 * form here would mean a second password path to keep correct, and the whole point
 * of verifying rather than issuing is that there is exactly one.
 *
 * It says nothing about whether the account exists, whether the password was wrong,
 * or whether the session merely expired. The verifier returns null for every failure
 * without distinguishing them, and a screen that explained the difference would undo
 * that.
 */
export function SignInRequired({
  adminUrl,
  reason,
  next
}: {
  adminUrl: string;
  reason: 'anonymous' | 'forbidden';
  /** The path that was refused. Displayed only; already checked to be local. */
  next?: string;
}) {
  const anonymous = reason === 'anonymous';
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center px-5">
      <div className="rounded-xl2 border border-hair bg-white px-8 py-8 shadow-card">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-600">
          Softifybd · Travel Accounts
        </p>
        <h1 className="mt-3 text-[24px] font-bold leading-tight text-navy-900">
          {anonymous ? 'Sign in to open the book' : 'Your role does not include this'}
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
          {anonymous ? (
            <>
              This is the accounting module. It holds every voucher, every customer balance and the settlement
              position, so it is not readable without a session.
            </>
          ) : (
            <>
              You are signed in, but this screen needs a capability your role does not carry. Ask a Super Admin to
              change the role, or open a screen your role covers.
            </>
          )}
        </p>

        {next && (
          <p className="mt-4 rounded-lg bg-navy-50 px-3.5 py-2.5 font-mono text-[12px] text-navy-900">{next}</p>
        )}

        {anonymous && (
          <>
            <a
              href={adminUrl}
              className="mt-6 inline-block rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700"
            >
              Sign in on the admin portal ↗
            </a>
            <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
              Sign in there and come back — the session is shared. The portal is the only place a password is
              checked, which is why there is no second form here.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
