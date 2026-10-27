import {
  IMPACT_SCHEMA_VERSION,
  impactReportSchema,
  type ChangedFile,
  type ImpactChainEntry,
  type ImpactedFile,
  type ImpactReport,
} from "@codecitadel/contracts";

import { isTestFile, type ModuleGraph } from "./graph.js";

/**
 * Which files, and which tests, can see a change.
 *
 * The only relationship used here is "this file imports that file", read from
 * the parsed syntax tree. Everything else — runtime registration, dependency
 * injection, computed specifiers, test-runner globs — is outside what the graph
 * can see, so it is stated as a limitation rather than quietly assumed away.
 *
 * Selection is deliberately pessimistic in the other direction too: a test that
 * is not selected is reported as "not selected", never as "safe".
 */

export interface ComputeImpactInput {
  graph: ModuleGraph;
  changed: readonly ChangedFile[];
  base: { generatedAt: string; root: string };
  /** Injectable clock so tests are deterministic. */
  generatedAt?: Date;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function computeImpact(input: ComputeImpactInput): ImpactReport {
  const { graph } = input;

  const changed = [...input.changed].sort((left, right) => comparePaths(left.path, right.path));
  const changedPaths = [...new Set(changed.map((entry) => entry.path))].sort(comparePaths);

  const importersOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const importers = importersOf.get(edge.to) ?? [];
    importers.push(edge.from);
    importersOf.set(edge.to, importers);
  }
  for (const importers of importersOf.values()) {
    importers.sort(comparePaths);
  }

  const chains = new Map<string, ImpactChainEntry[]>();
  const depths = new Map<string, number>();
  const queue: Array<{ path: string; depth: number; chain: ImpactChainEntry[] }> = [];

  for (const changedPath of changedPaths) {
    const chain: ImpactChainEntry[] = [{ path: changedPath, relation: "changed" }];
    chains.set(changedPath, chain);
    depths.set(changedPath, 0);
    queue.push({ path: changedPath, depth: 0, chain });
  }

  // Breadth-first so every chain is the shortest explanation available. Starting
  // from all changes at once means a test reachable from two changes reports the
  // nearer one instead of whichever happened to be visited first.
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) {
      continue;
    }
    for (const importer of importersOf.get(current.path) ?? []) {
      if (chains.has(importer)) {
        continue;
      }
      const chain: ImpactChainEntry[] = [{ path: importer, relation: "imports" }, ...current.chain];
      chains.set(importer, chain);
      depths.set(importer, current.depth + 1);
      queue.push({ path: importer, depth: current.depth + 1, chain });
    }
  }

  const impacted: ImpactedFile[] = [...chains.entries()]
    .map(([filePath, chain]) => ({
      path: filePath,
      depth: depths.get(filePath) ?? 0,
      chain,
    }))
    .sort((left, right) =>
      left.depth === right.depth ? comparePaths(left.path, right.path) : left.depth - right.depth,
    );

  const testFiles = graph.modules.filter(isTestFile);
  const selected = impacted.filter((entry) => isTestFile(entry.path));
  const notSelected = testFiles.length - selected.length;

  const known = new Set<string>([...graph.modules, ...graph.edges.map((edge) => edge.to)]);
  const incompleteReasons: string[] = [];
  const fullyAnalysed = graph.skipped.length === 0 && graph.unresolved.length === 0;

  for (const entry of changed) {
    if (known.has(entry.path)) {
      continue;
    }
    if (entry.change === "removed" && fullyAnalysed) {
      // Nothing that was analyzed imported it, so nothing in the graph can see it.
      continue;
    }
    incompleteReasons.push(
      `${entry.path} is ${entry.change} but was not analyzed as a source module; tests that depend on it may be missing from the selection.`,
    );
  }
  if (graph.skipped.length > 0) {
    const detail = graph.skipped
      .slice(0, 5)
      .map((file) => `${file.path} (${file.reason})`)
      .join(", ");
    incompleteReasons.push(
      `${graph.skipped.length} source file(s) could not be parsed, so their imports and test status are unknown: ${detail}${graph.skipped.length > 5 ? ", …" : ""}.`,
    );
  }
  if (graph.unresolved.length > 0) {
    const detail = graph.unresolved
      .slice(0, 5)
      .map((entry) => `${entry.from} → ${entry.specifier}`)
      .join(", ");
    incompleteReasons.push(
      `${graph.unresolved.length} local import(s) could not be resolved and were not followed: ${detail}${graph.unresolved.length > 5 ? ", …" : ""}.`,
    );
  }
  if (graph.outsideScope > 0) {
    incompleteReasons.push(
      `${graph.outsideScope} import(s) resolved to files the scan did not cover; those files are not in the graph and their dependents are unknown.`,
    );
  }

  const typeOnlyEdges = graph.edges.filter((edge) => edge.typeOnly).length;

  const limitations = [
    "Impact is derived from static import statements. Computed specifiers, dependency injection, global registration, and files loaded by test runners are not followed.",
    "Nothing was executed: a selected test is a candidate to run, not a result. This report says nothing about passing or failing.",
    "A test that was not selected is not proven unaffected; it may still exercise the change indirectly.",
  ];
  if (graph.externalImports > 0) {
    limitations.push(
      `${graph.externalImports} import(s) point at packages or builtins. Their source is not in this repository, so changes inside dependencies are not analysed.`,
    );
  }
  if (typeOnlyEdges > 0) {
    limitations.push(
      `${typeOnlyEdges} edge(s) are type-only imports. They can break compilation, but they do not affect runtime behaviour, and this report does not separate the two.`,
    );
  }
  if (incompleteReasons.length > 0) {
    limitations.push(
      "The graph is incomplete (see incompleteReasons), so the test selection is a lower bound, not a complete answer.",
    );
  }

  return impactReportSchema.parse({
    schemaVersion: IMPACT_SCHEMA_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    root: graph.root,
    base: input.base,
    changed,
    graph: {
      modules: graph.modules.length,
      edges: graph.edges.length,
      testFiles: testFiles.length,
      externalImports: graph.externalImports,
      outsideScope: graph.outsideScope,
      unresolved: graph.unresolved,
    },
    impacted,
    tests: { selected, notSelected },
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    limitations,
  });
}
