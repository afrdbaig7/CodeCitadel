import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  healthResponseSchema,
  payloadDigest,
  runDetailResponseSchema,
  uploadResponseSchema,
} from "@codecitadel/contracts";
import { PostgresReportStore } from "@codecitadel/storage";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";

const connectionString = process.env.CODECITADEL_TEST_DATABASE_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;
let scratch: string;
const suffix = randomUUID().replace(/-/g, "");
const token = `cc_api_postgres_${suffix}`;
const foreignToken = `cc_api_postgres_foreign_${suffix}`;
let store: PostgresReportStore;
let app: FastifyInstance;
let organization: { id: string; slug: string };
let foreignOrganization: { id: string; slug: string };

const impactReport = {
  schemaVersion: 1,
  generatedAt: "2026-10-25T09:00:00.000Z",
  root: "/repo",
  base: { generatedAt: "2026-10-24T09:00:00.000Z", root: "/repo" },
  changed: [],
  graph: { modules: 0, edges: 0, testFiles: 0, externalImports: 0, outsideScope: 0, unresolved: [] },
  impacted: [],
  tests: { selected: [], notSelected: 0 },
  complete: true,
  incompleteReasons: [],
  limitations: ["No file changed, so no test was selected."],
};

describePostgres("Fastify API with PostgreSQL storage (real integration)", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-api-postgres-"));
    store = await PostgresReportStore.open({
      connectionString: connectionString!,
      artifactsDir: path.join(scratch, "artifacts"),
      maxConnections: 3,
    });
    organization = await store.ensureOrganization(`api-test-${suffix}`);
    foreignOrganization = await store.ensureOrganization(`api-test-foreign-${suffix}`);
    await store.issueToken({ organizationId: organization.id, token, label: "api integration" });
    await store.issueToken({ organizationId: foreignOrganization.id, token: foreignToken, label: "foreign integration" });
    app = buildServer({ store });
  }, 30_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (store !== undefined) {
      await store.close();
      const pool = new Pool({ connectionString: connectionString!, max: 1 });
      try {
        await pool.query("delete from organizations where id = any($1::text[])", [
          [organization.id, foreignOrganization.id],
        ]);
      } finally {
        await pool.end();
      }
    }
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  it("reports PostgreSQL and the applied migration version from health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json()).storage).toMatchObject({ driver: "postgres", schemaVersion: 2 });
  });

  it("uploads, lists, and reads a real report and artifact through the API", async () => {
    const artifact = Buffer.from("database-backed trace\n", "utf8");
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        schemaVersion: 1,
        origin: "user-ci",
        kind: "impact",
        repository: { name: "api-postgres-test", commit: "abc123", branch: "test" },
        capturedAt: "2026-10-25T09:00:00.000Z",
        report: impactReport,
        artifacts: [{
          name: "trace.txt",
          digest: payloadDigest(artifact),
          contentBase64: artifact.toString("base64"),
        }],
      },
    });
    expect(upload.statusCode).toBe(202);
    const run = uploadResponseSchema.parse(upload.json()).run;
    expect(run.organizationId).toBe(organization.id);
    expect(run.artifacts[0]?.digest).toBe(payloadDigest(artifact));

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().runs.map((item: { id: string }) => item.id)).toContain(run.id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${run.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(runDetailResponseSchema.parse(detail.json()).report).toEqual(impactReport);

    const readArtifact = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${run.id}/artifacts/trace.txt`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readArtifact.statusCode).toBe(200);
    expect(readArtifact.headers["x-codecitadel-digest"]).toBe(payloadDigest(artifact));
    expect(readArtifact.rawPayload).toEqual(artifact);
  });

  it("keeps report and artifact reads scoped to the authenticated tenant", async () => {
    const inserted = await store.insertRun({
      organizationId: organization.id,
      repository: { name: "private", commit: null, branch: null },
      kind: "impact",
      origin: "local",
      capturedAt: "2026-10-25T09:00:00.000Z",
      receivedAt: new Date().toISOString(),
      reportJson: JSON.stringify(impactReport),
      outcome: "0 test file(s) selected",
      artifacts: [],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${inserted.id}`,
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(foreignOrganization.id).not.toBe(organization.id);
  });
});
