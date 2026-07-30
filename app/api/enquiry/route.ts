import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

/**
 * Demo-request capture. Appends to ../content/leads.json, which the admin
 * portal lists. Deliberately file-based: no database to install for a local
 * walkthrough. leads.json is gitignored — it holds names and phone numbers.
 */

const CONTENT_DIR = path.join(process.cwd(), 'content');
const LEADS_FILE = path.join(CONTENT_DIR, 'leads.json');

type Lead = {
  id: string;
  agency: string;
  name: string;
  phone: string;
  email: string;
  bookingsPerMonth: string;
  message: string;
  receivedAt: string;
};

async function readLeads(): Promise<Lead[]> {
  try {
    return JSON.parse(await readFile(LEADS_FILE, 'utf8')) as Lead[];
  } catch {
    return [];
  }
}

function clean(v: unknown, max = 400): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const lead: Lead = {
    id: Math.random().toString(36).slice(2, 10),
    agency: clean(body.agency, 160),
    name: clean(body.name, 120),
    phone: clean(body.phone, 40),
    email: clean(body.email, 160),
    bookingsPerMonth: clean(body.bookingsPerMonth, 40),
    message: clean(body.message, 1200),
    receivedAt: new Date().toISOString()
  };

  if (!lead.name || !lead.phone) {
    return NextResponse.json({ ok: false, error: 'Name and phone are required.' }, { status: 422 });
  }

  await mkdir(CONTENT_DIR, { recursive: true });
  const leads = await readLeads();
  leads.unshift(lead);
  await writeFile(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');

  return NextResponse.json({ ok: true });
}
