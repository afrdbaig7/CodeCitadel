import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { evidenceBundleSchema, replayReportSchema } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixture = path.join(repoRoot, "fixtures", "execution");
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-evidence-e2e-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const run = await exec(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout: run.stdout, stderr: run.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 2, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function makeCase(): { tree: string; manifest: string } {
  const dir = path.join(scratch, `case-${counter++}`);
  const tree = path.join(dir, "tree");
  mkdirSync(tree, { recursive: true });
  cpSync(fixture, tree, { recursive: true });

  // Add a failing reproduction check
  mkdirSync(path.join(tree, "reproductions"), { recursive: true });
  writeFileSync(
    path.join(tree, "reproductions", "failing.test.ts"),
    `import { describe, expect, it } from "vitest";
import { add } from "../src/math";

describe("math", () => {
  it("negative sum", () => {
    expect(add(-2, -1)).toBe(-4); // deliberate failure: -3 != -4
  });
});
`,
    "utf8",
  );

  const manifest = path.join(dir, "reproductions.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        schemaVersion: 1,
        reproductions: [
          {
            id: "math.negative-sum",
            requirement: null,
            statement: "add returns arithmetic sum for negative operands.",
            provenance: "user-authored",
            file: "reproductions/failing.test.ts",
            test: "math negative sum",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return { tree, manifest };
}

describe("codecitadel evidence export & replay e2e", () => {
  it("exports a valid evidence bundle from a reproduction report", { timeout: 120_000 }, async () => {
    const c = makeCase();
    const reportPath = path.join(scratch, `reproduce-report-${counter}.json`);
    const bundlePath = path.join(scratch, `bundle-${counter}.json`);

    // Run reproduction with --format json to produce a machine-readable report
    const repRun = await cli([
      "reproduce",
      "run",
      c.manifest,
      c.tree,
      "--id",
      "math.negative-sum",
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      reportPath,
    ]);
    expect(repRun.code).toBe(0);
    expect(existsSync(reportPath)).toBe(true);

    // Export evidence bundle
    const exportResult = await cli([
      "evidence",
      "export",
      reportPath,
      "--out",
      bundlePath,
    ]);

    expect(exportResult.code).toBe(0);
    expect(exportResult.stdout).toContain("evidence export → bundle_");
    expect(exportResult.stdout).toContain("reproductions/failing.test.ts");
    expect(existsSync(bundlePath)).toBe(true);

    const bundleContent = JSON.parse(readFileSync(bundlePath, "utf8"));
    const parsed = evidenceBundleSchema.safeParse(bundleContent);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.kind).toBe("reproduction");
    expect(parsed.data?.claim.expectedVerdict).toBe("reproduced");
  });

  it("refuses to overwrite an existing bundle without --force", { timeout: 120_000 }, async () => {
    const c = makeCase();
    const reportPath = path.join(scratch, `rep-overwrite-${counter}.json`);
    const bundlePath = path.join(scratch, `bundle-overwrite-${counter}.json`);

    await cli([
      "reproduce",
      "run",
      c.manifest,
      c.tree,
      "--id",
      "math.negative-sum",
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      reportPath,
    ]);

    writeFileSync(bundlePath, "already exists\n", "utf8");

    const exportResult = await cli([
      "evidence",
      "export",
      reportPath,
      "--out",
      bundlePath,
    ]);

    expect(exportResult.code).toBe(2);
    expect(exportResult.stderr).toContain("Refusing to overwrite");

    // With --force it should succeed
    const forced = await cli([
      "evidence",
      "export",
      reportPath,
      "--out",
      bundlePath,
      "--force",
    ]);
    expect(forced.code).toBe(0);
  });

  it("replays a bundle and confirms the original reproduction verdict (exit 0)", { timeout: 120_000 }, async () => {
    const c = makeCase();
    const reportPath = path.join(scratch, `rep-replay-${counter}.json`);
    const bundlePath = path.join(scratch, `bundle-replay-${counter}.json`);
    const replayReportPath = path.join(scratch, `replay-report-${counter}.json`);

    await cli([
      "reproduce",
      "run",
      c.manifest,
      c.tree,
      "--id",
      "math.negative-sum",
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      reportPath,
    ]);

    await cli([
      "evidence",
      "export",
      reportPath,
      "--out",
      bundlePath,
    ]);

    // Replay bundle against the tree
    const replayResult = await cli([
      "replay",
      bundlePath,
      c.tree,
      "--runner",
      vitestEntry,
      "--out",
      replayReportPath,
    ]);

    expect(replayResult.code).toBe(0);
    expect(replayResult.stdout).toContain("replay → CONFIRMED");
    expect(existsSync(replayReportPath)).toBe(true);

    const reportJson = JSON.parse(readFileSync(replayReportPath, "utf8"));
    const parsed = replayReportSchema.safeParse(reportJson);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.verdict).toBe("confirmed");
  });

  it("reports diverged when the check produces a different outcome (exit 1)", { timeout: 120_000 }, async () => {
    const c = makeCase();
    const reportPath = path.join(scratch, `rep-div-${counter}.json`);
    const bundlePath = path.join(scratch, `bundle-div-${counter}.json`);

    await cli([
      "reproduce",
      "run",
      c.manifest,
      c.tree,
      "--id",
      "math.negative-sum",
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      reportPath,
    ]);

    await cli([
      "evidence",
      "export",
      reportPath,
      "--out",
      bundlePath,
    ]);

    // Fix the test in the tree so it passes instead of failing
    writeFileSync(
      path.join(c.tree, "reproductions", "failing.test.ts"),
      `import { describe, expect, it } from "vitest";
import { add } from "../src/math";

describe("math", () => {
  it("negative sum", () => {
    expect(add(-2, -1)).toBe(-3); // fixed: passes now
  });
});
`,
      "utf8",
    );

    // Replaying now should detect divergence
    const replayResult = await cli([
      "replay",
      bundlePath,
      c.tree,
      "--runner",
      vitestEntry,
    ]);

    expect(replayResult.code).toBe(1);
    expect(replayResult.stdout).toContain("replay → DIVERGED");
    expect(replayResult.stdout).toContain("diverging from claimed");
  });

  it("refuses a tampered bundle before executing anything (exit 2)", { timeout: 120_000 }, async () => {
    const c = makeCase();
    const reportPath = path.join(scratch, `rep-tamper-${counter}.json`);
    const bundlePath = path.join(scratch, `bundle-tamper-${counter}.json`);

    await cli([
      "reproduce",
      "run",
      c.manifest,
      c.tree,
      "--id",
      "math.negative-sum",
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      reportPath,
    ]);

    await cli([
      "evidence",
      "export",
      reportPath,
      "--out",
      bundlePath,
    ]);

    // Tamper with the artifact content in the bundle
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    bundle.artifacts[0].content = "// tampered code\n";
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf8");

    const replayResult = await cli([
      "replay",
      bundlePath,
      c.tree,
      "--runner",
      vitestEntry,
    ]);

    expect(replayResult.code).toBe(2);
    expect(replayResult.stderr).toContain("Corrupted artifact");
    expect(replayResult.stderr).toContain("digest mismatch");
  });
});
