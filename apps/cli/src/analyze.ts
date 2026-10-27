import type {
  ChangedFile,
  CodeCitadelReport,
  ImpactReport,
  Snapshot,
  SnapshotDiff,
} from "@codecitadel/contracts";
import { buildSnapshot, diffSnapshots, scanRepositoryDetailed } from "@codecitadel/core";
import { buildModuleGraph, computeImpact } from "@codecitadel/symbol-graph";

export interface ChangeAnalysisInput {
  /** Directory to treat as the head. */
  root: string;
  /** Stored baseline to compare against. */
  baseSnapshot: Snapshot;
  scannerPath?: string | undefined;
}

export interface ChangeAnalysis {
  /** Fresh scan of the head tree. */
  report: CodeCitadelReport;
  headSnapshot: Snapshot;
  diff: SnapshotDiff;
  impact: ImpactReport;
}

/**
 * The one change-analysis pipeline: scan the head, compare it with a stored
 * snapshot, build the module graph, and select the tests that can see the
 * change.
 *
 * `impact` and `run` both call this so the test list a user sees and the test
 * list that is executed cannot diverge.
 */
export async function analyzeChanges(input: ChangeAnalysisInput): Promise<ChangeAnalysis> {
  const scan = await scanRepositoryDetailed({
    root: input.root,
    ...(input.scannerPath !== undefined ? { scannerPath: input.scannerPath } : {}),
  });

  const headSnapshot = buildSnapshot({ report: scan.report, files: scan.files });
  const diff = diffSnapshots(input.baseSnapshot, headSnapshot);

  const changed: ChangedFile[] = [
    ...diff.files.added.map((entry) => ({ path: entry.path, change: "added" as const })),
    ...diff.files.modified.map((entry) => ({ path: entry.path, change: "modified" as const })),
    ...diff.files.removed.map((entry) => ({ path: entry.path, change: "removed" as const })),
    ...diff.files.unverified.map((entry) => ({ path: entry.path, change: "unverified" as const })),
  ];

  const graph = buildModuleGraph({
    root: scan.report.scope.root,
    files: scan.files.map((file) => ({ path: file.path, skipped: file.skipped })),
  });

  const impact = computeImpact({
    graph,
    changed,
    base: { generatedAt: input.baseSnapshot.generatedAt, root: input.baseSnapshot.root },
  });

  return { report: scan.report, headSnapshot, diff, impact };
}
