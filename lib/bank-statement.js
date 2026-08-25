/**
 * Reading a bank statement file, without guessing.
 *
 * WHY THIS IS PLAIN COMMONJS
 *
 * The admin portal on :4001 imports the file and the app on :3002 renders what was
 * imported, and the portal cannot run TypeScript. Two copies of "what this file means"
 * would drift, and the drift would be silent — the portal accepting a mapping the app
 * reads differently. Same arrangement as lib/journal-rules.js and lib/period-lock.js.
 *
 * WHY THERE IS NO BUILT-IN FORMAT FOR ANY BANK
 *
 * The obvious feature here is a dropdown: Dutch-Bangla, BRAC, City Bank, bKash. It is
 * not built, on purpose. I have not seen a real export from any of them, and a layout
 * I guessed at would be worse than no layout at all — it would put the operator's money
 * in the wrong column while looking like it knew what it was doing. Same rule as the
 * carrier contracts and the tax rates: nothing here is invented.
 *
 * What is built instead is a mapping the operator states once per account and the
 * checks that make a wrong mapping obvious immediately rather than at year end.
 */

/* ------------------------------------------------------------------ parsing */

/**
 * Split a delimited file into rows, respecting quotes.
 *
 * Written out rather than done with a regex because bank narrations contain commas,
 * quotes and newlines — "PAYMENT TO ""AKASH TRAVELS"", DHAKA" is one field, and a
 * split(',') turns it into three and shifts every column after it.
 */
function parseDelimited(text, delimiter) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
}

/**
 * Which delimiter this file uses.
 *
 * Decided by which one gives the most CONSISTENT column count, not by which one appears
 * most. A narration full of commas beats the tab in raw frequency while producing a
 * ragged table, and ragged is the thing that actually breaks a mapping.
 */
function sniffDelimiter(text) {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const rows = parseDelimited(text, d).slice(0, 40);
    if (rows.length < 2) continue;
    const counts = rows.map((r) => r.length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode < 2) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = consistent * 100 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Header row plus body, with the delimiter worked out. */
function readTable(text) {
  const delimiter = sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length < 2) return { delimiter, headers: [], rows: [], error: 'The file has no rows under a header.' };
  const width = Math.max.apply(null, rows.map((r) => r.length));
  const headers = rows[0].map((h, i) => h || `Column ${i + 1}`);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  const body = rows.slice(1).map((r) => {
    const out = r.slice();
    while (out.length < width) out.push('');
    return out;
  });
  return { delimiter, headers, rows: body, error: null };
}

/* -------------------------------------------------------------------- dates */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/**
 * Does this date actually exist?
 *
 * Bounds-checking the parts is not enough: `d <= 31` happily accepts 31/02/2026 and
 * yields "2026-02-31", a string that sorts and compares like a date and is not one. It
 * would land between the 28th and the 1st in every range filter in the book and never
 * match a bank line, and nothing downstream would say why.
 *
 * Round-tripping through Date is the cheapest way to ask the calendar rather than
 * assert about it. Month is zero-based going in, so it is the readback that does the
 * work: February 31st comes back as March 3rd and fails the comparison.
 */
const plausible = (y, m, d) => {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

/**
 * Every reading of a date string that is actually possible.
 *
 * Returns a SET, not a best guess. `03/04/2026` is the third of April and the fourth of
 * March, and there is no way to tell from the string. Guessing here would silently move
 * transactions by up to eleven months, in a system whose entire purpose is agreeing with
 * somebody else's records about when money moved.
 */
function readings(value) {
  const s = String(value || '').trim();
  const out = {};
  if (!s) return out;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m && plausible(+m[1], +m[2], +m[3])) out['YYYY-MM-DD'] = iso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (plausible(y, b, a)) out['DD-MM-YYYY'] = iso(y, b, a);
    if (plausible(y, a, b)) out['MM-DD-YYYY'] = iso(y, a, b);
  }

  m = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,4})[-/\s](\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mo && plausible(y, mo, +m[1])) out['DD-MON-YYYY'] = iso(y, mo, +m[1]);
  }

  return out;
}

/**
 * Which date formats fit EVERY value in the column.
 *
 * A column is only unambiguous when exactly one format survives all of it. `13/04/2026`
 * kills MM-DD-YYYY on its own, which is why a whole-column answer is far stronger than a
 * per-cell one — and why a statement whose every day is twelve or under stays genuinely
 * ambiguous and has to be answered by a person.
 */
function dateFormats(values) {
  const all = ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY', 'DD-MON-YYYY'];
  let alive = all.slice();
  let seen = 0;
  for (const v of values) {
    if (!String(v || '').trim()) continue;
    seen++;
    const r = readings(v);
    alive = alive.filter((f) => r[f]);
    if (alive.length === 0) break;
  }
  return { candidates: alive, sampled: seen };
}

