import type {
  RequirementsEvaluation,
  RequirementsSummary,
  RequirementVerdict,
} from "@codecitadel/contracts";

const VERDICT_LABEL: Record<RequirementVerdict, string> = {
  met: "MET",
  unmet: "UNMET",
  inconclusive: "INCONCLUSIVE",
  not_accepted: "NOT ACCEPTED",
};

/**
 * The declarative view: what is written, and whether the acceptance still
 * covers it. Nothing here is an execution result.
 */
export function renderRequirementsSummaryText(summary: RequirementsSummary): string {
  const { counts } = summary;
  const lines: string[] = [];

  lines.push(
    `requirements → ${counts.total} requirement(s): ${counts.accepted} accepted, ` +
      `${counts.stale} stale, ${counts.proposed} proposed, ${counts.rejected} rejected`,
  );

  for (const requirement of summary.requirements) {
    const acceptance =
      requirement.acceptance === "current"
        ? `accepted by ${requirement.acceptedBy ?? "(unknown)"} at ${requirement.acceptedAt ?? "(unknown)"}`
        : requirement.acceptance === "stale"
          ? `acceptance STALE — accepted by ${requirement.acceptedBy ?? "(unknown)"}, text changed since`
          : `${requirement.state}, not accepted`;
    lines.push(
      "",
      `${requirement.id}  [${acceptance}]`,
      `  ${requirement.statement}`,
    );
    for (const check of requirement.checks) {
      lines.push(`  ${check.id.padEnd(28)} ${check.file} › ${check.name}  ${check.fingerprint}`);
    }
  }

  lines.push("", `_Requirements summary schema ${summary.schemaVersion}._`);
  return `${lines.join("\n")}\n`;
}

/**
 * The evidence view: every registered check against one stored run report.
 * A verdict is only ever as strong as the checks below it, so they are printed
 * even when the requirement is met.
 */
export function renderRequirementsEvaluationText(evaluation: RequirementsEvaluation): string {
  const { counts } = evaluation;
  const lines: string[] = [];

  lines.push(
    `requirements → ${counts.met} met, ${counts.unmet} unmet, ${counts.inconclusive} inconclusive, ` +
      `${counts.notAccepted} not accepted (out of ${counts.total})`,
  );
  lines.push(
    `  run ${evaluation.run.id} generated ${evaluation.run.generatedAt}, root ${evaluation.root}`,
  );

  for (const requirement of evaluation.requirements) {
    const suffix = requirement.acceptance === "missing" ? "" : `  [acceptance ${requirement.acceptance}]`;
    lines.push("", `${VERDICT_LABEL[requirement.verdict].padEnd(14)} ${requirement.id}${suffix}`);
    lines.push(`  ${requirement.statement}`);
    for (const check of requirement.checks) {
      // The outcome is the verdict; the runner's status is only extra detail
      // when it says something different (for example a skipped test rolling
      // up into `inconclusive`).
      const detail =
        check.outcome === "not_run"
          ? "  (no result)"
          : check.status !== null && check.status !== check.outcome
            ? `  (${check.status})`
            : "";
      lines.push(`  ${check.outcome.padEnd(13)} ${check.file} › ${check.name}${detail}`);
      if (check.message !== null && check.outcome !== "passed") {
        lines.push(`    ${check.message}`);
      }
    }
  }

  if (counts.notAccepted > 0) {
    lines.push(
      "",
      "not accepted requirements are listed but never satisfied by a result; they need an explicit",
      "`codecitadel requirements accept <id> --by <name>`.",
    );
  }

  lines.push("", "limitations");
  for (const limitation of evaluation.limitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push("");
  lines.push(
    `_Requirements evaluation schema ${evaluation.schemaVersion}. Generated ${evaluation.generatedAt}._`,
  );
  return `${lines.join("\n")}\n`;
}
