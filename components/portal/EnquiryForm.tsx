'use client';

import { useState } from 'react';

export function EnquiryForm() {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState('sending');
    setError('');
    const fd = new FormData(e.currentTarget);
    const payload = Object.fromEntries(fd.entries());

    try {
      const res = await fetch('/api/enquiry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Could not save that. Try again.');
        setState('error');
        return;
      }
      setState('done');
    } catch {
      setError('Network error — is the portal still running?');
      setState('error');
    }
  }

  if (state === 'done') {
    return (
      <div className="rounded-xl2 border border-teal-600/30 bg-teal-600/5 p-7">
        <h3 className="text-[17px] font-bold text-navy-900">Request logged</h3>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink">
          It is saved and visible in the admin portal under <strong>Demo requests</strong>. On the production platform
          this would also fire an email and create the CRM record.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl2 border border-hair bg-white p-6 shadow-card">
      <h3 className="text-[17px] font-bold text-navy-900">Request a 15-minute demo</h3>
      <p className="mt-1.5 text-[13px] text-muted">We will search two of your own routes live on the call.</p>

      <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
        <Input name="agency" label="Agency name" placeholder="Your agency" />
        <Input name="name" label="Your name" placeholder="Full name" required />
        <Input name="phone" label="Mobile / WhatsApp" placeholder="01XXXXXXXXX" required />
        <Input name="email" label="Email" type="email" placeholder="you@agency.com" />
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
            Bookings per month
          </span>
          <select
            name="bookingsPerMonth"
            defaultValue="20–50"
            className="w-full rounded-lg border border-hair bg-surface px-3.5 py-2.5 text-[14px] text-navy-900 outline-none focus:border-teal-500"
          >
            {['Under 20', '20–50', '50–100', '100–500', '500+'].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
            Anything specific to see
          </span>
          <textarea
            name="message"
            rows={3}
            placeholder="e.g. sub-agent panel, markup rules, Hajj group handling"
            className="w-full rounded-lg border border-hair bg-surface px-3.5 py-2.5 text-[14px] text-navy-900 outline-none placeholder:text-muted focus:border-teal-500"
          />
        </label>
      </div>

      {error && <p className="mt-4 text-[13px] font-semibold text-amber-700">{error}</p>}

      <button
        type="submit"
        disabled={state === 'sending'}
        className="mt-5 w-full rounded-lg bg-teal-600 px-5 py-3.5 text-[14px] font-bold text-white transition-colors hover:bg-teal-700 disabled:opacity-60"
      >
        {state === 'sending' ? 'Saving…' : 'Send request'}
      </button>
    </form>
  );
}

function Input({
  name,
  label,
  placeholder,
  type = 'text',
  required = false
}: {
  name: string;
  label: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
        {label}
        {required && <span className="text-amber-700"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-hair bg-surface px-3.5 py-2.5 text-[14px] text-navy-900 outline-none placeholder:text-muted focus:border-teal-500"
      />
    </label>
  );
}
