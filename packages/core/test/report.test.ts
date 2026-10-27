import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { codeCitadelReportSchema, type Finding } from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import { buildReport, describeLimitations, findingsAtOrAbove, sortFindings } from "../src/report.js";
import { CODECITADEL_VERSION } from "../src/version.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f_0123456789abcdef",
    ruleId: "security/dangerous-html-sink",
    ruleVersion: "1.0.0",
    ruleTitle: "Unescaped HTML injection sink",
    category: "security",
    severity: "medium",
    executor: "native-text",
    confidence: "low",
    evidenceStatus: "suspected",
    message: "Unescaped HTML injection sink",
    explanation: "Raw HTML reaches the DOM.",
    remediation: "Sanitize at the boundary.",
    references: [],
    location: {
      path: "src/b.tsx",
      startLine: 3,
      startColumn: 12,
      endLine: 3,
      endColumn: 35,
      startByte: 40,
      endByte: 63,
      snippet: "dangerouslySetInnerHTML",
      snippetRedacted: false,
      snippetTruncated: false,
    },
    ...overrides,
  };
}

describe("sortFindings", () => {
  it("orders by path, position, rule, then fingerprint", () => {
    const later = finding({
      id: "f_bbbbbbbbbbbbbbbb",
      location: { ...finding().location, path: "src/z.tsx" },
    });
    const earlier = finding({ id: "f_aaaaaaaaaaaaaaaa" });
    const sameLineOtherRule = finding({
      id: "f_cccccccccccccccc",
      ruleId: "quality/committed-todo-marker",
    });
    // Same position: the rule ID breaks the tie before the fingerprint does.
    expect(sortFindings([later, sameLineOtherRule, earlier]).map((item) => item.id)).toEqual([
      "f_cccccccccccccccc",
      "f_aaaaaaaaaaaaaaaa",
      "f_bbbbbbbbbbbbbbbb",
    ]);
  });

  it("breaks a full tie with the fingerprint", () => {
    const first = finding({ id: "f_1111111111111111" });
    const second = finding({ id: "f_2222222222222222" });
    expect(sortFindings([second, first]).map((item) => item.id)).toEqual([
      "f_1111111111111111",
      "f_2222222222222222",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [finding({ id: "f_bbbbbbbbbbbbbbbb" }), finding({ id: "f_aaaaaaaaaaaaaaaa" })];
    const before = input.map((item) => item.id);
    sortFindings(input);
    expect(input.map((item) => item.id)).toEqual(before);
  });
});

describe("limitations", () => {
  it("never returns an empty list", () => {
    expect(describeLimitations({ filesSkipped: 0, truncated: false, limitsHit: [] }).length).toBeGreaterThan(0);
  });

  it("names skipped files and the limits that cut the scan short", () => {
    const limitations = describeLimitations({
      filesSkipped: 3,
      truncated: true,
      limitsHit: ["maxFiles"],
    });
    expect(limitations.join("\n")).toContain("3 discovered file(s) were skipped");
    expect(limitations.join("\n")).toContain("maxFiles");
    expect(limitations.join("\n")).toContain("unknown, not clean");
  });
});

describe("findingsAtOrAbove", () => {
  it("includes the threshold and more severe findings only", () => {
    const findings = [
      finding({ id: "f_1111111111111111", severity: "critical" }),
      finding({ id: "f_2222222222222222", severity: "high" }),
      finding({ id: "f_3333333333333333", severity: "medium" }),
      finding({ id: "f_4444444444444444", severity: "info" }),
    ];
    expect(findingsAtOrAbove(findings, "high").map((item) => item.severity)).toEqual([
      "critical",
      "high",
    ]);
  });
});

describe("buildReport", () => {
  it("produces a report that satisfies the published schema", () => {
    const report = buildReport({
      root: "fixtures/security",
      options: {
        maxFiles: 10,
        maxBytesPerFile: 1024,
        maxTotalBytes: 4096,
        maxFindingsPerFile: 5,
        snippetBytes: 80,
        includeHidden: false,
        followSymlinks: false,
        exclude: [],
        rules: null,
      },
      scannerVersion: "0.1.0",
      protocol: { major: 1, minor: 0 },
      rules: [],
      findings: [finding()],
      filesScanned: 4,
      filesSkipped: 1,
      bytesRead: 512,
      durationMs: 7,
      truncated: false,
      limitsHit: [],
      generatedAt: new Date("2026-10-21T10:00:00.000Z"),
    });

    expect(() => codeCitadelReportSchema.parse(report)).not.toThrow();
    expect(report.summary.findings).toBe(1);
    expect(report.summary.bySeverity.medium).toBe(1);
    expect(report.summary.byCategory.security).toBe(1);
    expect(report.generatedAt).toBe("2026-10-21T10:00:00.000Z");
    expect(report.scope.limitations.length).toBeGreaterThan(0);
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    expect(CODECITADEL_VERSION).toBe(pkg.version);
  });
});
