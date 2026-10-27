import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "../src/migrate.js";
import { parseManifest, MANIFEST_FILE_NAME } from "../src/manifest.js";

describe("migrate", () => {
  it("creates the store and the first manifest entry together", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "migrate-test-"));
    try {
      const result = await migrate({ root, appliedBy: "codebuff", actor: "codebuff" });
      expect(result.storePath).toBe(path.resolve(root, "control-plane.sqlite"));
      expect(result.manifestPath).toBe(path.resolve(root, MANIFEST_FILE_NAME));
      expect(result.version).toBe(1);
      const raw = await import("node:fs/promises").then((mod) => mod.readFile(result.manifestPath, "utf8"));
      const manifest = parseManifest(raw);
      expect(manifest.entries).toHaveLength(1);
      expect(manifest.version).toBe(1);
      expect(manifest.appliedBy).toBe("codebuff");
      const second = await migrate({ root, appliedBy: "codebuff", actor: "codebuff" });
      expect(second.version).toBe(1);
      expect(second.appliedBy).toBe("codebuff");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
