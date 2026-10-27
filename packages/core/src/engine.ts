import path from "node:path";

import {
  PROTOCOL_MAJOR,
  scanOptionsSchema,
  type CapabilitiesMessage,
  type CodeCitadelReport,
  type FileEvent,
  type ScanOptionsInput,
  type ScannerEvent,
} from "@codecitadel/contracts";
import { readCapabilities, runScan } from "@codecitadel/scanner-client";

import { buildReport } from "./report.js";

export interface ScanRepositoryInput {
  root: string;
  options?: ScanOptionsInput;
  scannerPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable clock so report tests do not depend on wall-clock time. */
  now?: () => Date;
  onEvent?: (event: ScannerEvent) => void;
}

export interface ScanRepositoryResult {
  report: CodeCitadelReport;
  /**
   * The scanner's per-file records. The report keeps findings only, but a
   * snapshot needs the digest of every file it saw, so callers that store
   * evidence take them from here instead of re-reading the working tree.
   */
  files: FileEvent[];
}

/**
 * The engine facade for a passive scan.
 *
 * It owns exactly three things: resolve the root, call the scanner client, and
 * assemble a versioned report. Rules live in Rust; this layer must not
 * re-implement or silently "fix up" their results.
 */
export async function scanRepository(input: ScanRepositoryInput): Promise<CodeCitadelReport> {
  const result = await scanRepositoryDetailed(input);
  return result.report;
}

/** Same scan, with the per-file records kept for snapshot building. */
export async function scanRepositoryDetailed(
  input: ScanRepositoryInput,
): Promise<ScanRepositoryResult> {
  const root = path.resolve(input.root);
  const runOptions: Parameters<typeof runScan>[0] = { root };
  if (input.options !== undefined) {
    runOptions.options = input.options;
  }
  if (input.scannerPath !== undefined) {
    runOptions.scannerPath = input.scannerPath;
  }
  if (input.signal !== undefined) {
    runOptions.signal = input.signal;
  }
  if (input.timeoutMs !== undefined) {
    runOptions.timeoutMs = input.timeoutMs;
  }
  if (input.onEvent !== undefined) {
    runOptions.onEvent = input.onEvent;
  }

  const result = await runScan(runOptions);

  // The scanner counts what it emitted. A mismatch means the record stream and
  // the summary disagree, so the report would be internally inconsistent.
  if (result.summary.findings !== result.findings.length) {
    throw new Error(
      `Scanner summary reported ${result.summary.findings} findings but ${result.findings.length} were received.`,
    );
  }

  // Use the options the scanner says it enforced, not the ones we asked for.
  const effectiveOptions = scanOptionsSchema.parse(result.hello.options);
  const publishedRules = result.hello.capabilities.rules;
  const publishedIds = new Set(publishedRules.map((rule) => rule.id));

  // A rule ID the scanner does not publish would silently scan nothing and
  // produce a clean-looking report, so it is an error.
  const unknownRules = (effectiveOptions.rules ?? []).filter((id) => !publishedIds.has(id));
  if (unknownRules.length > 0) {
    throw new Error(
      `Unknown rule(s): ${unknownRules.join(", ")}. Published rules: ${[...publishedIds].join(", ")}.`,
    );
  }

  const enabledIds = new Set(
    effectiveOptions.rules ?? publishedRules.map((rule) => rule.id),
  );
  const appliedRules = publishedRules.filter((rule) => enabledIds.has(rule.id));

  const report = buildReport({
    root: result.hello.root,
    options: effectiveOptions,
    scannerVersion: result.hello.scannerVersion,
    // The client rejects an incompatible major before this point, so pinning
    // the literal here keeps the report schema honest about what it contains.
    protocol: { major: PROTOCOL_MAJOR, minor: result.hello.protocol.minor },
    rules: appliedRules,
    findings: result.findings,
    filesScanned: result.summary.filesScanned,
    filesSkipped: result.summary.filesSkipped,
    bytesRead: result.summary.bytesRead,
    durationMs: result.summary.durationMs,
    truncated: result.summary.truncated,
    limitsHit: result.summary.limitsHit,
    generatedAt: input.now ? input.now() : new Date(),
  });

  return { report, files: result.files };
}

/** Capability handshake used by `codecitadel doctor`. */
export function getScannerCapabilities(
  options: { scannerPath?: string; timeoutMs?: number } = {},
): Promise<CapabilitiesMessage> {
  return readCapabilities(options);
}
