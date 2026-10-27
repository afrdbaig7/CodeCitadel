import {
  REPORT_SCHEMA_VERSION,
  SEVERITY_ORDER,
  type Finding,
  type CodeCitadelReport,
  type RuleSummary,
  type ScanOptions,
  type Severity,
} from "@codecitadel/contracts";

import { CODECITADEL_VERSION } from "./version.js";

export interface ReportInput {
  root: string;
  options: ScanOptions;
  scannerVersion: string;
  /** Must match the literal protocol major the report schema pins. */
  protocol: CodeCitadelReport["tool"]["protocol"];
  rules: RuleSummary[];
  findings: Finding[];
  filesScanned: number;
  filesSkipped: number;
  bytesRead: number;
  durationMs: number;
  truncated: boolean;
  limitsHit: string[];
  generatedAt: Date;
}

/** Findings are ordered by file, then position, then rule: stable across runs. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    if (left.location.path !== right.location.path) {
      return left.location.path < right.location.path ? -1 : 1;
    }
    if (left.location.startLine !== right.location.startLine) {
      return left.location.startLine - right.location.startLine;
    }
    if (left.location.startColumn !== right.location.startColumn) {
      return left.location.startColumn - right.location.startColumn;
    }
    if (left.ruleId !== right.ruleId) {
      return left.ruleId < right.ruleId ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

export function countByCategory(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Statements about what the report does not establish.
 *
 * Every report carries limitations, including a fully successful one. A report
 * that claims completeness without evidence of completeness is the failure mode
 * this list exists to prevent.
 */
export function describeLimitations(input: {
  filesSkipped: number;
  truncated: boolean;
  limitsHit: string[];
}): string[] {
  const limitations = [
    "Rules are bounded text patterns: they cannot prove reachability, data flow, or that a match is a defect. Every finding is `suspected` evidence.",
    "Nothing in the scanned repository was executed: no project configuration was loaded, no dependency was installed, and no test was run.",
    "Dependency, supply-chain, and vulnerability intelligence is not implemented in this release.",
  ];

  if (input.filesSkipped > 0) {
    limitations.push(
      `${input.filesSkipped} discovered file(s) were skipped (binary, too large, unreadable, or not valid UTF-8) and were not analyzed.`,
    );
  }
  if (input.truncated) {
    limitations.push(
      `The scan stopped before covering the whole tree because a resource limit was reached (${input.limitsHit.join(", ")}). Files outside that scope are unknown, not clean.`,
    );
  }
  return limitations;
}

export function buildReport(input: ReportInput): CodeCitadelReport {
  const findings = sortFindings(input.findings);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: {
      name: "codecitadel",
      version: CODECITADEL_VERSION,
      scannerVersion: input.scannerVersion,
      protocol: input.protocol,
    },
    generatedAt: input.generatedAt.toISOString(),
    scope: {
      root: input.root,
      options: input.options,
      rules: input.rules,
      filesScanned: input.filesScanned,
      filesSkipped: input.filesSkipped,
      bytesRead: input.bytesRead,
      durationMs: input.durationMs,
      truncated: input.truncated,
      limitsHit: input.limitsHit,
      limitations: describeLimitations({
        filesSkipped: input.filesSkipped,
        truncated: input.truncated,
        limitsHit: input.limitsHit,
      }),
    },
    summary: {
      findings: findings.length,
      bySeverity: countBySeverity(findings),
      byCategory: countByCategory(findings),
    },
    findings,
  };
}

/** Severity at or above `threshold`, using the documented ordering. */
export function findingsAtOrAbove(
  findings: readonly Finding[],
  threshold: Severity,
): Finding[] {
  const limit = SEVERITY_ORDER.indexOf(threshold);
  if (limit < 0) {
    return [];
  }
  return findings.filter((finding) => SEVERITY_ORDER.indexOf(finding.severity) <= limit);
}
