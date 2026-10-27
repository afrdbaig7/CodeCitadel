import { createHash } from "node:crypto";

import type {
  CheckStatus,
  ExecutionCounts,
  ExecutionIsolation,
  TestResult,
} from "@codecitadel/contracts";

import type { ProcessStatus } from "./process.js";

export function summarize(results: readonly TestResult[]): ExecutionCounts {
  const counts: ExecutionCounts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    errored: 0,
    cancelled: 0,
    unsupported: 0,
    total: results.length,
  };
  for (const result of results) {
    switch (result.status) {
      case "passed":
        counts.passed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
      case "timed_out":
        counts.timedOut += 1;
        break;
      case "errored":
        counts.errored += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      case "unsupported":
        counts.unsupported += 1;
        break;
    }
  }
  return counts;
}

/**
 * The run-level status is derived from what was observed, in order of how much
 * it invalidates the run: a killed process trumps a failing test, and a failing
 * test trumps a passing one.
 */
export function aggregateStatus(status: ProcessStatus, counts: ExecutionCounts): CheckStatus {
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "timed_out") {
    return "timed_out";
  }
  if (counts.failed > 0) {
    return "failed";
  }
  if (counts.errored > 0 || counts.unsupported > 0) {
    return "errored";
  }
  if (counts.passed > 0) {
    return "passed";
  }
  return "skipped";
}

const NO_SANDBOX_LIMITATION =
  "No CPU, memory, network, or filesystem sandbox is applied; this is a disposable directory, not a container.";

export function isolationFor(
  mode: "source-copy" | "none",
  root: string,
  sharedPaths: readonly string[],
): ExecutionIsolation {
  if (mode === "none") {
    return {
      mode: "none",
      root,
      sharedPaths: [],
      limitations: [
        "Checks ran directly in the checkout, so repository code can modify the working tree.",
        NO_SANDBOX_LIMITATION,
      ],
    };
  }
  return {
    // Paths in the results are relative to the analyzed root, and the copy is
    // deleted afterwards, so the record names the tree it came from.
    mode: "source-copy",
    root,
    sharedPaths: [...sharedPaths],
    limitations: [
      "Checks ran in a disposable copy of the tree; the checkout was not the working directory.",
      "The copy lived under the OS temp directory and was removed after the run, so it cannot be re-inspected.",
      "The copy links node_modules from the checkout instead of installing dependencies, so a test can still modify installed packages.",
      "Symlinked files and directories are skipped when copying, so a tree that relies on them behaves differently here.",
      NO_SANDBOX_LIMITATION,
    ],
  };
}

export function recordId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `run_${digest.slice(0, 16)}`;
}
