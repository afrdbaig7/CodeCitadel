import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openStore, Store, type StoreOptions } from "../src/store.js";
import { parseManifest, createEmptyManifest } from "../src/manifest.js";

function makeStore(root?: string): Store {
  const overrides: Partial<StoreOptions> = {};
  if (root !== undefined) overrides.root = root;
  return openStore({ appliedBy: "test", actor: "test", ...overrides });
}

describe("store", () => {
  it("appends one task entry per transaction and keeps the manifest contiguous", () => {
    const root = mkdtempSync(path.join(tmpdir(), "store-test-"));
    try {
      const store = makeStore(root);
      const now = new Date().toISOString();
      const first = store.upsertTask({
        id: "tasks:write-nothing",
        scope: "test",
        summary: "write nothing",
        status: "done",
        attempt: 0,
        createdBy: "test",
        createdAt: now,
        updatedAt: now,
      });
      expect(first.version).toBe(1);
      const second = store.upsertTask({
        id: "tasks:write-nothing",
        scope: "test",
        summary: "write nothing",
        status: "done",
        attempt: 0,
        createdBy: "test",
        createdAt: now,
        updatedAt: now,
      });
      expect(second.version).toBe(2);
      expect(second.entries).toHaveLength(2);
      expect(second.entries[0].sequence).toBe(0);
      expect(second.entries[1].sequence).toBe(1);
      expect(second.entries[0].entry.task?.id).toBe("tasks:write-nothing");
      store.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stale status strings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "store-test-"));
    try {
      const store = makeStore(root);
      expect(() => {
        store.upsertTask({
          id: "tasks:bad",
          scope: "test",
          summary: "bad",
          status: "maybe" as any,
          attempt: 0,
          createdBy: "test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }).toThrow(/must be one of/);
      store.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the same manifest version when migrated twice", () => {
    const root = mkdtempSync(path.join(tmpdir(), "store-test-"));
    try {
      const store = makeStore(root);
      store.upsertTask({
        id: "tasks:one",
        scope: "test",
        summary: "one",
        status: "done",
        attempt: 0,
        createdBy: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const first = store.read();
      store.upsertTask({
        id: "tasks:one",
        scope: "test",
        summary: "one",
        status: "done",
        attempt: 0,
        createdBy: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const second = store.read();
      expect(second.version).toBe(first.version);
      expect(second.entries).toEqual(first.entries);
      const resource = store.resourceById("resource:r2-local-control-plane");
      expect(resource).not.toBeNull();
      expect(resource?.status).toBe("ready");
      store.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
