import {
  scannerEventSchema,
  type FileEvent,
  type Finding,
  type HelloEvent,
  type ScanSummary,
  type ScannerEvent,
  type WarningEvent,
} from "@codecitadel/contracts";

import { ScannerProtocolError, ScannerRunError } from "./errors.js";

export const MAX_RECORD_BYTES = 1024 * 1024;

export interface ScanStreamResult {
  hello: HelloEvent;
  files: FileEvent[];
  findings: Finding[];
  warnings: WarningEvent[];
  summary: ScanSummary;
  stderr: string;
  exitCode: number;
}

function preview(value: string, limit = 300): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Accumulates scanner records and validates them against the contract.
 *
 * Kept separate from process handling so the trust boundary can be tested
 * without spawning anything: the scanner's stdout is untrusted input, and every
 * record is parsed and schema-checked before it influences a report.
 *
 * At most one `hello` and one `summary` are accepted. A second one is a
 * protocol violation, not an update.
 */
export class ScanStreamCollector {
  readonly files: FileEvent[] = [];
  readonly findings: Finding[] = [];
  readonly warnings: WarningEvent[] = [];
  hello: HelloEvent | undefined;
  summary: ScanSummary | undefined;
  done: { ok: boolean; exitCode: number } | undefined;
  fatal: { code: string; message: string } | undefined;
  private readonly maxRecordBytes: number;

  constructor(options: { maxRecordBytes?: number } = {}) {
    this.maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
  }

  accept(line: string): ScannerEvent {
    if (line.length > this.maxRecordBytes) {
      throw new ScannerProtocolError(`A scanner record exceeded ${this.maxRecordBytes} bytes.`);
    }

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new ScannerProtocolError(
        `The scanner emitted invalid JSON: ${preview(line)} (${(error as Error).message})`,
      );
    }

    const parsed = scannerEventSchema.safeParse(json);
    if (!parsed.success) {
      throw new ScannerProtocolError(
        `The scanner emitted a record that does not match the protocol: ` +
          `${parsed.error.issues[0]?.message ?? "unknown issue"} in ${preview(line)}`,
      );
    }

    const event = parsed.data;
    switch (event.type) {
      case "hello":
        if (this.hello) {
          throw new ScannerProtocolError("The scanner sent more than one hello record.");
        }
        this.hello = event;
        return event;
      case "file":
        this.files.push(event);
        return event;
      case "finding":
        this.findings.push(event.finding);
        return event;
      case "warning":
        this.warnings.push(event);
        return event;
      case "summary":
        if (this.summary) {
          throw new ScannerProtocolError("The scanner sent more than one summary record.");
        }
        this.summary = event.summary;
        return event;
      case "error":
        if (event.fatal) {
          this.fatal = { code: event.code, message: event.message };
        } else {
          this.warnings.push({
            type: "warning",
            requestId: event.requestId,
            code: event.code,
            message: event.message,
          });
        }
        return event;
      case "done":
        this.done = { ok: event.ok, exitCode: event.exitCode };
        return event;
    }
  }

  /**
   * Builds the result, or throws if the stream is not a complete scan.
   *
   * A missing `done`, a missing `summary`, or a fatal error record means the
   * scan did not complete. Partial output is never returned as a result.
   */
  complete(stderr: string, exitCode: number | null): ScanStreamResult {
    if (this.fatal) {
      throw new ScannerRunError(this.fatal.code, this.fatal.message, stderr);
    }
    if (!this.done) {
      throw new ScannerProtocolError(
        `The scanner exited (code ${exitCode ?? "null"}) without a terminal done record. ` +
          `Partial results are not a scan. Stderr: ${preview(stderr, 600) || "(empty)"}`,
      );
    }
    if (!this.done.ok || this.done.exitCode !== 0) {
      throw new ScannerRunError(
        "scan_failed",
        `The scanner reported failure (exit ${this.done.exitCode}). ` +
          `Stderr: ${preview(stderr, 600) || "(empty)"}`,
        stderr,
      );
    }
    if (!this.hello || !this.summary) {
      throw new ScannerProtocolError(
        `The scanner finished without a ${this.hello ? "summary" : "hello"} record.`,
      );
    }
    if (this.done.exitCode !== exitCode) {
      // The process exit code and the protocol record must agree, otherwise one
      // of them is lying about the outcome.
      throw new ScannerProtocolError(
        `The scanner's done record says exit ${this.done.exitCode} but the process exited ${exitCode ?? "null"}.`,
      );
    }
    return {
      hello: this.hello,
      files: this.files,
      findings: this.findings,
      warnings: this.warnings,
      summary: this.summary,
      stderr,
      exitCode: this.done.exitCode,
    };
  }
}
