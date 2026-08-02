import { NextResponse } from 'next/server';
import {
  CALL_STATUS, DISPOSITION, INTEREST, PRIORITY_HINT,
  dashboard, filterLeads, getActivities, getLeads, getUsers, userName, type Lead
} from '@/lib/crm';

/**
 * Downloadable exports of the prospect database.
 *
 *   /api/crm/export?format=xlsx    Excel workbook, five sheets
 *   /api/crm/export?format=docx    Word prospect brief, grouped by priority
 *   /api/crm/export?format=md      Markdown, same structure
 *   /api/crm/export?format=csv     flat CSV with a UTF-8 BOM for Excel
 *
 * Every filter the lead list supports is honoured here, so "export what I am
 * looking at" works: ?priority=P1&city=Dhaka&view=due_today etc.
 *
 * Phone numbers, emails and addresses go out exactly as they came in. The
 * source registers print legacy landlines, emails with a comma instead of a
 * dot, and backslashes in addresses; 05_DATA_DICTIONARY.md is explicit that
 * those are preserved, not repaired.
 */

export const dynamic = 'force-dynamic';

const COLUMNS: { key: keyof Lead; header: string; width: number }[] = [
  { key: 'lead_id', header: 'Lead ID', width: 11 },
  { key: 'priority', header: 'Priority', width: 9 },
  { key: 'tier', header: 'Tier', width: 34 },
  { key: 'segment', header: 'Segment', width: 30 },
  { key: 'company', header: 'Company', width: 38 },
  { key: 'decision_maker', header: 'Decision maker', width: 32 },
  { key: 'city', header: 'City', width: 14 },
  { key: 'address', header: 'Address', width: 46 },
  { key: 'phone', header: 'Phone', width: 30 },
  { key: 'mobile', header: 'Mobile', width: 26 },
  { key: 'email', header: 'Email', width: 30 },
  { key: 'website', header: 'Website', width: 28 },
  { key: 'facebook', header: 'Facebook', width: 24 },
  { key: 'licence_ref', header: 'Licence ref', width: 22 },
  { key: 'booking_engine', header: 'Booking engine', width: 26 },
  { key: 'prospect_note', header: 'Why they are a prospect', width: 58 },
  { key: 'data_source', header: 'Source', width: 24 },
  { key: 'source_url', header: 'Source URL', width: 40 }
];

const CRM_COLUMNS: { key: keyof Lead; header: string; width: number }[] = [
  { key: 'assigned_to', header: 'Assigned to', width: 18 },
  { key: 'call_status', header: 'Call status', width: 22 },
  { key: 'last_call_date', header: 'Last call', width: 13 },
  { key: 'disposition', header: 'Disposition', width: 26 },
  { key: 'interest_level', header: 'Interest', width: 16 },
  { key: 'demo_scheduled', header: 'Demo', width: 12 },
  { key: 'next_action', header: 'Next action', width: 34 },
  { key: 'next_action_date', header: 'Next action date', width: 15 },
  { key: 'notes', header: 'Notes', width: 44 }
];

const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => today().replace(/-/g, '');

function pretty(lead: Lead, key: keyof Lead, users: { id: string; name: string }[]): string {
  const v = lead[key];
  if (v === null || v === undefined || v === '') return '';
  if (key === 'assigned_to') return userName(users as never, String(v));
  if (key === 'call_status') return CALL_STATUS[String(v)] ?? String(v);
  if (key === 'disposition') return DISPOSITION[String(v)] ?? String(v);
  if (key === 'interest_level') return INTEREST[String(v)] ?? String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const format = (p.get('format') ?? 'csv').toLowerCase();

  const [all, users, activities] = await Promise.all([getLeads(), getUsers(), getActivities()]);
  const rows = filterLeads(all, {
    q: p.get('q') ?? undefined,
    priority: p.get('priority') ?? undefined,
    tier: p.get('tier') ?? undefined,
    city: p.get('city') ?? undefined,
    status: p.get('status') ?? undefined,
    disposition: p.get('disposition') ?? undefined,
    assigned: p.get('assigned') ?? undefined,
    hasWebsite: p.get('hasWebsite') ?? undefined,
    hasMobile: p.get('hasMobile') ?? undefined,
    view: p.get('view') ?? undefined
  });

  const filename = `Softifybd-OTA-Prospects-${rows.length}-${stamp()}`;

  if (format === 'csv') return csv(rows, users, filename);
  if (format === 'md') return markdown(rows, users, activities, all, filename);
  if (format === 'xlsx') return xlsx(rows, users, activities, all, filename);
  if (format === 'docx') return wordDoc(rows, users, activities, all, filename);

  return NextResponse.json({ ok: false, error: 'format must be one of csv, md, xlsx, docx' }, { status: 422 });
}

