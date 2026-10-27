import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findingSchema,
  codeCitadelReportSchema,
  scanOptionsSchema,
  scannerEventSchema,
  severitySchema,
} from "../src/index.js";

const HELLO_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/analysis/scanner-hello.ndjson", import.meta.url),
);

const validFinding = {
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
  references: ["https://example.test/reference"],
  location: {
    path: "src/tls.ts",
    startLine: 2,
    startColumn: 26,
    endLine: 2,
    endColumn: 50,
    startByte: 25,
    endByte: 49,
    snippet: "rejectUnauthorized: false",
    snippetRedacted: false,
    snippetTruncated: false,
  },
};

describe("finding contract", () => {
  it("accepts a finding produced by the scanner", () => {
    expect(findingSchema.parse(validFinding)).toMatchObject({ severity: "high" });
  });

  it("rejects an unknown severity instead of coercing it", () => {
    const result = findingSchema.safeParse({ ...validFinding, severity: "blocker" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-fingerprint id", () => {
    expect(findingSchema.safeParse({ ...validFinding, id: "line-42" }).success).toBe(false);
  });

  it("allows a null snippet for binary or redacted-out content", () => {
    const parsed = findingSchema.parse({
      ...validFinding,
      location: { ...validFinding.location, snippet: null },
    });
    expect(parsed.location.snippet).toBeNull();
  });
});

describe("scan options", () => {
  it("applies documented defaults", () => {
    const options = scanOptionsSchema.parse({});
    expect(options.maxFiles).toBe(20_000);
    expect(options.maxBytesPerFile).toBe(1_048_576);
    expect(options.includeHidden).toBe(false);
    expect(options.rules).toBeNull();
  });

  it("rejects a non-positive limit rather than disabling it", () => {
    expect(scanOptionsSchema.safeParse({ maxFiles: 0 }).success).toBe(false);
  });
});

describe("protocol fixture", () => {
  it("parses the captured scanner handshake", () => {
    const line = readFileSync(HELLO_FIXTURE, "utf8").trim();
    expect(line.length).toBeGreaterThan(0);
    const event = scannerEventSchema.parse(JSON.parse(line));
    expect(event.type).toBe("hello");
    if (event.type !== "hello") {
      throw new Error("fixture must be a hello record");
    }
    expect(event.protocol.major).toBe(1);
    expect(event.capabilities.rules.length).toBeGreaterThanOrEqual(6);
    expect(event.capabilities.features).toContain("sha256-content-digest");
  });

  it("rejects a record with an unknown type", () => {
    expect(scannerEventSchema.safeParse({ type: "progress", requestId: "r" }).success).toBe(false);
  });
});

describe("report contract", () => {
  const baseReport = {
    schemaVersion: 1,
    tool: {
      name: "codecitadel",
      version: "0.1.0",
      scannerVersion: "0.1.0",
      protocol: { major: 1, minor: 0 },
    },
    generatedAt: "2026-10-21T10:00:00.000Z",
    scope: {
      root: "fixtures/clean",
      options: scanOptionsSchema.parse({}),
      rules: [],
      filesScanned: 2,
      filesSkipped: 0,
      bytesRead: 100,
      durationMs: 3,
      truncated: false,
      limitsHit: [],
      limitations: ["Text rules cannot prove reachability."],
    },
    summary: { findings: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} },
    findings: [],
  };

  it("accepts a minimal report", () => {
    expect(codeCitadelReportSchema.parse(baseReport).scope.filesScanned).toBe(2);
  });

  it("requires at least one limitation", () => {
    const report = { ...baseReport, scope: { ...baseReport.scope, limitations: [] } };
    expect(codeCitadelReportSchema.safeParse(report).success).toBe(false);
  });

  it("rejects a report version it does not understand", () => {
    expect(codeCitadelReportSchema.safeParse({ ...baseReport, schemaVersion: 2 }).success).toBe(false);
  });
});

describe("severity ordering", () => {
  it("is explicit rather than alphabetical", () => {
    expect(severitySchema.options).toEqual(["critical", "high", "medium", "low", "info"]);
  });
});
