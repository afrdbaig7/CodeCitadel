import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  artifactNameSchema,
  payloadDigest,
  type EvidenceOrigin,
  type ReportKind,
  type StoredRun,
} from "@codecitadel/contracts";

import { openDatabase } from "./db.js";

const RUN_COLUMNS = `r.id, r.organization_id, r.repository_id, repo.name as repository_name,
            r.commit_ref as head_commit, r.branch_ref as head_branch, r.kind, r.origin, r.captured_at,
            r.received_at, r.report_digest, r.outcome, r.bytes`;

const RUN_FROM = `from runs r join repositories repo on repo.id = r.repository_id`;

/** A tenant. `slug` is what an operator types; `id` is what rows reference. */
export interface Organization {
  id: string;
  slug: string;
}

export interface IssueTokenInput {
  organizationId: string;
  /** The plaintext token. Only its SHA-256 is stored. */
  token: string;
  label: string;
}

export interface ArtifactInput {
  name: string;
  digest: string;
  bytes: Buffer;
}

export interface InsertRunInput {
  organizationId: string;
  repository: { name: string; commit: string | null; branch: string | null };
  kind: ReportKind;
  origin: EvidenceOrigin;
  capturedAt: string;
  receivedAt: string;
  reportJson: string;
  outcome: string | null;
  artifacts: ArtifactInput[];
}

export interface StoredRunDetail {
  run: StoredRun;
  reportJson: string;
}

export interface ReadArtifact {
  bytes: Buffer;
  digest: string;
}

/** Shared API boundary: SQLite stays synchronous; PostgreSQL operations are async. */
export interface EvidenceStore {
  readonly schemaVersion: number;
  readonly driver: "sqlite" | "postgres";
  ensureOrganization(slug: string): Organization | Promise<Organization>;
  issueToken(input: IssueTokenInput): void | Promise<void>;
  authenticate(token: string): Organization | null | Promise<Organization | null>;
  insertRun(input: InsertRunInput): StoredRun | Promise<StoredRun>;
  listRuns(organizationId: string, limit?: number): StoredRun[] | Promise<StoredRun[]>;
  getRun(organizationId: string, runId: string): StoredRunDetail | null | Promise<StoredRunDetail | null>;
  readArtifact(organizationId: string, runId: string, name: string): ReadArtifact | null | Promise<ReadArtifact | null>;
  close(): void | Promise<void>;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The evidence store. Every read takes the organization it is acting for, so a
 * caller cannot forget the tenant filter and a wrong tenant looks like a missing
 * row rather than a forbidden one — the caller cannot learn that an id exists
 * elsewhere.
 */
export class ReportStore implements EvidenceStore {
  readonly driver = "sqlite" as const;
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private readonly artifactsDir: string;

  constructor(options: { file: string; artifactsDir: string }) {
    const opened = openDatabase(options.file);
    this.db = opened.db;
    this.schemaVersion = opened.schemaVersion;
    this.artifactsDir = path.resolve(options.artifactsDir);
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  /** Creates the organization if the slug is new, and returns it either way. */
  ensureOrganization(slug: string): Organization {
    const existing = this.db
      .prepare("select id, slug from organizations where slug = ?")
      .get(slug) as Organization | undefined;
    if (existing !== undefined) {
      return existing;
    }
    const organization: Organization = { id: id("org"), slug };
    this.db
      .prepare("insert into organizations (id, slug, created_at) values (?, ?, ?)")
      .run(organization.id, organization.slug, new Date().toISOString());
    return organization;
  }

  /** Records a token by hash. The plaintext is never written. */
  issueToken(input: IssueTokenInput): void {
    this.db
      .prepare(
        "insert into api_tokens (token_hash, organization_id, label, created_at) values (?, ?, ?, ?)",
      )
      .run(tokenHash(input.token), input.organizationId, input.label, new Date().toISOString());
  }

  /** The organization a bearer token belongs to, or null. */
  authenticate(token: string): Organization | null {
    const row = this.db
      .prepare(
        `select o.id as id, o.slug as slug
           from api_tokens t
           join organizations o on o.id = t.organization_id
          where t.token_hash = ?`,
      )
      .get(tokenHash(token)) as Organization | undefined;
    return row ?? null;
  }

  private ensureRepository(organizationId: string, name: string): string {
    const existing = this.db
      .prepare("select id from repositories where organization_id = ? and name = ?")
      .get(organizationId, name) as { id: string } | undefined;
    if (existing !== undefined) {
      return existing.id;
    }
    const repositoryId = id("repo");
    this.db
      .prepare(
        "insert into repositories (id, organization_id, name, created_at) values (?, ?, ?, ?)",
      )
      .run(repositoryId, organizationId, name, new Date().toISOString());
    return repositoryId;
  }

  private artifactPath(organizationId: string, runId: string, name: string): string {
    const parsed = artifactNameSchema.safeParse(name);
    if (!parsed.success) {
      throw new Error(`Refusing artifact ${JSON.stringify(name)}: the name is not a safe file name.`);
    }
    const relative = path.join(organizationId, runId, name);
    const absolute = path.resolve(this.artifactsDir, relative);
    if (!absolute.startsWith(`${this.artifactsDir}${path.sep}`)) {
      throw new Error(`Refusing artifact ${name}: it resolves outside the artifact directory.`);
    }
    return absolute;
  }

  /**
   * Stores one validated report and its artifacts atomically from the caller's
   * perspective: artifacts are written first, and a failure removes the partial
   * run row by rolling back the transaction.
   */
  insertRun(input: InsertRunInput): StoredRun {
    const repositoryId = this.ensureRepository(input.organizationId, input.repository.name);
    const runId = id("run");
    const bytes = Buffer.byteLength(input.reportJson, "utf8");
    const digest = payloadDigest(Buffer.from(input.reportJson, "utf8"));

    for (const artifact of input.artifacts) {
      const absolute = this.artifactPath(input.organizationId, runId, artifact.name);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, artifact.bytes, { flag: "wx" });
    }

    this.db.exec("begin");
    try {
      this.db
        .prepare(
          `insert into runs (id, organization_id, repository_id, kind, origin, commit_ref,
                             branch_ref, captured_at, received_at, report_digest, report_json,
                             outcome, bytes)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.organizationId,
          repositoryId,
          input.kind,
          input.origin,
          input.repository.commit,
          input.repository.branch,
          input.capturedAt,
          input.receivedAt,
          digest,
          input.reportJson,
          input.outcome,
          bytes,
        );

      for (const artifact of input.artifacts) {
        this.db
          .prepare(
            `insert into artifacts (id, organization_id, run_id, name, digest, bytes, relative_path)
             values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id("art"),
            input.organizationId,
            runId,
            artifact.name,
            artifact.digest,
            artifact.bytes.length,
            path.join(input.organizationId, runId, artifact.name),
          );
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }

    const stored = this.getRun(input.organizationId, runId);
    if (stored === null) {
      throw new Error("The run was written but could not be read back.");
    }
    return stored.run;
  }