/* -------------------------------------------------------------------- CSV */

function csv(rows: Lead[], users: { id: string; name: string }[], filename: string) {
  const cols = [...COLUMNS, ...CRM_COLUMNS];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const body = [
    cols.map((c) => esc(c.header)).join(','),
    ...rows.map((l) => cols.map((c) => esc(pretty(l, c.key, users))).join(','))
  ].join('\r\n');

  // BOM so Excel opens Bangla and the ৳ sign correctly
  return new NextResponse('﻿' + body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}.csv"`
    }
  });
}

/* --------------------------------------------------------------- Markdown */

function markdown(rows: Lead[], users: { id: string; name: string }[], activities: unknown[], all: Lead[], filename: string) {
  const d = dashboard(all, users as never, activities as never);
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const out: string[] = [];
  out.push('# Softifybd OTA Platform — B2B Prospect Database');
  out.push('');
  out.push(`**${rows.length} agencies in this export** · generated ${today()} · Softifybd Limited, Gulshan-1, Dhaka`);
  out.push('');
  out.push('> Compiled from the TOAB directory, the BAIRA register, the ATAB member directory and the');
  out.push('> Ministry of Religious Affairs Hajj agency register. This is a **prospecting universe**,');
  out.push('> not a licence certificate — verify a licence on regtravelagency.gov.bd before contracting.');
  out.push('');
  out.push('## Coverage');
  out.push('');
  out.push('| Measure | Value |');
  out.push('|---|---|');
  out.push(`| Total prospects in database | ${d.total} |`);
  out.push(`| Worked at least once | ${d.touched} (${d.coveragePct.toFixed(1)}%) |`);
  out.push(`| Reached a human | ${d.contacted} |`);
  out.push(`| Demos scheduled | ${d.demos} |`);
  out.push(`| Won | ${d.won} |`);
  out.push(`| P1 still untouched | ${d.p1Untouched} |`);
  out.push('');

  out.push('## By priority');
  out.push('');
  out.push('| Priority | Meaning | Total | Worked | Untouched |');
  out.push('|---|---|---|---|---|');
  for (const r of d.byPriority) out.push(`| ${r.priority} | ${r.hint} | ${r.total} | ${r.touched} | ${r.untouched} |`);
  out.push('');

  out.push('## By tier');
  out.push('');
  out.push('| Tier | Total | Worked |');
  out.push('|---|---|---|');
  for (const r of d.byTier) out.push(`| ${cell(r.tier)} | ${r.total} | ${r.touched} |`);
  out.push('');

  for (const pri of ['P1', 'P2', 'P3', 'P4', 'P5']) {
    const group = rows.filter((l) => l.priority === pri);
    if (!group.length) continue;
    out.push(`## ${pri} — ${PRIORITY_HINT[pri]} (${group.length})`);
    out.push('');
    out.push('| Lead | Company | Decision maker | City | Mobile | Phone | Email | Website | Why they are a prospect | Status |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const l of group) {
      out.push(
        `| ${l.lead_id} | **${cell(l.company)}** | ${cell(l.decision_maker)} | ${cell(l.city)} | ` +
        `\`${cell(l.mobile)}\` | \`${cell(l.phone)}\` | ${cell(l.email)} | ${cell(l.website || '—')} | ` +
        `${cell(l.prospect_note)} | ${CALL_STATUS[l.call_status] ?? l.call_status} |`
      );
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('Internal — Sales & BD use only. Phone numbers, emails and addresses are reproduced exactly as');
  out.push('printed in the source registers, including legacy landlines and known typographic artefacts.');
  out.push('');

  return new NextResponse(out.join('\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}.md"`
    }
  });
}

/* ------------------------------------------------------------------- XLSX */

async function xlsx(rows: Lead[], users: { id: string; name: string }[], activities: unknown[], all: Lead[], filename: string) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Softifybd Limited — OTA Platform';
  wb.created = new Date();

  const NAVY = 'FF13294B';
  const PANEL = 'FFEEF2F5';

  const headerRow = (ws: import('exceljs').Worksheet) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    r.alignment = { vertical: 'middle' };
    r.height = 22;
  };

  /* --- 1. master leads ---------------------------------------------- */
  const master = wb.addWorksheet('01_MASTER_LEADS', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  const cols = [...COLUMNS, ...CRM_COLUMNS];
  master.columns = cols.map((c) => ({ header: c.header, key: String(c.key), width: c.width }));
  for (const l of rows) {
    master.addRow(Object.fromEntries(cols.map((c) => [String(c.key), pretty(l, c.key, users)])));
  }
  headerRow(master);
  master.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  master.eachRow((row, i) => {
    if (i === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
    row.font = { size: 10 };
    if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PANEL } };
  });

  /* --- 2. call queue, dial-ready ------------------------------------ */
  const queue = wb.addWorksheet('02_CALL_QUEUE', { views: [{ state: 'frozen', ySplit: 1 }] });
  queue.columns = [
    { header: 'Priority', key: 'priority', width: 9 },
    { header: 'Lead ID', key: 'lead_id', width: 11 },
    { header: 'Company', key: 'company', width: 40 },
    { header: 'Decision maker', key: 'decision_maker', width: 32 },
    { header: 'Mobile', key: 'mobile', width: 26 },
    { header: 'Phone', key: 'phone', width: 28 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'Has website', key: 'hasweb', width: 12 },
    { header: 'Call status', key: 'call_status', width: 22 },
    { header: 'Assigned to', key: 'assigned_to', width: 18 },
    { header: 'Next action', key: 'next_action', width: 34 },
    { header: 'Next action date', key: 'next_action_date', width: 16 }
  ];
  for (const l of [...rows].sort((a, b) => a.priority.localeCompare(b.priority) || a.lead_id.localeCompare(b.lead_id))) {
    queue.addRow({
      priority: l.priority, lead_id: l.lead_id, company: l.company,
      decision_maker: l.decision_maker, mobile: l.mobile, phone: l.phone, city: l.city,
      hasweb: l.website ? 'yes' : 'no',
      call_status: CALL_STATUS[l.call_status] ?? l.call_status,
      assigned_to: userName(users as never, l.assigned_to),
      next_action: l.next_action ?? '', next_action_date: l.next_action_date ?? ''
    });
  }
  headerRow(queue);
  queue.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };

  /* --- 3. summary ---------------------------------------------------- */
  const d = dashboard(all, users as never, activities as never);
  const sum = wb.addWorksheet('03_SUMMARY');
  sum.columns = [{ header: 'Measure', key: 'k', width: 40 }, { header: 'Value', key: 'v', width: 22 }];
  const add = (k: string, v: string | number) => sum.addRow({ k, v });
  add('Total prospects', d.total);
  add('Worked at least once', d.touched);
  add('Coverage %', `${d.coveragePct.toFixed(1)}%`);
  add('Reached a human', d.contacted);
  add('Demos scheduled', d.demos);
  add('Won', d.won);
  add('P1 still untouched', d.p1Untouched);
  add('Unassigned leads', d.unassigned.length);
  add('Due today or overdue', d.dueToday.length);
  add('Disposition set but no next action', d.abandoned.length);
  add('Activities logged', d.totalActivities);
  add('Exported rows (after filters)', rows.length);
  add('Generated', today());
  headerRow(sum);

  /* --- 4. by tier ---------------------------------------------------- */
  const tier = wb.addWorksheet('04_BY_TIER');
  tier.columns = [
    { header: 'Tier', key: 't', width: 40 },
    { header: 'Total', key: 'n', width: 10 },
    { header: 'Worked', key: 'w', width: 10 },
    { header: 'Untouched', key: 'u', width: 12 }
  ];
  for (const r of d.byTier) tier.addRow({ t: r.tier, n: r.total, w: r.touched, u: r.total - r.touched });
  headerRow(tier);

  /* --- 5. per rep ---------------------------------------------------- */
  const rep = wb.addWorksheet('05_PER_REP');
  rep.columns = [
    { header: 'Sales person', key: 'n', width: 24 },
    { header: 'Role', key: 'r', width: 16 },
    { header: 'Assigned', key: 'a', width: 11 },
    { header: 'Called', key: 'c', width: 11 },
    { header: 'Reached', key: 'x', width: 11 },
    { header: 'Demos', key: 'd', width: 11 },
    { header: 'Hot', key: 'h', width: 11 },
    { header: 'Won', key: 'w', width: 11 },
    { header: 'Activities', key: 'act', width: 12 }
  ];
  for (const r of d.perRep) {
    rep.addRow({ n: r.user.name, r: r.user.role, a: r.assigned, c: r.called, x: r.contacted, d: r.demos, h: r.hot, w: r.won, act: r.activities });
  }
  headerRow(rep);

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}.xlsx"`
    }
  });
}