/** One value under a stated format, or null. Never a fallback to another format. */
function readDate(value, format) {
  const r = readings(value);
  return r[format] ?? null;
}

/* ------------------------------------------------------------------ amounts */

/**
 * A money cell as a number.
 *
 * Handles what statements actually contain: thousands separators in the Indian grouping
 * the local banks use, a trailing or leading CR/DR, parenthesised negatives, and a
 * currency symbol. Returns null rather than 0 for anything it cannot read — a zero here
 * would be a transaction silently valued at nothing.
 */
function readAmount(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }

  const cr = /\bcr\b/i.test(s);
  const dr = /\bdr\b/i.test(s);
  s = s.replace(/\b(cr|dr)\b/gi, '');

  s = s.replace(/[৳$£€]/g, '').replace(/[,\s]/g, '').replace(/^\+/, '');
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;

  const n = Number(s) * sign;
  if (!Number.isFinite(n)) return null;
  // DR on a statement line means money left the account. Applied only when the cell
  // says so — the debit/credit COLUMNS carry that meaning already for most exports.
  return dr && !cr ? -Math.abs(n) : n;
}

/* ------------------------------------------------------------------ mapping */

/**
 * A guess at which column is which, offered to the operator and never applied silently.
 *
 * Header names are matched loosely because every bank words them differently
 * ("Withdrawal", "Debit", "Dr Amount", "Paid Out"). The result is a SUGGESTION: the
 * import screen shows it, the operator confirms or changes it, and the confirmed mapping
 * is what gets stored against the account for next month.
 */
function suggestMapping(headers) {
  const find = (...patterns) => {
    for (const p of patterns) {
      const i = headers.findIndex((h) => p.test(String(h)));
      if (i !== -1) return i;
    }
    return -1;
  };
  return {
    date: find(/^(txn|trans(action)?|value|posting|entry)?\s*date/i, /date/i),
    description: find(/narration|particular|description|details|remark|transaction\s*detail/i),
    reference: find(/cheque|check|instrument|utr|ref(erence)?\s*(no|number)?$/i, /ref/i),
    debit: find(/withdraw|debit|^dr\b|paid\s*out|outflow/i),
    credit: find(/deposit|credit|^cr\b|paid\s*in|inflow/i),
    amount: find(/^amount$|^txn\s*amount$|^value$/i),
    balance: find(/balance|closing/i)
  };
}

/**
 * Turn a mapped table into statement lines, and say what could not be read.
 *
 * Two shapes are supported and they are genuinely different: separate Debit and Credit
 * columns (most bank exports), or one signed Amount column (most MFS and card exports).
 * A mapping that supplies neither is refused rather than defaulted, because defaulting
 * would mean deciding the direction of somebody's money by convention.
 */
function readLines(table, mapping, dateFormat) {
  const lines = [];
  const problems = [];
  const at = (row, idx) => (idx == null || idx < 0 ? '' : row[idx] ?? '');

  const hasSplit = mapping.debit >= 0 || mapping.credit >= 0;
  const hasSigned = mapping.amount >= 0;
  if (!hasSplit && !hasSigned) {
    return { lines: [], problems: ['Choose either a Debit and Credit column, or a single signed Amount column.'] };
  }

  table.rows.forEach((row, i) => {
    const n = i + 2; // +1 for the header, +1 because people count from one
    const rawDate = at(row, mapping.date);
    if (!String(rawDate).trim()) return; // a blank line, or a total row the bank appended

    const date = readDate(rawDate, dateFormat);
    if (!date) {
      problems.push(`Line ${n}: "${rawDate}" is not a date in ${dateFormat} format.`);
      return;
    }

    let amount = null;
    let direction = null;
    if (hasSplit) {
      const debit = readAmount(at(row, mapping.debit));
      const credit = readAmount(at(row, mapping.credit));
      if (debit && credit) {
        problems.push(`Line ${n}: both the debit and the credit column have a value. One line cannot be both.`);
        return;
      }
      if (debit) { amount = Math.abs(debit); direction = 'out'; }
      else if (credit) { amount = Math.abs(credit); direction = 'in'; }
    } else {
      const signed = readAmount(at(row, mapping.amount));
      if (signed !== null && signed !== 0) {
        amount = Math.abs(signed);
        direction = signed < 0 ? 'out' : 'in';
      }
    }

    if (amount === null || !direction) {
      problems.push(`Line ${n}: no readable amount.`);
      return;
    }

    lines.push({
      date,
      description: String(at(row, mapping.description)).trim(),
      reference: String(at(row, mapping.reference)).trim(),
      amount,
      direction,
      balance: mapping.balance >= 0 ? readAmount(at(row, mapping.balance)) : null,
      sourceLine: n
    });
  });

  return { lines, problems };
}

