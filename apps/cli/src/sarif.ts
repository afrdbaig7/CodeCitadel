import { pathToFileURL } from "node:url";

import {
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  sarifLogSchema,
  type CodeCitadelReport,
  type SarifLevel,
  type Severity,
} from "@codecitadel/contracts";

/**
 * SARIF 2.1.0 renderer.
 *
 * Three things SARIF cannot express, and how they are handled instead of lost:
 *
 * - It has three levels (`error`, `warning`, `note`). This project has five
 *   severities, so `critical`/`high` map to `error` and `low`/`info` to `note`,
 *   and the original severity is kept in the result's properties.
 * - It has no notion of evidence status. `suspected`, `reproduced`, and
 *   `unable_to_verify` travel in properties so an upload cannot look stronger
 *   than the report it came from.
 * - Redacted snippets must not be presented as source. A redacted snippet is
 *   omitted entirely and flagged, rather than emitted as the literal string
 *   `[redacted]` where a reader would mistake it for the file's text.
 */

const SEVERITY_TO_LEVEL: Record<Severity, SarifLevel> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

/** SARIF wants a directory URI, which needs a trailing slash. */
function directoryUri(root: string): string {
  const url = pathToFileURL(root).href;
  return url.endsWith("/") ? url : `${url}/`;
}

function toPosix(relativePath: string): string {
  return relativePath.split("\\").join("/");
}

function helpMarkdown(explanation: string, remediation: string, references: readonly string[]): string {
  const lines = [`**Explanation.** ${explanation}`, "", `**Remediation.** ${remediation}`];
  if (references.length > 0) {
    lines.push("", "**References.**", ...references.map((reference) => `- ${reference}`));
  }
  return lines.join("\n");
}

function helpText(explanation: string, remediation: string, references: readonly string[]): string {
  const parts = [explanation, `Remediation: ${remediation}`];
  if (references.length > 0) {
    parts.push(`References: ${references.join(", ")}`);
  }
  return parts.join("\n\n");
}

export function renderSarif(report: CodeCitadelReport): string {
  const rules = report.scope.rules;
  const ruleIndexById = new Map(rules.map((rule, index) => [rule.id, index]));

  const driverRules = rules.map((rule) => {
    // A missing explanation is described as missing; inventing prose would be
    // worse than a short honest sentence.
    const explanation = rule.explanation.length > 0 ? rule.explanation : rule.title;
    const remediation =
      rule.remediation.length > 0
        ? rule.remediation
        : "No remediation guidance is published for this rule.";

    return {
      id: rule.id,
      shortDescription: { text: rule.title },
      fullDescription: { text: explanation },
      help: {
        text: helpText(explanation, remediation, rule.references),
        markdown: helpMarkdown(explanation, remediation, rule.references),
      },
      defaultConfiguration: { level: SEVERITY_TO_LEVEL[rule.severity] },
      properties: {
        category: rule.category,
        severity: rule.severity,
        executor: rule.executor,
        tags: [rule.category, rule.executor],
      },
    };
  });

  const results = report.findings.map((finding) => {
    const ruleIndex = ruleIndexById.get(finding.ruleId);
    if (ruleIndex === undefined) {
      // A result pointing at a rule that was not published would be an
      // unopenable SARIF file in most viewers, so this is a hard error.
      throw new Error(
        `Finding ${finding.id} uses rule ${finding.ruleId}, which is not in the report's rule list.`,
      );
    }

    const region: Record<string, unknown> = {
      startLine: finding.location.startLine,
      startColumn: finding.location.startColumn,
      endLine: finding.location.endLine,
      endColumn: finding.location.endColumn,
    };
    if (finding.location.snippet !== null && !finding.location.snippetRedacted) {
      region.snippet = { text: finding.location.snippet };
    }

    return {
      ruleId: finding.ruleId,
      ruleIndex,
      level: SEVERITY_TO_LEVEL[finding.severity],
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: toPosix(finding.location.path),
              uriBaseId: "SRCROOT",
            },
            region,
          },
        },
      ],
      partialFingerprints: {
        // The scanner's fingerprint is stable across unrelated line insertions,
        // which is exactly what SARIF's partial fingerprint is for.
        "codecitadelFindingFingerprint/v1": finding.id,
      },
      properties: {
        severity: finding.severity,
        confidence: finding.confidence,
        evidenceStatus: finding.evidenceStatus,
        snippetRedacted: finding.location.snippetRedacted,
      },
    };
  });

  const log = sarifLogSchema.parse({
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "codecitadel",
            version: `${report.tool.version}+scanner.${report.tool.scannerVersion}`,
            rules: driverRules,
          },
        },
        originalUriBaseIds: {
          SRCROOT: { uri: directoryUri(report.scope.root) },
        },
        results,
        properties: {
          scannerVersion: report.tool.scannerVersion,
          filesScanned: report.scope.filesScanned,
          filesSkipped: report.scope.filesSkipped,
          truncated: report.scope.truncated,
          limitations: report.scope.limitations,
        },
      },
    ],
  });

  return `${JSON.stringify(log, null, 2)}\n`;
}
