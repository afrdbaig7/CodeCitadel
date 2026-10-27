import { describe, expect, it } from "vitest";

import { ScannerProtocolError, ScannerRunError } from "../src/errors.js";
import { ScanStreamCollector, MAX_RECORD_BYTES } from "../src/stream.js";

const hello = {
  type: "hello",
  requestId: "req-1",
  scannerVersion: "0.1.0",
  protocol: { major: 1, minor: 0 },
  root: "/repo",
  options: {
    maxFiles: 10,
    maxBytesPerFile: 1024,
    maxTotalBytes: 4096,
    maxFindingsPerFile: 5,
    snippetBytes: 80,
    includeHidden: false,
    followSymlinks: false,
    exclude: [],
    rules: ["secrets/aws-access-key-id"],
  },
  capabilities: { rules: [], features: ["sha256-content-digest"] },
};

const finding = {
  id: "f_0123456789abcdef",
  ruleId: "secrets/aws-access-key-id",
  ruleVersion: "1.0.0",
  ruleTitle: "AWS access key ID in source",
  category: "secrets",
  severity: "high",
  executor: "native-text",
  confidence: "high",
  evidenceStatus: "suspected",
  message: "AWS access key ID in source",
  explanation: "A key appears in the file.",
  remediation: "Rotate it.",
  references: [],
  location: {
    path: "src/config.ts",
    startLine: 3,
    startColumn: 20,
    endLine: 3,
    endColumn: 40,
    startByte: 60,
    endByte: 80,
    snippet: "[redacted]",
    snippetRedacted: true,
    snippetTruncated: false,
  },
};

const summary = {
  filesSeen: 1,
  filesScanned: 1,
  filesSkipped: 0,
  bytesRead: 120,
  findings: 1,
  findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  truncated: false,
  limitsHit: [],
  durationMs: 4,
};

const events = [
  hello,
  { type: "file", requestId: "req-1", path: "src/config.ts", sizeBytes: 120, digest: null, skipped: null },
  { type: "finding", requestId: "req-1", finding },
  { type: "warning", requestId: "req-1", code: "non_utf8_path", message: "skipped a path" },
  { type: "summary", requestId: "req-1", summary },
  { type: "done", requestId: "req-1", ok: true, exitCode: 0 },
];

function run(lines: readonly unknown[]): ScanStreamCollector {
  const collector = new ScanStreamCollector();
  for (const line of lines) {
    collector.accept(JSON.stringify(line));
  }
  return collector;
}

describe("ScanStreamCollector", () => {
  it("collects a complete, valid scan", () => {
    const result = run(events).complete("", 0);
    expect(result.findings).toHaveLength(1);
    expect(result.files).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.summary.findings).toBe(1);
    expect(result.hello.scannerVersion).toBe("0.1.0");
  });

  it("rejects invalid JSON", () => {
    const collector = new ScanStreamCollector();
    expect(() => collector.accept("{not json")).toThrow(ScannerProtocolError);
  });

  it("rejects an unknown record type", () => {
    const collector = new ScanStreamCollector();
    expect(() => collector.accept(JSON.stringify({ type: "progress", requestId: "req-1" }))).toThrow(
      /does not match the protocol/,
    );
  });

  it("rejects a record larger than the limit", () => {
    const collector = new ScanStreamCollector();
    expect(() => collector.accept("x".repeat(MAX_RECORD_BYTES + 1))).toThrow(/exceeded/);
  });

  it("rejects a second hello record", () => {
    expect(() => run([hello, hello])).toThrow(/more than one hello/);
  });

  it("rejects a second summary record", () => {
    const eventsWithTwoSummaries = [hello, { type: "summary", requestId: "req-1", summary }, { type: "summary", requestId: "req-1", summary }];
    expect(() => run(eventsWithTwoSummaries)).toThrow(/more than one summary/);
  });

  it("refuses to complete a stream without a done record", () => {
    const collector = run([hello, { type: "summary", requestId: "req-1", summary }]);
    expect(() => collector.complete("boom", 0)).toThrow(/without a terminal done record/);
  });

  it("surfaces a fatal scanner error instead of an empty result", () => {
    const collector = run([
      hello,
      { type: "error", requestId: "req-1", code: "invalid_root", message: "missing", fatal: true },
      { type: "done", requestId: "req-1", ok: false, exitCode: 2 },
    ]);
    expect(() => collector.complete("", 2)).toThrow(ScannerRunError);
  });

  it("rejects a done record that disagrees with the process exit code", () => {
    const collector = run(events);
    expect(() => collector.complete("", 3)).toThrow(/exited 3/);
  });

  it("rejects a failed done record with no error record", () => {
    const collector = run([
      hello,
      { type: "summary", requestId: "req-1", summary },
      { type: "done", requestId: "req-1", ok: false, exitCode: 2 },
    ]);
    expect(() => collector.complete("", 2)).toThrow(/reported failure/);
  });
});
