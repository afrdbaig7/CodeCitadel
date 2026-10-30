import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Schema history. Each entry is applied once and recorded, so an existing
 * database is upgraded in order and a fresh one gets the whole history. Hosted
 * mode will use a separate Postgres history; nothing here assumes the SQL is
 * portable, and the contract tests are what the two implementations share.
 */
export const MIGRATIONS: readonly string[] = [
  `create table if not exists organizations (
     id text primary key,
     slug text not null unique,
     created_at text not null
   );
   create table if not exists api_tokens (
     token_hash text primary key,
     organization_id text not null references organizations(id) on delete cascade,
     label text not null,
     created_at text not null
   );
   create table if not exists repositories (
     id text primary key,
     organization_id text not null references organizations(id) on delete cascade,
     name text not null,
     created_at text not null,
     unique (organization_id, name)
   );
   create table if not exists runs (
     id text primary key,
     organization_id text not null references organizations(id) on delete cascade,
     repository_id text not null references repositories(id) on delete cascade,
     kind text not null,
     origin text not null,
     commit_ref text,
     branch_ref text,
     captured_at text not null,
     received_at text not null,
     report_digest text not null,
     report_json text not null,
     outcome text,
     bytes integer not null
   );
   create index if not exists runs_by_tenant on runs (organization_id, received_at desc);
   create table if not exists artifacts (
     id text primary key,
     organization_id text not null references organizations(id) on delete cascade,
     run_id text not null references runs(id) on delete cascade,
     name text not null,
     digest text not null,
     bytes integer not null,
     relative_path text not null,
     unique (run_id, name)
   );`,
  `alter table api_tokens add column role text not null default 'admin';
   alter table artifacts add column storage_driver text not null default 'filesystem';
   create table if not exists oidc_memberships (
     id text primary key,
     organization_id text not null references organizations(id) on delete cascade,
     issuer text not null,
     subject text not null,
     role text not null check (role in ('read_only','upload','admin')),
     created_at text not null,
     unique (organization_id, issuer, subject)
   );
   create index if not exists oidc_memberships_by_identity on oidc_memberships (issuer, subject);
   create table if not exists audit_events (
     id text primary key,
     organization_id text not null references organizations(id) on delete cascade,
     actor text not null,
     action text not null,
     target text not null,
     created_at text not null
   );
   create index if not exists audit_events_by_tenant on audit_events (organization_id, created_at desc);`,
];

export interface OpenedDatabase {
  db: DatabaseSync;
  /** The schema version this database is at after opening. */
  schemaVersion: number;
}

/**
 * Opens (and migrates) the database.
 *
 * WAL and `foreign_keys` are set per connection because SQLite defaults both
 * off; a tenant-owned row must not be able to point at a parent that does not
 * exist. `:memory:` skips directory creation, which is what tests use.
 */
export function openDatabase(file: string): OpenedDatabase {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal;");
  db.exec("pragma foreign_keys = on;");
  db.exec("pragma busy_timeout = 5000;");

  db.exec(`create table if not exists schema_migrations (
    version integer primary key,
    applied_at text not null
  );`);

  const applied = new Set(
    (db.prepare("select version from schema_migrations").all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );

  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (applied.has(version)) {
      return;
    }
    db.exec("begin");
    try {
      db.exec(sql);
      db.prepare("insert into schema_migrations (version, applied_at) values (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  });

  const row = db.prepare("select max(version) as version from schema_migrations").get() as
    | { version: number | null }
    | undefined;

  return { db, schemaVersion: row?.version ?? 0 };
}
