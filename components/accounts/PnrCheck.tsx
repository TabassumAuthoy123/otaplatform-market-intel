'use client';

import { useState } from 'react';

type LocalHit = {
  invoiceNo: string; date: string; customer: string; status: string;
  invoiceTotal: number; paid: number; due: number; grossProfit: number;
  lines: { description: string; pax: number; sale: number; supplierCost: number; margin: number; supplier: string }[];
};

type Result = {
  ok: boolean;
  locator?: string;
  local?: LocalHit[];
  live?: {
    configured: boolean;
    missing?: string[];
    message?: string;
    attempted?: boolean;
    upstreamStatus?: number;
    upstreamOk?: boolean;
    elapsedMs?: number;
    endpointHost?: string;
    data?: unknown;
    error?: string;
  };
  error?: string;
};

const bdt = (n: number) => '৳' + Math.round(n).toLocaleString('en-IN');

export function PnrCheck({ samplePnrs }: { samplePnrs: string[] }) {
  const [locator, setLocator] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [res, setRes] = useState<Result | null>(null);

  async function run(value?: string) {
    const l = (value ?? locator).trim().toUpperCase();
    if (!l) return;
    setLocator(l);
    setState('loading');
    try {
      const r = await fetch(`/api/gds/pnr?locator=${encodeURIComponent(l)}`, { cache: 'no-store' });
      setRes(await r.json());
    } catch {
      setRes({ ok: false, error: 'Could not reach the app itself — is the dev server still running?' });
    }
    setState('done');
  }

  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4"
      >
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Record locator (PNR)</span>
          <input
            value={locator}
            onChange={(e) => setLocator(e.target.value.toUpperCase())}
            placeholder="e.g. 4ABE15"
            maxLength={8}
            className="tnum w-52 rounded-lg border border-hair bg-surface px-3 py-2 text-[15px] font-semibold uppercase tracking-wider outline-none focus:border-teal-500"
          />
        </label>
        <button
          type="submit"
          disabled={state === 'loading'}
          className="rounded-lg bg-teal-600 px-6 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
        >
          {state === 'loading' ? 'Checking…' : 'Check'}
        </button>
      </form>

      {samplePnrs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">PNRs in this book:</span>
          {samplePnrs.map((p) => (
            <button
              key={p}
              onClick={() => run(p)}
              className="tnum rounded border border-hair bg-white px-2.5 py-1 text-[12px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {res?.error && (
        <div className="rounded-lg border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4 text-[13px]">{res.error}</div>
      )}

      {state === 'done' && res?.ok && (
        <div className="space-y-5">
          {/* ------------------------------------------------ our own book */}
          <section className="rounded-xl2 border border-hair bg-white">
            <header className="border-b border-hair px-5 py-3.5">
              <h2 className="text-[14px] font-bold text-navy-900">In our book</h2>
              <p className="mt-0.5 text-[12px] text-muted">From content/accounting.json — always available, no GDS needed</p>
            </header>
            {res.local && res.local.length > 0 ? (
              <div className="divide-y divide-hair">
                {res.local.map((h) => (
                  <div key={h.invoiceNo} className="p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div>
                        <span className="tnum text-[15px] font-bold text-navy-900">{h.invoiceNo}</span>
                        <span className="ml-3 text-[13px] text-ink">{h.customer}</span>
                        <span className="tnum ml-3 text-[12px] text-muted">{h.date}</span>
                      </div>
                      <span className="chip border-navy-900/20 bg-navy-900/5 text-navy-900">{h.status.replace('_', ' ')}</span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-4">
                      <Fig label="Invoice total" value={bdt(h.invoiceTotal)} />
                      <Fig label="Paid" value={bdt(h.paid)} />
                      <Fig label="Due" value={bdt(h.due)} tone={h.due > 0 ? 'warn' : 'plain'} />
                      <Fig label="Gross profit" value={bdt(h.grossProfit)} tone="good" />
                    </div>

                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full min-w-[520px] text-left text-[12.5px]">
                        <thead>
                          <tr className="border-b border-hair text-[11px] uppercase tracking-wide text-muted">
                            <th className="py-2">Line</th>
                            <th className="py-2">Supplier</th>
                            <th className="py-2 text-right">Pax</th>
                            <th className="py-2 text-right">Sale</th>
                            <th className="py-2 text-right">Cost</th>
                            <th className="py-2 text-right">Margin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {h.lines.map((l, i) => (
                            <tr key={i} className="border-b border-hair last:border-0">
                              <td className="py-2">{l.description}</td>
                              <td className="py-2 text-muted">{l.supplier}</td>
                              <td className="tnum py-2 text-right">{l.pax}</td>
                              <td className="tnum py-2 text-right">{bdt(l.sale)}</td>
                              <td className="tnum py-2 text-right text-muted">{bdt(l.supplierCost)}</td>
                              <td className="tnum py-2 text-right font-semibold text-teal-700">{bdt(l.margin)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-5 py-8 text-center text-[13px] text-muted">
                No invoice in this book carries PNR <span className="tnum font-semibold">{res.locator}</span>.
              </p>
            )}
          </section>

          {/* --------------------------------------------------- live GDS */}
          <section className="rounded-xl2 border border-hair bg-white">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hair px-5 py-3.5">
              <div>
                <h2 className="text-[14px] font-bold text-navy-900">Live GDS</h2>
                <p className="mt-0.5 text-[12px] text-muted">
                  {res.live?.configured
                    ? `${res.live.endpointHost ?? ''} · ${res.live.elapsedMs ?? 0}ms`
                    : 'Not configured'}
                </p>
              </div>
              {res.live?.configured && (
                <span
                  className={`chip ${
                    res.live.upstreamOk
                      ? 'border-teal-600/30 bg-teal-600/10 text-teal-700'
                      : 'border-amber-700/30 bg-amber-700/10 text-amber-700'
                  }`}
                >
                  {res.live.upstreamOk ? `HTTP ${res.live.upstreamStatus}` : res.live.error ? 'transport error' : `HTTP ${res.live.upstreamStatus}`}
                </span>
              )}
            </header>

            {!res.live?.configured ? (
              <div className="p-5">
                <p className="text-[13px] leading-relaxed text-ink">{res.live?.message}</p>
                {res.live?.missing && res.live.missing.length > 0 && (
                  <>
                    <p className="mt-4 text-[11px] font-bold uppercase tracking-wide text-muted">Missing environment variables</p>
                    <ul className="mt-2 space-y-1">
                      {res.live.missing.map((m) => (
                        <li key={m} className="tnum text-[13px] font-semibold text-amber-700">{m}</li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
                  Copy <code className="rounded bg-panel px-1.5 py-0.5">.env.example</code> to{' '}
                  <code className="rounded bg-panel px-1.5 py-0.5">.env</code>, fill in the GDS block, and restart the
                  app. <code className="rounded bg-panel px-1.5 py-0.5">.env</code> is gitignored — credentials must
                  never be committed.
                </p>
              </div>
            ) : res.live.error ? (
              <div className="p-5">
                <p className="text-[13px] font-semibold text-amber-700">{res.live.error}</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                  The call left this machine and failed. Usual causes: the endpoint host is wrong, your IP is not
                  whitelisted with Travelport, or the network blocks it.
                </p>
              </div>
            ) : (
              <pre className="max-h-[420px] overflow-auto bg-navy-950 p-5 text-[12px] leading-relaxed text-teal-300">
                {typeof res.live.data === 'string' ? res.live.data : JSON.stringify(res.live.data, null, 2)}
              </pre>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Fig({ label, value, tone = 'plain' }: { label: string; value: string; tone?: 'plain' | 'good' | 'warn' }) {
  const c = tone === 'good' ? 'text-teal-700' : tone === 'warn' ? 'text-amber-700' : 'text-navy-900';
  return (
    <div className="rounded-lg border border-hair bg-surface px-3.5 py-2.5">
      <div className="text-[10.5px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum mt-0.5 text-[16px] font-bold ${c}`}>{value}</div>
    </div>
  );
}
