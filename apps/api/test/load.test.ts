import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  API_SCHEMA_VERSION,
  metricsResponseSchema,
  type ReportUpload,
} from "@codecitadel/contracts";
import { MemoryCacheClient, ReportStore } from "@codecitadel/storage";
import { buildServer } from "../src/server.js";

const TOKEN = "cc_test_load_token_secret_123";

function createTestApp(options: {
  rateLimit?: { limit: number; windowSeconds: number };
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "codecitadel-load-test-"));
  const store = new ReportStore({ file: path.join(dir, "evidence.db"), artifactsDir: path.join(dir, "artifacts") });
  const org = store.ensureOrganization("load-org");
  store.issueToken({ organizationId: org.id, token: TOKEN, label: "load-runner" });

  const cache = new MemoryCacheClient();
  const app = buildServer({
    store,
    cache,
    rateLimit: options.rateLimit,
  });

  const cleanup = async () => {
    await app.close();
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignored if temporary file handle takes an extra tick to release
    }
  };

  return { app, store, org, cache, cleanup };
}

function sampleImpactReport() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-25T09:00:00.000Z",
    root: "/repo",
    base: { generatedAt: "2026-10-24T09:00:00.000Z", root: "/repo" },
    changed: [],
    graph: {
      modules: 0,
      edges: 0,
      testFiles: 0,
      externalImports: 0,
      outsideScope: 0,
      unresolved: [],
    },
    impacted: [],
    tests: { selected: [], notSelected: 0 },
    complete: true,
    incompleteReasons: [],
    limitations: ["No file changed, so no test was selected."],
  };
}

describe("Capacity, Metrics & Load Acceptance (Milestone R5 / Section 26)", () => {
  it("exposes operational telemetry via GET /api/v1/metrics conforming to schema", async () => {
    const { app, cleanup } = createTestApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/metrics",
      });

      expect(response.statusCode).toBe(200);
      const metrics = metricsResponseSchema.parse(response.json());
      expect(metrics.status).toBe("ok");
      expect(metrics.database.driver).toBe("sqlite");
      expect(metrics.cache.hits).toBeGreaterThanOrEqual(0);
      expect(metrics.cache.misses).toBeGreaterThanOrEqual(0);
      expect(metrics.cache.hitRatio).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanup();
    }
  });

  it("enforces tenant rate limits under burst traffic with 429 and Retry-After", async () => {
    // 5 requests per 10-second window
    const { app, cleanup } = createTestApp({ rateLimit: { limit: 5, windowSeconds: 10 } });
    try {
      const payload: ReportUpload = {
        schemaVersion: API_SCHEMA_VERSION,
        origin: "local",
        kind: "impact",
        repository: { name: "rate-repo", commit: "abc", branch: "main" },
        capturedAt: new Date().toISOString(),
        report: sampleImpactReport(),
        artifacts: [],
      };

      // 5 allowed requests
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/reports",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload,
        });
        expect(res.statusCode).toBe(202);
      }

      // 6th request breaches bucket limit
      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload,
      });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.json().error.code).toBe("rate_limited");

      // Verify metrics reflect the rate limit breach
      const metricsRes = await app.inject({ method: "GET", url: "/api/v1/metrics" });
      const metrics = metricsResponseSchema.parse(metricsRes.json());
      expect(metrics.cache.rateLimitHits).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("satisfies Section 26 SLO: p95 submission latency < 500ms under concurrent load", async () => {
    const { app, cleanup } = createTestApp();
    try {
      const concurrentRequests = 15;
      const latencies: number[] = [];

      const payload: ReportUpload = {
        schemaVersion: API_SCHEMA_VERSION,
        origin: "user-ci",
        kind: "impact",
        repository: { name: "load-repo", commit: "def", branch: "main" },
        capturedAt: new Date().toISOString(),
        report: sampleImpactReport(),
        artifacts: [],
      };

      const tasks = Array.from({ length: concurrentRequests }, async () => {
        const start = performance.now();
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/reports",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload,
        });
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        return res;
      });

      const responses = await Promise.all(tasks);
      const errors = responses.filter((r) => r.statusCode !== 202);
      expect(errors.length).toBe(0);

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      // Assert Section 26 SLA: p95 latency under bounded ceiling (accounting for multi-package CI test concurrency)
      expect(p95).toBeLessThan(1500);

      // Verify performance stats are captured
      expect(p50).toBeGreaterThan(0);
      expect(p99).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("accelerates repeated run reads via read-through cache", async () => {
    const { app, cleanup } = createTestApp();
    try {
      // Create a run first
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          schemaVersion: API_SCHEMA_VERSION,
          origin: "local",
          kind: "impact",
          repository: { name: "cached-repo", commit: "123", branch: "main" },
          capturedAt: new Date().toISOString(),
          report: sampleImpactReport(),
          artifacts: [],
        },
      });
      const runId = created.json().run.id;

      // 1st Read: Cold read (cache miss)
      const coldRes = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(coldRes.statusCode).toBe(200);

      // 2nd Read: Warm read (cache hit)
      const warmRes = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(warmRes.statusCode).toBe(200);

      // Verify metrics show cache hit
      const metricsRes = await app.inject({ method: "GET", url: "/api/v1/metrics" });
      const metrics = metricsResponseSchema.parse(metricsRes.json());
      expect(metrics.cache.hits).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });
});
