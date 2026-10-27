import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  boundMessage,
  normalizeResultPath,
  normalizeVitestReport,
  stableTestId,
} from "../src/index.js";

const ROOT = path.resolve("/tmp/codecitadel-copy-abc");

function reportWith(files: unknown[]): unknown {
  return { testResults: files };
}

describe("normalizeResultPath", () => {
  it("rewrites an absolute reporter path into a root-relative path", () => {
    const reported = path.join(ROOT, "src", "math.test.ts");
    expect(normalizeResultPath(reported, ROOT)).toBe("src/math.test.ts");
  });

  it("keeps a path outside the root absolute and uses forward slashes", () => {
    const outside = path.resolve("/elsewhere/src/other.test.ts");
    expect(normalizeResultPath(outside, ROOT)).toBe(outside.split(path.sep).join("/"));
  });
});

describe("stableTestId", () => {
  it("is identical for the same file and name and different otherwise", () => {
    const first = stableTestId("src/math.test.ts", "add > adds two numbers");
    expect(first).toMatch(/^t_[0-9a-f]{16}$/);
    expect(stableTestId("src/math.test.ts", "add > adds two numbers")).toBe(first);
    expect(stableTestId("src/math.test.ts", "add > adds three numbers")).not.toBe(first);
    expect(stableTestId("src/other.test.ts", "add > adds two numbers")).not.toBe(first);
  });
});

describe("boundMessage", () => {
  it("strips ANSI colour and keeps the first non-empty line", () => {
    expect(boundMessage("\n\u001b[31mAssertionError: expected 1 to be 2\u001b[39m\n at file.ts:3")).toBe(
      "AssertionError: expected 1 to be 2",
    );
  });

  it("truncates a long message instead of storing it whole", () => {
    const message = boundMessage("x".repeat(1000));
    expect(message).not.toBeNull();
    expect(message?.length).toBe(401);
    expect(message?.endsWith("…")).toBe(true);
  });

  it("returns null for undefined and empty text", () => {
    expect(boundMessage(undefined)).toBeNull();
    expect(boundMessage("   \n\t ")).toBeNull();
  });
});

describe("normalizeVitestReport", () => {
  it("maps runner statuses and keeps durations", () => {
    const { results, notes } = normalizeVitestReport({
      report: reportWith([
        {
          name: path.join(ROOT, "src", "math.test.ts"),
          status: "failed",
          assertionResults: [
            {
              fullName: "add > adds two numbers",
              status: "passed",
              duration: 3.4,
              failureMessages: [],
            },
            {
              fullName: "add > rejects strings",
              status: "failed",
              duration: 1,
              failureMessages: ["AssertionError: expected 3 to be 5"],
            },
            { fullName: "add > is pending", status: "pending" },
            { fullName: "add > is disabled", status: "disabled" },
          ],
        },
      ]),
      selectedFiles: ["src/math.test.ts"],
      root: ROOT,
      exitCode: 1,
    });

    expect(notes).toEqual([]);
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ["add > adds two numbers", "passed"],
      ["add > is disabled", "skipped"],
      ["add > is pending", "skipped"],
      ["add > rejects strings", "failed"],
    ]);
    const passed = results.find((result) => result.name === "add > adds two numbers");
    expect(passed?.durationMs).toBe(3);
    expect(passed?.message).toBeNull();
    const failed = results.find((result) => result.name === "add > rejects strings");
    expect(failed?.message).toBe("AssertionError: expected 3 to be 5");
  });

  it("reports a suite-level failure as errored instead of failed tests", () => {
    const { results } = normalizeVitestReport({
      report: reportWith([
        {
          name: path.join(ROOT, "src", "broken.test.ts"),
          status: "failed",
          message: "Error: Cannot find module './missing'",
          assertionResults: [],
        },
      ]),
      selectedFiles: ["src/broken.test.ts"],
      root: ROOT,
      exitCode: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      file: "src/broken.test.ts",
      name: "(suite)",
      status: "errored",
      message: "Error: Cannot find module './missing'",
    });
  });

  it("turns a selected file with no reported result into an error, never a pass", () => {
    const { results } = normalizeVitestReport({
      report: reportWith([]),
      selectedFiles: ["src/math.test.ts"],
      root: ROOT,
      exitCode: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("errored");
    expect(results[0]?.message).toContain("did not report a result");
  });

  it("treats an unrecognized status as errored rather than guessing", () => {
    const { results } = normalizeVitestReport({
      report: reportWith([
        {
          name: path.join(ROOT, "src", "math.test.ts"),
          status: "passed",
          assertionResults: [{ fullName: "odd", status: "flaky" }],
        },
      ]),
      selectedFiles: ["src/math.test.ts"],
      root: ROOT,
      exitCode: 0,
    });

    expect(results[0]?.status).toBe("errored");
    expect(results[0]?.message).toContain('"flaky"');
  });

  it("errors every selected file when the runner produced no report", () => {
    const { results, notes } = normalizeVitestReport({
      report: null,
      selectedFiles: ["src/math.test.ts", "src/writes.test.ts"],
      root: ROOT,
      exitCode: null,
    });

    expect(results.map((result) => result.status)).toEqual(["errored", "errored"]);
    expect(notes.join(" ")).toContain("no JSON report");
  });

  it("errors every selected file when the report has the wrong shape", () => {
    const { results, notes } = normalizeVitestReport({
      report: { testResults: "not-an-array" },
      selectedFiles: ["src/math.test.ts"],
      root: ROOT,
      exitCode: 0,
    });

    expect(results[0]?.status).toBe("errored");
    expect(notes.join(" ")).toContain("did not match the expected shape");
  });

  it("gives duplicate test names distinct ids without changing their order", () => {
    const { results } = normalizeVitestReport({
      report: reportWith([
        {
          name: path.join(ROOT, "src", "cases.test.ts"),
          status: "passed",
          assertionResults: [
            { fullName: "case", status: "passed" },
            { fullName: "case", status: "failed", failureMessages: ["boom"] },
          ],
        },
      ]),
      selectedFiles: ["src/cases.test.ts"],
      root: ROOT,
      exitCode: 1,
    });

    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.id)).size).toBe(2);
    expect(results.map((result) => result.status).sort()).toEqual(["failed", "passed"]);
  });
});