/**
 * Walk the running balance the statement prints and check our reading of it.
 *
 * This is the best check available, and it costs nothing: the bank has already told us
 * what each line does to the balance. If our reading of the amounts and directions is
 * right, every consecutive pair satisfies `previous ± amount === current`. If the
 * operator has mapped Debit and Credit the wrong way round, or picked the wrong date
 * format so the rows sorted differently, this fails on the first pair — before anything
 * is written, instead of at year end when nothing reconciles and nobody knows why.
 *
 * Skipped, with that said plainly, when the statement carries no balance column. An
 * unverifiable import is not refused; it is labelled.
 */
function verifyBalanceChain(lines) {
  const withBalance = lines.filter((l) => l.balance !== null && l.balance !== undefined);
  if (withBalance.length < 2) {
    return { checked: false, ok: null, breaks: [], detail: 'No running balance column, so the amounts could not be cross-checked against the bank\'s own arithmetic.' };
  }
  const breaks = [];
  for (let i = 1; i < withBalance.length; i++) {
    const prev = withBalance[i - 1];
    const cur = withBalance[i];
    const move = cur.direction === 'in' ? cur.amount : -cur.amount;
    const expected = Math.round((prev.balance + move) * 100) / 100;
    const actual = Math.round(cur.balance * 100) / 100;
    if (expected !== actual) {
      breaks.push({
        sourceLine: cur.sourceLine,
        expected,
        actual,
        by: Math.round((actual - expected) * 100) / 100
      });
    }
  }
  return {
    checked: true,
    ok: breaks.length === 0,
    breaks,
    detail: breaks.length === 0
      ? `${withBalance.length} lines, and every one moves the printed balance by exactly its own amount`
      : `${breaks.length} line(s) do not move the printed balance by their own amount. The debit and credit columns are probably mapped the wrong way round, or the date format is wrong and the rows are out of order.`
  };
}

/**
 * Everything an import screen needs, in one call, WITHOUT writing anything.
 *
 * Preview is mandatory for the same reason it is mandatory on the CRM import: an upsert
 * straight off a paste overwrites work nobody can get back. Here the stakes are lower —
 * a statement is a record of somebody else's facts — but a wrong mapping quietly
 * reverses the direction of every transaction, and that is worth one confirmation click.
 */
function preview(text, mapping, dateFormat) {
  const table = readTable(text);
  if (table.error) return { table, error: table.error };

  const suggested = suggestMapping(table.headers);
  const useMapping = mapping || suggested;

  const dateCol = useMapping.date >= 0 ? table.rows.map((r) => r[useMapping.date]) : [];
  const formats = dateFormats(dateCol);
  const useFormat = dateFormat || (formats.candidates.length === 1 ? formats.candidates[0] : null);

  if (!useFormat) {
    return {
      table,
      suggested,
      mapping: useMapping,
      dateFormats: formats,
      error: formats.candidates.length === 0
        ? 'No date format fits every value in that column. Check the Date column is the right one.'
        : `That date column reads equally well as ${formats.candidates.join(' or ')} — for example a day of 12 or less is both. Say which one the bank used; guessing would move transactions by up to eleven months.`
    };
  }

  const { lines, problems } = readLines(table, useMapping, useFormat);
  const chain = verifyBalanceChain(lines);

  const totalIn = lines.filter((l) => l.direction === 'in').reduce((t, l) => t + l.amount, 0);
  const totalOut = lines.filter((l) => l.direction === 'out').reduce((t, l) => t + l.amount, 0);
  const dates = lines.map((l) => l.date).sort();

  return {
    table,
    suggested,
    mapping: useMapping,
    dateFormats: formats,
    dateFormat: useFormat,
    lines,
    problems,
    chain,
    summary: {
      count: lines.length,
      totalIn,
      totalOut,
      net: totalIn - totalOut,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      openingPrinted: lines.length && lines[0].balance !== null
        ? Math.round((lines[0].balance - (lines[0].direction === 'in' ? lines[0].amount : -lines[0].amount)) * 100) / 100
        : null,
      closingPrinted: lines.length ? lines[lines.length - 1].balance : null
    },
    error: null
  };
}

module.exports = {
  parseDelimited, sniffDelimiter, readTable,
  readings, dateFormats, readDate, readAmount,
  suggestMapping, readLines, verifyBalanceChain, preview
};
