'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Demo search panel. It does not call a GDS — it hands the query to /flights,
 * which filters the sample route list. Kept deliberately obvious so nobody
 * mistakes it for live availability during the walkthrough.
 */
export function SearchWidget({ tabs, origins }: { tabs: string[]; origins: string[] }) {
  const router = useRouter();
  const [tab, setTab] = useState(tabs[0] ?? 'Flights');
  const [from, setFrom] = useState(origins[0] ?? 'Dhaka (DAC)');
  const [to, setTo] = useState('');
  const [depart, setDepart] = useState('');
  const [pax, setPax] = useState('1');

  const destinationFor: Record<string, string> = {
    Flights: '/flights',
    Hotels: '/hotels',
    'Hajj & Umrah': '/packages',
    Visa: '/visa'
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const base = destinationFor[tab] ?? '/flights';
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (depart) q.set('depart', depart);
    if (pax) q.set('pax', pax);
    router.push(`${base}?${q.toString()}`);
  }

  const isFlight = tab === 'Flights';

  return (
    <div className="rounded-xl2 bg-white p-2 shadow-lift">
      <div className="flex gap-1 overflow-x-auto px-1 pt-1">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-colors ${
              t === tab ? 'bg-navy-900 text-white' : 'text-muted hover:bg-panel hover:text-navy-900'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[1.1fr_1.1fr_1fr_0.7fr_auto]">
        <Field label={isFlight ? 'From' : 'City / country'}>
          <input
            list="origins"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="Dhaka (DAC)"
            className="w-full bg-transparent text-[14px] font-semibold text-navy-900 outline-none placeholder:font-normal placeholder:text-muted"
          />
          <datalist id="origins">
            {origins.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Field>

        <Field label={isFlight ? 'To' : 'Destination'}>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Jeddah, Dubai, Kolkata…"
            className="w-full bg-transparent text-[14px] font-semibold text-navy-900 outline-none placeholder:font-normal placeholder:text-muted"
          />
        </Field>

        <Field label={isFlight ? 'Departure' : 'Check-in'}>
          <input
            type="date"
            value={depart}
            onChange={(e) => setDepart(e.target.value)}
            className="tnum w-full bg-transparent text-[14px] font-semibold text-navy-900 outline-none"
          />
        </Field>

        <Field label="Travellers">
          <select
            value={pax}
            onChange={(e) => setPax(e.target.value)}
            className="w-full bg-transparent text-[14px] font-semibold text-navy-900 outline-none"
          >
            {['1', '2', '3', '4', '5+'].map((n) => (
              <option key={n} value={n}>
                {n} {n === '1' ? 'traveller' : 'travellers'}
              </option>
            ))}
          </select>
        </Field>

        <button
          type="submit"
          className="rounded-lg bg-teal-600 px-7 py-3.5 text-[14px] font-bold text-white transition-colors hover:bg-teal-700"
        >
          Search
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block rounded-lg border border-hair bg-surface px-3.5 py-2.5 focus-within:border-teal-500">
      <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.12em] text-muted">{label}</span>
      {children}
    </label>
  );
}
