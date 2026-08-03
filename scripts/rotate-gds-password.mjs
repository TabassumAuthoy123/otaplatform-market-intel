/**
 * Swap a GDS password everywhere it is stored, then prove the new one works.
 *
 *   node scripts/rotate-gds-password.mjs travelport
 *   node scripts/rotate-gds-password.mjs sabre
 *
 * WHY THIS EXISTS
 *
 * The Travelport password has been exposed more than once — in a screenshot and
 * in chat — and Travelport's own email says it does not expire, so it stays
 * usable until somebody changes it. Rotating it cannot be done from here:
 * Travelport has no API for it, and it is their portal and the agency's vendor
 * account. It is done in MyTravelport or by their support desk.
 *
 * What CAN be automated is everything after that, which is where the mistakes
 * happen. The same secret lives in two places — this app's .env and the
 * OTAPlatform MySQL config table — and changing one without the other leaves a
 * platform that half works, with a 401 that looks like an outage.
 *
 * This reads the new value from a prompt-free stdin pipe or an argument, writes
 * both, and immediately runs a real search. If the search fails it says so and
 * tells you the old value is still what the supplier expects.
 *
 * The new password is never printed, never logged, and never passed on a command
 * line that a shell would record — pipe it in.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SUPPLIERS = {
  travelport: {
    // The Travelport block is named GDS_* because it was the first and only
    // supplier when those variables were written. Verified against the real
    // .env rather than assumed — the first version of this script guessed
    // TRAVELPORT_PASSWORD and would have refused to run.
    envKey: 'GDS_PASSWORD',
    table: 'travelport_gds_configs',
    column: 'password',
    portal: 'MyTravelport (support.travelport.com) — or ask their support desk to reset it',
    probe: '/api/gds/search?from=DAC&to=DXB&depart=+45'
  },
  sabre: {
    envKey: 'SABRE_PASSWORD',
    table: 'sabre_gds_configs',
    column: 'password',
    portal: 'Sabre Central (central.sabre.com) → Manage Credentials',
    probe: '/api/sabre/search?from=DAC&to=DXB&depart=+45'
  }
};

const which = (process.argv[2] || '').toLowerCase();
const cfg = SUPPLIERS[which];
if (!cfg) {
  console.error(`\nUsage: node scripts/rotate-gds-password.mjs <${Object.keys(SUPPLIERS).join('|')}>`);
  console.error('\nChange the password on the supplier portal FIRST, then pipe the new value in:');
  console.error('  echo "the-new-password" | node scripts/rotate-gds-password.mjs travelport\n');
  process.exit(1);
}

/* -------------------------------------------------------- read the new value */

function readSecret() {
  // Deliberately stdin, not argv: a password on a command line lands in shell
  // history and in the process list, where the whole point was to stop it being
  // somewhere it can be read.
  try {
    const piped = readFileSync(0, 'utf8').trim();
    if (piped) return piped;
  } catch {
    // nothing piped
  }
  return null;
}

const secret = readSecret();
if (!secret) {
  console.error(`\nNothing on stdin. Change it at: ${cfg.portal}`);
  console.error('Then pipe the new value in — do not pass it as an argument:\n');
  console.error(`  echo "the-new-password" | node scripts/rotate-gds-password.mjs ${which}\n`);
  process.exit(1);
}
if (secret.includes('\n')) {
  console.error('\nThat looks like more than one line. Pipe only the password.\n');
  process.exit(1);
}

const mask = (s) => `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)} (${s.length} chars)`;
console.log(`\nRotating ${which}. New value: ${mask(secret)}`);

/* ---------------------------------------------------------------- 1. the .env */

const ENV = '.env';
if (!existsSync(ENV)) {
  console.error(`\n${ENV} does not exist. Copy .env.example to .env first.\n`);
  process.exit(1);
}

copyFileSync(ENV, `${ENV}.before-rotation`);
const before = readFileSync(ENV, 'utf8');
const line = new RegExp(`^${cfg.envKey}=.*$`, 'm');
if (!line.test(before)) {
  console.error(`\n${cfg.envKey} is not in ${ENV}. Add it first so this replaces rather than guesses.\n`);
  process.exit(1);
}
// Quoted, because GDS passwords contain braces and quotes that a shell would eat.
writeFileSync(ENV, before.replace(line, `${cfg.envKey}="${secret}"`));
console.log(`  .env                      updated (previous file kept as .env.before-rotation)`);

/* ------------------------------------------- 2. the OTAPlatform config table */

let dbDone = false;
try {
  execFileSync(
    'docker',
    [
      'exec', '-i', 'otaplatform_mysql',
      'mysql', '-uroot', '-proot', 'otaplatform',
      '-e', `UPDATE ${cfg.table} SET ${cfg.column} = ? WHERE 1 ORDER BY id DESC LIMIT 1;`
    ],
    { input: '', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  dbDone = true;
} catch {
  // Prepared statements are not available through -e, so do it the safe way:
  // hand the value to mysql on stdin rather than interpolating it into argv.
  try {
    const sql = `SET @p = ${JSON.stringify(secret)};\nUPDATE ${cfg.table} SET ${cfg.column} = @p ORDER BY id DESC LIMIT 1;\n`;
    execFileSync(
      'docker',
      ['exec', '-i', 'otaplatform_mysql', 'mysql', '-uroot', '-proot', 'otaplatform'],
      { input: sql, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    dbDone = true;
  } catch (err) {
    console.log(`  ${cfg.table.padEnd(25)} NOT updated — ${String(err.message).split('\n')[0]}`);
  }
}
if (dbDone) console.log(`  ${cfg.table.padEnd(25)} updated in the OTAPlatform database`);

/* ------------------------------------------------------------- 3. prove it works */

console.log('\nRestart the app so it picks up .env, then this script checks the new value.');
console.log('  Ctrl+C the dev server and run: npm run dev:alt');
console.log('\nWaiting for the app to answer on :3002 ...');

const APP = process.env.APP_URL || 'http://127.0.0.1:3002';
const depart = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 45);
  return d.toISOString().slice(0, 10);
})();

let live = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${APP}/portal/flights?from=DAC&to=DXB&depart=${depart}&pax=1`);
    const html = await res.text();
    if (res.ok) {
      const label = which === 'travelport' ? 'Travelport' : 'Sabre';
      const panel = new RegExp(`>${label}</span><span[^>]*>([^<]+)<`).exec(html.replace(/<!--[\s\S]*?-->/g, ''));
      const said = panel?.[1]?.trim() ?? 'no panel';
      const fares = /(\d+) fares/.exec(said);
      if (fares && Number(fares[1]) > 0) {
        console.log(`\n  ${label} answered: ${said}`);
        console.log('  The new password works. Delete .env.before-rotation when you are happy.\n');
        live = true;
      } else if (!/^\s*$/.test(said)) {
        console.log(`\n  ${label} answered: ${said}`);
      }
      break;
    }
  } catch {
    // still restarting
  }
  await new Promise((r) => setTimeout(r, 2000));
}

if (!live) {
  console.log('\n  Could not confirm a live search with the new value.');
  console.log('  Nothing is lost: .env.before-rotation holds the previous file, and the');
  console.log('  supplier still expects whatever is set on their portal. Check the panel on');
  console.log(`  ${APP}/portal/flights?from=DAC&to=DXB&depart=${depart} — it prints the supplier's own error.\n`);
  process.exit(1);
}
