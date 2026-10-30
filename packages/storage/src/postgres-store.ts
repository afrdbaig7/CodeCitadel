import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { artifactNameSchema, payloadDigest, type StoredRun } from "@codecitadel/contracts";
import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";

import { openPostgresDatabase } from "./db-postgres.js";
import type {
  ArtifactInput, AuditEvent, AuthPrincipal, EvidenceStore, InsertRunInput, IssueTokenInput,
  Organization, OrganizationMember, OrganizationRole, ReadArtifact, StoredArtifact, StoredRunDetail,
} from "./store.js";

function id(prefix: string): string { return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`; }
function tokenHash(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }

interface RunRow extends QueryResultRow {
  id: string; organization_id: string; repository_id: string; repository_name: string;
  head_commit: string | null; head_branch: string | null; kind: string; origin: string;
  captured_at: string; received_at: string; report_digest: string; outcome: string | null;
  bytes: number; report_json?: string;
}
interface ArtifactRow extends QueryResultRow { name: string; digest: string; bytes: number; relative_path?: string; storage_driver?: "filesystem" | "s3"; }

/** PostgreSQL implementation of the tenant-scoped evidence store. */
export class PostgresReportStore implements EvidenceStore {
  readonly driver = "postgres" as const;
  readonly schemaVersion: number;
  private readonly db: Awaited<ReturnType<typeof openPostgresDatabase>>["db"];
  private readonly pool: Awaited<ReturnType<typeof openPostgresDatabase>>["pool"];
  private readonly artifactsDir: string;

  private constructor(opened: Awaited<ReturnType<typeof openPostgresDatabase>>, artifactsDir: string) {
    this.db = opened.db; this.pool = opened.pool; this.schemaVersion = opened.schemaVersion;
    this.artifactsDir = path.resolve(artifactsDir); mkdirSync(this.artifactsDir, { recursive: true });
  }
  static async open(options: { connectionString: string; artifactsDir: string; maxConnections?: number }): Promise<PostgresReportStore> {
    const opened = await openPostgresDatabase(options.connectionString, options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections });
    return new PostgresReportStore(opened, options.artifactsDir);
  }
  async ensureOrganization(slug: string): Promise<Organization> {
    const result = await this.db.execute<{ id: string; slug: string }>(sql`insert into organizations (id,slug,created_at) values (${id("org")},${slug},${new Date().toISOString()}) on conflict(slug) do update set slug=excluded.slug returning id,slug`);
    const organization = result.rows[0]; if (organization === undefined) throw new Error("PostgreSQL did not return the organization row."); return organization;
  }
  async createOrganization(slug: string): Promise<Organization> {
    const result = await this.db.execute<{ id: string; slug: string }>(sql`insert into organizations (id,slug,created_at) values (${id("org")},${slug},${new Date().toISOString()}) on conflict(slug) do nothing returning id,slug`);
    const organization = result.rows[0];
    if (organization === undefined) throw new Error("An organization with that slug already exists.");
    return organization;
  }
  async getOrganization(idOrSlug: string): Promise<Organization | null> {
    const result = await this.db.execute<{ id: string; slug: string }>(sql`select id,slug from organizations where id=${idOrSlug} or slug=${idOrSlug}`);
    return result.rows[0] ?? null;
  }
  async issueToken(input: IssueTokenInput): Promise<void> {
    await this.db.execute(sql`insert into api_tokens(token_hash,organization_id,label,role,created_at) values(${tokenHash(input.token)},${input.organizationId},${input.label},${input.role ?? "admin"},${new Date().toISOString()})`);
  }
  async authenticate(token: string): Promise<AuthPrincipal | null> {
    const result = await this.db.execute<Record<string, unknown>>(sql`select o.id,o.slug,t.role,null as issuer,null as subject from api_tokens t join organizations o on o.id=t.organization_id where t.token_hash=${tokenHash(token)}`);
    const row = result.rows[0]; return row === undefined ? null : { id: String(row.id), slug: String(row.slug), role: row.role as OrganizationRole, issuer: null, subject: null };
  }
  async findMembership(issuer: string, subject: string): Promise<AuthPrincipal[]> {
    const result = await this.db.execute<Record<string, unknown>>(sql`select o.id,o.slug,m.role,m.issuer,m.subject from oidc_memberships m join organizations o on o.id=m.organization_id where m.issuer=${issuer} and m.subject=${subject} order by o.slug`);
    return result.rows.map((row) => ({ id: String(row.id), slug: String(row.slug), role: row.role as OrganizationRole, issuer: String(row.issuer), subject: String(row.subject) }));
  }
  async setMembership(input: { organizationId: string; issuer: string; subject: string; role: OrganizationRole }): Promise<void> {
    await this.db.execute(sql`insert into oidc_memberships(id,organization_id,issuer,subject,role,created_at) values(${id("mem")},${input.organizationId},${input.issuer},${input.subject},${input.role},${new Date().toISOString()}) on conflict(organization_id,issuer,subject) do update set role=excluded.role`);
  }
  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const result = await this.db.execute<Record<string, unknown>>(sql`select o.id,o.slug,m.role,m.issuer,m.subject,m.created_at from oidc_memberships m join organizations o on o.id=m.organization_id where m.organization_id=${organizationId} order by m.issuer,m.subject`);
    return result.rows.map((row) => ({ id: String(row.id), slug: String(row.slug), role: row.role as OrganizationRole, issuer: String(row.issuer), subject: String(row.subject), createdAt: String(row.created_at) }));
  }
  async recordAudit(event: Omit<AuditEvent, "id" | "createdAt">): Promise<void> {
    await this.db.execute(sql`insert into audit_events(id,organization_id,actor,action,target,created_at) values(${id("audit")},${event.organizationId},${event.actor},${event.action},${event.target},${new Date().toISOString()})`);
  }
  async listAudit(organizationId: string, limit = 100): Promise<AuditEvent[]> {
    const result = await this.db.execute<Record<string, unknown>>(sql`select id,organization_id,actor,action,target,created_at from audit_events where organization_id=${organizationId} order by created_at desc limit ${limit}`);
    return result.rows.map((row) => ({ id: String(row.id), organizationId: String(row.organization_id), actor: String(row.actor), action: String(row.action), target: String(row.target), createdAt: String(row.created_at) }));
  }
  private artifactPath(organizationId: string, runId: string, name: string): string {
    if (!artifactNameSchema.safeParse(name).success) throw new Error("Refusing artifact: unsafe name.");
    const absolute = path.resolve(this.artifactsDir, organizationId, runId, name);
    if (!absolute.startsWith(`${this.artifactsDir}${path.sep}`)) throw new Error("Artifact path escapes storage directory.");
    return absolute;
  }
  async insertRun(input: InsertRunInput): Promise<StoredRun> {
    const runId = id("run"); const reportBytes = Buffer.from(input.reportJson, "utf8"); const digest = payloadDigest(reportBytes); const written: string[] = [];
    try {
      for (const artifact of input.artifacts) {
        if (artifact.bytes === undefined) { if (artifact.objectKey === undefined || artifact.byteLength === undefined) throw new Error("Object-backed artifact needs key and size."); continue; }
        const file = this.artifactPath(input.organizationId, runId, artifact.name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, artifact.bytes, { flag: "wx" }); written.push(file);
      }
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`insert into repositories(id,organization_id,name,created_at) values(${id("repo")},${input.organizationId},${input.repository.name},${new Date().toISOString()}) on conflict(organization_id,name) do nothing`);
        const repo = await tx.execute<{ id: string }>(sql`select id from repositories where organization_id=${input.organizationId} and name=${input.repository.name}`);
        const repoId = repo.rows[0]?.id; if (repoId === undefined) throw new Error("Repository row missing after insert.");
        await tx.execute(sql`insert into runs(id,organization_id,repository_id,kind,origin,commit_ref,branch_ref,captured_at,received_at,report_digest,report_json,outcome,bytes) values(${runId},${input.organizationId},${repoId},${input.kind},${input.origin},${input.repository.commit},${input.repository.branch},${input.capturedAt},${input.receivedAt},${digest},${input.reportJson},${input.outcome},${reportBytes.length})`);
        for (const artifact of input.artifacts) await tx.execute(sql`insert into artifacts(id,organization_id,run_id,name,digest,bytes,relative_path,storage_driver) values(${id("art")},${input.organizationId},${runId},${artifact.name},${artifact.digest},${artifact.byteLength ?? artifact.bytes?.length ?? 0},${artifact.objectKey ?? path.join(input.organizationId,runId,artifact.name)},${artifact.objectKey === undefined ? "filesystem" : "s3"})`);
      });
    } catch (error) { for (const file of written) rmSync(file, { force: true }); throw error; }
    const stored = await this.getRun(input.organizationId, runId); if (stored === null) throw new Error("Written run could not be read back."); return stored.run;
  }
  private async rowToRun(row: RunRow): Promise<StoredRun> {
    const result = await this.db.execute<ArtifactRow>(sql`select name,digest,bytes from artifacts where run_id=${row.id} order by name`);
    return { id: row.id, organizationId: row.organization_id, repository: { id: row.repository_id, name: row.repository_name, commit: row.head_commit, branch: row.head_branch }, kind: row.kind as StoredRun["kind"], origin: row.origin as StoredRun["origin"], capturedAt: row.captured_at, receivedAt: row.received_at, reportDigest: row.report_digest, outcome: row.outcome, bytes: row.bytes, artifacts: result.rows };
  }
  async listRuns(organizationId: string, limit = 50): Promise<StoredRun[]> {
    const result = await this.db.execute<RunRow>(sql`select r.id,r.organization_id,r.repository_id,repo.name as repository_name,r.commit_ref as head_commit,r.branch_ref as head_branch,r.kind,r.origin,r.captured_at,r.received_at,r.report_digest,r.outcome,r.bytes from runs r join repositories repo on repo.id=r.repository_id where r.organization_id=${organizationId} order by r.received_at desc limit ${limit}`);
    return Promise.all(result.rows.map((row) => this.rowToRun(row)));
  }
  async getRun(organizationId: string, runId: string): Promise<StoredRunDetail | null> {
    const result = await this.db.execute<RunRow>(sql`select r.id,r.organization_id,r.repository_id,repo.name as repository_name,r.commit_ref as head_commit,r.branch_ref as head_branch,r.kind,r.origin,r.captured_at,r.received_at,r.report_digest,r.outcome,r.bytes,r.report_json from runs r join repositories repo on repo.id=r.repository_id where r.organization_id=${organizationId} and r.id=${runId}`);
    const row = result.rows[0]; if (row === undefined || row.report_json === undefined) return null; return { run: await this.rowToRun(row), reportJson: row.report_json };
  }
  async getArtifact(organizationId: string, runId: string, name: string): Promise<StoredArtifact | null> {
    if (!artifactNameSchema.safeParse(name).success) return null;
    const result = await this.db.execute<ArtifactRow>(sql`select a.name,a.digest,a.bytes,a.relative_path,a.storage_driver from artifacts a join runs r on r.id=a.run_id where r.organization_id=${organizationId} and r.id=${runId} and a.name=${name}`);
    const row = result.rows[0]; return row === undefined ? null : { name: row.name, digest: row.digest, bytes: row.bytes, objectKey: row.relative_path ?? "", storageDriver: row.storage_driver ?? "filesystem" };
  }
  async attachArtifact(organizationId: string, runId: string, artifact: ArtifactInput & { objectKey: string; byteLength: number }): Promise<void> {
    if (!artifactNameSchema.safeParse(artifact.name).success || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0 || !artifact.objectKey.startsWith(`artifacts/${encodeURIComponent(organizationId)}/${encodeURIComponent(runId)}/${artifact.name}/`)) throw new Error("Invalid artifact metadata.");
    const run = await this.getRun(organizationId, runId); if (run === null) throw new Error("Run not found in this organization.");
    await this.db.execute(sql`insert into artifacts(id,organization_id,run_id,name,digest,bytes,relative_path,storage_driver) values(${id("art")},${organizationId},${runId},${artifact.name},${artifact.digest},${artifact.byteLength},${artifact.objectKey},'s3')`);
  }
  async readArtifact(organizationId: string, runId: string, name: string): Promise<ReadArtifact | null> {
    const artifact = await this.getArtifact(organizationId, runId, name); if (artifact === null || artifact.storageDriver === "s3") return null;
    const file = path.resolve(this.artifactsDir, artifact.objectKey); if (!file.startsWith(`${this.artifactsDir}${path.sep}`)) throw new Error("Stored artifact path escapes storage directory.");
    return { bytes: readFileSync(file), digest: artifact.digest };
  }
  async close(): Promise<void> { await this.pool.end(); }
}
