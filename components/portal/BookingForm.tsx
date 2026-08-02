'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Props = { from: string; to: string; date: string; fareSig: string; unitPrice: number; currency: string };

const blankPax = () => ({ title: 'Mr', firstName: '', lastName: '', dob: '', passport: '', nationality: 'Bangladeshi' });

export function BookingForm({ from, to, date, fareSig, unitPrice, currency }: Props) {
  const router = useRouter();
  const [passengers, setPassengers] = useState([blankPax()]);
  const [contact, setContact] = useState({ name: '', email: '', phone: '' });
  const [serviceCharge, setServiceCharge] = useState(0);
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [error, setError] = useState('');

  const total = unitPrice * passengers.length + serviceCharge;
  const set = (i: number, k: string, v: string) =>
    setPassengers((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setError('');
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, date, sig: fareSig, contact, passengers, serviceCharge })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Could not take that booking.');
        setState('error');
        return;
      }
      router.push(`/portal/booking?ref=${encodeURIComponent(json.ref)}`);
    } catch {
      setError('Network error — is the app still running?');
      setState('error');
    }
  }

  const field = (label: string, node: React.ReactNode) => (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.1em] text-muted">{label}</span>
      {node}
    </label>
  );
  const cls =
    'w-full rounded-lg border border-hair bg-surface px-3.5 py-2.5 text-[14px] text-navy-900 outline-none focus:border-teal-500';

  return (
    <form onSubmit={submit} className="space-y-5">
      {passengers.map((p, i) => (
        <div key={i} className="rounded-xl2 border border-hair bg-white p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-[15px] font-bold text-navy-900">Passenger {i + 1}</h3>
            {passengers.length > 1 && (
              <button type="button" onClick={() => setPassengers((x) => x.filter((_, j) => j !== i))}
                className="text-[12.5px] font-semibold text-amber-700 hover:underline">Remove</button>
            )}
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {field('Title', (
              <select value={p.title} onChange={(e) => set(i, 'title', e.target.value)} className={cls}>
                {['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss'].map((t) => <option key={t}>{t}</option>)}
              </select>
            ))}
            {field('Given name — as in passport', <input required value={p.firstName} onChange={(e) => set(i, 'firstName', e.target.value)} className={cls} />)}
            {field('Surname', <input required value={p.lastName} onChange={(e) => set(i, 'lastName', e.target.value)} className={cls} />)}
            {field('Date of birth', <input type="date" value={p.dob} onChange={(e) => set(i, 'dob', e.target.value)} className={`tnum ${cls}`} />)}
            {field('Passport number', <input value={p.passport} onChange={(e) => set(i, 'passport', e.target.value)} className={`tnum ${cls}`} />)}
            {field('Nationality', <input value={p.nationality} onChange={(e) => set(i, 'nationality', e.target.value)} className={cls} />)}
          </div>
        </div>
      ))}

      <button type="button" onClick={() => setPassengers((p) => [...p, blankPax()])}
        className="rounded-lg border border-dashed border-hair bg-white px-5 py-2.5 text-[13px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700">
        + Add another passenger
      </button>

      <div className="rounded-xl2 border border-hair bg-white p-5">
        <h3 className="mb-4 text-[15px] font-bold text-navy-900">Contact for this booking</h3>
        <div className="grid gap-3.5 sm:grid-cols-3">
          {field('Name', <input required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} className={cls} />)}
          {field('Mobile', <input required value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="01XXXXXXXXX" className={cls} />)}
          {field('Email', <input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} className={cls} />)}
        </div>
      </div>

      <div className="rounded-xl2 border border-hair bg-white p-5">
        <h3 className="mb-1 text-[15px] font-bold text-navy-900">Agency service charge</h3>
        <p className="mb-4 text-[12.5px] text-muted">Your markup on top of the airline fare. It flows straight into the margin report.</p>
        <div className="max-w-[220px]">
          <input type="number" min={0} step={100} value={serviceCharge}
            onChange={(e) => setServiceCharge(Math.max(0, Number(e.target.value) || 0))} className={`tnum ${cls}`} />
        </div>
      </div>

      <div className="rounded-xl2 border border-hair bg-panel p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Total for {passengers.length} passenger{passengers.length > 1 ? 's' : ''}</div>
            <div className="tnum mt-1 text-[26px] font-bold text-navy-900">{currency} {total.toLocaleString('en-IN')}</div>
            <div className="tnum mt-0.5 text-[12px] text-muted">
              {currency} {unitPrice.toLocaleString('en-IN')} × {passengers.length}
              {serviceCharge > 0 && ` + ${currency} ${serviceCharge.toLocaleString('en-IN')} service charge`}
            </div>
          </div>
          <button type="submit" disabled={state === 'sending'}
            className="rounded-lg bg-teal-600 px-8 py-3.5 text-[14px] font-bold text-white transition-colors hover:bg-teal-700 disabled:opacity-60">
            {state === 'sending' ? 'Holding the fare…' : 'Confirm booking'}
          </button>
        </div>
        {error && <p className="mt-4 text-[13px] font-semibold text-amber-700">{error}</p>}
      </div>

      <p className="text-[12px] leading-relaxed text-muted">
        The fare is re-priced against Travelport when you press confirm, so the price you see is the price that is
        checked. This creates a <strong>held booking</strong> and an invoice in the accounts — it does not issue a
        ticket.
      </p>
    </form>
  );
}
