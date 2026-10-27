import type { ChangedFile } from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import { computeImpact, type ModuleGraph } from "../src/index.js";

function graph(overrides: Partial<ModuleGraph> = {}): ModuleGraph {
  return {
    root: "/repo",
    modules: [],
    edges: [],
    unresolved: [],
    externalImports: 0,
    outsideScope: 0,
    skipped: [],
    ...overrides,
  };
}

function changed(...paths: Array<[string, ChangedFile["change"]]>): ChangedFile[] {
  return paths.map(([filePath, change]) => ({ path: filePath, change }));
}

const base = { generatedAt: "2026-01-01T00:00:00.000Z", root: "/repo" };
const now = new Date("2026-01-02T00:00:00.000Z");

describe("computeImpact", () => {
  it("selects a test that imports a changed file, and explains why", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.ts", "src/a.test.ts"],
        edges: [{ from: "src/a.test.ts", to: "src/a.ts", symbols: ["value"], typeOnly: false }],
      }),
      changed: changed(["src/a.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.tests.selected).toHaveLength(1);
    expect(report.tests.selected[0]?.path).toBe("src/a.test.ts");
    expect(report.tests.selected[0]?.chain).toEqual([
      { path: "src/a.test.ts", relation: "imports" },
      { path: "src/a.ts", relation: "changed" },
    ]);
    expect(report.tests.notSelected).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it("follows the shortest chain through several files", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.test.ts", "src/mid.ts", "src/deep.ts"],
        edges: [
          { from: "src/a.test.ts", to: "src/mid.ts", symbols: ["mid"], typeOnly: false },
          { from: "src/mid.ts", to: "src/deep.ts", symbols: ["deep"], typeOnly: false },
        ],
      }),
      changed: changed(["src/deep.ts", "modified"]),
      base,
      generatedAt: now,
    });

    const selected = report.tests.selected[0];
    expect(selected?.depth).toBe(2);
    expect(selected?.chain.map((entry) => entry.path)).toEqual([
      "src/a.test.ts",
      "src/mid.ts",
      "src/deep.ts",
    ]);
    expect(selected?.chain.map((entry) => entry.relation)).toEqual(["imports", "imports", "changed"]);
  });

  it("does not select a test that cannot reach the change, and says how many were skipped", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.ts", "src/a.test.ts", "src/b.ts", "src/b.test.ts"],
        edges: [
          { from: "src/a.test.ts", to: "src/a.ts", symbols: [], typeOnly: false },
          { from: "src/b.test.ts", to: "src/b.ts", symbols: [], typeOnly: false },
        ],
      }),
      changed: changed(["src/a.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.tests.selected.map((entry) => entry.path)).toEqual(["src/a.test.ts"]);
    expect(report.tests.notSelected).toBe(1);
  });

  it("selects a changed test file itself with no hops", () => {
    const report = computeImpact({
      graph: graph({ modules: ["src/a.test.ts"], edges: [] }),
      changed: changed(["src/a.test.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.tests.selected[0]?.depth).toBe(0);
    expect(report.tests.selected[0]?.chain).toEqual([
      { path: "src/a.test.ts", relation: "changed" },
    ]);
  });

  it("finds importers of a removed file through the edge that pointed at it", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.test.ts"],
        edges: [{ from: "src/a.test.ts", to: "src/gone.ts", symbols: ["gone"], typeOnly: false }],
      }),
      changed: changed(["src/gone.ts", "removed"]),
      base,
      generatedAt: now,
    });

    expect(report.tests.selected.map((entry) => entry.path)).toEqual(["src/a.test.ts"]);
    expect(report.complete).toBe(true);
  });

  it("marks the result incomplete when a local import could not be resolved", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.ts"],
        unresolved: [{ from: "src/a.ts", specifier: "./moved" }],
      }),
      changed: changed(["src/a.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.complete).toBe(false);
    expect(report.incompleteReasons.join(" ")).toContain("could not be resolved");
    expect(report.limitations.join(" ")).toContain("lower bound");
  });

  it("marks the result incomplete when a source file could not be parsed", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.ts"],
        skipped: [{ path: "src/huge.ts", reason: "too_large" }],
      }),
      changed: changed(["src/a.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.complete).toBe(false);
    expect(report.incompleteReasons.join(" ")).toContain("src/huge.ts (too_large)");
  });

  it("says so when a changed file is not in the graph at all", () => {
    const report = computeImpact({
      graph: graph({ modules: ["src/a.ts"] }),
      changed: changed(["docs/readme.md", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.complete).toBe(false);
    expect(report.incompleteReasons.join(" ")).toContain("docs/readme.md is modified");
    expect(report.tests.selected).toHaveLength(0);
  });

  it("reports external and type-only edges as limitations rather than following them", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/a.ts", "src/a.test.ts"],
        edges: [{ from: "src/a.test.ts", to: "src/a.ts", symbols: ["t"], typeOnly: true }],
        externalImports: 3,
      }),
      changed: changed(["src/a.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.graph.externalImports).toBe(3);
    const limitations = report.limitations.join(" ");
    expect(limitations).toContain("3 import(s) point at packages");
    expect(limitations).toContain("type-only");
  });

  it("is deterministic and sorted by depth then path", () => {
    const report = computeImpact({
      graph: graph({
        modules: ["src/z.test.ts", "src/a.test.ts", "src/shared.ts"],
        edges: [
          { from: "src/z.test.ts", to: "src/shared.ts", symbols: [], typeOnly: false },
          { from: "src/a.test.ts", to: "src/shared.ts", symbols: [], typeOnly: false },
        ],
      }),
      changed: changed(["src/shared.ts", "modified"]),
      base,
      generatedAt: now,
    });

    expect(report.tests.selected.map((entry) => entry.path)).toEqual([
      "src/a.test.ts",
      "src/z.test.ts",
    ]);
    const again = computeImpact({
      graph: graph({
        modules: ["src/z.test.ts", "src/a.test.ts", "src/shared.ts"],
        edges: [
          { from: "src/z.test.ts", to: "src/shared.ts", symbols: [], typeOnly: false },
          { from: "src/a.test.ts", to: "src/shared.ts", symbols: [], typeOnly: false },
        ],
      }),
      changed: changed(["src/shared.ts", "modified"]),
      base,
      generatedAt: now,
    });
    expect(again).toEqual(report);
  });
});
