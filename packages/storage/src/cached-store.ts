import type { StoredRun } from "@codecitadel/contracts";

import type { CacheClient } from "./cache.js";
import type {
  AuditEvent,
  AuthPrincipal,
  CreateManagedRunInput,
  EvidenceStore,
  InsertRunInput,
  IssueTokenInput,
  Organization,
  OrganizationMember,
  OrganizationRole,
  OutboxEventRecord,
  ReadArtifact,
  StoredArtifact,
  StoredRunDetail,
} from "./store.js";

/**
 * Transparent caching decorator for an EvidenceStore.
 * Caches hot run lookups with TTL and automatically purges cache on state modifications.
 */
export class CachedEvidenceStore implements EvidenceStore {
  constructor(
    private readonly underlying: EvidenceStore,
    private readonly cache: CacheClient,
    private readonly ttlSeconds: number = 300,
  ) {}

  get schemaVersion(): number {
    return this.underlying.schemaVersion;
  }

  get driver(): "sqlite" | "postgres" {
    return this.underlying.driver;
  }

  private runKey(organizationId: string, runId: string): string {
    return `cc:run:${encodeURIComponent(organizationId)}:${encodeURIComponent(runId)}`;
  }

  async ensureOrganization(slug: string): Promise<Organization> {
    return this.underlying.ensureOrganization(slug);
  }

  async issueToken(input: IssueTokenInput): Promise<void> {
    return this.underlying.issueToken(input);
  }

  async authenticate(token: string): Promise<AuthPrincipal | null> {
    return this.underlying.authenticate(token);
  }

  async findMembership(issuer: string, subject: string): Promise<AuthPrincipal[]> {
    return this.underlying.findMembership(issuer, subject);
  }

  async createOrganization(slug: string): Promise<Organization> {
    return this.underlying.createOrganization(slug);
  }

  async getOrganization(idOrSlug: string): Promise<Organization | null> {
    return this.underlying.getOrganization(idOrSlug);
  }

  async setMembership(input: {
    organizationId: string;
    issuer: string;
    subject: string;
    role: OrganizationRole;
  }): Promise<void> {
    return this.underlying.setMembership(input);
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return this.underlying.listMembers(organizationId);
  }

  async recordAudit(event: Omit<AuditEvent, "id" | "createdAt">): Promise<void> {
    return this.underlying.recordAudit(event);
  }

  async listAudit(organizationId: string, limit?: number): Promise<AuditEvent[]> {
    return this.underlying.listAudit(organizationId, limit);
  }

  async insertRun(input: InsertRunInput): Promise<StoredRun> {
    const run = await this.underlying.insertRun(input);
    await this.cache.delete(this.runKey(input.organizationId, run.id));
    return run;
  }

  async listRuns(organizationId: string, limit?: number): Promise<StoredRun[]> {
    return this.underlying.listRuns(organizationId, limit);
  }

  async getRun(organizationId: string, runId: string): Promise<StoredRunDetail | null> {
    const key = this.runKey(organizationId, runId);
    const cached = await this.cache.get<StoredRunDetail>(key);
    if (cached !== null) {
      return cached;
    }

    const detail = await this.underlying.getRun(organizationId, runId);
    if (detail !== null) {
      await this.cache.set(key, detail, this.ttlSeconds);
    }
    return detail;
  }

  async readArtifact(organizationId: string, runId: string, name: string): Promise<ReadArtifact | null> {
    return this.underlying.readArtifact(organizationId, runId, name);
  }

  async getArtifact(organizationId: string, runId: string, name: string): Promise<StoredArtifact | null> {
    return this.underlying.getArtifact(organizationId, runId, name);
  }

  async attachArtifact(
    organizationId: string,
    runId: string,
    artifact: { name: string; digest: string; objectKey: string; byteLength: number },
  ): Promise<void> {
    await this.underlying.attachArtifact(organizationId, runId, artifact);
    await this.cache.delete(this.runKey(organizationId, runId));
  }

  async createManagedRun(input: CreateManagedRunInput): Promise<{ runId: string; outboxEventId: string }> {
    return this.underlying.createManagedRun(input);
  }

  async claimOutboxEvents(batchSize?: number): Promise<OutboxEventRecord[]> {
    return this.underlying.claimOutboxEvents(batchSize);
  }

  async markOutboxDispatched(id: string): Promise<void> {
    return this.underlying.markOutboxDispatched(id);
  }

  async markOutboxFailed(id: string, errorMessage: string): Promise<void> {
    return this.underlying.markOutboxFailed(id, errorMessage);
  }

  async updateRunStatus(
    organizationId: string,
    runId: string,
    status: string,
    details?: { outcome?: string; reportJson?: string },
  ): Promise<void> {
    await this.underlying.updateRunStatus(organizationId, runId, status, details);
    await this.cache.delete(this.runKey(organizationId, runId));
  }

  async close(): Promise<void> {
    await this.cache.close();
    await this.underlying.close();
  }
}
