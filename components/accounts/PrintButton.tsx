'use client';

/**
 * The one interactive control on an otherwise static document.
 *
 * A client component purely because `window.print()` needs a browser. Kept in its
 * own file so the itinerary page stays a server component — it reads the book and
 * the company record, and pulling all of that into the client to get one button
 * would ship the accounting data to the browser to render a print dialog.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700"
    >
      Print / save as PDF
    </button>
  );
}