/* ------------------------------------------------------------------- DOCX */

async function wordDoc(rows: Lead[], users: { id: string; name: string }[], activities: unknown[], all: Lead[], filename: string) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, AlignmentType, BorderStyle, ShadingType
  } = await import('docx');

  const NAVY = '13294B';
  const TEAL = '0F6F73';
  const HAIR = 'DCE6EC';
  const d = dashboard(all, users as never, activities as never);

  const cellBorders = {
    top: { style: BorderStyle.SINGLE, size: 2, color: HAIR },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: HAIR },
    left: { style: BorderStyle.SINGLE, size: 2, color: HAIR },
    right: { style: BorderStyle.SINGLE, size: 2, color: HAIR }
  };

  const td = (text: string, opts: { bold?: boolean; head?: boolean; mono?: boolean; width?: number } = {}) =>
    new TableCell({
      borders: cellBorders,
      width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
      shading: opts.head ? { type: ShadingType.CLEAR, fill: NAVY } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text: text || '—',
              bold: opts.bold || opts.head,
              size: opts.head ? 16 : 16,
              color: opts.head ? 'FFFFFF' : '1F2933',
              font: opts.mono ? 'Consolas' : undefined
            })
          ]
        })
      ]
    });

  const h1 = (text: string) =>
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 320, after: 140 },
      children: [new TextRun({ text, bold: true, color: NAVY, size: 30 })]
    });

  const h2 = (text: string) =>
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 260, after: 110 },
      children: [new TextRun({ text, bold: true, color: NAVY, size: 24 })]
    });

  const body = (text: string, opts: { muted?: boolean; bold?: boolean } = {}) =>
    new Paragraph({
      spacing: { after: 110 },
      children: [new TextRun({ text, size: 19, bold: opts.bold, color: opts.muted ? '5A6472' : '1F2933' })]
    });

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  // cover
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: 'SOFTIFYBD LIMITED · OTA PLATFORM', bold: true, color: TEAL, size: 17 })]
    }),
    new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: 'B2B Prospect Database', bold: true, color: NAVY, size: 46 })]
    }),
    body(`${rows.length} licensed Bangladeshi travel agencies · generated ${today()}`, { bold: true }),
    body('Tower of Aakash, Level 18, 54 Gulshan Avenue, Dhaka 1212 · 096-12345-100', { muted: true }),
    body(
      'Compiled from the TOAB directory, the BAIRA register, the ATAB member directory and the Ministry of ' +
      'Religious Affairs Hajj agency register. This is a prospecting universe, not a licence certificate — ' +
      'verify any licence on regtravelagency.gov.bd before contracting.',
      { muted: true }
    )
  );

  // coverage
  children.push(h1('Coverage'));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [td('Measure', { head: true, width: 60 }), td('Value', { head: true, width: 40 })] }),
        ...[
          ['Total prospects in database', String(d.total)],
          ['Worked at least once', `${d.touched} (${d.coveragePct.toFixed(1)}%)`],
          ['Reached a human', String(d.contacted)],
          ['Demos scheduled', String(d.demos)],
          ['Won', String(d.won)],
          ['P1 still untouched', String(d.p1Untouched)],
          ['Unassigned', String(d.unassigned.length)]
        ].map(([k, v]) => new TableRow({ children: [td(k), td(v, { bold: true })] }))
      ]
    })
  );

  // per rep
  children.push(h1('Who is doing what'));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: ['Sales person', 'Assigned', 'Called', 'Reached', 'Demos', 'Hot', 'Won'].map((h) => td(h, { head: true }))
        }),
        ...d.perRep.map((r) =>
          new TableRow({
            children: [
              td(r.user.name, { bold: true }), td(String(r.assigned)), td(String(r.called)),
              td(String(r.contacted)), td(String(r.demos)), td(String(r.hot)), td(String(r.won))
            ]
          })
        )
      ]
    })
  );

  // the list, grouped by priority
  for (const pri of ['P1', 'P2', 'P3', 'P4', 'P5']) {
    const group = rows.filter((l) => l.priority === pri);
    if (!group.length) continue;

    children.push(h1(`${pri} — ${PRIORITY_HINT[pri]}`));
    children.push(body(`${group.length} agencies`, { muted: true }));

    for (const l of group) {
      children.push(h2(`${l.lead_id} · ${l.company}`));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [td('Decision maker', { bold: true, width: 24 }), td(l.decision_maker, { width: 76 })] }),
            new TableRow({ children: [td('Mobile', { bold: true }), td(l.mobile, { mono: true })] }),
            new TableRow({ children: [td('Phone', { bold: true }), td(l.phone, { mono: true })] }),
            new TableRow({ children: [td('Email', { bold: true }), td(l.email, { mono: true })] }),
            new TableRow({ children: [td('Address', { bold: true }), td(`${l.address}${l.city ? ` — ${l.city}` : ''}`)] }),
            new TableRow({ children: [td('Website', { bold: true }), td(l.website || 'none — sales signal')] }),
            new TableRow({ children: [td('Booking engine', { bold: true }), td(l.booking_engine)] }),
            new TableRow({ children: [td('Tier / segment', { bold: true }), td(`${l.tier} · ${l.segment}`)] }),
            new TableRow({ children: [td('Licence ref', { bold: true }), td(l.licence_ref)] }),
            new TableRow({ children: [td('Why a prospect', { bold: true }), td(l.prospect_note)] }),
            new TableRow({ children: [td('Source', { bold: true }), td(`${l.data_source} — ${l.source_url}`)] }),
            new TableRow({
              children: [
                td('Call status', { bold: true }),
                td(
                  `${CALL_STATUS[l.call_status] ?? l.call_status}` +
                  `${l.assigned_to ? ` · ${userName(users as never, l.assigned_to)}` : ''}` +
                  `${l.disposition ? ` · ${DISPOSITION[l.disposition]}` : ''}` +
                  `${l.next_action ? ` · next: ${l.next_action} (${l.next_action_date ?? 'no date'})` : ''}`
                )
              ]
            })
          ]
        })
      );
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    }
  }

  children.push(
    new Paragraph({
      spacing: { before: 300 },
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text:
            'Internal — Sales & BD use only. Phone numbers, emails and addresses are reproduced exactly as printed ' +
            'in the source registers, including legacy Dhaka landlines and known typographic artefacts. Do not ' +
            '"correct" them without checking the source URL.',
          size: 17, color: '5A6472', italics: true
        })
      ]
    })
  );

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);

  return new NextResponse(buf as unknown as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="${filename}.docx"`
    }
  });
}
