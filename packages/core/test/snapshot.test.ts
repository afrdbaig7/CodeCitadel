import {
  codeCitadelReportSchema,
  type CodeCitadelReport,
  type FileEvent,
  type Finding,
} from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

import { buildReport } from "../src/report.js";
import { buildSnapshot, diffSnapshots, introducedAtOrAbove } from "../src/snapshot.js";

function digest(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

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
    message: "TLS verification disabled",
    explanation: "Verification is turned off.",
    remediation: "Remove the override.",
    references: [],
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

function report(
  overrides: {
    findings?: Finding[];
    rules?: Array<{ id: string; version: string }>;
    generatedAt?: string;
    root?: string;
    truncated?: boolean;
    exclude?: string[];
  } = {},
): CodeCitadelReport {
  const findings = overrides.findings ?? [];
  const rules = overrides.rules ?? [{ id: "security/tls-verification-disabled", version: "1.0.0" }];
  return codeCitadelReportSchema.parse(
    buildReport({
      root: overrides.root ?? "/repo",
      options: {
        maxFiles: 20_000,
        maxBytesPerFile: 1_048_576,
        maxTotalBytes: 134_217_728,
        maxFindingsPerFile: 50,
        snippetBytes: 160,
        includeHidden: false,
        followSymlinks: false,
        exclude: overrides.exclude ?? [],
        rules: null,
      },
      scannerVersion: "0.1.0",
      protocol: { major: 1, minor: 0 },
      rules: rules.map((rule) => ({
        id: rule.id,
        version: rule.version,
        title: "TLS certificate verification disabled",
        category: "security" as const,
        severity: "high" as const,
        executor: "native-text" as const,
        languages: ["javascript"],
        explanation: "Explanation.",
        remediation: "Remediation.",
        references: [],
      })),
      findings,
      filesScanned: 1,
      filesSkipped: 0,
      bytesRead: 10,
      durationMs: 1,
      truncated: overrides.truncated ?? false,
      limitsHit: [],
      generatedAt: new Date(overrides.generatedAt ?? "2026-01-01T00:00:00.000Z"),
    }),
  );
}

function file(
  path: string,
  contentDigest: string | null,
  skipped: FileEvent["skipped"] = null,
): FileEvent {
  return {
    type: "file",
    requestId: "scan_test",
    path,
    sizeBytes: 10,
    digest: contentDigest,
    skipped,
  };
}

describe("buildSnapshot", () => {
  it("records every discovered file in path order, including skipped ones", () => {
    const snapshot = buildSnapshot({
      report: report(),
      files: [
        file("src/b.ts", digest("b")),
        file("assets/data.bin", digest("a"), "binary"),
        file("huge.log", null, "too_large"),
        file("src/a.ts", digest("c")),
      ],
    });

    expect(snapshot.files.map((entry) => entry.path)).toEqual([
      "assets/data.bin",
      "huge.log",
      "src/a.ts",
      "src/b.ts",
    ]);
    // A binary file has a digest but no analysis; an oversized one has neither.
    expect(snapshot.files.find((entry) => entry.path === "assets/data.bin")).toMatchObject({
      digest: digest("a"),
      skipped: "binary",
    });
    expect(snapshot.files.find((entry) => entry.path === "huge.log")).toMatchObject({
      digest: null,
      skipped: "too_large",
    });
  });

  it("is deterministic for the same scan", () => {
    const reportValue = report({ findings: [finding()] });
    const files = [file("src/tls.ts", digest("a")), file("src/other.ts", digest("b"))];

    expect(buildSnapshot({ report: reportValue, files })).toEqual(
      buildSnapshot({ report: reportValue, files }),
    );
  });

  it("stores the coverage options and enabled rules the scan actually used", () => {
    const snapshot = buildSnapshot({
      report: report({ exclude: ["**/dist/**"], rules: [{ id: "quality/todo", version: "1.0.0" }] }),
      files: [],
    });

    expect(snapshot.options.exclude).toEqual(["**/dist/**"]);
    expect(snapshot.rules).toEqual([{ id: "quality/todo", version: "1.0.0" }]);
    expect(snapshot.truncated).toBe(false);
  });
});

describe("diffSnapshots", () => {
  it("classifies unchanged, added, modified, and removed files", () => {
    const base = buildSnapshot({
      report: report({ generatedAt: "2026-01-01T00:00:00.000Z" }),
      files: [
        file("same.ts", digest("a")),
        file("changed.ts", digest("b")),
        file("deleted.ts", digest("c")),
      ],
    });
    const head = buildSnapshot({
      report: report({ generatedAt: "2026-01-02T00:00:00.000Z" }),
      files: [file("same.ts", digest("a")), file("changed.ts", digest("d")), file("new.ts", digest("e"))],
    });

    const diff = diffSnapshots(base, head);

    expect(diff.files.unchanged).toBe(1);
    expect(diff.files.modified.map((entry) => entry.path)).toEqual(["changed.ts"]);
    expect(diff.files.removed.map((entry) => entry.path)).toEqual(["deleted.ts"]);
    expect(diff.files.added.map((entry) => entry.path)).toEqual(["new.ts"]);
    expect(diff.files.added[0]?.baseDigest).toBeNull();
    expect(diff.limitations.length).toBeGreaterThan(0);
  });

  it("reports a file that became unreadable as unverified, not removed", () => {
    const base = buildSnapshot({
      report: report(),
      files: [file("src/tls.ts", digest("a"))],
    });
    const head = buildSnapshot({
      report: report(),
      files: [file("src/tls.ts", null, "too_large")],
    });

    const diff = diffSnapshots(base, head);

    expect(diff.files.removed).toHaveLength(0);
    expect(diff.files.unverified.map((entry) => entry.path)).toEqual(["src/tls.ts"]);
    expect(diff.limitations.join(" ")).toContain("could not be read or analyzed");
  });

  it("does not call a finding resolved when its file was skipped in the head scan", () => {
    const base = buildSnapshot({
      report: report({ findings: [finding()] }),
      files: [file("src/tls.ts", digest("a"))],
    });
    const head = buildSnapshot({
      report: report({ findings: [] }),
      files: [file("src/tls.ts", digest("b"), "binary")],
    });

    const diff = diffSnapshots(base, head);

    expect(diff.findings.resolved).toHaveLength(0);
    expect(diff.findings.unverified.map((entry) => entry.id)).toEqual(["f_0123456789abcdef"]);
    expect(diff.limitations.join(" ")).toContain("unverified, not resolved");
  });

  it("calls a finding resolved when its file was analyzed and no longer matches", () => {
    const base = buildSnapshot({
      report: report({ findings: [finding()] }),
      files: [file("src/tls.ts", digest("a"))],
    });
    const head = buildSnapshot({
      report: report({ findings: [] }),
      files: [file("src/tls.ts", digest("b"))],
    });

    const diff = diffSnapshots(base, head);

    expect(diff.findings.resolved.map((entry) => entry.id)).toEqual(["f_0123456789abcdef"]);
    expect(diff.findings.unverified).toHaveLength(0);
    expect(diff.files.modified.map((entry) => entry.path)).toEqual(["src/tls.ts"]);
  });

  it("calls a finding resolved when the file is gone", () => {
    const base = buildSnapshot({
      report: report({ findings: [finding()] }),
      files: [file("src/tls.ts", digest("a"))],
    });
    const head = buildSnapshot({ report: report({ findings: [] }), files: [] });

    const diff = diffSnapshots(base, head);

    expect(diff.findings.resolved.map((entry) => entry.id)).toEqual(["f_0123456789abcdef"]);
    expect(diff.files.removed.map((entry) => entry.path)).toEqual(["src/tls.ts"]);
  });

  it("treats absence from a truncated head scan as unknown", () => {
    const base = buildSnapshot({
      report: report({ findings: [finding()] }),
      files: [file("src/tls.ts", digest("a"))],
    });
    const head = buildSnapshot({ report: report({ truncated: true }), files: [] });

    const diff = diffSnapshots(base, head);

    expect(diff.files.removed).toHaveLength(0);
    expect(diff.files.unverified.map((entry) => entry.path)).toEqual(["src/tls.ts"]);
    expect(diff.findings.resolved).toHaveLength(0);
    expect(diff.findings.unverified).toHaveLength(1);
    expect(diff.limitations.join(" ")).toContain("truncated by a resource limit");
  });

  it("flags differing rules and coverage options instead of implying a code change", () => {
    const base = buildSnapshot({ report: report(), files: [file("a.ts", digest("a"))] });
    const head = buildSnapshot({
      report: report({
        rules: [{ id: "quality/committed-todo-marker", version: "2.0.0" }],
        exclude: ["**/vendor/**"],
      }),
      files: [file("a.ts", digest("a"))],
    });

    const diff = diffSnapshots(base, head);

    expect(diff.rules.changed).toBe(true);
    expect(diff.rules.added).toEqual(["quality/committed-todo-marker"]);
    expect(diff.rules.removed).toEqual(["security/tls-verification-disabled"]);
    expect(diff.options.changed).toBe(true);
    expect(diff.options.differences.join(" ")).toContain("exclude");
    const limitations = diff.limitations.join(" ");
    expect(limitations).toContain("enabled rules differ");
    expect(limitations).toContain("coverage options differ");
  });

  it("counts files unreadable in both snapshots without inventing a change", () => {
    const base = buildSnapshot({ report: report(), files: [file("big.bin", null, "too_large")] });
    const head = buildSnapshot({ report: report(), files: [file("big.bin", null, "too_large")] });

    const diff = diffSnapshots(base, head);

    expect(diff.files.stillUnverified).toBe(1);
    expect(diff.files.added).toHaveLength(0);
    expect(diff.files.removed).toHaveLength(0);
    expect(diff.files.unverified).toHaveLength(0);
  });
});

describe("introducedAtOrAbove", () => {
  it("selects only introduced findings at or above the threshold", () => {
    const base = buildSnapshot({ report: report({ findings: [] }), files: [] });
    const head = buildSnapshot({
      report: report({
        findings: [
          finding({ id: "f_0000000000000001", severity: "critical" }),
          finding({ id: "f_0000000000000002", severity: "low" }),
        ],
      }),
      files: [],
    });

    const diff = diffSnapshots(base, head);

    expect(diff.findings.introduced).toHaveLength(2);
    expect(introducedAtOrAbove(diff, "high").map((entry) => entry.id)).toEqual([
      "f_0000000000000001",
    ]);
    expect(introducedAtOrAbove(diff, "critical")).toHaveLength(1);
    expect(introducedAtOrAbove(diff, "info")).toHaveLength(2);
  });
});
