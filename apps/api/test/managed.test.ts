import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  API_SCHEMA_VERSION,
  managedRunResponseSchema,
  runDetailResponseSchema,
} from "@codecitadel/contracts";
import { EmbeddedOrchestrationEngine, OutboxDispatcher } from "@codecitadel/orchestrator";
import { ReportStore } from "@codecitadel/storage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-api-managed-"));
let app: FastifyInstance;
let store: ReportStore;
let acme: { id: string; slug: string };
const ADMIN_TOKEN = "cc_admin_secret_token";
const READONLY_TOKEN = "cc_readonly_secret_token";

beforeAll(async () => {
  store = new ReportStore({
    file: path.join(scratch, "evidence.db"),
    artifactsDir: path.join(scratch, "artifacts"),
  });

  acme = store.ensureOrganization("acme-managed");
  store.issueToken({
    organizationId: acme.id,
    token: ADMIN_TOKEN,
    label: "admin",
    role: "admin",
  });
  store.issueToken({
    organizationId: acme.id,
    token: READONLY_TOKEN,
    label: "viewer",
    role: "read_only",
  });

  app = buildServer({ store });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.close();
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

describe("POST /api/v1/runs/managed (Managed Execution API)", () => {
  it("enqueues a managed run and returns 202 Accepted with statusUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs/managed",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        schemaVersion: API_SCHEMA_VERSION,
        repository: { name: "billing-service", commit: "commit123", branch: "main" },
        check: { kind: "scan" },
        budget: { timeoutMs: 45_000, maxFiles: 200 },
      },
    });

    expect(res.statusCode).toBe(202);
    const parsed = managedRunResponseSchema.parse(JSON.parse(res.body));
    expect(parsed.status).toBe("queued");
    expect(parsed.statusUrl).toBe(`/api/v1/runs/${parsed.runId}`);

    // Verify stored projection
    const detailRes = await app.inject({
      method: "GET",
      url: parsed.statusUrl,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = runDetailResponseSchema.parse(JSON.parse(detailRes.body));
    expect(detail.run.origin).toBe("managed");
    expect(detail.run.status).toBe("queued");
  });

  it("orchestration engine processes queued outbox event to completed state", async () => {
    const enqueueRes = await app.inject({
      method: "POST",
      url: "/api/v1/runs/managed",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        schemaVersion: API_SCHEMA_VERSION,
        repository: { name: "checkout-app", commit: "sha456", branch: "feat/perf" },
        check: { kind: "scan" },
      },
    });

    expect(enqueueRes.statusCode).toBe(202);
    const { runId, statusUrl } = JSON.parse(enqueueRes.body) as {
      runId: string;
      statusUrl: string;
    };

    // Instantiate engine and dispatcher to process outbox event
    const engine = new EmbeddedOrchestrationEngine(store);
    const dispatcher = new OutboxDispatcher(store, engine);

    const dispatchedCount = await dispatcher.dispatchOnce();
    expect(dispatchedCount).toBeGreaterThanOrEqual(1);

    // Allow worker execution microtask to settle
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Poll status URL
    const checkRes = await app.inject({
      method: "GET",
      url: statusUrl,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(checkRes.statusCode).toBe(200);
    const detail = runDetailResponseSchema.parse(JSON.parse(checkRes.body));
    expect(detail.run.status).toBe("completed");
    expect(detail.run.outcome).toContain("finding(s)");
  });

  it("supports user cancellation via POST /api/v1/runs/:id/cancel", async () => {
    const enqueueRes = await app.inject({
      method: "POST",
      url: "/api/v1/runs/managed",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        schemaVersion: API_SCHEMA_VERSION,
        repository: { name: "long-running-job", commit: "long1", branch: "main" },
        check: { kind: "scan" },
      },
    });
    const { runId } = JSON.parse(enqueueRes.body) as { runId: string };

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(cancelRes.statusCode).toBe(200);
    const cancelBody = JSON.parse(cancelRes.body);
    expect(cancelBody.status).toBe("cancelled");

    // Verify detail
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const detail = runDetailResponseSchema.parse(JSON.parse(detailRes.body));
    expect(detail.run.status).toBe("cancelled");
  });

  it("rejects unauthorized read_only tokens with 403 Forbidden", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs/managed",
      headers: { authorization: `Bearer ${READONLY_TOKEN}` },
      payload: {
        schemaVersion: API_SCHEMA_VERSION,
        repository: { name: "denied-app" },
        check: { kind: "scan" },
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("not permitted to perform the requested action");
  });

  it("rejects unauthenticated requests with 401 Unauthorized", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs/managed",
      payload: {
        schemaVersion: API_SCHEMA_VERSION,
        repository: { name: "unauth-app" },
        check: { kind: "scan" },
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid request body with 400 Bad Request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs/managed",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        schemaVersion: 999, // unsupported schema version
        repository: { name: "" }, // empty name
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid_request");
  });
});
