import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  artifactNameSchema,
  payloadDigest,
  type StoredRun,
} from "@codecitadel/contracts";
import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";

import { openPostgresDatabase } from "./db-postgres.js";
import type {
  ArtifactInput,
  EvidenceStore,
  InsertRunInput,
  IssueTokenInput,
  Organization,
  ReadArtifact,
  StoredRunDetail,
} from "./store.js";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

interface RunRow extends QueryResultRow {
  id: string;
  organization_id: string;
  repository_id: string;
  repository_name: string;
  head_commit: string | null;
  head_branch: string | null;
  kind: string;
  origin: string;
  captured_at: string;
  received_at: string;
  report_digest: string;
  outcome: string | null;
  bytes: number;
  report_json?: string;
}

interface ArtifactRow extends QueryResultRow {
  name: string;
  digest: string;
  bytes: number;
  relative_path?: string;
}

/** PostgreSQL implementation of the tenant-scoped evidence store. */
export class PostgresReportStore implements EvidenceStore {
  readonly driver = "postgres" as const;
  readonly schemaVersion: number;
  private readonly db: Awaited<ReturnType<typeof openPostgresDatabase>>["db"];
  private readonly pool: Awaited<ReturnType<typeof openPostgresDatabase>>["pool"];
  private readonly artifactsDir: string;

  private constructor(
    opened: Awaited<ReturnType<typeof openPostgresDatabase>>,
    artifactsDir: string,
  ) {
    this.db = opened.db;
    this.pool = opened.pool;
    this.schemaVersion = opened.schemaVersion;
    this.artifactsDir = path.resolve(artifactsDir);
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  static async open(options: {
    connectionString: string;
    artifactsDir: string;
    maxConnections?: number;
  }): Promise<PostgresReportStore> {
    const opened = await openPostgresDatabase(options.connectionString, {
      ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    });
    return new PostgresReportStore(opened, options.artifactsDir);
  }

  async ensureOrganization(slug: string): Promise<Organization> {
    const result = await this.db.execute<{ id: string; slug: string }>(sql`
      insert into organizations (id, slug, created_at)
      values (${id("org")}, ${slug}, ${new Date().toISOString()})
      on conflict (slug) do update set slug = excluded.slug
      returning id, slug
    `);
    const organization = result.rows[0];
    if (organization === undefined) throw new Error("PostgreSQL did not return the organization row.");
    return organization;
  }

  async issueToken(input: IssueTokenInput): Promise<void> {
    await this.db.execute(sql`
      insert into api_tokens (token_hash, organization_id, label, created_at)
      values (${tokenHash(input.token)}, ${input.organizationId}, ${input.label}, ${new Date().toISOString()})
    `);
  }

  async authenticate(token: string): Promise<Organization | null> {
    const result = await this.db.execute<{ id: string; slug: string }>(sql`
      select o.id, o.slug from api_tokens t
      join organizations o on o.id = t.organization_id
      where t.token_hash = ${tokenHash(token)}
    `);
    return result.rows[0] ?? null;
  }

  private artifactPath(organizationId: string, runId: string, name: string): string {
    if (!artifactNameSchema.safeParse(name).success) {
      throw new Error(`Refusing artifact ${JSON.stringify(name)}: the name is not a safe file name.`);
    }
    const absolute = path.resolve(this.artifactsDir, organizationId, runId, name);
    if (!absolute.startsWith(`${this.artifactsDir}${path.sep}`)) {
      throw new Error(`Refusing artifact ${name}: it resolves outside the artifact directory.`);
    }
    return absolute;
  }

  async insertRun(input: InsertRunInput): Promise<StoredRun> {
    const runId = id("run");
    const repositoryId = id("repo");
    const reportBytes = Buffer.from(input.reportJson, "utf8");
    const reportDigest = payloadDigest(reportBytes);
    const writtenFiles: string[] = [];

    try {
      for (const artifact of input.artifacts) {
        const absolute = this.artifactPath(input.organizationId, runId, artifact.name);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, artifact.bytes, { flag: "wx" });
        writtenFiles.push(absolute);
      }

      await this.db.transaction(async (transaction) => {
        await transaction.execute(sql`
          insert into repositories (id, organization_id, name, created_at)
          values (${repositoryId}, ${input.organizationId}, ${input.repository.name}, ${new Date().toISOString()})
          on conflict (organization_id, name) do nothing
        `);
        const repository = await transaction.execute<{ id: string }>(sql`
          select id from repositories where organization_id = ${input.organizationId}
          and name = ${input.repository.name}
        `);
        const storedRepositoryId = repository.rows[0]?.id;
        if (storedRepositoryId === undefined) throw new Error("PostgreSQL did not return the repository row.");

        await transaction.execute(sql`
          insert into runs (id, organization_id, repository_id, kind, origin, commit_ref,
            branch_ref, captured_at, received_at, report_digest, report_json, outcome, bytes)
          values (${runId}, ${input.organizationId}, ${storedRepositoryId}, ${input.kind}, ${input.origin},
            ${input.repository.commit}, ${input.repository.branch}, ${input.capturedAt}, ${input.receivedAt},
            ${reportDigest}, ${input.reportJson}, ${input.outcome}, ${reportBytes.length})
        `);

        for (const artifact of input.artifacts) {
          await transaction.execute(sql`
            insert into artifacts (id, organization_id, run_id, name, digest, bytes, relative_path)
            values (${id("art")}, ${input.organizationId}, ${runId}, ${artifact.name}, ${artifact.digest},
              ${artifact.bytes.length}, ${path.join(input.organizationId, runId, artifact.name)})
          `);
        }
      });
    } catch (error) {
      for (const file of writtenFiles) rmSync(file, { force: true });
      throw error;
    }

    const stored = await this.getRun(input.organizationId, runId);
    if (stored === null) throw new Error("The run was written but could not be read back.");
    return stored.run;
  }

