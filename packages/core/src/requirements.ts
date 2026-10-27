import {
  requirementDigest,
  requirementsEvaluationSchema,
  requirementsSummarySchema,
  requirementDocumentSchema,
  testFingerprint,
  type AcceptanceStatus,
  type EvaluatedRequirement,
  type EvaluatedRequirementCheck,
  type Requirement,
  type RequirementCheckOutcome,
  type RequirementDocument,
  type RequirementsEvaluation,
  type RequirementsSummary,
  type RequirementVerdict,
  type TestRunReport,
} from "@codecitadel/contracts";

/** A requirement document that cannot be read, used, or accepted as written. */
export class RequirementDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementDocumentError";
  }
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "" : ` at ${path.map((segment) => String(segment)).join(".")}`;
}

/**
 * Reads a document strictly. The schema rejects unknown fields as well as a
 * wrong version, so a typo in a committed requirement is a load error instead
 * of a silently ignored key — and `requirements accept` can rewrite the file
 * without losing anything it did not understand.
 */
export function parseRequirementDocument(
  text: string,
  source = "requirement document",
): RequirementDocument {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new RequirementDocumentError(`${source} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = requirementDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RequirementDocumentError(
      `${source} does not match requirement schema version 1${
        issue ? formatIssuePath(issue.path) : ""
      }: ${issue?.message ?? "invalid document"}.`,
    );
  }
  return parsed.data;
}

/**
 * Whether the acceptance block still covers the requirement as written. The
 * digest is recomputed on every read, so an edit after acceptance downgrades
 * the requirement to `stale` rather than carrying the old approval forward.
 */
export function acceptanceStatusOf(requirement: Requirement): AcceptanceStatus {
  if (requirement.acceptance === null) {
    return "missing";
  }
  return requirement.acceptance.digest === requirementDigest(requirement) ? "current" : "stale";
}

/** The `requirements list` view: states, acceptance, and check fingerprints. */
export function summarizeRequirements(document: RequirementDocument): RequirementsSummary {
  const requirements = document.requirements.map((requirement) => {
    const acceptance = acceptanceStatusOf(requirement);
    return {
      id: requirement.id,
      statement: requirement.statement,
      state: requirement.state,
      acceptance,
      acceptedAt: requirement.acceptance?.acceptedAt ?? null,
      acceptedBy: requirement.acceptance?.acceptedBy ?? null,
      checks: requirement.checks.map((check) => ({
        id: check.id,
        file: check.file,
        name: check.name,
        fingerprint: testFingerprint(check.file, check.name),
      })),
    };
  });

  return requirementsSummarySchema.parse({
    schemaVersion: 1,
    requirements,
    counts: {
      accepted: requirements.filter((entry) => entry.acceptance === "current").length,
      stale: requirements.filter((entry) => entry.acceptance === "stale").length,
      proposed: requirements.filter((entry) => entry.state === "proposed").length,
      rejected: requirements.filter((entry) => entry.state === "rejected").length,
      total: requirements.length,
    },
  });
}

export interface AcceptRequirementInput {
  document: RequirementDocument;
  id: string;
  /** Who is recording the acceptance. Required: nobody accepts anonymously. */
  acceptedBy: string;
  at?: Date;
}

/**
 * Records an explicit acceptance. This is deliberately the only way a
 * requirement becomes verifiable: there is no inference path, and the digest
 * fixes exactly what was accepted. A `stale` requirement is accepted again by
 * running this same command, which replaces the old record.
 */
export function acceptRequirement(input: AcceptRequirementInput): RequirementDocument {
  const { document, id, acceptedBy, at } = input;
  if (acceptedBy.trim() === "") {
    throw new RequirementDocumentError("An acceptance needs a non-empty --by value.");
  }

  const index = document.requirements.findIndex((requirement) => requirement.id === id);
  if (index === -1) {
    throw new RequirementDocumentError(
      `No requirement with id "${id}" in this document. Known ids: ${document.requirements
        .map((requirement) => requirement.id)
        .join(", ")}.`,
    );
  }

  const requirement = document.requirements[index] as Requirement;
  const accepted: Requirement = {
    ...requirement,
    state: "accepted",
    acceptance: {
      acceptedAt: (at ?? new Date()).toISOString(),
      acceptedBy,
      digest: requirementDigest(requirement),
    },
  };

  const requirements = [...document.requirements];
  requirements[index] = accepted;
  return requirementDocumentSchema.parse({ ...document, requirements });
}

function outcomeOf(status: string | undefined): RequirementCheckOutcome {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case undefined:
      return "not_run";
    default:
      // skipped, timed_out, errored, cancelled, unsupported: no evidence either way.
      return "inconclusive";
  }
}

function verdictOf(
  acceptance: AcceptanceStatus,
  checks: readonly EvaluatedRequirementCheck[],
): RequirementVerdict {
  if (acceptance !== "current") {
    return "not_accepted";
  }
  if (checks.some((check) => check.outcome === "failed")) {
    return "unmet";
  }
  if (checks.some((check) => check.outcome !== "passed")) {
    return "inconclusive";
  }
  return "met";
}

export interface EvaluateRequirementsInput {
  document: RequirementDocument;
  report: TestRunReport;
  generatedAt?: Date;
}

/**
 * Evaluates every requirement's registered checks against one stored run
 * report. A missing result is `not_run`, never a pass; a stale acceptance is
 * `not_accepted`, never a quieter kind of acceptance.
 */
export function evaluateRequirements(input: EvaluateRequirementsInput): RequirementsEvaluation {
  const { document, report } = input;
  const byId = new Map(report.results.map((result) => [result.id, result]));

  const requirements: EvaluatedRequirement[] = document.requirements.map((requirement) => {
    const acceptance = acceptanceStatusOf(requirement);
    const checks: EvaluatedRequirementCheck[] = requirement.checks.map((check) => {
      const fingerprint = testFingerprint(check.file, check.name);
      const result = byId.get(fingerprint);
      return {
        id: check.id,
        file: check.file,
        name: check.name,
        fingerprint,
        outcome: outcomeOf(result?.status),
        status: result?.status ?? null,
        message: result?.message ?? null,
      };
    });
    return {
      id: requirement.id,
      statement: requirement.statement,
      verdict: verdictOf(acceptance, checks),
      acceptance,
      checks,
    };
  });

  const counts = {
    met: requirements.filter((entry) => entry.verdict === "met").length,
    unmet: requirements.filter((entry) => entry.verdict === "unmet").length,
    inconclusive: requirements.filter((entry) => entry.verdict === "inconclusive").length,
    notAccepted: requirements.filter((entry) => entry.verdict === "not_accepted").length,
    total: requirements.length,
  };

  const limitations = [
    "A met requirement means its registered checks passed in this one stored run. " +
      "It is not proof that the statement holds beyond those checks.",
    "Checks are paired to results by fingerprint (file and full test name). The fingerprint does not " +
      "capture the test body, so a rewritten assertion keeps its check id and can still satisfy it.",
    "The evaluation reads a stored run report. It does not verify that the run analyzed the tree the " +
      "requirement was accepted against, and it does not re-run anything.",
  ];
  if (requirements.some((entry) => entry.acceptance !== "current")) {
    limitations.push(
      "At least one requirement is not accepted under its current text, so no result can satisfy it. " +
        "Accept it explicitly with `codecitadel requirements accept <id> --by <name>`.",
    );
  }

  return requirementsEvaluationSchema.parse({
    schemaVersion: 1,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    root: report.root,
    run: { id: report.record.id, generatedAt: report.generatedAt },
    requirements,
    counts,
    limitations,
  });
}
