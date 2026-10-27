import type {
  ComparisonCounts,
  ExecutionComparison,
  PatchInspection,
  PatchSignal,
} from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyPatchPath,
  decidePatchVerdict,
  inspectPatch,
  type InspectablePatchFile,
} from "../src/patch-verification.js";

function file(
  overrides: Partial<InspectablePatchFile> & Pick<InspectablePatchFile, "path">,
): InspectablePatchFile {
  return {
    status: "modified",
    added: [],
    removed: [],
    ...overrides,
  };
}

function lines(...texts: string[]): { text: string; line: number }[] {
  return texts.map((text, index) => ({ text, line: index + 1 }));
}

function counts(overrides: Partial<ComparisonCounts> = {}): ComparisonCounts {
  return {
    newlyFailing: 0,
    stillFailing: 0,
    fixed: 0,
    newlyPassing: 1,
    stillPassing: 1,
    newlyInconclusive: 0,
    stillInconclusive: 0,
    newlySkipped: 0,
    stillSkipped: 0,
    gone: 0,
    total: 2,
    ...overrides,
  };
}

function comparison(overrides: Partial<ExecutionComparison> = {}): ExecutionComparison {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-24T00:00:00.000Z",
    before: {
      root: "/repo",
      generatedAt: "2026-10-24T00:00:00.000Z",
      runnerVersion: "3.2.4",
      nodeVersion: "24.0.0",
      platform: "win32-x64",
      status: "failed",
    },
    after: {
      root: "/repo",
      generatedAt: "2026-10-24T00:01:00.000Z",
      runnerVersion: "3.2.4",
      nodeVersion: "24.0.0",
      platform: "win32-x64",
      status: "passed",
    },
    comparable: true,
    notComparableReasons: [],
    tests: [],
    counts: counts(),
    limitations: ["Comparisons pair fingerprints."],
    ...overrides,
  };
}

function inspection(signals: PatchSignal[] = []): PatchInspection {
  return {
    files: [
      { path: "src/math.ts", status: "modified", kind: "source", addedLines: 1, removedLines: 1 },
    ],
    signals,
    weakening: signals.filter((signal) => signal.severity === "weakening").length,
  };
}

const WEAKENING: PatchSignal = {
  kind: "edited-requirement",
  file: "codecitadel.requirements.json",
  line: null,
  severity: "weakening",
  detail: "edits the requirement document.",
};

describe("classifyPatchPath", () => {
  it("classifies by path shape, including test directories and root config files", () => {
    expect(classifyPatchPath("src/math.ts")).toBe("source");
    expect(classifyPatchPath("src/math.test.ts")).toBe("test");
    expect(classifyPatchPath("src/math.spec.mts")).toBe("test");
    expect(classifyPatchPath("tests/helper.ts")).toBe("test");
    expect(classifyPatchPath("src/__tests__/util.ts")).toBe("test");
    expect(classifyPatchPath("codecitadel.requirements.json")).toBe("requirement-document");
    expect(classifyPatchPath("packages/a/codecitadel.requirements.json")).toBe(
      "requirement-document",
    );
    expect(classifyPatchPath("vitest.config.ts")).toBe("runner-config");
    expect(classifyPatchPath("package.json")).toBe("runner-config");
    expect(classifyPatchPath("tsconfig.build.json")).toBe("runner-config");
    expect(classifyPatchPath("pnpm-lock.yaml")).toBe("dependency-lock");
    expect(classifyPatchPath(".gitignore")).toBe("ignore-rules");
  });
});

