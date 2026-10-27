import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildModuleGraph, isModuleFile, isTestFile, type ModuleCandidate } from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-graph-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>): string {
  const root = path.join(scratch, name);
  for (const [filePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, filePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
  return root;
}

function candidates(files: Record<string, string>, skipped: Record<string, string> = {}): ModuleCandidate[] {
  return Object.keys(files)
    .sort()
    .map((filePath) => ({ path: filePath, skipped: skipped[filePath] ?? null }));
}

describe("buildModuleGraph", () => {
  it("resolves relative imports and records the imported names", () => {
    const files = {
      "src/a.ts": 'import { helper, other as renamed } from "./b";\nimport def from "./b";\nexport const value = 1;\n',
      "src/b.ts": "export const helper = 1;\nexport const other = 2;\nexport default 3;\n",
    };
    const graph = buildModuleGraph({ root: project("symbols", files), files: candidates(files) });

    expect(graph.modules).toEqual(["src/a.ts", "src/b.ts"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "src/a.ts", to: "src/b.ts" });
    // One merged edge; a default import and two named imports.
    expect(graph.edges[0]?.symbols.sort()).toEqual(["default", "helper", "other"]);
    expect(graph.unresolved).toHaveLength(0);
  });

  it("follows re-exports, require, and dynamic import", () => {
    const files = {
      "src/reexport.ts": 'export * from "./target";\nexport { only } from "./target";\n',
      "src/require.js": 'const target = require("./target");\nmodule.exports = target;\n',
      "src/dynamic.ts": 'export async function load() {\n  return import("./target");\n}\n',
      "src/target.ts": "export const only = 1;\n",
    };
    const graph = buildModuleGraph({ root: project("forms", files), files: candidates(files) });

    const pairs = graph.edges.map((edge) => `${edge.from}->${edge.to}`);
    expect(pairs).toEqual([
      "src/dynamic.ts->src/target.ts",
      "src/reexport.ts->src/target.ts",
      "src/require.js->src/target.ts",
    ]);
  });

  it("records an unresolvable local import instead of dropping it", () => {
    const files = { "src/a.ts": 'import { gone } from "./missing";\nexport const value = gone;\n' };
    const graph = buildModuleGraph({ root: project("unresolved", files), files: candidates(files) });

    expect(graph.edges).toHaveLength(0);
    expect(graph.unresolved).toEqual([{ from: "src/a.ts", specifier: "./missing" }]);
  });

  it("counts package and builtin imports without following them", () => {
    const files = {
      "src/a.ts": 'import { readFileSync } from "node:fs";\nimport zod from "zod";\nexport const v = zod;\n',
    };
    const graph = buildModuleGraph({ root: project("external", files), files: candidates(files) });

    expect(graph.externalImports).toBe(2);
    expect(graph.edges).toHaveLength(0);
  });

  it("does not treat a file the scanner skipped as a parsed module", () => {
    const files = {
      "src/binary.js": "not really parsed",
      "src/a.ts": "export const value = 1;\n",
    };
    const graph = buildModuleGraph({
      root: project("skipped", files),
      files: candidates(files, { "src/binary.js": "binary" }),
    });

    expect(graph.modules).toEqual(["src/a.ts"]);
    expect(graph.skipped).toEqual([{ path: "src/binary.js", reason: "binary" }]);
  });

  it("counts an import that resolves outside the scanned file list", () => {
    const files = {
      "src/a.ts": 'import { x } from "../outside/x";\nexport const value = x;\n',
      "outside/x.ts": "export const x = 1;\n",
    };
    const candidatesWithoutOutside = Object.keys(files)
      .filter((filePath) => filePath.startsWith("src/"))
      .map((filePath) => ({ path: filePath, skipped: null }));

    const graph = buildModuleGraph({
      root: project("outside", files),
      files: candidatesWithoutOutside,
    });

    expect(graph.edges).toHaveLength(0);
    expect(graph.outsideScope).toBe(1);
  });

  it("is deterministic for the same input", () => {
    const files = {
      "src/z.ts": 'import "./a";\nimport "./b";\n',
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": "export const b = 1;\n",
    };
    const root = project("deterministic", files);
    const first = buildModuleGraph({ root, files: candidates(files) });
    const second = buildModuleGraph({ root, files: candidates(files) });
    expect(second).toEqual(first);
  });
});

describe("isTestFile", () => {
  it("recognises common test naming conventions only", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("src/a.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/a.ts")).toBe(true);
    expect(isTestFile("tests/a.test.mjs")).toBe(true);
    expect(isTestFile("src/testing.ts")).toBe(false);
    expect(isTestFile("src/a.ts")).toBe(false);
  });
});

describe("isModuleFile", () => {
  it("accepts source extensions and rejects assets", () => {
    expect(isModuleFile("a.ts")).toBe(true);
    expect(isModuleFile("a.mts")).toBe(true);
    expect(isModuleFile("a.jsx")).toBe(true);
    expect(isModuleFile("a.json")).toBe(false);
    expect(isModuleFile("a.css")).toBe(false);
  });
});
