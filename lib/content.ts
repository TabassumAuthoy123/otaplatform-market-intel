import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The single source of truth for every string on the /portal storefront is
 * content/site.json, which the admin portal (port 4001) writes.
 *
 * Read fresh on every request — the whole point is that an edit in admin shows
 * up on refresh here. Pages that render this must set `dynamic = 'force-dynamic'`.
 */

export type Link = { label: string; href: string };

export type Route = {
  from: string; fromCode: string; to: string; toCode: string;
  airline: string; priceFrom: number; tag: string; duration: string; stops: string;
};

export type Package = {
  title: string; kind: string; nights: number; priceFrom: number;
  tag: string; includes: string[];
};

export type Hotel = { name: string; city: string; priceFrom: number; rating: number; note: string };

export type Theme = {
  preset: string;
  /** R G B triplets, e.g. "15 111 115" — they feed CSS variables. */
  primary: string; primaryHover: string; navy: string; navyDeep: string; accentLight: string;
  headingFont: string; bodyFont: string; radius: string;
};

export type SectionToggle = { key: string; label: string; note: string; enabled: boolean };

export type SiteContent = {
  theme?: Theme;
  sections?: { items: SectionToggle[] };
  brand: {
    name: string; company: string; logoMark: string; tagline: string;
    hotline: string; email: string; address: string; productSite: string;
  };
  announcement: { enabled: boolean; text: string; linkLab?: string; linkHref?: string };
  nav: Link[];
  hero: {
    kicker: string; title: string; subtitle: string;
    primaryCta: Link; secondaryCta: Link;
    searchTabs: string[]; popularFrom: string[]; badges: string[];
  };
  trustStats: { value: string; label: string; sub: string }[];
  routes: Route[];
  packages: Package[];
  hotels: Hotel[];
  services: { title: string; desc: string; icon: string }[];
  why: { title: string; desc: string }[];
  credentials: { label: string; note: string }[];
  paymentMethods: string[];
  testimonials: { items: { name: string; city: string; quote: string; rating: number }[] };
  agentCta: { kicker: string; title: string; body: string; bullets: string[]; cta: Link };
  agentTiers: { name: string; for: string; featured: boolean; features: string[] }[];
  pricingNote: string;
  about: {
    title: string; body: string;
    facts: { k: string; v: string }[];
    capabilities: { area: string; detail: string }[];
  };
  visa: {
    title: string; body: string; note: string;
    destinations: { country: string; type: string; processing: string }[];
  };
  contact: { title: string; body: string; hotline: string; email: string; salesEmail: string; address: string };
  footer: {
    blurb: string; legal: string; disclaimer: string;
    columns: { title: string; links: Link[] }[];
  };
};

const CONTENT_FILE = path.join(process.cwd(), 'content', 'site.json');

export async function getContent(): Promise<SiteContent> {
  const raw = await readFile(CONTENT_FILE, 'utf8');
  return JSON.parse(raw) as SiteContent;
}

/** 62,500 -> "৳62,500" */
export function bdt(n: number): string {
  return '৳' + n.toLocaleString('en-IN');
}

/** Is a storefront section switched on? Unknown keys default to visible. */
export function sectionOn(c: SiteContent, key: string): boolean {
  const item = c.sections?.items?.find((s) => s.key === key);
  return item ? item.enabled : true;
}

/** The <style> body that repaints the storefront from the saved theme. */
export function themeCss(c: SiteContent): string {
  const t = c.theme;
  if (!t) return '';
  const v: string[] = [];
  if (t.primary) v.push(`--c-primary:${t.primary}`);
  if (t.primaryHover) v.push(`--c-primary-hover:${t.primaryHover}`);
  if (t.navy) v.push(`--c-navy:${t.navy}`);
  if (t.navyDeep) v.push(`--c-navy-deep:${t.navyDeep}`);
  if (t.accentLight) v.push(`--c-accent-light:${t.accentLight}`);
  if (t.bodyFont) v.push(`--font-sans:'${t.bodyFont}',system-ui,sans-serif`);
  if (t.headingFont) v.push(`--font-heading:'${t.headingFont}',system-ui,sans-serif`);
  return v.length ? `:root{${v.join(';')}}` : '';
}

/** Google Fonts href for the chosen faces, or null when they are already local. */
export function fontHref(c: SiteContent): string | null {
  const fams = Array.from(new Set([c.theme?.headingFont, c.theme?.bodyFont].filter(Boolean) as string[]));
  if (!fams.length) return null;
  const q = fams.map((f) => `family=${encodeURIComponent(f)}:wght@400;500;600;700;800`).join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}
