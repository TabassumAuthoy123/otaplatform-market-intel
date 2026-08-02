import { readFileSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of the schema file.
 *
 * `datasource { url = env("DATABASE_URL") }` is rejected outright by the CLI
 * from version 7 onwards. This project pins no Prisma version, so `npx prisma`
 * fetches the latest — which means the command README hands to the DBA team,
 * `npx prisma migrate dev --name init`, had quietly stopped working. Nothing
 * here runs Prisma, so nothing noticed.
 *
 * The URL lives here now and `prisma/schema.prisma` stays a pure description of
 * the tables, which is the half the DBA team actually reads.
 */

/**
 * Read DATABASE_URL from .env without depending on dotenv.
 *
 * The schema is a handoff artefact, not something this app runs, so it carries
 * no Prisma or dotenv dependency. This config therefore has to work with
 * nothing installed beyond the CLI that npx just downloaded.
 */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('DATABASE_URL='));
    const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  } catch {
    // no .env on this machine — fall through to the local default
  }
  // The OTAPlatform MySQL container publishes 3306 on host port 3307.
  return 'mysql://root:root@127.0.0.1:3307/ota_market_intel';
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: databaseUrl() }
});
