import { randomBytes } from "node:crypto";

import { Pool } from "pg";

import { migrate } from "../../src/db.ts";

/**
 * Where the demo's disposable PostgreSQL lives.
 *
 * The default matches the container the demo documentation starts
 * (`postgres:16-alpine` on host port 55432). Overriding it with
 * `CODECITADEL_DEMO_PG_URL` is how a developer points the demo at a different
 * scratch server; the value must be a database this fixture is allowed to create
 * and drop databases in, because every test run creates its own.
 */
export const DEMO_ADMIN_URL =
  process.env.CODECITADEL_DEMO_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres";

export interface DisposableDatabase {
  /** The generated database name, for assertions and error messages. */
  name: string;
  /** A connection string for the disposable database itself. */
  url: string;
  /** A pool for the disposable database, already migrated. */
  pool: Pool;
  /** Closes the pool and drops the database, even if clients are still connected. */
  drop: () => Promise<void>;
}

function databaseUrlFor(name: string): string {
  const url = new URL(DEMO_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Creates a database for one test run, so tests never share rows and a failed
 * run cannot leave state behind for the next one. The name is generated here
 * from random bytes: nothing from the environment is interpolated into SQL
 * unquoted.
 */
export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const name = `cc_demo_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: DEMO_ADMIN_URL, max: 1 });
  try {
    await admin.query(`create database "${name}"`);
  } catch (error) {
    throw new Error(
      `Cannot create the disposable database ${name} at ${DEMO_ADMIN_URL}: ${(error as Error).message}. ` +
        "Start the demo database with `docker run --rm -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine`.",
    );
  } finally {
    await admin.end();
  }

  const url = databaseUrlFor(name);
  const pool = new Pool({ connectionString: url, max: 10 });
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    name,
    url,
    pool,
    drop: async () => {
      await pool.end();
      const cleanup = new Pool({ connectionString: DEMO_ADMIN_URL, max: 1 });
      try {
        await cleanup.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function seedUser(pool: Pool, email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into users (email) values ($1) returning id",
    [email],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Seeding a user returned no row.");
  }
  return row.id;
}

export async function seedCoupon(pool: Pool, code: string, percentOff = 25): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into coupons (code, percent_off) values ($1, $2) returning id",
    [code, percentOff],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Seeding a coupon returned no row.");
  }
  return row.id;
}

export async function countRedemptions(pool: Pool, userId: string, couponId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from redemptions where user_id = $1 and coupon_id = $2",
    [userId, couponId],
  );
  return Number(result.rows[0]?.count ?? "0");
}
