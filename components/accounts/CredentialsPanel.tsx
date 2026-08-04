import { CREDENTIAL_GROUP_LABEL, credentialInventory, missingRequired } from '@/lib/credentials';
import type { CredentialGroup } from '@/lib/credentials';

/**
 * Every environment variable the platform reads, with enough detail to check one
 * and not enough to leak one.
 *
 * This replaces a hand-written list of seven variables that had drifted out of
 * date and omitted GDS_TARGET_BRANCH — the one whose absence made every booking
 * return uAPI 8236 and get filed as an entitlement block for weeks. A setup
 * screen that is missing a required variable is read as complete, which is worse
 * than having no screen.
 *
 * Secrets show a length and a sha256 prefix instead of a value. That is not a
 * weaker check than printing the password, it is a stronger one: hash the value
 * you think it should be and compare, and a trailing space or a smart quote — both
 * invisible on screen — shows up as a different fingerprint.
 */
const GROUPS: CredentialGroup[] = ['travelport', 'sabre', 'app', 'admin'];

export function CredentialsPanel() {
  const all = credentialInventory();
  const missing = missingRequired();

  return (
    <div className="rounded-xl2 border border-hair bg-white shadow-card">
      <div className="border-b border-hair px-5 py-4">
        <h2 className="text-[15px] font-bold text-navy-900">Credentials and environment — read from the running process</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Not a copy of <code className="rounded bg-panel px-1 py-0.5">.env</code> — this is what{' '}
          <code className="rounded bg-panel px-1 py-0.5">process.env</code> actually holds right now, so a variable you
          edited without restarting shows as it really is.
        </p>
      </div>

      <div
        className={`border-l-[3px] px-5 py-3 text-[13px] ${
          missing.length
            ? 'border-red-600 bg-red-50 text-red-700'
            : 'border-teal-600 bg-teal-600/5 text-teal-800'
        }`}
      >
        {missing.length ? (
          <>
            <strong>{missing.length} required variable(s) missing:</strong> {missing.join(', ')}. The features that
            depend on them will fail, and some fail with a supplier error code that looks like a permission problem.
          </>
        ) : (
          <>
            <strong>Every required variable is set.</strong> Passwords are never rendered here, never returned by an
            API and never logged. Compare one by hashing the value you have:{' '}
            <code className="rounded bg-white/60 px-1 py-0.5">
              printf %s &apos;your-value&apos; | sha256sum
            </code>{' '}
            — the first 12 characters should match the fingerprint below.
          </>
        )}
      </div>

      {GROUPS.map((g) => {
        const rows = all.filter((c) => c.group === g);
        if (!rows.length) return null;
        return (
          <div key={g} className="border-t border-hair">
            <p className="bg-panel px-5 py-2 text-[11px] font-bold uppercase tracking-wide text-muted">
              {CREDENTIAL_GROUP_LABEL[g]}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left">
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.name} className="border-b border-hair last:border-0 align-top">
                      <td className="px-5 py-3">
                        <span className="tnum text-[12.5px] font-semibold text-navy-900">{c.name}</span>
                        {c.required && (
                          <span className="ml-2 chip border-amber-700/30 bg-amber-700/10 text-[10px] text-amber-700">
                            required
                          </span>
                        )}
                        {c.secret && (
                          <span className="ml-2 chip border-navy-900/20 bg-panel text-[10px] text-muted">secret</span>
                        )}
                        <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-muted">{c.purpose}</p>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {c.present ? (
                          <span className="chip border-teal-600/30 bg-teal-600/10 text-[11px] text-teal-700">set</span>
                        ) : c.required ? (
                          <span className="chip border-red-600/30 bg-red-50 text-[11px] text-red-700">missing</span>
                        ) : (
                          <span className="chip border-navy-900/15 bg-panel text-[11px] text-muted">unset</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {/* Identifiers in full; secrets as length + hash; unset with its fallback. */}
                        {c.value !== undefined && (
                          <span className="tnum break-all text-[12px] text-ink">{c.value}</span>
                        )}
                        {c.fingerprint && (
                          <span className="tnum text-[12px] text-muted">
                            {c.length} chars · sha256 {c.fingerprint}
                          </span>
                        )}
                        {!c.present && c.fallback && (
                          <span className="text-[12px] text-muted">falls back to {c.fallback}</span>
                        )}
                        {!c.present && !c.fallback && !c.required && (
                          <span className="text-[12px] text-muted">not used</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="border-t border-hair bg-surface px-5 py-4 text-[12px] leading-relaxed text-muted">
        <p className="font-semibold text-navy-900">Where these live, and why not in the repository</p>
        <p className="mt-1">
          All of them are in <code className="rounded bg-panel px-1 py-0.5">.env</code> in the project root, which is
          gitignored. The GitHub repository for this project is <strong>public</strong>, so a credential committed to it
          — including into a README — is published, and stays reachable through the commit history after it is deleted.
          The Travelport password has already been exposed once that way and needs rotating.
        </p>
        <p className="mt-1">
          To rotate one: change it on the supplier&apos;s portal, then{' '}
          <code className="rounded bg-panel px-1 py-0.5">
            echo &quot;new&quot; | node scripts/rotate-gds-password.mjs travelport
          </code>
          . The script reads stdin rather than an argument so the value never enters shell history or the process list.
        </p>
      </div>
    </div>
  );
}
