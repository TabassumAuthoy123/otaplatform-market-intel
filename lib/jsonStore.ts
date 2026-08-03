import { readFile, stat } from 'node:fs/promises';

/**
 * Read a JSON file, re-parsing it only when it has actually changed.
 *
 * The design rule for this app is that an edit in the admin portal shows on the
 * next page load, which is why every loader reads from disk rather than holding
 * state. That rule is kept exactly: the cache key is the file's modification
 * time and size, so an admin write invalidates it by definition.
 *
 * What it removes is the waste. content/crm-leads.json is 421 KB for 400 leads
 * and was parsed on every single request; at the 5,800 leads the spec asks for
 * that is roughly 6 MB of JSON.parse per page view, for a file that changes a
 * few times an hour.
 *
 * A read failure is never cached — a truncated file caught mid-write must be
 * retried on the next request, not remembered.
 */

type Entry = { key: string; value: unknown };
const cache = new Map<string, Entry>();

export async function readJsonCached<T>(file: string, fallback: T): Promise<T> {
  try {
    const s = await stat(file);
    const key = `${s.mtimeMs}:${s.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value as T;

    const value = JSON.parse(await readFile(file, 'utf8')) as T;
    cache.set(file, { key, value });
    return value;
  } catch {
    return fallback;
  }
}

/**
 * Same caching, but a missing or corrupt file is an error rather than a silent
 * empty result.
 *
 * The accounting book has no sensible fallback. Returning an empty book would
 * render a dashboard full of zeroes, which reads as "no trading yet" rather than
 * "the file is broken" — the worst possible failure for a set of accounts.
 */
export async function readJsonRequired<T>(file: string, what: string): Promise<T> {
  let raw: string;
  try {
    const s = await stat(file);
    const key = `${s.mtimeMs}:${s.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value as T;
    raw = await readFile(file, 'utf8');
    try {
      const value = JSON.parse(raw) as T;
      cache.set(file, { key, value });
      return value;
    } catch (err) {
      throw new Error(
        `${what} at ${file} is not valid JSON: ${(err as Error).message}. ` +
        'Nothing has been changed. Restore it from a backup in the admin portal, ' +
        'or from content/pre-restore-backup.json if a restore was interrupted.'
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('is not valid JSON')) throw err;
    throw new Error(
      `${what} could not be read from ${file}: ${(err as Error).message}. ` +
      'The app cannot show accounts without it.'
    );
  }
}
