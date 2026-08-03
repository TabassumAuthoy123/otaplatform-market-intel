'use strict';

/**
 * A small job runner, hosted inside the admin portal.
 *
 * WHY HERE AND NOT A NEW SERVICE
 *
 * The admin portal is already a long-running Node process with the write path,
 * the atomic-write helpers and the audit log in it. A separate scheduler would
 * be a second thing to start, a second thing to forget to start, and a second
 * place that writes content/. This runs in-process and needs nothing installed.
 *
 * FOUR PROPERTIES THAT MATTER
 *
 * 1. **A dead scheduler must be obvious.** Every run stamps its outcome, and the
 *    alerts screen shows how long ago each job last completed. A scheduler that
 *    quietly stopped is worse than none, because the screen looks calm either
 *    way and everybody trusts it more.
 *
 * 2. **A job that throws becomes an alert.** Failing silently is the exact
 *    failure mode this whole file exists to remove.
 *
 * 3. **Alerts are derived, not accumulated.** Each run replaces that job's
 *    alerts wholesale, so anything fixed disappears on the next pass without
 *    anybody closing it. Only `firstSeen` and an acknowledgement are remembered,
 *    because "how long has this been broken" cannot be derived from a book that
 *    is already correct again.
 *
 * 4. **Jobs never overlap.** One at a time, and never while another is running,
 *    so two passes cannot fight over the same file.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const clock = require('./clock.js');
const { jobs } = require('./jobs.js');

const TICK_MS = 60 * 1000;

/** How many dated backups to keep before the oldest is dropped. */
const KEEP_BACKUPS = 14;

