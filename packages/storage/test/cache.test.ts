import { describe, expect, it } from "vitest";

import {
  CachedEvidenceStore,
  MemoryCacheClient,
  ValkeyCacheClient,
  createCacheClient,
  type EvidenceStore,
  type StoredRunDetail,
} from "../src/index.js";

describe("MemoryCacheClient", () => {
  it("stores and retrieves typed values", async () => {
    const cache = new MemoryCacheClient();
    await cache.set("key1", { count: 42 });

    const value = await cache.get<{ count: number }>("key1");
    expect(value).toEqual({ count: 42 });

    const missing = await cache.get("missing");
    expect(missing).toBeNull();

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.sets).toBe(1);
  });

  it("evicts expired entries after TTL", async () => {
    const cache = new MemoryCacheClient();
    // 1-second TTL
    await cache.set("temp", "val", 1);
    expect(await cache.get("temp")).toBe("val");

    // Manually test expiration by setting TTL to -1 (in the past)
    await cache.set("past", "val", -1);
    expect(await cache.get("past")).toBeNull();
  });

  it("deletes stored entries", async () => {
    const cache = new MemoryCacheClient();
    await cache.set("to-delete", "val");
    await cache.delete("to-delete");
    expect(await cache.get("to-delete")).toBeNull();
  });

  it("enforces sliding-window rate limits", async () => {
    const cache = new MemoryCacheClient();
    const limit = 3;
    const windowSeconds = 2;

    const r1 = await cache.checkRateLimit("user:123", limit, windowSeconds);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await cache.checkRateLimit("user:123", limit, windowSeconds);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await cache.checkRateLimit("user:123", limit, windowSeconds);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = await cache.checkRateLimit("user:123", limit, windowSeconds);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);

    const stats = cache.getStats();
    expect(stats.rateLimitHits).toBe(1);
  });
});

describe("ValkeyCacheClient fallback resilience", () => {
  it("falls back to memory gracefully when Valkey is unreachable", async () => {
    // Port 6399 is not running, client must fail open / fallback to memory without throwing
    const cache = new ValkeyCacheClient("redis://127.0.0.1:6399");
    await cache.set("fallback-key", { status: "safe" });

    const val = await cache.get<{ status: string }>("fallback-key");
    expect(val).toEqual({ status: "safe" });

    const rate = await cache.checkRateLimit("client:1", 2, 60);
    expect(rate.allowed).toBe(true);

    await cache.close();
  });
});

describe("createCacheClient factory", () => {
  it("creates MemoryCacheClient when no URL is provided", () => {
    const client = createCacheClient();
    expect(client).toBeInstanceOf(MemoryCacheClient);
  });

  it("creates ValkeyCacheClient when URL is provided", async () => {
    const client = createCacheClient("redis://127.0.0.1:6379");
    expect(client).toBeInstanceOf(ValkeyCacheClient);
    await client.close();
  });
});

describe("CachedEvidenceStore", () => {
  it("caches getRun reads and purges on updates", async () => {
    let underlyingCalls = 0;
    const sampleDetail: StoredRunDetail = {
      run: {
        id: "run_test_1",
        organizationId: "org_1",
        repositoryId: "repo_1",
        repositoryName: "test-repo",
        headCommit: "abc",
        headBranch: "main",
        kind: "scan",
        origin: "local",
        capturedAt: "2026-11-03T10:00:00.000Z",
        receivedAt: "2026-11-03T10:00:00.000Z",
        reportDigest: "sha256:1234567890123456789012345678901234567890123456789012345678901234",
        outcome: "passed",
        bytes: 100,
        status: "completed",
        artifacts: [],
      },
      reportJson: JSON.stringify({ schemaVersion: 1 }),
    };

    const mockStore: Partial<EvidenceStore> = {
      schemaVersion: 1,
      driver: "sqlite",
      getRun: async () => {
        underlyingCalls += 1;
        return sampleDetail;
      },
      updateRunStatus: async () => {},
      close: async () => {},
    };

    const cache = new MemoryCacheClient();
    const cachedStore = new CachedEvidenceStore(mockStore as EvidenceStore, cache);

    // First call: cache miss, hits underlying store
    const read1 = await cachedStore.getRun("org_1", "run_test_1");
    expect(read1?.run.id).toBe("run_test_1");
    expect(underlyingCalls).toBe(1);

    // Second call: cache hit, underlying store is not called
    const read2 = await cachedStore.getRun("org_1", "run_test_1");
    expect(read2?.run.id).toBe("run_test_1");
    expect(underlyingCalls).toBe(1);

    // Invalidate via updateRunStatus
    await cachedStore.updateRunStatus("org_1", "run_test_1", "cancelled");

    // Third call: cache miss again, hits underlying store
    const read3 = await cachedStore.getRun("org_1", "run_test_1");
    expect(read3?.run.id).toBe("run_test_1");
    expect(underlyingCalls).toBe(2);

    await cachedStore.close();
  });
});
