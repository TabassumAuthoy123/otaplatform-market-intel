import Link from 'next/link';
import { CALL_STATUS } from '@/lib/crm';
import { CREDENTIAL_LABEL, ENGINE_LABEL, credentialsOf, engineOf, getMarket, type Credential, type EngineState } from '@/lib/market';

// Runs off content/crm-leads.json — the 400 researched prospects.
export const dynamic = 'force-dynamic';

const CRED_KEYS: Credential[] = ['iata', 'hajj', 'baira', 'toab', 'none'];
const ENGINE_KEYS: EngineState[] = ['none_seen', 'brochure', 'not_checked', 'live_engine'];

const tel = (s: string) => {
  const m = String(s).match(/[\d][\d\s\-+]{5,}/);
  return m ? m[0].replace(/[^\d+]/g, '') : null;
};
const wa = (s: string) => {
  const m = String(s).match(/01\d[\d\s-]{7,}/);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  return d.length >= 11 ? `88${d.slice(0, 11)}` : null;
};

export default async function AgenciesPage({
  searchParams
}: {
  searchParams: {
    q?: string; credential?: string; engine?: string; city?: string;
    priority?: string; tier?: string; hasMobile?: string; page?: string;
  };
}) {
  const m = await getMarket();
  let rows = m.leads;

  const term = (searchParams.q ?? '').trim().toLowerCase();
  if (term) {
    rows = rows.filter((l) =>
      [l.company, l.decision_maker, l.phone, l.mobile, l.email, l.address, l.lead_id, l.segment]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(term)));
  }
  if (searchParams.credential) rows = rows.filter((l) => credentialsOf(l).includes(searchParams.credential as Credential));
  if (searchParams.engine) rows = rows.filter((l) => engineOf(l) === searchParams.engine);
  if (searchParams.city) rows = rows.filter((l) => l.city === searchParams.city);
  if (searchParams.priority) rows = rows.filter((l) => l.priority === searchParams.priority);
  if (searchParams.tier) rows = rows.filter((l) => l.tier === searchParams.tier);
  if (searchParams.hasMobile === 'yes') rows = rows.filter((l) => !!l.mobile);

  const PER = 50;
  const page = Math.max(1, Number(searchParams.page) || 1);
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const slice = rows.slice((page - 1) * PER, page * PER);

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...searchParams, ...over })) if (v) p.set(k, String(v));
    return p.toString();
  };
  const exportQs = qs({ page: undefined });

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
      active ? 'bg-teal-600 text-white' : 'bg-white text-navy-900 border border-hair hover:border-teal-500'
    }`;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-teal-600">Target customer database</div>
        <h1 className="text-[24px] font-bold text-navy-900 sm:text-[28px]">
          {rows.length} of {m.leads.length} agencies
        </h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-muted">
          Name, address, decision maker, phone, email and website for cold calling. Click a number to dial.
          Contact details are printed exactly as the source register published them — legacy landlines and all.
        </p>
      </div>

      {/* ------------------------------------------------------- quick filters */}
      <div className="space-y-3 rounded-xl2 border border-hair bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Credential</span>
          <Link href="/agencies" className={chip(!searchParams.credential)}>All</Link>
          {CRED_KEYS.map((c) => (
            <Link key={c} href={`/agencies?${qs({ credential: c, page: undefined })}`} className={chip(searchParams.credential === c)}>
              {CREDENTIAL_LABEL[c]} ({m.byCredential.find((x) => x.key === c)?.count ?? 0})
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Their website</span>
          {ENGINE_KEYS.map((e) => (
            <Link key={e} href={`/agencies?${qs({ engine: e, page: undefined })}`} className={chip(searchParams.engine === e)}>
              {ENGINE_LABEL[e]} ({m.byEngine.find((x) => x.key === e)?.count ?? 0})
            </Link>
          ))}
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Search</span>
          <input name="q" defaultValue={searchParams.q ?? ''} placeholder="company, owner, phone, email, address"
            className="w-72 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">City</span>
          <select name="city" defaultValue={searchParams.city ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All cities</option>
            {m.byCity.map((c) => <option key={c.city} value={c.city}>{c.city} ({c.count})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Priority</span>
          <select name="priority" defaultValue={searchParams.priority ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All</option>
            {m.byPriority.map((p) => <option key={p.priority} value={p.priority}>{p.priority} ({p.count})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Dialable</span>
          <select name="hasMobile" defaultValue={searchParams.hasMobile ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">Any</option>
            <option value="yes">Has a mobile</option>
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Filter</button>
        <a href="/agencies" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Reset</a>
      </form>

      <div className="flex flex-wrap items-center gap-2 rounded-xl2 border border-hair bg-white p-4">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Download this list</span>
        {(['xlsx', 'docx', 'md', 'csv'] as const).map((f) => (
          <a key={f} href={`/api/crm/export?${exportQs}&format=${f}`}
            className="rounded-lg border border-hair px-4 py-2 text-[13px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700">
            {f === 'xlsx' ? 'Excel .xlsx' : f === 'docx' ? 'Word .docx' : f === 'md' ? 'Markdown .md' : 'CSV'}
          </a>
        ))}
        <span className="text-[12px] text-muted">Exports honour every filter above</span>
      </div>

      {/* ------------------------------------------------------------- table */}
      <div className="overflow-x-auto rounded-xl2 border border-hair bg-white">
        <table className="w-full min-w-[1050px] text-left">
          <thead>
            <tr className="border-b border-hair bg-navy-900 text-white">
              {['Agency', 'Decision maker', 'Address', 'Call', 'Email / web', 'Credentials', 'Their site', 'Status'].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 && (
              <tr><td colSpan={8} className="px-5 py-10 text-center text-[13px] text-muted">Nothing matches that filter.</td></tr>
            )}
            {slice.map((l, i) => {
              const t = tel(l.mobile || l.phone || '');
              const w = wa(l.mobile || l.phone || '');
              const creds = credentialsOf(l);
              return (
                <tr key={l.lead_id} className={i % 2 === 1 ? 'bg-surface' : ''}>
                  <td className="border-b border-hair px-4 py-3 align-top">
                    <div className="text-[13.5px] font-semibold text-navy-900">{l.company}</div>
                    <div className="tnum mt-0.5 text-[11px] text-muted">{l.lead_id} · {l.priority}</div>
                    <div className="mt-1 text-[11.5px] leading-snug text-muted">{l.segment}</div>
                  </td>
                  <td className="border-b border-hair px-4 py-3 align-top text-[12.5px]">{l.decision_maker || '—'}</td>
                  <td className="border-b border-hair px-4 py-3 align-top text-[12px] leading-snug text-muted">
                    {l.address || '—'}
                    {l.city && <div className="mt-0.5 font-semibold text-navy-900">{l.city}</div>}
                  </td>
                  <td className="border-b border-hair px-4 py-3 align-top">
                    {t ? (
                      <a href={`tel:${t}`} className="tnum block text-[12.5px] font-semibold text-teal-700 hover:underline">{l.mobile || l.phone}</a>
                    ) : (
                      <span className="text-[12px] text-muted">no number</span>
                    )}
                    {w && <a href={`https://wa.me/${w}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11.5px] text-muted hover:text-teal-700">WhatsApp →</a>}
                  </td>
                  <td className="border-b border-hair px-4 py-3 align-top text-[12px]">
                    {l.email ? <a href={`mailto:${l.email}`} className="block break-all text-teal-700 hover:underline">{l.email}</a> : <span className="text-muted">—</span>}
                    {l.website && (
                      <a href={/^https?:/.test(l.website) ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer" className="mt-1 block break-all text-muted hover:text-teal-700">{l.website}</a>
                    )}
                    {l.facebook && (
                      <a href={l.facebook} target="_blank" rel="noreferrer" className="mt-1 block text-muted hover:text-teal-700">Facebook →</a>
                    )}
                  </td>
                  <td className="border-b border-hair px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-1">
                      {creds.map((c) => (
                        <span key={c} className={`chip ${c === 'iata' ? 'border-teal-600/30 bg-teal-600/10 text-teal-700' : c === 'none' ? 'border-hair bg-panel text-muted' : 'border-navy-900/15 bg-navy-900/5 text-navy-900'}`}>
                          {c === 'none' ? 'not printed' : c}
                        </span>
                      ))}
                    </div>
                    {l.licence_ref && <div className="mt-1 text-[11px] leading-snug text-muted">{l.licence_ref}</div>}
                  </td>
                  <td className="border-b border-hair px-4 py-3 align-top text-[11.5px] leading-snug">
                    {l.booking_engine || <span className="text-muted">not checked</span>}
                  </td>
                  <td className="border-b border-hair px-4 py-3 align-top">
                    <span className="chip border-hair bg-panel text-muted">{CALL_STATUS[l.call_status] ?? l.call_status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] text-muted">Showing {slice.length} of {rows.length} · page {page} of {pages}</span>
        {page > 1 && <Link href={`/agencies?${qs({ page: page - 1 })}`} className="rounded-lg border border-hair bg-white px-4 py-2 text-[13px] font-semibold text-navy-900">← Prev</Link>}
        {page < pages && <Link href={`/agencies?${qs({ page: page + 1 })}`} className="rounded-lg border border-hair bg-white px-4 py-2 text-[13px] font-semibold text-navy-900">Next →</Link>}
      </div>

      <div className="rounded-xl2 border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink">
          <strong>This is a prospecting universe, not a licence register.</strong> A credential chip means the source
          directory printed that number, nothing more. TAMS at regtravelagency.gov.bd is the only definitive check —
          run it before you contract with anyone. Call Sunday–Thursday, 11:00–13:00 and 15:00–17:00; almost all of
          these close Friday.
        </p>
      </div>
    </div>
  );
}