function createScheduler({ contentDir, readJson, writeJsonAtomic, appUrl, backupSet, onAudit }) {
  const ALERTS = path.join(contentDir, 'alerts.json');
  const STATE = path.join(contentDir, 'scheduler-state.json');
  const BACKUP_DIR = path.join(contentDir, 'backups');

  let running = false;
  let timer = null;
  let startedAt = null;

  const state = () => readJson(STATE, { jobs: {} });
  const alerts = () => readJson(ALERTS, { open: [], acknowledged: {} });

  /* ------------------------------------------------------------- backups */

  async function writeDailyBackup() {
    try {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      const stamp = clock.todayIn(zone());
      const file = path.join(BACKUP_DIR, `book-${stamp}.json`);
      const payload = { takenAt: new Date().toISOString(), takenBy: 'scheduler', files: {} };
      for (const name of backupSet) {
        const full = path.join(contentDir, name);
        if (fs.existsSync(full)) payload.files[name] = readJson(full, null);
      }
      if (Object.keys(payload.files).length === 0) {
        return { ok: false, error: 'None of the managed files exist, so there was nothing to back up.' };
      }
      await writeJsonAtomic(file, payload);

      // Keep the newest few. Unbounded dated backups fill a disk quietly, and a
      // full disk is how the atomic writes start failing.
      const kept = fs.readdirSync(BACKUP_DIR).filter((f) => /^book-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_BACKUPS))) {
        try {
          fs.unlinkSync(path.join(BACKUP_DIR, old));
        } catch {
          /* a backup we could not delete is not worth failing the job over */
        }
      }
      return { ok: true, file, kept: Math.min(kept.length, KEEP_BACKUPS) };
    } catch (err) {
      return { ok: false, error: `${err.message}.` };
    }
  }

  function zone() {
    const book = readJson(path.join(contentDir, 'accounting.json'), {});
    return (book.company && book.company.timezone) || clock.DEFAULT_ZONE;
  }

  const ctx = { readJson, contentDir, appUrl, writeDailyBackup };
  const defs = jobs(ctx);

  /* --------------------------------------------------------------- a pass */

  async function runJob(def, reason) {
    const began = Date.now();
    let produced = [];
    let error = null;
    try {
      produced = (await def.run()) ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Rule 2: the failure IS the alert, and it is attributed to the job so a
      // broken check can never look like a clean one.
      produced = [{
        id: `job_failed:${def.key}`,
        severity: 'critical',
        title: `The "${def.label}" check could not run`,
        detail: `${error} Until this runs, nothing it watches is being watched.`,
        where: '/alerts'
      }];
    }

    const now = new Date().toISOString();
    const store = alerts();

    // Rule 3: this job's alerts are replaced entirely. firstSeen survives so the
    // age of a problem is real, and an acknowledgement survives until the
    // problem itself goes away.
    const mine = new Set(produced.map((a) => a.id));
    const previous = new Map((store.open ?? []).filter((a) => a.job === def.key).map((a) => [a.id, a]));
    const others = (store.open ?? []).filter((a) => a.job !== def.key);

    store.open = [
      ...others,
      ...produced.map((a) => ({
        ...a,
        job: def.key,
        jobLabel: def.label,
        firstSeen: previous.get(a.id)?.firstSeen ?? now,
        lastSeen: now
      }))
    ];
    // An acknowledgement on something that has gone away is noise.
    for (const id of Object.keys(store.acknowledged ?? {})) {
      if (!store.open.some((a) => a.id === id)) delete store.acknowledged[id];
    }
    await writeJsonAtomic(ALERTS, store);

    const st = state();
    st.jobs[def.key] = {
      label: def.label,
      lastRunAt: now,
      lastRunLocal: clock.stampIn(zone()),
      elapsedMs: Date.now() - began,
      reason,
      ok: !error,
      error,
      raised: produced.length,
      closed: [...previous.keys()].filter((id) => !mine.has(id)).length
    };
    st.lastTickAt = now;
    await writeJsonAtomic(STATE, st);

    // Only worth an audit line when something changed, or the check broke.
    const closedNow = [...previous.keys()].filter((id) => !mine.has(id)).length;
    if (onAudit && (error || produced.length !== previous.size || closedNow)) {
      await onAudit({
        action: 'update',
        collection: 'scheduler',
        id: def.key,
        summary: error
          ? `Check "${def.label}" failed: ${error}`
          : `Check "${def.label}" — ${produced.length} open, ${closedNow} closed`
      });
    }

    return { key: def.key, raised: produced.length, error };
  }

  /** Which jobs are due, by their own interval. */
  function due(now = Date.now()) {
    const st = state();
    return defs.filter((d) => {
      const last = st.jobs?.[d.key]?.lastRunAt;
      if (!last) return true;
      return now - Date.parse(last) >= d.everyMinutes * 60 * 1000;
    });
  }

  async function tick(reason = 'schedule') {
    // Rule 4. A long GDS check must not have a second pass start underneath it.
    if (running) return { skipped: 'a pass is already running' };
    running = true;
    try {
      const ran = [];
      for (const def of due()) ran.push(await runJob(def, reason));
      const st = state();
      st.lastTickAt = new Date().toISOString();
      await writeJsonAtomic(STATE, st);
      return { ran };
    } finally {
      running = false;
    }
  }

  async function runAll(reason = 'manual') {
    if (running) return { skipped: 'a pass is already running' };
    running = true;
    try {
      const ran = [];
      for (const def of defs) ran.push(await runJob(def, reason));
      return { ran };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    startedAt = new Date().toISOString();
    // A first pass shortly after boot, not immediately: the app on :3002 may
    // still be compiling, and a check that fails because nothing was listening
    // yet would raise an alert about itself.
    setTimeout(() => { tick('startup').catch(() => {}); }, 15000);
    timer = setInterval(() => { tick('schedule').catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * Everything the alerts screen needs, including how stale each job is.
   *
   * `overdueBy` is the point: it is what makes a stopped scheduler visible. A
   * job whose interval has passed twice over is not quiet, it is not running.
   */
  function status() {
    const st = state();
    const store = alerts();
    const now = Date.now();
    const acked = store.acknowledged ?? {};

    const list = (store.open ?? []).map((a) => ({ ...a, ack: acked[a.id] ?? null }));
    const order = { critical: 0, warning: 1, info: 2 };
    list.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || String(a.firstSeen).localeCompare(String(b.firstSeen)));

    return {
      running: Boolean(timer),
      startedAt,
      lastTickAt: st.lastTickAt ?? null,
      alerts: list,
      counts: {
        critical: list.filter((a) => a.severity === 'critical' && !a.ack).length,
        warning: list.filter((a) => a.severity === 'warning' && !a.ack).length,
        info: list.filter((a) => a.severity === 'info' && !a.ack).length,
        acknowledged: list.filter((a) => a.ack).length
      },
      jobs: defs.map((d) => {
        const j = st.jobs?.[d.key];
        const lastMs = j?.lastRunAt ? now - Date.parse(j.lastRunAt) : null;
        const intervalMs = d.everyMinutes * 60 * 1000;
        return {
          key: d.key,
          label: d.label,
          why: d.why,
          everyMinutes: d.everyMinutes,
          lastRunAt: j?.lastRunAt ?? null,
          lastRunLocal: j?.lastRunLocal ?? null,
          elapsedMs: j?.elapsedMs ?? null,
          ok: j?.ok ?? null,
          error: j?.error ?? null,
          raised: j?.raised ?? null,
          neverRun: !j,
          // Two intervals late is not a slow job, it is a stopped one.
          overdue: lastMs !== null && lastMs > intervalMs * 2,
          overdueBy: lastMs !== null ? Math.max(0, Math.round((lastMs - intervalMs) / 60000)) : null
        };
      })
    };
  }

  async function acknowledge(id, email, note) {
    const store = alerts();
    if (!(store.open ?? []).some((a) => a.id === id)) return false;
    store.acknowledged = store.acknowledged ?? {};
    store.acknowledged[id] = { by: email, at: clock.stampIn(zone()), note: String(note ?? '').slice(0, 240) };
    await writeJsonAtomic(ALERTS, store);
    return true;
  }

  async function unacknowledge(id) {
    const store = alerts();
    if (!store.acknowledged?.[id]) return false;
    delete store.acknowledged[id];
    await writeJsonAtomic(ALERTS, store);
    return true;
  }

  return { start, stop, tick, runAll, status, acknowledge, unacknowledge, definitions: defs };
}

module.exports = { createScheduler, KEEP_BACKUPS };
