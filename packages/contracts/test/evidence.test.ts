import { describe, expect, it } from "vitest";

import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  REPLAY_REPORT_SCHEMA_VERSION,
  bundleArtifactBytes,
  bundleArtifactDigest,
  evidenceBundleSchema,
  replayReportSchema,
  type EvidenceBundle,
  type ReplayReport,
} from "../src/index.js";

const TEST_SOURCE = 'expect(1 + 1).toBe(2);\n';
const TEST_DIGEST = bundleArtifactDigest(TEST_SOURCE);
const TEST_BYTES = bundleArtifactBytes(TEST_SOURCE);

function makeBundle(): EvidenceBundle {
  return {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: "bundle_0123456789abcdef",
    kind: "reproduction",
    generatedAt: "2026-10-26T12:00:00.000Z",
    engineVersion: "0.1.0",
    platform: "win32-x64",
    nodeVersion: "v24.18.0",
    target: {
      root: "/checkout",
      commit: null,
      snapshotDigest: null,
    },
    claim: {
      statement: "A coupon cannot be redeemed twice by one user.",
      expectedVerdict: "reproduced",
      provenance: "user-authored",
      requirement: "coupon.single-redemption",
      check: {
        file: "reproductions/coupon-race.test.ts",
        test: "coupon concurrent redemptions by one user redeem the coupon once",
        fingerprint: "t_b73bd648aba98ad5",
      },
    },
    permissions: {
      executeCode: true,
      runner: "vitest",
      isolation: "source-copy",
      env: ["CODECITADEL_DEMO_PG_URL"],
      network: "loopback",
    },
    artifacts: [
      {
        path: "reproductions/coupon-race.test.ts",
        digest: TEST_DIGEST,
        bytes: TEST_BYTES,
        encoding: "utf8",
        content: TEST_SOURCE,
      },
    ],
    record: {
      id: "run_0123456789abcdef",
      runner: "vitest",
      runnerVersion: "3.2.4",
      nodeVersion: "v24.18.0",
      platform: "win32-x64",
      status: "failed",
      exitCode: 1,
      durationMs: 1200,
      startedAt: "2026-10-26T12:00:00.000Z",
      command: ["node", "vitest.mjs", "run", "reproductions/coupon-race.test.ts"],
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
        root: "C:\\Temp\\disposable",
        sharedPaths: ["node_modules"],
        limitations: ["shared node_modules"],
      },
      detail: "1 test failed",
    },
    report: {
      sample: "report payload",
    },
    limitations: [
      "Replaying this bundle executes repository code in an isolated disposable copy.",
      "The check requires access to a PostgreSQL instance via CODECITADEL_DEMO_PG_URL.",
    ],
  };
}

describe("evidence bundle contracts", () => {
  it("validates a compliant evidence bundle", () => {
    const bundle = makeBundle();
    const result = evidenceBundleSchema.safeParse(bundle);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid bundle id", () => {
    const bundle = { ...makeBundle(), id: "invalid-id" };
    const result = evidenceBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("computes accurate digest and byte counts for artifacts", () => {
    const content = "hello world\n";
    const digest = bundleArtifactDigest(content);
    const bytes = bundleArtifactBytes(content);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bytes).toBe(12);
  });

  it("validates a compliant replay report", () => {
    const report: ReplayReport = {
      schemaVersion: REPLAY_REPORT_SCHEMA_VERSION,
      generatedAt: "2026-10-26T12:05:00.000Z",
      bundleId: "bundle_0123456789abcdef",
      bundleKind: "reproduction",
      verdict: "confirmed",
      reason: "Replaying the check observed the same failure as originally claimed.",
      original: {
        verdict: "reproduced",
        status: "failed",
        message: "AssertionError: Expected 1 got 8",
      },
      replayed: {
        verdict: "reproduced",
        status: "failed",
        message: "AssertionError: Expected 1 got 8",
        exitCode: 1,
        durationMs: 1100,
      },
      validation: {
        bundleBytes: 1540,
        artifactCount: 1,
        verifiedDigests: true,
      },
      limitations: ["Disposable copy isolation"],
    };

    const result = replayReportSchema.safeParse(report);
    expect(result.success).toBe(true);
  });
});
