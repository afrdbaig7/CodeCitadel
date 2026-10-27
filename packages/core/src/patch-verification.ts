import {
  patchInspectionSchema,
  type CheckStatus,
  type ExecutionComparison,
  type PatchFileKind,
  type PatchFileReport,
  type PatchFileStatus,
  type PatchInspection,
  type PatchSignal,
  type PatchSignalKind,
  type PatchVerificationVerdict,
} from "@codecitadel/contracts";

/**
 * What a patch contains, and whether it can be trusted as evidence.
 *
 * Both functions are pure: they read a parsed patch and two stored results and
 * return a versioned record. Nothing here executes, writes, or fetches.
 */

export interface InspectablePatchLine {
  text: string;
  /** Line in the patched file, or null when the line was removed. */
  line: number | null;
}

export interface InspectablePatchFile {
  path: string;
  status: PatchFileStatus;
  added: readonly InspectablePatchLine[];
  removed: readonly InspectablePatchLine[];
}

const REQUIREMENT_DOCUMENT = "codecitadel.requirements.json";

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "go.sum",
]);

const IGNORE_FILES = new Set([
  ".gitignore",
  ".npmignore",
  ".eslintignore",
  ".prettierignore",
  ".dockerignore",
]);

function baseName(file: string): string {
  const segments = file.split("/");
  return segments[segments.length - 1] ?? file;
}

/**
 * Classifies a path by what it is, not by whether touching it is acceptable.
 * The classification drives which signals are raised; the severity decides
 * whether those signals block a `verified` verdict.
 */
export function classifyPatchPath(file: string): PatchFileKind {
  const name = baseName(file);
  if (name === REQUIREMENT_DOCUMENT) {
    return "requirement-document";
  }
  if (IGNORE_FILES.has(name.toLowerCase())) {
    return "ignore-rules";
  }
  if (LOCKFILES.has(name.toLowerCase())) {
    return "dependency-lock";
  }
  if (
    name === "package.json" ||
    /^(vitest|jest|stryker|playwright|karma|mocha)\.config\.[cm]?[jt]s$/.test(name) ||
    /^tsconfig(\..+)?\.json$/.test(name) ||
    name === ".mocharc.json"
  ) {
    return "runner-config";
  }
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(file)
  ) {
    return "test";
  }
  return "source";
}

interface SignalPattern {
  kind: PatchSignalKind;
  pattern: RegExp;
  detail: (count: number) => string;
}

