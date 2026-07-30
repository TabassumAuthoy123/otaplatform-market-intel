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

export type SiteContent = {
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
