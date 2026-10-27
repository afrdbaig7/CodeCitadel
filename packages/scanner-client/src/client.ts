import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  capabilitiesMessageSchema,
  isCompatibleProtocol,
  scanRequestSchema,
  type CapabilitiesMessage,
  type ScanOptionsInput,
  type ScannerEvent,
} from "@codecitadel/contracts";

import {
  ScanAbortedError,
  ScannerProtocolError,
  ScannerRunError,
  ScannerTimeoutError,
} from "./errors.js";
import { resolveScannerBinary } from "./resolve-binary.js";
import { MAX_RECORD_BYTES, ScanStreamCollector, type ScanStreamResult } from "./stream.js";

/** Only this much stderr is retained for diagnostics and error messages. */
const MAX_STDERR_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 120_000;

export type { ScanStreamResult } from "./stream.js";

export interface RunScanOptions {
  root: string;
  options?: ScanOptionsInput;
  /** Explicit scanner path; otherwise resolved from the environment/workspace. */
  scannerPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: ScannerEvent) => void;
}

function preview(value: string, limit = 300): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_STDERR_BYTES ? next : next.slice(next.length - MAX_STDERR_BYTES);
}

function resolveBinaryPath(explicitPath: string | undefined): string {
  return explicitPath
    ? resolveScannerBinary({ explicitPath }).path
    : resolveScannerBinary().path;
}

/**
 * Spawns the scanner, validates every record, and resolves only after a
 * terminal `done` record.
 *
 * Failures are explicit and are never reported as "no findings": a crash, a
 * timeout, a cancelled process, or a stream that ends without `done` all
 * reject.
 */
export function runScan(run: RunScanOptions): Promise<ScanStreamResult> {
  const binaryPath = resolveBinaryPath(run.scannerPath);
  const request = scanRequestSchema.parse({
    type: "scan",
    requestId: `scan_${randomUUID()}`,
    protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    root: path.resolve(run.root),
    options: run.options ?? {},
  });

  const collector = new ScanStreamCollector();
  let stderr = "";

  return new Promise<ScanStreamResult>((resolve, reject) => {
    const child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const interface_ = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      run.signal?.removeEventListener("abort", onAbort);
      interface_.close();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!child.killed) {
        child.kill();
      }
      reject(error);
    };

    function onAbort() {
      fail(new ScanAbortedError());
    }

    child.on("error", (error) => {
      fail(
        new ScannerRunError(
          "spawn_failed",
          `Cannot start the scanner at ${binaryPath}: ${error.message}`,
          stderr,
        ),
      );
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    timeoutHandle = setTimeout(() => fail(new ScannerTimeoutError(timeoutMs)), timeoutMs);

    if (run.signal) {
      if (run.signal.aborted) {
        onAbort();
      } else {
        run.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    void (async () => {
      try {
        for await (const line of interface_) {
          if (line.length === 0) {
            continue;
          }
          const event = collector.accept(line);
          run.onEvent?.(event);
          if (event.type === "hello" && !isCompatibleProtocol(event.protocol)) {
            fail(
              new ScannerProtocolError(
                `Incompatible scanner protocol ${event.protocol.major}.${event.protocol.minor}; ` +
                  `this client reads ${PROTOCOL_MAJOR}.x.`,
              ),
            );
            return;
          }
          if (settled) {
            return;
          }
        }
      } catch (error) {
        fail(
          error instanceof ScannerProtocolError
            ? error
            : new ScannerProtocolError(`Cannot read scanner output: ${(error as Error).message}`),
        );
      }
    })();

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      try {
        const result = collector.complete(stderr, code);
        settled = true;
        cleanup();
        resolve(result);
      } catch (error) {
        fail(error as Error);
      }
    });

    child.stdin.on("error", (error) => {
      fail(new ScannerRunError("stdin_failed", `Cannot write to the scanner: ${error.message}`, stderr));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

/**
 * Reads the capability handshake. Used by `doctor` to prove the binary is the
 * expected version and to list rules without scanning anything.
 */
export function readCapabilities(
  options: { scannerPath?: string; timeoutMs?: number } = {},
): Promise<CapabilitiesMessage> {
  const binaryPath = resolveBinaryPath(options.scannerPath);
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise<CapabilitiesMessage>((resolve, reject) => {
    const child = spawn(binaryPath, ["--capabilities"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    let settled = false;

    const handle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new ScannerTimeoutError(timeoutMs));
      }
    }, timeoutMs);

    const succeed = (value: CapabilitiesMessage) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(handle);
      resolve(value);
    };

    const failWith = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(handle);
      reject(error);
    };

    child.on("error", (error) =>
      failWith(
        new ScannerRunError(
          "spawn_failed",
          `Cannot start the scanner at ${binaryPath}: ${error.message}`,
          stderr,
        ),
      ),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_RECORD_BYTES) {
        child.kill();
        failWith(new ScannerProtocolError("Capability output exceeded the record limit."));
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        failWith(
          new ScannerRunError(
            "capabilities_failed",
            `The scanner exited with code ${code}: ${preview(stderr, 400) || "(no stderr)"}`,
            stderr,
          ),
        );
        return;
      }
      const line = stdout.trim();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch {
        failWith(new ScannerProtocolError(`Capability output is not JSON: ${preview(line)}`));
        return;
      }
      const parsed = capabilitiesMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        failWith(
          new ScannerProtocolError(
            `Capability output does not match the contract: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
          ),
        );
        return;
      }
      succeed(parsed.data);
    });
  });
}
