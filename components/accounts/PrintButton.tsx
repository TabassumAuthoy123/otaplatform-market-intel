'use client';

/**
 * "Save as PDF" in the browser's print dialog is the PDF export.
 *
 * A PDF library would mean a second renderer to keep in step with the pages
 * people actually reviewed, and it would drift. The print stylesheet in
 * globals.css does the work instead: navigation and filters drop out, table
 * headings repeat on every page, and nothing is left inside a scroll window.
 */
export function PrintButton({ label = 'Print / PDF' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-hair bg-white px-3.5 py-2 text-[12.5px] font-semibold text-navy-900 transition-colors hover:border-teal-500 hover:text-teal-700"
    >
      {label}
    </button>
  );
}
