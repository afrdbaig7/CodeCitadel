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

export type OrganizationRole = "read_only" | "upload" | "admin";

export interface AuthPrincipal extends Organization {
  role: OrganizationRole;
  issuer: string | null;
  subject: string | null;
}

export interface OrganizationMember extends AuthPrincipal {
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  actor: string;
  action: string;
  target: string;
  createdAt: string;
}

export interface IssueTokenInput {
  organizationId: string;
  /** The plaintext token. Only its SHA-256 is stored. */
  token: string;
  label: string;
  role?: OrganizationRole;
}

export interface ArtifactInput {
  name: string;
  digest: string;
  bytes?: Buffer;
  objectKey?: string;
  byteLength?: number;
}

export interface StoredArtifact {
  name: string;
  digest: string;
  bytes: number;
  storageDriver: "filesystem" | "s3";
  objectKey: string;
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
  authenticate(token: string): AuthPrincipal | null | Promise<AuthPrincipal | null>;
  findMembership(issuer: string, subject: string): AuthPrincipal[] | Promise<AuthPrincipal[]>;
  createOrganization(slug: string): Organization | Promise<Organization>;
  getOrganization(idOrSlug: string): Organization | null | Promise<Organization | null>;
  setMembership(input: { organizationId: string; issuer: string; subject: string; role: OrganizationRole }): void | Promise<void>;
  listMembers(organizationId: string): OrganizationMember[] | Promise<OrganizationMember[]>;
  recordAudit(event: Omit<AuditEvent, "id" | "createdAt">): void | Promise<void>;
  listAudit(organizationId: string, limit?: number): AuditEvent[] | Promise<AuditEvent[]>;
  insertRun(input: InsertRunInput): StoredRun | Promise<StoredRun>;
  listRuns(organizationId: string, limit?: number): StoredRun[] | Promise<StoredRun[]>;
  getRun(organizationId: string, runId: string): StoredRunDetail | null | Promise<StoredRunDetail | null>;
  readArtifact(organizationId: string, runId: string, name: string): ReadArtifact | null | Promise<ReadArtifact | null>;
  getArtifact(organizationId: string, runId: string, name: string): StoredArtifact | null | Promise<StoredArtifact | null>;
  attachArtifact(organizationId: string, runId: string, artifact: ArtifactInput & { objectKey: string; byteLength: number }): void | Promise<void>;
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
        "insert into api_tokens (token_hash, organization_id, label, role, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(tokenHash(input.token), input.organizationId, input.label, input.role ?? "admin", new Date().toISOString());
  }

  /** The organization a bearer token belongs to, or null. */
  authenticate(token: string): AuthPrincipal | null {
    const row = this.db
      .prepare(
        `select o.id, o.slug, t.role, null as issuer, null as subject
           from api_tokens t join organizations o on o.id = t.organization_id
          where t.token_hash = ?`,
      )
      .get(tokenHash(token)) as AuthPrincipal | undefined;
    return row ?? null;
  }

  findMembership(issuer: string, subject: string): AuthPrincipal[] {
    return this.db.prepare(`select o.id,o.slug,m.role,m.issuer,m.subject from oidc_memberships m
      join organizations o on o.id=m.organization_id where m.issuer=? and m.subject=? order by o.slug`)
      .all(issuer, subject) as unknown as AuthPrincipal[];
  }

  createOrganization(slug: string): Organization {
    const organization: Organization = { id: id("org"), slug };
    this.db.prepare("insert into organizations (id, slug, created_at) values (?, ?, ?)")
      .run(organization.id, organization.slug, new Date().toISOString());
    return organization;
  }

  getOrganization(idOrSlug: string): Organization | null {
    const row = this.db.prepare("select id,slug from organizations where id=? or slug=?")
      .get(idOrSlug, idOrSlug) as Organization | undefined;
    return row ?? null;
  }

  setMembership(input: { organizationId: string; issuer: string; subject: string; role: OrganizationRole }): void {
    this.db.prepare(`insert into oidc_memberships(id,organization_id,issuer,subject,role,created_at)
      values(?,?,?,?,?,?) on conflict(organization_id,issuer,subject) do update set role=excluded.role`)
      .run(id("mem"), input.organizationId, input.issuer, input.subject, input.role, new Date().toISOString());
  }

  listMembers(organizationId: string): OrganizationMember[] {
    return this.db.prepare(`select o.id,o.slug,m.role,m.issuer,m.subject,m.created_at as "createdAt"
      from oidc_memberships m join organizations o on o.id=m.organization_id
      where m.organization_id=? order by m.issuer,m.subject`).all(organizationId) as unknown as OrganizationMember[];
  }

  recordAudit(event: Omit<AuditEvent, "id" | "createdAt">): void {
    this.db.prepare("insert into audit_events(id,organization_id,actor,action,target,created_at) values(?,?,?,?,?,?)")
      .run(id("audit"), event.organizationId, event.actor, event.action, event.target, new Date().toISOString());
  }

  listAudit(organizationId: string, limit = 100): AuditEvent[] {
    return this.db.prepare(`select id,organization_id as "organizationId",actor,action,target,created_at as "createdAt"
      from audit_events where organization_id=? order by created_at desc limit ?`).all(organizationId, limit) as unknown as AuditEvent[];
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
      if (artifact.bytes === undefined) throw new Error("SQLite storage requires artifact bytes.");
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
            `insert into artifacts (id, organization_id, run_id, name, digest, bytes, relative_path, storage_driver)
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id("art"),
            input.organizationId,
            runId,
            artifact.name,
            artifact.digest,
            artifact.byteLength ?? artifact.bytes?.length ?? 0,
            artifact.objectKey ?? path.join(input.organizationId, runId, artifact.name),
            artifact.objectKey === undefined ? "filesystem" : "s3",
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

  getArtifact(organizationId: string, runId: string, name: string): StoredArtifact | null {
    const row = this.db.prepare(`select a.digest,a.bytes,a.relative_path,a.storage_driver from artifacts a
      join runs r on r.id=a.run_id where r.organization_id=? and r.id=? and a.name=?`)
      .get(organizationId, runId, name) as { digest: string; bytes: number; relative_path: string; storage_driver: "filesystem" | "s3" } | undefined;
    if (row === undefined) return null;
    return { name, digest: row.digest, bytes: row.bytes, objectKey: row.relative_path, storageDriver: row.storage_driver };
  }

  attachArtifact(organizationId: string, runId: string, artifact: ArtifactInput & { objectKey: string; byteLength: number }): void {
    if (!artifactNameSchema.safeParse(artifact.name).success || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0 || !artifact.objectKey.startsWith(`artifacts/${encodeURIComponent(organizationId)}/${encodeURIComponent(runId)}/${artifact.name}/`)) throw new Error("Invalid artifact metadata.");
    const run = this.db.prepare("select 1 from runs where id=? and organization_id=?").get(runId, organizationId);
    if (run === undefined) throw new Error("Run not found in this organization.");
    this.db.prepare(`insert into artifacts(id,organization_id,run_id,name,digest,bytes,relative_path,storage_driver)
      values(?,?,?,?,?,?,?, 's3')`).run(id("art"), organizationId, runId, artifact.name, artifact.digest, artifact.byteLength, artifact.objectKey);
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
