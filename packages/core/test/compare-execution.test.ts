import type {
  CheckStatus,
  ExecutionComparison,
  ImpactReport,
  OutcomeComparison,
  TestResult,
  TestRunReport,
} from "@codecitadel/contracts";
import { executionComparisonSchema, testRunReportSchema } from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import { compareExecutionReports } from "../src/compare-execution.js";

const GENERATED_AT = "2026-10-23T00:00:00.000Z";

function result(
  overrides: Partial<Pick<TestResult, "id" | "file" | "name" | "status" | "message">> = {},
): TestResult {
  return {
    id: overrides.id ?? "t_0000000000000001",
    file: overrides.file ?? "src/math.test.ts",
    name: overrides.name ?? "add adds two numbers",
    status: overrides.status ?? "passed",
    durationMs: 1,
    message: overrides.message ?? null,
  };
}

function impact(
  overrides: Partial<Pick<ImpactReport, "changed" | "tests" | "root">> = {},
): ImpactReport {
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    root: overrides.root ?? "/repo",
    base: { generatedAt: GENERATED_AT, root: "/repo" },
    changed: overrides.changed ?? [{ path: "src/math.ts", change: "modified" }],
    graph: { modules: 1, edges: 1, testFiles: 1, externalImports: 0, outsideScope: 0, unresolved: [] },
    impacted: [{ path: "src/math.test.ts", depth: 1, chain: [
      { path: "src/math.ts", relation: "changed" },
      { path: "src/math.test.ts", relation: "imports" },
    ] }],
    tests: overrides.tests ?? {
      selected: [{ path: "src/math.test.ts", depth: 1, chain: [
        { path: "src/math.ts", relation: "changed" },
        { path: "src/math.test.ts", relation: "imports" },
      ] }],
      notSelected: 0,
    },
    complete: true,
    incompleteReasons: [],
    limitations: ["Import reachability is not semantics."],
  };
}

function report(
  overrides: Partial<{
    root: string;
    results: TestResult[];
    changed: ImpactReport["changed"];
    selected: string[];
    runnerVersion: string | null;
    nodeVersion: string;
    platform: string;
    status: CheckStatus;
    isolationMode: "source-copy" | "none";
  }> = {},
): TestRunReport {
  const impactReport = impact({ root: overrides.root, changed: overrides.changed });
  if (overrides.selected !== undefined) {
    impactReport.tests = {
      selected: overrides.selected.map((entry) => ({
        path: entry,
        depth: 1,
        chain: [{ path: entry, relation: "changed" }],
      })),
      notSelected: 0,
    };
  }
  return testRunReportSchema.parse({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    root: overrides.root ?? "/repo",
    impact: impactReport,
    record: {
      id: "run_0000000000000001",
      runner: "vitest",
      runnerVersion: overrides.runnerVersion ?? "3.2.4",
      nodeVersion: overrides.nodeVersion ?? "v24.18.0",
      platform: overrides.platform ?? "win32-x64",
      status: overrides.status ?? "passed",
      exitCode: 0,
      durationMs: 10,
      startedAt: GENERATED_AT,
      command: ["node", "vitest.mjs"],
      counts: {
        passed: overrides.results?.filter((entry) => entry.status === "passed").length ?? 0,
        failed: 0,
        skipped: 0,
        timedOut: 0,
        errored: 0,
        cancelled: 0,
        unsupported: 0,
        total: overrides.results?.length ?? 0,
      },
      isolation: {
        mode: overrides.isolationMode ?? "source-copy",
        root: overrides.root ?? "/repo",
        sharedPaths: [],
        limitations: ["No sandbox."],
      },
      detail: null,
    },
    results: overrides.results ?? [result()],
    limitations: ["A passing result is not proof of correctness."],
  });
}

function comparison(before: TestRunReport, after: TestRunReport): ExecutionComparison {
  return executionComparisonSchema.parse(compareExecutionReports({ before, after, generatedAt: new Date(GENERATED_AT) }));
}

function labelsOf(comparisonResult: ExecutionComparison): OutcomeComparison[] {
  return comparisonResult.tests.map((test) => test.comparison);
}

