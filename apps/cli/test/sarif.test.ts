import { sarifLogSchema, type Finding, type RuleSummary, type Severity } from "@codecitadel/contracts";
import { buildReport } from "@codecitadel/core";
import { describe, expect, it } from "vitest";

import { renderSarif } from "../src/sarif.js";

const RULES: RuleSummary[] = [
  {
    id: "security/tls-verification-disabled",
    version: "1.0.0",
    title: "TLS certificate verification disabled",
    category: "security",
    severity: "high",
    executor: "native-text",
    languages: ["javascript"],
    explanation: "Verification is turned off.",
    remediation: "Remove the override.",
    references: ["https://example.test/tls"],
  },
  {
    id: "secrets/aws-access-key-id",
    version: "1.0.0",
    title: "AWS access key ID",
    category: "secrets",
    severity: "critical",
    executor: "native-text",
    languages: ["*"],
    explanation: "A key identifier is committed.",
    remediation: "Rotate the key and load it from the environment.",
    references: [],
  },
  {
    id: "quality/committed-todo-marker",
    version: "1.0.0",
    title: "Committed TODO marker",
    category: "quality",
    severity: "info",
    executor: "native-text",
    languages: ["*"],
    explanation: "",
    remediation: "",
    references: [],
  },
];

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f_0123456789abcdef",
    ruleId: "security/tls-verification-disabled",
    ruleVersion: "1.0.0",
    ruleTitle: "TLS certificate verification disabled",
    category: "security",
    severity: "high",
    executor: "native-text",
    confidence: "medium",
    evidenceStatus: "suspected",
    message: "TLS certificate verification disabled",
    explanation: "Verification is turned off.",
    remediation: "Remove the override.",
    references: ["https://example.test/tls"],
    location: {
      path: "src/tls.ts",
      startLine: 4,
      startColumn: 26,
      endLine: 4,
      endColumn: 50,
      startByte: 60,
      endByte: 84,
      snippet: "rejectUnauthorized: false",
      snippetRedacted: false,
      snippetTruncated: false,
    },
    ...overrides,
  };
}

function report(findings: Finding[]) {
  return buildReport({
    root: "D:\\repo",
    options: {
      maxFiles: 20_000,
      maxBytesPerFile: 1_048_576,
      maxTotalBytes: 134_217_728,
      maxFindingsPerFile: 50,
      snippetBytes: 160,
      includeHidden: false,
      followSymlinks: false,
      exclude: [],
      rules: null,
    },
    scannerVersion: "0.1.0",
    protocol: { major: 1, minor: 0 },
    rules: RULES,
    findings,
    filesScanned: 3,
    filesSkipped: 1,
    bytesRead: 100,
    durationMs: 5,
    truncated: false,
    limitsHit: [],
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function parse(log: string) {
  return sarifLogSchema.parse(JSON.parse(log));
}

describe("renderSarif", () => {
  it("emits a schema-valid SARIF 2.1.0 log with rule indices that match results", () => {
    const log = parse(renderSarif(report([finding()])));

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-2.1.0");
    const run = log.runs[0];
    expect(run?.tool.driver.name).toBe("codecitadel");
    expect(run?.tool.driver.rules).toHaveLength(RULES.length);

    const result = run?.results[0];
    const rule = run?.tool.driver.rules[result?.ruleIndex ?? -1];
    expect(result?.ruleId).toBe(rule?.id);
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("src/tls.ts");
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uriBaseId).toBe("SRCROOT");
    expect(run?.originalUriBaseIds.SRCROOT?.uri).toMatch(/^file:\/\/\/.*\/$/);
  });

  it("maps all five severities onto the three SARIF levels without losing them", () => {
    const severities: Severity[] = ["critical", "high", "medium", "low", "info"];
    const findings = severities.map((severity, index) =>
      finding({
        id: `f_000000000000000${index}`,
        severity,
        ruleId: severity === "critical" ? "secrets/aws-access-key-id" : "security/tls-verification-disabled",
      }),
    );
    const run = parse(renderSarif(report(findings))).runs[0];

    const mapped = run?.results.map((result) => [result.properties.severity, result.level]);
    expect(mapped).toEqual([
      ["critical", "error"],
      ["high", "error"],
      ["medium", "warning"],
      ["low", "note"],
      ["info", "note"],
    ]);
  });

  it("omits a redacted snippet instead of pretending it is source", () => {
    const log = parse(
      renderSarif(
        report([
          finding({
            location: {
              ...finding().location,
              snippet: "[redacted]",
              snippetRedacted: true,
            },
          }),
        ]),
      ),
    );
    const result = log.runs[0]?.results[0];

    expect(result?.locations[0]?.physicalLocation.region.snippet).toBeUndefined();
    expect(result?.properties.snippetRedacted).toBe(true);
    expect(JSON.stringify(log)).not.toContain("[redacted]");
  });

  it("keeps the scanner fingerprint as a partial fingerprint", () => {
    const result = parse(renderSarif(report([finding()]))).runs[0]?.results[0];
    expect(result?.partialFingerprints).toEqual({
      "codecitadelFindingFingerprint/v1": "f_0123456789abcdef",
    });
  });

  it("carries evidence status and limitations so an upload cannot look stronger than the report", () => {
    const run = parse(renderSarif(report([finding()]))).runs[0];

    expect(run?.results[0]?.properties.evidenceStatus).toBe("suspected");
    expect(run?.properties.truncated).toBe(false);
    expect(run?.properties.limitations.length).toBeGreaterThan(0);
    expect(run?.properties.filesSkipped).toBe(1);
  });

  it("describes a rule with no guidance instead of inventing prose", () => {
    const rules = parse(renderSarif(report([]))).runs[0]?.tool.driver.rules ?? [];
    const todo = rules.find((rule) => rule.id === "quality/committed-todo-marker");

    expect(todo?.fullDescription.text).toBe("Committed TODO marker");
    expect(todo?.help.text).toContain("No remediation guidance is published");
  });

  it("escapes Windows paths into forward-slash URIs", () => {
    const log = parse(
      renderSarif(
        report([
          finding({
            location: { ...finding().location, path: "src\\nested\\tls.ts" },
          }),
        ]),
      ),
    );
    expect(log.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      "src/nested/tls.ts",
    );
  });
});
