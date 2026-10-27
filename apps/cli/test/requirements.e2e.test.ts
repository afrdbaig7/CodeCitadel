import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  requirementsEvaluationSchema,
  requirementsSummarySchema,
  testFingerprint,
  type TestRunReport,
} from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixtureRoot = path.join(repoRoot, "fixtures", "requirements");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-requirements-"));
const GENERATED_AT = "2026-10-23T00:00:00.000Z";
const ROOT = "/repo";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 2,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

let counter = 0;
function workTree(): string {
  counter += 1;
  const target = path.join(scratch, `case-${counter}`);
  cpSync(fixtureRoot, target, { recursive: true });
  return target;
}

function documentPath(tree: string): string {
  return path.join(tree, "codecitadel.requirements.json");
}

function reportFor(
  results: readonly { file: string; name: string; status: "passed" | "failed" | "skipped" }[],
): TestRunReport {
  const status = results.some((entry) => entry.status === "failed") ? "failed" : "passed";
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    root: ROOT,
    impact: {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      root: ROOT,
      base: { generatedAt: GENERATED_AT, root: ROOT },
      changed: [{ path: "src/coupon.ts", change: "modified" }],
      graph: {
        modules: 1,
        edges: 1,
        testFiles: 1,
        externalImports: 0,
        outsideScope: 0,
        unresolved: [],
      },
      impacted: [],
      tests: {
        selected: [
          {
            path: "src/coupon.test.ts",
            depth: 1,
            chain: [
              { path: "src/coupon.ts", relation: "changed" },
              { path: "src/coupon.test.ts", relation: "imports" },
            ],
          },
        ],
        notSelected: 0,
      },
      complete: true,
      incompleteReasons: [],
      limitations: ["Import reachability is not semantics."],
    },
    record: {
      id: "run_0123456789abcdef",
      runner: "vitest",
      runnerVersion: "3.2.4",
      nodeVersion: "22.11.0",
      platform: "win32-x64",
      status,
      exitCode: status === "passed" ? 0 : 1,
      durationMs: 40,
      startedAt: GENERATED_AT,
      command: ["node", "vitest", "run", "src/coupon.test.ts"],
      counts: {
        passed: results.filter((entry) => entry.status === "passed").length,
        failed: results.filter((entry) => entry.status === "failed").length,
        skipped: results.filter((entry) => entry.status === "skipped").length,
        timedOut: 0,
        errored: 0,
        cancelled: 0,
        unsupported: 0,
        total: results.length,
      },
      isolation: {
        mode: "source-copy",
        root: "/tmp/codecitadel-copy",
        sharedPaths: ["node_modules"],
        limitations: ["The copy shares node_modules with the checkout."],
      },
      detail: null,
    },
    results: results.map((entry) => ({
      id: testFingerprint(entry.file, entry.name),
      file: entry.file,
      name: entry.name,
      status: entry.status,
      durationMs: 3,
      message: entry.status === "failed" ? "expected 400, received 200" : null,
    })),
    limitations: ["A pass covers only the selected tests in this environment."],
  };
}

function writeReport(tree: string, results: Parameters<typeof reportFor>[0]): string {
  const file = path.join(tree, `report-${counter}-${results.length}.json`);
  writeFileSync(file, `${JSON.stringify(reportFor(results), null, 2)}\n`, "utf8");
  return file;
}

const FIRST_USE = "coupon > a user redeems a coupon once";
const REPEATED_USE = "coupon > a repeated redemption is rejected";
const FILE = "src/coupon.test.ts";

