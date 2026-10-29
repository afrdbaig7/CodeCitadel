import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { payloadDigest } from "@codecitadel/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresReportStore, openPostgresDatabase } from "../src/index.js";

const connectionString = process.env.CODECITADEL_TEST_DATABASE_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;
let scratch: string;
let store: PostgresReportStore;
let organization: { id: string; slug: string };
const suffix = randomUUID().replace(/-/g, "");

function insertReport(repositoryName = "checkout") {
  return store.insertRun({
    organizationId: organization.id,
    repository: { name: repositoryName, commit: "abc123", branch: "main" },
    kind: "impact",
    origin: "local",
    capturedAt: "2026-10-25T09:00:00.000Z",
    receivedAt: new Date().toISOString(),
    reportJson: JSON.stringify({ schemaVersion: 1, suffix }),
    outcome: "0 test file(s) selected",
    artifacts: [],
  });
}

describePostgres("PostgresReportStore (real PostgreSQL integration)", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-postgres-test-"));
    store = await PostgresReportStore.open({
      connectionString: connectionString!,
      artifactsDir: path.join(scratch, "artifacts"),
      maxConnections: 3,
    });
    organization = await store.ensureOrganization(`storage-test-${suffix}`);
  }, 30_000);

  afterAll(async () => {
    if (store !== undefined) {
      await store.close();
      const opened = await openPostgresDatabase(connectionString!, { maxConnections: 1 });
      try {
        await opened.db.execute(sql`delete from organizations where id = ${organization.id}`);
      } finally {
        await opened.pool.end();
      }
    }
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  it("applies PostgreSQL migration version 1 and reopens idempotently", async () => {
    expect(store.driver).toBe("postgres");
    expect(store.schemaVersion).toBe(1);
    const reopened = await PostgresReportStore.open({
      connectionString: connectionString!,
      artifactsDir: path.join(scratch, "reopen-artifacts"),
      maxConnections: 1,
    });
    expect(reopened.schemaVersion).toBe(1);
    await reopened.close();
  });

  it("hashes bearer tokens and resolves the authenticated organization", async () => {
    const token = `cc_integration_${suffix}`;
    await store.issueToken({ organizationId: organization.id, token, label: "integration" });
    expect(await store.authenticate(token)).toEqual(organization);
    expect(await store.authenticate(`${token}_wrong`)).toBeNull();
  });

  it("round-trips a report and digest-checked artifact without crossing tenants", async () => {
    const artifact = Buffer.from("postgres assertion trace\n", "utf8");
    const reportJson = JSON.stringify({ schemaVersion: 1, suffix });
    const run = await store.insertRun({
      organizationId: organization.id,
      repository: { name: "checkout", commit: "abc123", branch: "main" },
      kind: "impact",
      origin: "user-ci",
      capturedAt: "2026-10-25T09:00:00.000Z",
      receivedAt: new Date().toISOString(),
      reportJson,
      outcome: "0 test file(s) selected",
      artifacts: [{ name: "trace.txt", digest: payloadDigest(artifact), bytes: artifact }],
    });

    expect(run.reportDigest).toBe(payloadDigest(reportJson));
    expect(run.artifacts).toEqual([
      { name: "trace.txt", digest: payloadDigest(artifact), bytes: artifact.length },
    ]);
    expect((await store.listRuns(organization.id)).map((row) => row.id)).toContain(run.id);
    expect(await store.getRun(organization.id, run.id)).toMatchObject({
      run: { id: run.id, repository: { name: "checkout" } },
      reportJson,
    });
    expect(await store.readArtifact(organization.id, run.id, "trace.txt")).toEqual({
      bytes: artifact,
      digest: payloadDigest(artifact),
    });
    expect(await store.getRun(`other-${suffix}`, run.id)).toBeNull();
    expect(await store.readArtifact(`other-${suffix}`, run.id, "trace.txt")).toBeNull();
  });

  it("reuses a tenant repository under concurrent inserts", async () => {
    const runs = await Promise.all(Array.from({ length: 4 }, () => insertReport("parallel-checkout")));
    expect(new Set(runs.map((run) => run.repository.id)).size).toBe(1);
  });
});
