import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

/** Absolute path of the SQL files applied by `migrate`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export function createPool(connectionString: string): Pool {
  // A small pool: the demo is about concurrency between requests, not about
  // saturating the database, and a bound keeps a runaway test from opening
  // hundreds of connections.
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 5_000 });
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

async function migrationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

/**
 * Applies each migration exactly once, in filename order.
 *
 * Every file runs in its own transaction with its own `schema_migrations` row,
 * so a failure leaves the database at the last fully applied version instead of
 * a half-applied one. Two processes migrating at once can still race; the demo
 * assumes a single migrator, and the unique primary key turns a lost race into
 * an error rather than a duplicate row.
 */
export async function migrate(pool: Pool, directory = MIGRATIONS_DIR): Promise<MigrationResult> {
  await pool.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const appliedRows = await pool.query<{ version: string }>("select version from schema_migrations");
  const alreadyApplied = new Set(appliedRows.rows.map((row) => row.version));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of await migrationFiles(directory)) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = await readFile(path.join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [file]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
    applied.push(file);
  }

  return { applied, skipped };
}
