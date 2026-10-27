import { describe, expect, it } from "vitest";

import {
  reproductionSourceBytes,
  reproductionSourceDigest,
  type ReproductionReport,
} from "@codecitadel/contracts";

import {
  BundleValidationError,
  createBundleFromReproduction,
  decideReplayVerdict,
  validateEvidenceBundle,
} from "../src/index.js";

const TEST_SOURCE = 'expect(add(-2, -1)).toBe(-4);\n';

function makeReproductionReport(): ReproductionReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-25T07:00:00.000Z",
    root: "/checkout",
    verdict: "reproduced",
    reason: "The named check failed against this tree.",
    reproduction: {
      id: "math.negative-sum",
      statement: "add returns the arithmetic sum for negative operands.",
      provenance: "user-authored",
      requirement: null,
    },
    check: {
      file: "reproductions/negative.test.ts",
      test: "reproduction adds negative numbers",
      fingerprint: "t_bf37f5a039805a04",
      digest: reproductionSourceDigest(TEST_SOURCE),
      bytes: reproductionSourceBytes(TEST_SOURCE),
      source: TEST_SOURCE,
    },
    requirement: null,
    record: {
      id: "run_0123456789abcdef",
      runner: "vitest",
      runnerVersion: "3.2.4",
      nodeVersion: "v24.18.0",
      platform: "win32-x64",
      status: "failed",
      exitCode: 1,
      durationMs: 900,
      startedAt: "2026-10-25T07:00:00.000Z",
      command: ["node", "vitest.mjs", "run", "reproductions/negative.test.ts"],
      counts: {
        passed: 0,
        failed: 1,
        skipped: 0,
        timedOut: 0,
        errored: 0,
        cancelled: 0,
        unsupported: 0,
        total: 1,
      },
      isolation: {
        mode: "source-copy",
        root: "C:\\Temp\\copy",
        sharedPaths: ["node_modules"],
        limitations: ["shared node_modules"],
      },
      detail: "1 test failed",
    },
    results: [
      {
        id: "t_bf37f5a039805a04",
        file: "reproductions/negative.test.ts",
        name: "reproduction adds negative numbers",
        status: "failed",
        durationMs: 12,
        message: "AssertionError: expected -3 to be -4",
      },
    ],
    result: {
      id: "t_bf37f5a039805a04",
      file: "reproductions/negative.test.ts",
      name: "reproduction adds negative numbers",
      status: "failed",
      durationMs: 12,
      message: "AssertionError: expected -3 to be -4",
    },
    limitations: [
      "The check was executed inside a disposable copy.",
      "Forwarded environment variables by name: CODECITADEL_DEMO_PG_URL",
    ],
  };
}

describe("evidence bundle core functions", () => {
  it("creates an evidence bundle from a reproduction report with forwarded env", () => {
    const report = makeReproductionReport();
    const bundle = createBundleFromReproduction(report);

    expect(bundle.kind).toBe("reproduction");
    expect(bundle.claim.expectedVerdict).toBe("reproduced");
    expect(bundle.permissions.env).toEqual(["CODECITADEL_DEMO_PG_URL"]);
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0].path).toBe("reproductions/negative.test.ts");
  });

  it("validates a bundle successfully when digests match", () => {
    const report = makeReproductionReport();
    const bundle = createBundleFromReproduction(report);
    const serialized = JSON.stringify(bundle);

    const validated = validateEvidenceBundle(serialized);
    expect(validated.id).toBe(bundle.id);
  });

  it("throws BundleValidationError when an artifact is tampered", () => {
    const report = makeReproductionReport();
    const bundle = createBundleFromReproduction(report);

    // Tamper with the content
    bundle.artifacts[0].content = "tampered content\n";

    expect(() => validateEvidenceBundle(bundle)).toThrow(BundleValidationError);
    expect(() => validateEvidenceBundle(bundle)).toThrow(/Corrupted artifact/);
  });

  it("throws BundleValidationError when bundle size exceeds limit", () => {
    const hugeString = "x".repeat(100);
    expect(() => validateEvidenceBundle(hugeString, 50)).toThrow(BundleValidationError);
    expect(() => validateEvidenceBundle(hugeString, 50)).toThrow(/exceeds maximum allowed limit/);
  });

  it("confirms replay when re-execution matches expected verdict", () => {
    const report = makeReproductionReport();
    const bundle = createBundleFromReproduction(report);

    const replayResult = decideReplayVerdict(
      bundle,
      {
        verdict: "reproduced",
        status: "failed",
        message: "AssertionError: expected -3 to be -4",
        exitCode: 1,
        durationMs: 850,
      },
      1200,
    );

    expect(replayResult.verdict).toBe("confirmed");
    expect(replayResult.reason).toContain("confirmed the claimed outcome");
  });

  it("reports diverged when re-execution produces a different outcome", () => {
    const report = makeReproductionReport();
    const bundle = createBundleFromReproduction(report);

    const replayResult = decideReplayVerdict(
      bundle,
      {
        verdict: "not_reproduced",
        status: "passed",
        message: null,
        exitCode: 0,
        durationMs: 850,
      },
      1200,
    );

    expect(replayResult.verdict).toBe("diverged");
    expect(replayResult.reason).toContain("diverging from claimed");
  });

  it("reports inconclusive when re-execution encounters runner error", () => {
    const report = makeReproductionReport();
    const bundle = createBundleFromReproduction(report);

    const replayResult = decideReplayVerdict(
      bundle,
      {
        verdict: "inconclusive",
        status: "errored",
        message: "failed to resolve module",
        exitCode: 2,
        durationMs: 100,
      },
      1200,
    );

    expect(replayResult.verdict).toBe("inconclusive");
    expect(replayResult.reason).toContain("inconclusive: runner errored");
  });
});