  private async rowToRun(row: RunRow): Promise<StoredRun> {
    const artifacts = await this.db.execute<ArtifactRow>(sql`
      select name, digest, bytes from artifacts where run_id = ${row.id} order by name
    `);
    return {
      id: row.id,
      organizationId: row.organization_id,
      repository: {
        id: row.repository_id,
        name: row.repository_name,
        commit: row.head_commit,
        branch: row.head_branch,
      },
      kind: row.kind as StoredRun["kind"],
      origin: row.origin as StoredRun["origin"],
      capturedAt: row.captured_at,
      receivedAt: row.received_at,
      reportDigest: row.report_digest,
      outcome: row.outcome,
      bytes: row.bytes,
      artifacts: artifacts.rows,
    };
  }

  async listRuns(organizationId: string, limit = 50): Promise<StoredRun[]> {
    const rows = await this.db.execute<RunRow>(sql`
      select r.id, r.organization_id, r.repository_id, repo.name as repository_name,
        r.commit_ref as head_commit, r.branch_ref as head_branch, r.kind, r.origin,
        r.captured_at, r.received_at, r.report_digest, r.outcome, r.bytes
      from runs r join repositories repo on repo.id = r.repository_id
      where r.organization_id = ${organizationId}
      order by r.received_at desc limit ${limit}
    `);
    return Promise.all(rows.rows.map((row) => this.rowToRun(row)));
  }

  async getRun(organizationId: string, runId: string): Promise<StoredRunDetail | null> {
    const result = await this.db.execute<RunRow>(sql`
      select r.id, r.organization_id, r.repository_id, repo.name as repository_name,
        r.commit_ref as head_commit, r.branch_ref as head_branch, r.kind, r.origin,
        r.captured_at, r.received_at, r.report_digest, r.outcome, r.bytes, r.report_json
      from runs r join repositories repo on repo.id = r.repository_id
      where r.organization_id = ${organizationId} and r.id = ${runId}
    `);
    const row = result.rows[0];
    if (row === undefined || row.report_json === undefined) return null;
    return { run: await this.rowToRun(row), reportJson: row.report_json };
  }

  async readArtifact(organizationId: string, runId: string, name: string): Promise<ReadArtifact | null> {
    const result = await this.db.execute<ArtifactRow>(sql`
      select a.digest, a.relative_path from artifacts a
      join runs r on r.id = a.run_id
      where a.run_id = ${runId} and a.name = ${name} and r.organization_id = ${organizationId}
    `);
    const row = result.rows[0];
    if (row?.relative_path === undefined) return null;
    const absolute = path.resolve(this.artifactsDir, row.relative_path);
    if (!absolute.startsWith(`${this.artifactsDir}${path.sep}`)) {
      throw new Error(`Refusing to read ${name}: the stored path escapes the artifact directory.`);
    }
    return { bytes: readFileSync(absolute), digest: row.digest };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
