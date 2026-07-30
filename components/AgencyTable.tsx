'use client';

import { useMemo, useState } from 'react';
import type { Agency, Cluster, Segment } from '@/data/schema';
import { CRED_LABEL, SALES_MODE_LABEL, EXCLUSION_LABEL } from '@/data/schema';
import { PriorityChip, CredChip, Tag } from './ui';

type Init = { segment: string; cluster: string; priority: string; district: string; q: string };

const telHref = (p: string) => `tel:+880${p.replace(/[^0-9]/g, '').replace(/^0/, '')}`;
const waHref = (p: string) => `https://wa.me/880${p.replace(/[^0-9]/g, '').replace(/^0/, '')}`;

export default function AgencyTable({
  rows,
  clusters,
  segments,
  initial
}: {
  rows: Agency[];
  clusters: Cluster[];
  segments: Segment[];
  initial: Init;
}) {
  const [f, setF] = useState<Init>(initial);
  const [hidePlatformed, setHidePlatformed] = useState(true);
  const [sort, setSort] = useState<'priority' | 'reviews' | 'name'>('priority');

  const districts = useMemo(
    () => Array.from(new Set(clusters.map((c) => c.district))).sort(),
    [clusters]
  );

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    let out = rows.filter((a) => {
      if (hidePlatformed && a.priority === 'X') return false;
      if (f.segment && a.segment !== f.segment && a.segmentSecondary !== f.segment) return false;
      if (f.cluster && a.clusterId !== f.cluster) return false;
      if (f.priority && a.priority !== f.priority) return false;
      if (f.district && a.district !== f.district) return false;
      if (q) {
        const hay = `${a.name} ${a.address} ${a.signal} ${a.phone ?? ''} ${a.district}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const order = { A: 0, B: 1, C: 2, X: 3 } as const;
    out = [...out].sort((x, y) => {
      if (sort === 'reviews') return (y.reviewCount ?? -1) - (x.reviewCount ?? -1);
      if (sort === 'name') return x.name.localeCompare(y.name);
      return order[x.priority] - order[y.priority] || (y.reviewCount ?? 0) - (x.reviewCount ?? 0);
    });
    return out;
  }, [rows, f, hidePlatformed, sort]);

  function exportCsv() {
    const head = [
      'ID', 'Agency', 'Cluster', 'District', 'Address', 'Phone', 'Priority', 'Segment',
      'Civil Aviation', 'IATA', 'IATA No', 'Hajj', 'Sales mode', 'Has platform',
      'Rating', 'Reviews', 'Open 24/7', 'Suggested tier', 'Signal'
    ];
    const body = filtered.map((a) => [
      a.id, a.name, clusters.find((c) => c.id === a.clusterId)?.name ?? '', a.district, a.address,
      a.phone ?? '', a.priority, a.segment, CRED_LABEL[a.caabLicence], CRED_LABEL[a.iata],
      a.iataNo ?? '', CRED_LABEL[a.hajjLicence], SALES_MODE_LABEL[a.salesMode],
      a.hasOwnPlatform ? 'Yes' : 'No', a.rating ?? '', a.reviewCount ?? '',
      a.open247 ? 'Yes' : 'No', a.suggestedTier ?? '', a.signal
    ]);
    const csv = [head, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ota-targets-${filtered.length}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const sel = 'rounded border border-hair bg-white px-3 py-2 text-sm text-ink focus:border-teal-600 focus:outline-none';

  return (
    <div>
      {/* ---------------------------- filters ---------------------------- */}
      <div className="mb-4 rounded-lg border border-hair bg-white p-4 no-print">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            value={f.q}
            onChange={(e) => setF({ ...f, q: e.target.value })}
            placeholder="Search name, address, phone, signal…"
            className={`${sel} min-w-[260px] flex-1`}
          />
          <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} className={sel}>
            <option value="">All priorities</option>
            <option value="A">A — call first</option>
            <option value="B">B — wave two</option>
            <option value="C">C — qualify first</option>
            <option value="X">X — do not call</option>
          </select>
          <select value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })} className={sel}>
            <option value="">All segments</option>
            {segments.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} — {s.shortName}
              </option>
            ))}
          </select>
          <select value={f.cluster} onChange={(e) => setF({ ...f, cluster: e.target.value })} className={sel}>
            <option value="">All clusters</option>
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} className={sel}>
            <option value="">All districts</option>
            {districts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={sel}>
            <option value="priority">Sort: priority</option>
            <option value="reviews">Sort: review volume</option>
            <option value="name">Sort: name</option>
          </select>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hair pt-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={hidePlatformed}
                onChange={(e) => setHidePlatformed(e.target.checked)}
                className="h-4 w-4 accent-teal-600"
              />
              Hide agencies that already have a platform
            </label>
            <span className="text-sm text-muted">
              Showing <strong className="text-navy-900">{filtered.length}</strong> of {rows.length}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setF({ segment: '', cluster: '', priority: '', district: '', q: '' }); setHidePlatformed(true); }}
              className="rounded border border-hair px-3.5 py-2 text-sm text-muted hover:bg-panel"
            >
              Reset
            </button>
            <button onClick={exportCsv} className="rounded bg-teal-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-teal-500">
              Export {filtered.length} to CSV
            </button>
          </div>
        </div>
      </div>

      {/* ----------------------------- table ----------------------------- */}
      <div className="overflow-x-auto rounded-lg border border-hair bg-white scroll-thin">
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="sticky top-0">
            <tr className="bg-navy-900 text-left text-[11px] uppercase tracking-wider text-white">
              <th className="w-9 px-3 py-3">Pri</th>
              <th className="px-3 py-3">Agency &amp; signal</th>
              <th className="px-3 py-3">Address</th>
              <th className="px-3 py-3">Contact</th>
              <th className="px-3 py-3">Credentials</th>
              <th className="px-3 py-3">Seg</th>
              <th className="px-3 py-3 text-right">Scale</th>
              <th className="px-3 py-3">Tier</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a, i) => (
              <tr key={a.id} className={`border-t border-hair align-top ${i % 2 ? 'bg-white' : 'bg-surface'}`}>
                <td className="px-3 py-3"><PriorityChip p={a.priority} /></td>

                <td className="px-3 py-3">
                  <p className="font-semibold leading-snug text-navy-900">{a.name}</p>
                  <p className="mt-1 max-w-[380px] text-xs leading-snug text-muted">{a.signal}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {a.open247 && <Tag tone="amber">24/7</Tag>}
                    {a.salesMode === 'sub_agent' && <Tag tone="teal">Sub-agent</Tag>}
                    {a.hasOwnPlatform && <Tag tone="amber">Has platform</Tag>}
                    {a.exclusionReason && <Tag tone="amber">{EXCLUSION_LABEL[a.exclusionReason]}</Tag>}
                  </div>
                </td>

                <td className="px-3 py-3">
                  <p className="max-w-[250px] text-xs leading-snug text-ink">{a.address}</p>
                  <p className="mt-1 text-[11px] font-medium text-teal-600">{a.district}</p>
                </td>

                <td className="px-3 py-3 whitespace-nowrap">
                  {a.phone ? (
                    <>
                      <a href={telHref(a.phone)} className="block font-mono text-xs font-semibold text-navy-900 hover:text-teal-600">
                        {a.phone}
                      </a>
                      <a href={waHref(a.phone)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] font-semibold text-teal-600 hover:underline">
                        WhatsApp →
                      </a>
                    </>
                  ) : (
                    <span className="text-[11px] font-medium text-amber-700">
                      Not published
                      <br />visit / Facebook
                    </span>
                  )}
                  {a.website && (
                    <a href={a.website} target="_blank" rel="noreferrer" className="mt-1 block text-[11px] text-muted hover:text-teal-600">
                      website ↗
                    </a>
                  )}
                </td>

                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <CredChip state={a.caabLicence} label={`Civil Av: ${CRED_LABEL[a.caabLicence]}`} />
                    <CredChip state={a.iata} label={`IATA: ${a.iataNo ?? CRED_LABEL[a.iata]}`} />
                    {a.hajjLicence !== 'unknown' && (
                      <CredChip state={a.hajjLicence} label={`Hajj: ${CRED_LABEL[a.hajjLicence]}`} />
                    )}
                    {a.atabNo && <CredChip state={a.atab} label={`ATAB ${a.atabNo}`} />}
                  </div>
                </td>

                <td className="px-3 py-3">
                  <span className="rounded bg-navy-900 px-1.5 py-0.5 text-[10px] font-bold text-white">{a.segment}</span>
                  {a.segmentSecondary && (
                    <span className="ml-1 rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {a.segmentSecondary}
                    </span>
                  )}
                </td>

                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <p className="font-bold tabular-nums text-navy-900">{a.reviewCount ?? '—'}</p>
                  <p className="text-[11px] text-muted">{a.rating ? `${a.rating}★` : 'no rating'}</p>
                </td>

                <td className="px-3 py-3">
                  {a.suggestedTier ? <Tag tone="teal">{a.suggestedTier}</Tag> : <span className="text-xs text-muted">qualify</span>}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-14 text-center text-sm text-muted">
                  No agencies match these filters. Try Reset.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
