import { describe, expect, it } from "vitest";

import {
  reproductionDocumentSchema,
  reproductionExportSchema,
  reproductionReportSchema,
  reproductionSourceBytes,
  reproductionSourceDigest,
} from "../src/index.js";

const ENTRY = {
  id: "math.negative-sum",
  requirement: null,
  statement: "add returns the arithmetic sum for negative operands.",
  provenance: "user-authored" as const,
  file: "reproductions/negative.test.ts",
  test: "reproduction adds negative numbers",
};

const SOURCE = 'expect(add(-2, -1)).toBe(-4);\n';

function report() {
  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-10-25T07:00:00.000Z",
    root: "/checkout",
    verdict: "reproduced" as const,
    reason: "The named check failed against this tree.",
    reproduction: {
      id: ENTRY.id,
      statement: ENTRY.statement,
      provenance: ENTRY.provenance,
      requirement: null,
    },
    check: {
      file: ENTRY.file,
      test: ENTRY.test,
      fingerprint: "t_0123456789abcdef",
      digest: reproductionSourceDigest(SOURCE),
      bytes: reproductionSourceBytes(SOURCE),
      source: SOURCE,
    },
    requirement: null,
    record: {
      id: "run_0123456789abcdef",
      runner: "vitest" as const,
      runnerVersion: "3.2.4",
      nodeVersion: "v24.18.0",
      platform: "win32-x64",
      status: "failed" as const,
      exitCode: 1,
      durationMs: 900,
      startedAt: "2026-10-25T07:00:00.000Z",
      command: ["node", "vitest.mjs", "run", ENTRY.file],
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
        mode: "source-copy" as const,
        root: "/tmp/copy",
        sharedPaths: ["node_modules"],
        limitations: ["The copy shares node_modules with the checkout."],
      },
      detail: "1 test(s) failed.",
    },
    results: [],
    result: null,
    limitations: ["The reproduction ran in a disposable copy."],
  };
}

describe("reproductionDocumentSchema", () => {
  it("accepts a manifest with a declared check", () => {
    const parsed = reproductionDocumentSchema.parse({
      schemaVersion: 1,
      reproductions: [ENTRY],
    });
    expect(parsed.reproductions[0]?.test).toBe(ENTRY.test);
  });

  it("rejects an unknown field instead of ignoring a typo", () => {
    const result = reproductionDocumentSchema.safeParse({
      schemaVersion: 1,
      reproductions: [{ ...ENTRY, tests: ENTRY.test }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids and a wrong schema version", () => {
    expect(
      reproductionDocumentSchema.safeParse({
        schemaVersion: 1,
        reproductions: [ENTRY, { ...ENTRY, file: "reproductions/other.test.ts" }],
      }).success,
    ).toBe(false);

    expect(
      reproductionDocumentSchema.safeParse({
        schemaVersion: 2,
        reproductions: [ENTRY],
      }).success,
    ).toBe(false);
  });
});

describe("reproductionReportSchema", () => {
  it("accepts a report that carries the check source", () => {
    const parsed = reproductionReportSchema.parse(report());
    expect(parsed.check.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts a report where nothing was executed", () => {
    const parsed = reproductionReportSchema.parse({
      ...report(),
      verdict: "not_accepted",
      reason: "The requirement is proposed, not accepted.",
      requirement: { id: "math.negative-sum", state: "proposed", acceptance: "missing" },
      record: null,
      results: [],
      result: null,
    });
    expect(parsed.record).toBeNull();
  });

  it("rejects a verdict outside the four the tool defines", () => {
    expect(reproductionReportSchema.safeParse({ ...report(), verdict: "passed" }).success).toBe(
      false,
    );
  });
});

describe("reproduction source digests", () => {
  it("covers the UTF-8 bytes, not the character count", () => {
    const emoji = "expect(«ok»).toBe('ünïcode 🙂');";
    expect(reproductionSourceBytes(emoji)).toBeGreaterThan(emoji.length);
    expect(reproductionSourceDigest(emoji)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reproductionSourceDigest(emoji)).not.toBe(reproductionSourceDigest(`${emoji} `));
  });
});

describe("reproductionExportSchema", () => {
  it("accepts a manifest that references the recorded evidence", () => {
    const source = SOURCE;
    const parsed = reproductionExportSchema.parse({
      schemaVersion: 1,
      kind: "codecitadel.reproduction-export",
      generatedAt: "2026-10-25T07:05:00.000Z",
      id: ENTRY.id,
      statement: ENTRY.statement,
      provenance: ENTRY.provenance,
      requirement: null,
      check: {
        file: ENTRY.file,
        test: ENTRY.test,
        fingerprint: "t_0123456789abcdef",
        digest: reproductionSourceDigest(source),
      },
      evidence: {
        schemaVersion: 1,
        generatedAt: "2026-10-25T07:00:00.000Z",
        root: "/checkout",
        verdict: "reproduced",
        execution: {
          runner: "vitest",
          runnerVersion: "3.2.4",
          nodeVersion: "v24.18.0",
          platform: "win32-x64",
          isolation: "source-copy",
          startedAt: "2026-10-25T07:00:00.000Z",
        },
      },
      files: [{ path: ENTRY.file, digest: reproductionSourceDigest(source), bytes: 32 }],
      limitations: ["The exported test needs the project's own dependencies."],
    });
    expect(parsed.files[0]?.path).toBe(ENTRY.file);
  });

  it("rejects a manifest with no files or a wrong kind", () => {
    expect(
      reproductionExportSchema.safeParse({
        schemaVersion: 1,
        kind: "codecitadel.reproduction-export",
        generatedAt: "2026-10-25T07:05:00.000Z",
        id: ENTRY.id,
        statement: ENTRY.statement,
        provenance: ENTRY.provenance,
        requirement: null,
        check: {
          file: ENTRY.file,
          test: ENTRY.test,
          fingerprint: "t_0123456789abcdef",
          digest: reproductionSourceDigest(SOURCE),
        },
        evidence: {
          schemaVersion: 1,
          generatedAt: "2026-10-25T07:00:00.000Z",
          root: "/checkout",
          verdict: "reproduced",
          execution: null,
        },
        files: [],
        limitations: ["…"],
      }).success,
    ).toBe(false);

    expect(
      reproductionExportSchema.safeParse({
        schemaVersion: 1,
        kind: "reproduction-export",
        generatedAt: "2026-10-25T07:05:00.000Z",
        id: ENTRY.id,
        statement: ENTRY.statement,
        provenance: ENTRY.provenance,
        requirement: null,
        check: {
          file: ENTRY.file,
          test: ENTRY.test,
          fingerprint: "t_0123456789abcdef",
          digest: reproductionSourceDigest(SOURCE),
        },
        evidence: {
          schemaVersion: 1,
          generatedAt: "2026-10-25T07:00:00.000Z",
          root: "/checkout",
          verdict: "reproduced",
          execution: null,
        },
        files: [{ path: ENTRY.file, digest: reproductionSourceDigest(SOURCE), bytes: 32 }],
        limitations: ["…"],
      }).success,
    ).toBe(false);
  });
});
