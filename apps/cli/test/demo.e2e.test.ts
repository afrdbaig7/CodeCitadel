import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const project = path.join(repoRoot, "examples", "shopping-api");
const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-demo-e2e-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function cli(args: readonly string[]) {
  try {
    const run = await exec(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: run.stdout, stderr: run.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 2, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * The demo starts a service on the host, so its preflight refusals are the part
 * that must hold everywhere: it refuses before it starts anything, and it says
 * what to do instead. The demonstration itself needs Docker or --database-url
 * and is exercised by running `demo coupon-race` by hand.
 */
describe("codecitadel demo coupon-race", () => {
  it("refuses a project that does not exist", async () => {
    const result = await cli([
      "demo",
      "coupon-race",
      "--project",
      path.join(scratch, "no-such-project"),
      "--out",
      path.join(scratch, "out-1"),
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not exist");
    expect(result.stderr).toContain("--project");
  });

  it("refuses a project that is missing the declared requirement", async () => {
    const incomplete = path.join(scratch, "incomplete");
    mkdirSync(path.join(incomplete, "src"), { recursive: true });
    writeFileSync(path.join(incomplete, "src", "coupons.ts"), "export {};\n", "utf8");

    const result = await cli([
      "demo",
      "coupon-race",
      "--project",
      incomplete,
      "--out",
      path.join(scratch, "out-2"),
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("codecitadel.requirements.json");
  });

  it("refuses to overwrite artifacts a previous demo left behind", async () => {
    const out = path.join(scratch, "out-3");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "demo-report.json"), "{}\n", "utf8");

    const result = await cli(["demo", "coupon-race", "--project", project, "--out", out]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Refusing to overwrite");
    expect(result.stderr).toContain("demo-report.json");
  });

  it("refuses an unusable format instead of running anything", async () => {
    const result = await cli([
      "demo",
      "coupon-race",
      "--project",
      project,
      "--out",
      path.join(scratch, "out-4"),
      "--format",
      "xml",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--format must be text or json");
  });
});
