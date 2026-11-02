import type { MutationReport } from "@codecitadel/contracts";

export function renderMutationText(report: MutationReport, threshold?: number): string {
  const lines: string[] = [];
  const { summary, scope, mutants } = report;

  lines.push("=== CodeCitadel Mutation Testing Report ===");
  lines.push(`Root: ${scope.root}`);
  lines.push(`Files analyzed: ${scope.filesAnalyzed} · Duration: ${scope.durationMs}ms`);
  lines.push("");

  lines.push("Summary:");
  lines.push(`  Total mutants:     ${summary.total}`);
  lines.push(`  Killed (caught):   ${summary.killed}`);
  lines.push(`  Survived (gap):    ${summary.survived}`);
  lines.push(`  Timed out:         ${summary.timedOut}`);
  lines.push(`  Compile errors:    ${summary.compileError}`);
  lines.push(`  Mutation score:    ${summary.mutationScore.toFixed(1)}%`);
  lines.push("");

  if (threshold !== undefined) {
    if (summary.mutationScore >= threshold) {
      lines.push(`Policy: PASSED (score ${summary.mutationScore.toFixed(1)}% >= threshold ${threshold}%)`);
    } else {
      lines.push(`Policy: BREACHED (score ${summary.mutationScore.toFixed(1)}% < threshold ${threshold}%)`);
    }
    lines.push("");
  }

  const survivedMutants = mutants.filter((m) => m.status === "survived");
  if (survivedMutants.length > 0) {
    lines.push(`Survived Mutants (${survivedMutants.length} test gaps identified):`);
    for (const mutant of survivedMutants) {
      lines.push(`  [SURVIVED] ${mutant.id} (${mutant.mutatorName})`);
      lines.push(`  Location: ${mutant.location.path}:${mutant.location.startLine}:${mutant.location.startColumn}`);
      lines.push(`  Description: ${mutant.description}`);
      lines.push("  Diff:");
      for (const diffLine of mutant.diff.split("\n")) {
        lines.push(`    ${diffLine}`);
      }
      lines.push("  Remediation: Add an assertion in your test suite that specifically asserts the outcome of this expression.");
      lines.push("");
    }
  } else {
    lines.push("No mutants survived! All testable mutations were caught by your test suite.");
  }

  return lines.join("\n") + "\n";
}