describe("compareExecutionReports pairing grid", () => {
  it("labels a passing pair as still passing and carries both statuses", () => {
    const before = report({ results: [result({ status: "passed", message: null })] });
    const after = report({ results: [result({ status: "passed", message: null })] });

    const comparisonResult = comparison(before, after);

    expect(labelsOf(comparisonResult)).toEqual(["still_passing"]);
    expect(comparisonResult.tests[0]).toMatchObject({
      before: { status: "passed", message: null },
      after: { status: "passed", message: null },
      identitySuspect: false,
    });
    expect(comparisonResult.counts).toMatchObject({ stillPassing: 1, total: 1 });
  });

  it("labels a failure appearing after a pass as newly failing", () => {
    const before = report({ results: [result({ status: "passed" })] });
    const after = report({ results: [result({ status: "failed", message: "expected 3 to equal 2" })] });

    const comparisonResult = comparison(before, after);

    expect(labelsOf(comparisonResult)).toEqual(["newly_failing"]);
    expect(comparisonResult.tests[0]?.before?.status).toBe("passed");
    expect(comparisonResult.tests[0]?.after?.message).toBe("expected 3 to equal 2");
  });

  it("labels a test that was failing in both runs as still failing with both messages", () => {
    const before = report({ results: [result({ status: "failed", message: "expected 3 to equal 4" })], status: "failed" });
    const after = report({ results: [result({ status: "failed", message: "expected 3 to equal 5" })], status: "failed" });

    const comparisonResult = comparison(before, after);

    expect(labelsOf(comparisonResult)).toEqual(["still_failing"]);
    expect(comparisonResult.tests[0]?.before?.message).toBe("expected 3 to equal 4");
    expect(comparisonResult.tests[0]?.after?.message).toBe("expected 3 to equal 5");
  });

  it("labels a failure that became a pass as fixed", () => {
    const before = report({ results: [result({ status: "failed", message: "expected 3 to equal 2" })], status: "failed" });
    const after = report({ results: [result({ status: "passed" })] });

    const comparisonResult = comparison(before, after);

    expect(labelsOf(comparisonResult)).toEqual(["fixed"]);
  });

  it("labels a first-seen passing test as newly passing, and an inconclusive run as newly inconclusive", () => {
    const before = report({ results: [] });
    const afterPass = report({ results: [result({ id: "t_0000000000000002", status: "passed" })] });
    const afterError = report({ results: [result({ id: "t_0000000000000002", status: "errored", message: "collection failed" })], status: "errored" });

    expect(labelsOf(comparison(before, afterPass))).toEqual(["newly_passing"]);

    const inconclusive = comparison(before, afterError);
    expect(labelsOf(inconclusive)).toEqual(["newly_inconclusive"]);
    expect(inconclusive.counts.newlyInconclusive).toBe(1);
  });

  it("labels an inconclusive pair with the same status as still inconclusive", () => {
    const before = report({ results: [result({ status: "timed_out", message: "deadline" })], status: "timed_out" });
    const after = report({ results: [result({ status: "timed_out", message: "deadline" })], status: "timed_out" });

    const comparisonResult = comparison(before, after);

    expect(labelsOf(comparisonResult)).toEqual(["still_inconclusive"]);
  });

  it("labels skipped pairs and flags a test that lost evidence when it became skipped", () => {
    const before = report({ results: [result({ status: "skipped" })], status: "skipped" });
    const after = report({ results: [result({ status: "skipped" })], status: "skipped" });
    const dropped = report({ results: [result({ status: "skipped" })], status: "skipped" });

    expect(labelsOf(comparison(before, after))).toEqual(["still_skipped"]);
    // A test that passed before and was skipped after is newly skipped, a loss.
    const passedBefore = report({ results: [result({ status: "passed" })] });
    expect(labelsOf(comparison(passedBefore, dropped))).toEqual(["newly_skipped"]);
  });

  it("counts a test present only before as gone, with no after side", () => {
    const before = report({ results: [result({ id: "t_0000000000000003", status: "passed" })] });
    const after = report({ results: [] });

    const comparisonResult = comparison(before, after);

    expect(labelsOf(comparisonResult)).toEqual(["gone"]);
    expect(comparisonResult.tests[0]).toMatchObject({
      before: { status: "passed" },
      after: null,
    });
    expect(comparisonResult.counts.gone).toBe(1);
  });

  it("produces every pair it can and states incomparability when the environments differ", () => {
    const before = report({ results: [result(), result({ id: "t_0000000000000004", status: "failed", message: "boom" })], status: "failed" });
    const after = report({
      results: [result(), result({ id: "t_0000000000000004" })],
      runnerVersion: "3.3.0",
      status: "passed",
    });

    const comparisonResult = comparison(before, after);

    expect(comparisonResult.comparable).toBe(false);
    expect(comparisonResult.notComparableReasons.join(" ")).toContain("different runner versions");
    // The pairing is still produced, with the verdict separate.
    expect(labelsOf(comparisonResult).sort()).toEqual(["fixed", "still_passing"]);
    expect(comparisonResult.limitations.join(" ")).toContain("must not be used as verification evidence");
  });

  it("is incomparable when the selection differs", () => {
    const before = report({ results: [result()] });
    const after = report({ results: [result()] });

    after.impact.tests = {
      selected: [{ path: "src/other.test.ts", depth: 1, chain: [{ path: "src/other.test.ts", relation: "changed" }] }],
      notSelected: 0,
    };

    const comparisonResult = comparison(before, after);

    expect(comparisonResult.comparable).toBe(false);
    expect(comparisonResult.notComparableReasons.join(" ")).toContain("selected different test files");
  });

  it("is incomparable when the roots differ", () => {
    const before = report({ root: "/repo", results: [result()] });
    const after = report({ root: "/elsewhere", results: [result()] });

    const comparisonResult = comparison(before, after);

    expect(comparisonResult.comparable).toBe(false);
    expect(comparisonResult.notComparableReasons.join(" ")).toContain("different roots");
  });

  it("marks identity as suspect when the test file's change classification differs", () => {
    const before = report({ results: [result({ status: "failed", message: "bug" })], status: "failed" });
    const after = report({
      results: [result({ status: "failed", message: "bug" })],
      status: "failed",
      changed: [
        { path: "src/math.ts", change: "modified" },
        { path: "src/math.test.ts", change: "added" },
      ],
    });

    const comparisonResult = comparison(before, after);

    expect(comparisonResult.tests[0]?.identitySuspect).toBe(true);
    expect(comparisonResult.comparable).toBe(false);
    expect(comparisonResult.limitations.join(" ")).toContain("same way. The fingerprint does not capture the test body");
  });

  it("keeps the same schema contract readable by the CLI", () => {
    const before = report({ results: [result()] });
    const after = report({ results: [result()] });

    const comparisonResult = compareExecutionReports({ before, after, generatedAt: new Date(GENERATED_AT) });

    expect(comparisonResult.schemaVersion).toBe(1);
    expect(comparisonResult.before).toMatchObject({ runnerVersion: "3.2.4", platform: "win32-x64" });
    expect(comparisonResult.after).toEqual(comparisonResult.before);
  });
});