describe("inspectPatch", () => {
  it("flags an added skip and an added only as weakening", () => {
    const result = inspectPatch([
      file({
        path: "src/math.test.ts",
        added: [
          { text: 'it.skip("pending", () => {', line: 12 },
          { text: 'test.only("focused", () => {', line: 15 },
        ],
        removed: [],
      }),
    ]);

    const kinds = result.signals.map((signal) => signal.kind);
    expect(kinds).toContain("edited-test");
    expect(kinds).toContain("added-skip");
    expect(kinds).toContain("added-only");
    expect(result.weakening).toBe(2);
    expect(result.signals.find((signal) => signal.kind === "added-skip")?.line).toBe(12);
    expect(result.signals.find((signal) => signal.kind === "edited-test")?.severity).toBe(
      "warning",
    );
  });

  it("flags fewer assertions than before", () => {
    const result = inspectPatch([
      file({
        path: "src/math.test.ts",
        added: lines("  expect(add(1, 1)).toBe(2);"),
        removed: lines("  expect(add(1, 1)).toBe(2);", "  expect(add(2, 2)).toBe(4);"),
      }),
    ]);

    const signal = result.signals.find((entry) => entry.kind === "removed-assertion");
    expect(signal).toMatchObject({ severity: "weakening", file: "src/math.test.ts" });
    expect(signal?.detail).toContain("2 assertion");
    expect(result.weakening).toBeGreaterThanOrEqual(1);
  });

  it("treats an edited test as a warning and a deleted test as weakening", () => {
    const edited = inspectPatch([file({ path: "src/a.test.ts", status: "modified" })]);
    expect(edited.signals).toEqual([
      expect.objectContaining({ kind: "edited-test", severity: "warning" }),
    ]);
    expect(edited.weakening).toBe(0);

    const deleted = inspectPatch([file({ path: "src/a.test.ts", status: "deleted" })]);
    expect(deleted.signals).toEqual([
      expect.objectContaining({ kind: "removed-test-file", severity: "weakening" }),
    ]);
    expect(deleted.weakening).toBe(1);
  });

  it("flags requirement, runner-config, and ignore-rule edits as weakening", () => {
    const result = inspectPatch([
      file({ path: "codecitadel.requirements.json" }),
      file({ path: "vitest.config.ts" }),
      file({ path: ".gitignore" }),
    ]);

    expect(result.signals.map((signal) => signal.kind).sort()).toEqual([
      "changed-ignore-rules",
      "changed-runner-config",
      "edited-requirement",
    ]);
    expect(result.weakening).toBe(3);
  });

  it("reports a lockfile change as context, not as weakening", () => {
    const result = inspectPatch([file({ path: "pnpm-lock.yaml" })]);
    expect(result.signals).toEqual([
      expect.objectContaining({ kind: "changed-lockfile", severity: "warning" }),
    ]);
    expect(result.weakening).toBe(0);
  });

  it("requires at least one file change", () => {
    expect(() => inspectPatch([])).toThrow(/at least one/);
  });
});

describe("decidePatchVerdict", () => {
  const base = {
    applied: true,
    applyError: null,
    afterStatus: "passed" as const,
    comparison: comparison(),
    requirementRegressions: [],
    inspection: inspection(),
  };

  it("verifies a patch whose checks all still pass", () => {
    expect(decidePatchVerdict(base)).toMatchObject({ verdict: "verified" });
    expect(decidePatchVerdict(base).reason).toContain("passed after the patch");
  });

  it("never verifies a patch that weakens its own evidence", () => {
    const decision = decidePatchVerdict({
      ...base,
      inspection: inspection([WEAKENING]),
    });
    expect(decision.verdict).toBe("not_verified");
    expect(decision.reason).toContain("edited-requirement");
    expect(decision.reason).toContain("cannot verify itself");
  });

  it("does not let a weakening warning block the verdict", () => {
    const decision = decidePatchVerdict({
      ...base,
      inspection: inspection([{ ...WEAKENING, kind: "edited-test", severity: "warning" }]),
    });
    expect(decision.verdict).toBe("verified");
  });

  it("reports an unpublished requirement regression as not verified", () => {
    const decision = decidePatchVerdict({ ...base, requirementRegressions: ["coupon.one-use"] });
    expect(decision.verdict).toBe("not_verified");
    expect(decision.reason).toContain("coupon.one-use");
  });

  it("distinguishes a new failure from a pre-existing one", () => {
    expect(
      decidePatchVerdict({ ...base, comparison: comparison({ counts: counts({ newlyFailing: 1 }) }) })
        .verdict,
    ).toBe("not_verified");
    expect(
      decidePatchVerdict({ ...base, comparison: comparison({ counts: counts({ stillFailing: 1 }) }) })
        .reason,
    ).toContain("still fail");
  });

  it("never turns a skipped, vanished, or inconclusive result into a pass", () => {
    for (const overrides of [
      { newlySkipped: 1 },
      { newlyInconclusive: 1 },
      { gone: 1 },
    ] as const) {
      const decision = decidePatchVerdict({
        ...base,
        comparison: comparison({ counts: counts(overrides) }),
      });
      expect(decision.verdict).toBe("inconclusive");
    }
  });

  it("refuses to use a pair of runs that is not comparable", () => {
    const decision = decidePatchVerdict({
      ...base,
      comparison: comparison({
        comparable: false,
        notComparableReasons: ["The runs analyzed different roots."],
      }),
    });
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reason).toContain("different roots");
  });

  it("is inconclusive when the run produced no usable result", () => {
    expect(decidePatchVerdict({ ...base, afterStatus: "timed_out" }).verdict).toBe("inconclusive");
    expect(decidePatchVerdict({ ...base, afterStatus: "skipped" }).verdict).toBe("inconclusive");
    expect(decidePatchVerdict({ ...base, afterStatus: null, comparison: null }).verdict).toBe(
      "inconclusive",
    );
  });

  it("reports a patch that did not apply as not applied", () => {
    const decision = decidePatchVerdict({
      ...base,
      applied: false,
      applyError: "The patch is stale.",
      comparison: null,
      afterStatus: null,
    });
    expect(decision.verdict).toBe("not_applied");
    expect(decision.reason).toContain("stale");
  });
});
