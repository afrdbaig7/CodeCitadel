import {
  reproductionDocumentSchema,
  type CheckStatus,
  type ReproductionDocument,
  type ReproductionEntry,
  type ReproductionRequirement,
  type ReproductionVerdict,
  type TestResult,
} from "@codecitadel/contracts";

/** A reproduction manifest that cannot be read, or a path it may not name. */
export class ReproductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReproductionError";
  }
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "" : ` at ${path.map((segment) => String(segment)).join(".")}`;
}

/**
 * Reads a manifest strictly. Unknown fields are rejected along with a wrong
 * version, so a mistyped `test` name is a load error rather than a silently
 * ignored key that would later look like "no result reported".
 */
export function parseReproductionDocument(
  text: string,
  source = "reproduction document",
): ReproductionDocument {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ReproductionError(`${source} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = reproductionDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ReproductionError(
      `${source} does not match reproduction schema version 1${
        issue ? formatIssuePath(issue.path) : ""
      }: ${issue?.message ?? "invalid document"}.`,
    );
  }
  return parsed.data;
}

/** Selects one declared reproduction, naming the alternatives when it is absent. */
export function findReproduction(
  document: ReproductionDocument,
  id: string,
): ReproductionEntry {
  const entry = document.reproductions.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = document.reproductions.map((candidate) => candidate.id).join(", ");
    throw new ReproductionError(
      `There is no reproduction "${id}" in this document. Known reproductions: ${known}.`,
    );
  }
  return entry;
}

/**
 * A reproduction may only name a file inside the analyzed root, with forward
 * slashes and no traversal. The check runs in a copy, but the source it reads
 * and the path the runner receives both come from this string, so it is
 * validated once here rather than trusted twice.
 */
export function validateReproductionPath(candidate: string): void {
  if (candidate.trim() === "") {
    throw new ReproductionError("The reproduction file path is empty.");
  }
  if (candidate.includes("\\")) {
    throw new ReproductionError(
      `The reproduction file path ${JSON.stringify(candidate)} uses a backslash. Use forward slashes relative to the analyzed root.`,
    );
  }
  if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
    throw new ReproductionError(
      `The reproduction file path ${JSON.stringify(candidate)} is absolute. Use a path relative to the analyzed root.`,
    );
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ReproductionError(
      `The reproduction file path ${JSON.stringify(candidate)} must not contain empty, "." or ".." segments.`,
    );
  }
}

export interface ReproductionDecisionInput {
  /** The requirement as read at run time, or null when none was named. */
  requirement: ReproductionRequirement | null;
  /** The supervised run's status, or null when nothing was executed. */
  executionStatus: CheckStatus | null;
  /** The named test's result, or null when the runner reported none. */
  result: TestResult | null;
  /** Why nothing was executed, when the gate refused before running. */
  notExecutedReason?: string | undefined;
}

export interface ReproductionDecision {
  verdict: ReproductionVerdict;
  reason: string;
}

/** Statuses that mean the runner produced a verdict for this check. */
const DEFINITE: readonly CheckStatus[] = ["passed", "failed"];

/**
 * The verdict policy, in a fixed order. An unaccepted requirement stops the
 * question before any code runs; a run that did not finish says nothing; a
 * missing result is not a pass. Only a completed run of the named test — with
 * its assertion actually failing — counts as a reproduction.
 *
 * Order matters: later stages cannot rescue earlier ones, so a broken setup can
 * never be reported as a reproduced bug.
 */
export function decideReproductionVerdict(
  input: ReproductionDecisionInput,
): ReproductionDecision {
  const { requirement } = input;

  if (requirement !== null && requirement.state !== "accepted") {
    return {
      verdict: "not_accepted",
      reason:
        `The requirement "${requirement.id}" is ${requirement.state}, not accepted, so this ` +
        "reproduction is not evidence for it.",
    };
  }
  if (requirement !== null && requirement.acceptance !== "current") {
    return {
      verdict: "not_accepted",
      reason:
        `The acceptance of "${requirement.id}" is ${requirement.acceptance}: the requirement was ` +
        "edited after it was approved. Accept it as written before treating a reproduction as evidence.",
    };
  }

  if (input.executionStatus === null) {
    return {
      verdict: "inconclusive",
      reason: input.notExecutedReason ?? "Nothing was executed, so there is no evidence either way.",
    };
  }

  if (!DEFINITE.includes(input.executionStatus)) {
    return {
      verdict: "inconclusive",
      reason:
        `The run ended ${input.executionStatus}, so no outcome was established for this ` +
        "reproduction.",
    };
  }

  if (input.result === null) {
    return {
      verdict: "inconclusive",
      reason:
        "The runner reported no result for the named test. Check the test name and that the " +
        "file is collected by the project's runner configuration.",
    };
  }

  switch (input.result.status) {
    case "failed":
      return {
        verdict: "reproduced",
        reason:
          "The named check failed against this tree, so the expected behavior does not hold " +
          "under this check.",
      };
    case "passed":
      return {
        verdict: "not_reproduced",
        reason:
          "The named check passed, so the failure was not observed under this check. That is " +
          "not proof the behavior cannot fail.",
      };
    default:
      return {
        verdict: "inconclusive",
        reason:
          `The named test ended ${input.result.status}, which establishes neither a failure nor ` +
          "a pass.",
      };
  }
}
