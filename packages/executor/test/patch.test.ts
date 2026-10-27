import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  applyPatch,
  parseUnifiedDiff,
  PatchApplyError,
  PatchParseError,
} from "../src/patch.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-patch-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function tree(files: Record<string, string>): string {
  counter += 1;
  const dir = path.join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

const MODIFY = [
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,3 @@",
  " export function add(left: number, right: number): number {",
  "-  return left - right;",
  "+  return left + right;",
  " }",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads a modified file, its hunks, and the line numbers on each side", () => {
    const parsed = parseUnifiedDiff(MODIFY);
    expect(parsed.files).toHaveLength(1);

    const [file] = parsed.files;
    expect(file).toMatchObject({
      oldPath: "src/math.ts",
      newPath: "src/math.ts",
      addedLines: 1,
      removedLines: 1,
    });
    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 });
    expect(file?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
    expect(file?.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
    ]);
  });

  it("reads a created and a deleted file from /dev/null headers", () => {
    const parsed = parseUnifiedDiff(
      [
        "--- /dev/null",
        "+++ b/src/new/deep.ts",
        "@@ -0,0 +1,2 @@",
        "+export const a = 1;",
        "+export const b = 2;",
        "--- a/src/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const old = 1;",
        "",
      ].join("\n"),
    );

    expect(parsed.files.map((file) => [file.oldPath, file.newPath])).toEqual([
      [null, "src/new/deep.ts"],
      ["src/old.ts", null],
    ]);
    expect(parsed.files[0]?.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newCount: 2 });
  });

  it("tolerates git headers it can ignore and strips a trailing no-newline marker", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-one",
        "\\ No newline at end of file",
        "+two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );

    expect(parsed.files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ["removed", "one"],
      ["added", "two"],
    ]);
  });

  it("refuses paths that are absolute, traverse, or use backslashes", () => {
    for (const header of [
      ["--- a/../escape.ts", "+++ b/../escape.ts"],
      ["--- /etc/passwd", "+++ /etc/passwd"],
      ["--- a/src\\\\win.ts", "+++ b/src\\\\win.ts"],
      ["--- a/.git/config", "+++ b/.git/config"],
    ]) {
      const text = [...header, "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
      expect(() => parseUnifiedDiff(text)).toThrow(PatchParseError);
    }
  });

  it("refuses binary changes, renames, and mode changes instead of approximating them", () => {
    expect(() => parseUnifiedDiff("GIT binary patch\nliteral 3\n")).toThrow(PatchParseError);
    expect(() => parseUnifiedDiff("rename from src/a.ts\nrename to src/b.ts\n")).toThrow(
      PatchParseError,
    );
    expect(() => parseUnifiedDiff("new mode 100755\n")).toThrow(PatchParseError);
  });

  it("refuses a hunk that claims more lines than it contains", () => {
    const text = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,5 +1,5 @@",
      " one",
      " two",
      "",
    ].join("\n");
    expect(() => parseUnifiedDiff(text)).toThrow(/ended early/);
  });

  it("refuses text that is not a unified diff", () => {
    expect(() => parseUnifiedDiff("just some text\n")).toThrow(/Expected a "--- " file header/);
  });
});

describe("applyPatch", () => {
  it("applies a hunk and keeps the file's line endings", () => {
    const dir = tree({ "src/math.ts": "one\r\ntwo\r\nthree\r\n" });
    const patch = parseUnifiedDiff(
      [
        "--- a/src/math.ts",
        "+++ b/src/math.ts",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        "",
      ].join("\n"),
    );

    return applyPatch(dir, patch).then((applied) => {
      expect(readFileSync(path.join(dir, "src/math.ts"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
      expect(applied.files).toEqual([
        { path: "src/math.ts", status: "modified", addedLines: 1, removedLines: 1 },
      ]);
      expect(applied).toMatchObject({ addedLines: 1, removedLines: 1 });
    });
  });

  it("creates parent directories for a new file and removes a deleted one", async () => {
    const dir = tree({ "src/old.ts": "old\n" });
    const patch = parseUnifiedDiff(
      [
        "--- /dev/null",
        "+++ b/src/new/deep.ts",
        "@@ -0,0 +1,2 @@",
        "+export const a = 1;",
        "+export const b = 2;",
        "--- a/src/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old",
        "",
      ].join("\n"),
    );

    const applied = await applyPatch(dir, patch);

    expect(readFileSync(path.join(dir, "src/new/deep.ts"), "utf8")).toBe(
      "export const a = 1;\nexport const b = 2;\n",
    );
    expect(existsSync(path.join(dir, "src/old.ts"))).toBe(false);
    expect(applied.files.map((file) => file.status)).toEqual(["created", "deleted"]);
  });

  it("refuses a stale patch at the exact line instead of searching for a match", async () => {
    const dir = tree({ "src/math.ts": "export function add() {\n  return 1;\n}\n" });

    await expect(applyPatch(dir, parseUnifiedDiff(MODIFY))).rejects.toThrow(
      /does not match the file at old line 1.*stale/s,
    );
    expect(readFileSync(path.join(dir, "src/math.ts"), "utf8")).toBe(
      "export function add() {\n  return 1;\n}\n",
    );
  });

  it("refuses to create a file that already exists", async () => {
    const dir = tree({ "src/a.ts": "present\n" });
    const patch = parseUnifiedDiff(
      ["--- /dev/null", "+++ b/src/a.ts", "@@ -0,0 +1 @@", "+other", ""].join("\n"),
    );

    await expect(applyPatch(dir, patch)).rejects.toThrow(/already exists/);
    expect(readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe("present\n");
  });

  it("refuses to write through a symbolic link", async () => {
    const dir = tree({ "-": "" });
    const outside = tree({ "target.ts": "untouched\n" });
    const link = path.join(dir, "linked");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    const patch = parseUnifiedDiff(
      ["--- /dev/null", "+++ b/linked/target.ts", "@@ -0,0 +1 @@", "+escaped", ""].join("\n"),
    );

    await expect(applyPatch(dir, patch)).rejects.toThrow(PatchApplyError);
    await expect(applyPatch(dir, patch)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(path.join(outside, "target.ts"), "utf8")).toBe("untouched\n");
  });

  it("refuses a deletion that would leave content behind", async () => {
    const dir = tree({ "src/a.ts": "one\ntwo\n" });
    const patch = parseUnifiedDiff(
      ["--- a/src/a.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-one", ""].join("\n"),
    );

    await expect(applyPatch(dir, patch)).rejects.toThrow(/inconsistent/);
  });
});
