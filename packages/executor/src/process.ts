import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export type ProcessStatus = "exited" | "timed_out" | "cancelled";

export interface ProcessOutcome {
  exitCode: number | null;
  status: ProcessStatus;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  spawnError: Error | null;
}

/**
 * Environment handed to the runner.
 *
 * This is an allow-list, not `process.env` with a few deletions: a test run
 * should not inherit tokens, cloud credentials, or CI secrets from the shell
 * that started it. Node and the OS still need a few variables to work at all.
 */
const ENV_ALLOW_LIST = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "TZ",
];

/**
 * Most variables a caller may name for forwarding. Forwarding is a counted,
 * explicit exception to the allow-list, not a way to hand over `process.env`.
 */
export const MAX_PASSTHROUGH_ENV = 16;

/** A portable variable name. Nothing else — no `=`, no shell syntax, no spaces. */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A caller asked to forward something the executor refuses to forward. */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export interface ResolvedEnvironment {
  /** The exact environment handed to the runner. */
  env: NodeJS.ProcessEnv;
  /** Names copied from this process, in request order. Values are not recorded. */
  forwarded: string[];
  /** Names the caller asked for that this process does not have. */
  missing: string[];
}

/**
 * Builds the runner environment: the allow-list, plus the variables the caller
 * named explicitly.
 *
 * Forwarding is by **name**, copied from this process, so a value never has to
 * be written into a command line, a log, or an evidence report. That also means
 * a caller cannot inject a value it does not already hold, and an unknown name is
 * reported as missing rather than silently skipped.
 */
export function buildEnvironment(passthrough: readonly string[] = []): ResolvedEnvironment {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of ENV_ALLOW_LIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const unique = [...new Set(passthrough)];
  if (unique.length > MAX_PASSTHROUGH_ENV) {
    throw new EnvironmentError(
      `At most ${MAX_PASSTHROUGH_ENV} environment variables may be forwarded to a runner, received ${unique.length}.`,
    );
  }

  const forwarded: string[] = [];
  const missing: string[] = [];
  for (const name of unique) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new EnvironmentError(
        `${JSON.stringify(name.slice(0, 80))} is not a valid environment variable name; use letters, digits, and underscores, starting with a letter or underscore.`,
      );
    }
    if (ENV_ALLOW_LIST.includes(name)) {
      throw new EnvironmentError(
        `${name} is always forwarded to the runner, so it does not need to be named.`,
      );
    }
    const value = process.env[name];
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    env[name] = value;
    forwarded.push(name);
  }

  return { env, forwarded, missing };
}

/**
 * Runs a process without a shell, with a deadline, cancellation, and a bounded
 * output budget shared by stdout and stderr.
 *
 * A killed run reports `timed_out` or `cancelled`; it is never treated as a
 * failed test, because no test result was observed.
 */
export function runSupervised(
  argv: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal | undefined;
    /** The exact environment to use; defaults to the allow-list alone. */
    env?: NodeJS.ProcessEnv | undefined;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({
        exitCode: null,
        status: "exited",
        stdout: "",
        stderr: "",
        outputTruncated: false,
        spawnError: new Error("No command to execute."),
      });
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildEnvironment().env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let captured = 0;
    let outputTruncated = false;
    let status: ProcessStatus = "exited";
    let spawnError: Error | null = null;
    let settled = false;

    const capture = (chunk: Buffer, toStderr: boolean) => {
      if (captured >= options.maxOutputBytes) {
        outputTruncated = true;
        return;
      }
      const room = options.maxOutputBytes - captured;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      captured += slice.length;
      if (slice.length < chunk.length) {
        outputTruncated = true;
      }
      const text = slice.toString("utf8");
      if (toStderr) {
        stderr += text;
      } else {
        stdout += text;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));

    let escalation: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      // Graceful first, then forced: a runner that ignores SIGTERM must not
      // keep the CLI alive forever.
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
      escalation.unref();
    };

    const deadline = setTimeout(() => {
      status = "timed_out";
      terminate();
    }, options.timeoutMs);
    deadline.unref();

    const onAbort = () => {
      status = "cancelled";
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (escalation !== undefined) {
        clearTimeout(escalation);
      }
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, status, stdout, stderr, outputTruncated, spawnError });
    };

    child.on("error", (error) => {
      spawnError = error;
      finish(null);
    });
    // `close` fires after stdio is drained, so the captured output is complete.
    child.on("close", (code) => finish(code));
  });
}
