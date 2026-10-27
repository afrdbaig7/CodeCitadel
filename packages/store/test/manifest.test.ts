import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseManifest, createEmptyManifest, MANIFEST_FILE_NAME } from "../src/manifest.js";

describe("manifest", () => {
  it("rejects a tampered document", () => {
    const manifest = createEmptyManifest(".", "test");
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.appliedBy = "tampered";
    expect(() => parseManifest(JSON.stringify(tampered))).toThrow(/does not match manifest schema version 1/);
  });

  it("changes its hash after any field edit", () => {
    const first = createEmptyManifest(".", "test");
    const second = JSON.parse(JSON.stringify(first)) as any;
    second.appliedBy = "owner";
    const firstHash = `sha256:${createHash("sha256").update(Buffer.from(JSON.stringify(first), "utf8")).digest("hex")}`;
    const secondHash = `sha256:${createHash("sha256").update(Buffer.from(JSON.stringify(second), "utf8")).digest("hex")}`;
    expect(firstHash).not.toBe(secondHash);
  });

  it("rounds trip through the file reader", () => {
    const manifest = createEmptyManifest(".", "test");
    const json = JSON.stringify(manifest, null, 2) + "\n";
    expect(parseManifest(json)).toEqual(manifest);
  });
});