describe("codecitadel requirements", () => {
  it("lists a proposed document without claiming it is accepted", async () => {
    const tree = workTree();
    const result = await cli(["requirements", "list", tree]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 requirement(s): 0 accepted");
    expect(result.stdout).toContain("coupon.single-redemption");
    expect(result.stdout).toContain("proposed, not accepted");
    expect(result.stdout).toContain(testFingerprint(FILE, FIRST_USE));
  });

  it("records an explicit acceptance and reports it as current", async () => {
    const tree = workTree();
    const accepted = await cli([
      "requirements",
      "accept",
      "coupon.single-redemption",
      tree,
      "--by",
      "tester",
    ]);
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain("accepted coupon.single-redemption by tester");

    const listed = await cli(["requirements", "list", tree, "--format", "json"]);
    expect(listed.code).toBe(0);
    const summary = requirementsSummarySchema.parse(JSON.parse(listed.stdout));
    expect(summary.counts).toMatchObject({ accepted: 1, stale: 0, proposed: 1 });
    const coupon = summary.requirements.find((entry) => entry.id === "coupon.single-redemption");
    expect(coupon).toMatchObject({ acceptance: "current", acceptedBy: "tester" });

    const stored = JSON.parse(readFileSync(documentPath(tree), "utf8"));
    expect(stored.requirements[0].state).toBe("accepted");
    expect(stored.requirements[0].acceptance.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("evaluates accepted checks against a stored report and passes", async () => {
    const tree = workTree();
    await cli(["requirements", "accept", "coupon.single-redemption", tree, "--by", "tester"]);
    const report = writeReport(tree, [
      { file: FILE, name: FIRST_USE, status: "passed" },
      { file: FILE, name: REPEATED_USE, status: "passed" },
    ]);

    const result = await cli(["requirements", "check", tree, "--report", report]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("1 met, 0 unmet, 0 inconclusive, 1 not accepted");
    expect(result.stdout).toContain("MET");
    expect(result.stderr).toContain("not accepted: 1 requirement(s)");

    const json = await cli(["requirements", "check", tree, "--report", report, "--format", "json"]);
    const evaluation = requirementsEvaluationSchema.parse(JSON.parse(json.stdout));
    expect(evaluation.requirements[0]?.checks.map((check) => check.outcome)).toEqual([
      "passed",
      "passed",
    ]);
  });

  it("exits 1 when an accepted requirement is unmet", async () => {
    const tree = workTree();
    await cli(["requirements", "accept", "coupon.single-redemption", tree, "--by", "tester"]);
    const report = writeReport(tree, [
      { file: FILE, name: FIRST_USE, status: "passed" },
      { file: FILE, name: REPEATED_USE, status: "failed" },
    ]);

    const result = await cli(["requirements", "check", tree, "--report", report]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("UNMET");
    expect(result.stdout).toContain("expected 400, received 200");
  });

  it("exits 2 when a registered check has no result", async () => {
    const tree = workTree();
    await cli(["requirements", "accept", "coupon.single-redemption", tree, "--by", "tester"]);
    const report = writeReport(tree, [{ file: FILE, name: FIRST_USE, status: "passed" }]);

    const result = await cli(["requirements", "check", tree, "--report", report]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("INCONCLUSIVE");
    expect(result.stdout).toContain("not_run");
  });

  it("treats an edit after acceptance as stale and refuses to evaluate it", async () => {
    const tree = workTree();
    await cli(["requirements", "accept", "coupon.single-redemption", tree, "--by", "tester"]);

    const stored = JSON.parse(readFileSync(documentPath(tree), "utf8"));
    stored.requirements[0].statement = "A coupon can be redeemed twice per user.";
    writeFileSync(documentPath(tree), `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const listed = await cli(["requirements", "list", tree]);
    expect(listed.code).toBe(2);
    expect(listed.stderr).toContain("changed after acceptance");

    const report = writeReport(tree, [
      { file: FILE, name: FIRST_USE, status: "passed" },
      { file: FILE, name: REPEATED_USE, status: "passed" },
    ]);
    const checked = await cli(["requirements", "check", tree, "--report", report]);
    expect(checked.code).toBe(2);
    expect(checked.stdout).toContain("NOT ACCEPTED");
  });

  it("rejects an unknown requirement id and an invalid document", async () => {
    const tree = workTree();
    const unknown = await cli(["requirements", "accept", "coupon.nope", tree, "--by", "tester"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('No requirement with id "coupon.nope"');

    writeFileSync(documentPath(tree), '{"schemaVersion":1}', "utf8");
    const invalid = await cli(["requirements", "list", tree]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("does not match requirement schema version 1");
  });
});