  private rowToRun(row: {
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
  }): StoredRun {
    const artifacts = this.db
      .prepare("select name, digest, bytes from artifacts where run_id = ? order by name")
      .all(row.id) as { name: string; digest: string; bytes: number }[];
    return {
      id: row.id,
      organizationId: row.organization_id,
      repository: {
        id: row.repository_id,
        name: row.repository_name,
        commit: row.head_commit,
        branch: row.head_branch,
      },
      kind: row.kind as ReportKind,
      origin: row.origin as EvidenceOrigin,
      capturedAt: row.captured_at,
      receivedAt: row.received_at,
      reportDigest: row.report_digest,
      outcome: row.outcome,
      bytes: row.bytes,
      artifacts,
    };
  }

  private readonly selectRun = `select ${RUN_COLUMNS} ${RUN_FROM}`;

  /**
   * The list query deliberately omits the report body: a listing must not read
   * every stored report. A detail read needs it, so it asks for the same columns
   * plus the body instead of trusting a cast to add a column the SQL never
   * selected.
   */
  private readonly selectRunDetail = `select ${RUN_COLUMNS}, r.report_json ${RUN_FROM}`;

  listRuns(organizationId: string, limit = 50): StoredRun[] {
    const rows = this.db
      .prepare(`${this.selectRun} where r.organization_id = ? order by r.received_at desc limit ?`)
      .all(organizationId, limit) as Parameters<ReportStore["rowToRun"]>[0][];
    return rows.map((row) => this.rowToRun(row));
  }

  getRun(organizationId: string, runId: string): StoredRunDetail | null {
    const row = this.db
      .prepare(`${this.selectRunDetail} where r.organization_id = ? and r.id = ?`)
      .get(organizationId, runId) as
      | (Parameters<ReportStore["rowToRun"]>[0] & { report_json: string })
      | undefined;
    if (row === undefined) {
      return null;
    }
    return { run: this.rowToRun(row), reportJson: row.report_json };
  }

  readArtifact(organizationId: string, runId: string, name: string): ReadArtifact | null {
    const row = this.db
      .prepare(
        `select a.digest as digest, a.relative_path as relative_path
           from artifacts a join runs r on r.id = a.run_id
          where a.run_id = ? and a.name = ? and r.organization_id = ?`,
      )
      .get(runId, name, organizationId) as { digest: string; relative_path: string } | undefined;
    if (row === undefined) {
      return null;
    }
    const absolute = path.resolve(this.artifactsDir, row.relative_path);
    if (!absolute.startsWith(`${this.artifactsDir}${path.sep}`)) {
      throw new Error(`Refusing to read ${name}: the stored path escapes the artifact directory.`);
    }
    return { bytes: readFileSync(absolute), digest: row.digest };
  }

  close(): void {
    this.db.close();
  }
}