const ADDED_LINE_SIGNALS: readonly SignalPattern[] = [
  {
    kind: "added-skip",
    pattern: /\b(?:it|test|describe|suite|context)\.(?:skip|todo)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(/,
    detail: (count) =>
      count === 1
        ? "adds a skipped or todo test, which reports no result while the file still exits successfully."
        : `adds ${count} skipped or todo tests, which report no result while the file still exits successfully.`,
  },
  {
    kind: "added-only",
    pattern: /\b(?:it|test|describe|suite|context)\.only\s*\(/,
    detail: (count) =>
      count === 1
        ? "adds a focused (.only) test, which silently prevents the other tests in that file from running."
        : `adds ${count} focused (.only) tests, which silently prevent the other tests in that file from running.`,
  },
  {
    kind: "suppressed-diagnostics",
    pattern: /@ts-(?:ignore|expect-error|nocheck)\b|eslint-disable(?:-next-line|-line)?\b|prettier-ignore\b/,
    detail: (count) =>
      count === 1
        ? "adds a diagnostic suppression, which hides a compiler or lint error instead of resolving it."
        : `adds ${count} diagnostic suppressions, which hide compiler or lint errors instead of resolving them.`,
  },
];

const ASSERTION = /\bexpect\s*\(/g;

function countMatches(lines: readonly InspectablePatchLine[], pattern: RegExp): number {
  let total = 0;
  for (const line of lines) {
    const matches = line.text.match(pattern);
    total += matches === null ? 0 : matches.length;
  }
  return total;
}

function scanAddedLines(file: InspectablePatchFile): PatchSignal[] {
  const signals: PatchSignal[] = [];
  for (const candidate of ADDED_LINE_SIGNALS) {
    const matching = file.added.filter((line) => candidate.pattern.test(line.text));
    if (matching.length === 0) {
      continue;
    }
    signals.push({
      kind: candidate.kind,
      file: file.path,
      line: matching[0]?.line ?? null,
      severity: "weakening",
      detail: candidate.detail(matching.length),
    });
  }
  return signals;
}

/**
 * Reads one parsed patch and reports what a reviewer must see: which files were
 * touched, and which edits remove or hide the evidence that would otherwise
 * verify the patch.
 *
 * The rules are intentionally blunt. Touching a test file is a warning, because
 * adding a regression test is the expected repair. Editing the requirement
 * document, changing runner or type configuration, changing ignore rules,
 * deleting a test file, skipping a test, focusing a test, suppressing a
 * diagnostic, or removing assertions is `weakening`: each one can make a failing
 * suite look green without changing the behaviour under test.
 */
export function inspectPatch(files: readonly InspectablePatchFile[]): PatchInspection {
  if (files.length === 0) {
    throw new Error("inspectPatch needs at least one file change.");
  }

  const reports: PatchFileReport[] = [];
  const signals: PatchSignal[] = [];

  for (const file of files) {
    const kind = classifyPatchPath(file.path);
    reports.push({
      path: file.path,
      status: file.status,
      kind,
      addedLines: file.added.length,
      removedLines: file.removed.length,
    });

    if (kind === "test") {
      signals.push(
        file.status === "deleted"
          ? {
              kind: "removed-test-file",
              file: file.path,
              line: null,
              severity: "weakening",
              detail: "deletes a test file, so its checks report no result after the patch.",
            }
          : {
              kind: "edited-test",
              file: file.path,
              line: null,
              severity: "warning",
              detail:
                "edits a test file. This is expected when the patch adds a regression test, and is listed so the edit is reviewed.",
            },
      );
    }
    if (kind === "requirement-document") {
      signals.push({
        kind: "edited-requirement",
        file: file.path,
        line: null,
        severity: "weakening",
        detail:
          "edits the requirement document. Acceptance and check mappings are the contract under verification; a patch cannot amend it.",
      });
    }
    if (kind === "runner-config") {
      signals.push({
        kind: "changed-runner-config",
        file: file.path,
        line: null,
        severity: "weakening",
        detail:
          "changes runner or compiler configuration, which can change what runs and what counts as an error.",
      });
    }
    if (kind === "ignore-rules") {
      signals.push({
        kind: "changed-ignore-rules",
        file: file.path,
        line: null,
        severity: "weakening",
        detail: "changes ignore rules, which can remove files from analysis and execution.",
      });
    }
    if (kind === "dependency-lock") {
      signals.push({
        kind: "changed-lockfile",
        file: file.path,
        line: null,
        severity: "warning",
        detail:
          "changes a dependency lockfile. The verified run links node_modules from the checkout, so these dependencies were not installed.",
      });
    }

    signals.push(...scanAddedLines(file));

    const removedAssertions = countMatches(file.removed, ASSERTION);
    const addedAssertions = countMatches(file.added, ASSERTION);
    if (removedAssertions > addedAssertions) {
      signals.push({
        kind: "removed-assertion",
        file: file.path,
        line: null,
        severity: "weakening",
        detail: `removes ${removedAssertions} assertion call(s) and adds ${addedAssertions}. Fewer assertions can pass the same test without checking the behaviour.`,
      });
    }
  }

  signals.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.kind.localeCompare(right.kind),
  );

  return patchInspectionSchema.parse({
    files: reports,
    signals,
    weakening: signals.filter((signal) => signal.severity === "weakening").length,
  });
}

export interface PatchVerdictInput {
  /** Whether the patch applied to the disposable copy. */
  applied: boolean;
  /** Why it did not apply, when it did not. */
  applyError: string | null;
  /** Status of the post-patch run, or null when nothing ran. */
  afterStatus: CheckStatus | null;
  comparison: ExecutionComparison | null;
  /** Requirements that were met before the patch and are not met after it. */
  requirementRegressions: readonly string[];
  inspection: PatchInspection;
}

export interface PatchVerdict {
  verdict: PatchVerificationVerdict;
  reason: string;
}

const INCONCLUSIVE_STATUSES: ReadonlySet<CheckStatus> = new Set<CheckStatus>([
  "timed_out",
  "errored",
  "cancelled",
  "unsupported",
  "skipped",
]);

/**
 * Turns the observed facts into one verdict. The order matters: a patch that
 * weakens its own evidence never earns a pass, even if the resulting suite is
 * green, and a green suite never compensates for a requirement that regressed.
 */
export function decidePatchVerdict(input: PatchVerdictInput): PatchVerdict {
  if (!input.applied) {
    return {
      verdict: "not_applied",
      reason: `The patch did not apply: ${input.applyError ?? "unknown reason"}`,
    };
  }

  const weakening = input.inspection.signals.filter((signal) => signal.severity === "weakening");
  if (weakening.length > 0) {
    const kinds = [...new Set(weakening.map((signal) => signal.kind))].sort();
    return {
      verdict: "not_verified",
      reason:
        `The patch carries ${weakening.length} weakening signal(s) (${kinds.join(", ")}); ` +
        "a patch cannot verify itself by removing or hiding the evidence.",
    };
  }

  if (input.requirementRegressions.length > 0) {
    return {
      verdict: "not_verified",
      reason:
        `Accepted requirement(s) stopped being met after the patch: ` +
        `${input.requirementRegressions.join(", ")}.`,
    };
  }

  if (input.afterStatus === null || INCONCLUSIVE_STATUSES.has(input.afterStatus)) {
    return {
      verdict: "inconclusive",
      reason:
        input.afterStatus === null
          ? "No post-patch run was produced, so there is no evidence either way."
          : `The post-patch run ended ${input.afterStatus}, so no usable result was observed.`,
    };
  }

  const comparison = input.comparison;
  if (comparison === null) {
    return {
      verdict: "inconclusive",
      reason: "There is no before/after pairing to verify, so no claim can be made.",
    };
  }

  if (!comparison.comparable) {
    return {
      verdict: "inconclusive",
      reason:
        "The before and after runs are not comparable, so their pairing is not verification evidence: " +
        (comparison.notComparableReasons[0] ?? "the reports do not describe the same experiment"),
    };
  }

  const { counts } = comparison;
  if (counts.newlyFailing > 0) {
    return {
      verdict: "not_verified",
      reason: `${counts.newlyFailing} test(s) that passed before the patch fail after it.`,
    };
  }
  if (counts.stillFailing > 0) {
    return {
      verdict: "not_verified",
      reason:
        `${counts.stillFailing} test(s) failed before the patch and still fail after it; ` +
        "the patch does not resolve the failing evidence.",
    };
  }
  if (counts.newlyInconclusive > 0 || counts.newlySkipped > 0) {
    return {
      verdict: "inconclusive",
      reason:
        `${counts.newlyInconclusive + counts.newlySkipped} test(s) stopped producing a result after the patch ` +
        "(skipped or inconclusive), which is not a pass.",
    };
  }
  if (counts.gone > 0) {
    return {
      verdict: "inconclusive",
      reason: `${counts.gone} test(s) present before the patch are absent after it; absence is not a pass.`,
    };
  }
  if (counts.total === 0 || input.afterStatus !== "passed") {
    return {
      verdict: "inconclusive",
      reason: "The post-patch run produced no test results to compare.",
    };
  }

  return {
    verdict: "verified",
    reason:
      `All ${counts.stillPassing + counts.newlyPassing} selected test result(s) passed after the patch, ` +
      "no test newly fails, and no weakening signal was found.",
  };
}
