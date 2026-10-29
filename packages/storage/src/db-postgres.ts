import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { Pool } from "pg";

/** Drizzle's schema is the typed description of the PostgreSQL tables. */
const organizationsTable = pgTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

const repositoriesTable = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("repositories_by_tenant_name").on(table.organizationId, table.name)],
);

const runsTable = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositoriesTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    origin: text("origin").notNull(),
    commitRef: text("commit_ref"),
    branchRef: text("branch_ref"),
    capturedAt: text("captured_at").notNull(),
    receivedAt: text("received_at").notNull(),
    reportDigest: text("report_digest").notNull(),
    reportJson: text("report_json").notNull(),
    outcome: text("outcome"),
    bytes: integer("bytes").notNull(),
  },
  (table) => [index("runs_by_tenant").on(table.organizationId, table.receivedAt)],
);

export const postgresSchema = {
  organizations: organizationsTable,
  apiTokens: pgTable("api_tokens", {
    tokenHash: text("token_hash").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    createdAt: text("created_at").notNull(),
  }),
  repositories: repositoriesTable,
  runs: runsTable,
  artifacts: pgTable(
    "artifacts",
    {
      id: text("id").primaryKey(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organizationsTable.id, { onDelete: "cascade" }),
      runId: text("run_id")
        .notNull()
        .references(() => runsTable.id, { onDelete: "cascade" }),
      name: text("name").notNull(),
      digest: text("digest").notNull(),
      bytes: integer("bytes").notNull(),
      relativePath: text("relative_path").notNull(),
    },
    (table) => [uniqueIndex("artifacts_by_run_name").on(table.runId, table.name)],
  ),
};

/** One version contains ordered SQL statements so each DDL change is reviewable. */
export const POSTGRES_MIGRATIONS: readonly (readonly string[])[] = [
  [
    `create table organizations (id text primary key, slug text not null unique, created_at text not null)`,
    `create table api_tokens (token_hash text primary key, organization_id text not null references organizations(id) on delete cascade, label text not null, created_at text not null)`,
    `create table repositories (id text primary key, organization_id text not null references organizations(id) on delete cascade, name text not null, created_at text not null, unique (organization_id, name))`,
    `create table runs (id text primary key, organization_id text not null references organizations(id) on delete cascade, repository_id text not null references repositories(id) on delete cascade, kind text not null, origin text not null, commit_ref text, branch_ref text, captured_at text not null, received_at text not null, report_digest text not null, report_json text not null, outcome text, bytes integer not null)`,
    `create index runs_by_tenant on runs (organization_id, received_at desc)`,
    `create table artifacts (id text primary key, organization_id text not null references organizations(id) on delete cascade, run_id text not null references runs(id) on delete cascade, name text not null, digest text not null, bytes integer not null, relative_path text not null, unique (run_id, name))`,
  ],
];

export interface OpenedPostgresDatabase {
  db: ReturnType<typeof drizzle<typeof postgresSchema>>;
  pool: Pool;
  schemaVersion: number;
}

/** Opens a bounded pool and applies each unapplied schema version transactionally. */
export async function openPostgresDatabase(
  connectionString: string,
  options: { maxConnections?: number } = {},
): Promise<OpenedPostgresDatabase> {
  const pool = new Pool({ connectionString, max: options.maxConnections ?? 5 });
  const db = drizzle(pool, { schema: postgresSchema });

  try {
    await db.execute(
      sql.raw(
        "create table if not exists schema_migrations (version integer primary key, applied_at text not null)",
      ),
    );

    for (const [index, statements] of POSTGRES_MIGRATIONS.entries()) {
      const version = index + 1;
      await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext('codecitadel-storage-migrations'))`,
        );
        const found = await transaction.execute<{ version: number }>(
          sql`select version from schema_migrations where version = ${version}`,
        );
        if (found.rows.length > 0) return;

        for (const statement of statements) {
          await transaction.execute(sql.raw(statement));
        }
        await transaction.execute(
          sql`insert into schema_migrations (version, applied_at) values (${version}, ${new Date().toISOString()})`,
        );
      });
    }

    const result = await db.execute<{ version: number | null }>(
      sql`select max(version) as version from schema_migrations`,
    );
    return { db, pool, schemaVersion: Number(result.rows[0]?.version ?? 0) };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
