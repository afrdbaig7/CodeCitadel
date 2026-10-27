import { createHash } from "node:crypto";

import { z } from "zod";

import { checkStatusSchema } from "./execution.js";
import { TEST_FINGERPRINT_PATTERN } from "./fingerprint.js";

/**
 * Requirement document schema version. A document is committed evidence: it is
 * read by a build, quoted in a review, and re-read later. A reader must reject a
 * version it does not understand rather than guessing at its meaning.
 */
export const REQUIREMENTS_SCHEMA_VERSION = 1;

/** Default file name, looked up in the analyzed directory. */
export const REQUIREMENT_DOCUMENT_FILE = "codecitadel.requirements.json";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * A registered executable check: one test, named the way the runner names it.
 *
 * The reference is declarative on purpose — a requirement cannot execute code
 * by itself. It only says which stored result would count as evidence.
 */
export const requirementCheckSchema = z.strictObject({
  id: z
    .string()
    .regex(ID_PATTERN, "must start with a lowercase letter or digit and use only a-z, 0-9, ., _, -"),
  /** Test file path relative to the analyzed root, with forward slashes. */
  file: z.string().min(1),
  /** Full test name as the runner reports it, including any describe prefix. */
  name: z.string().min(1),
});
export type RequirementCheck = z.infer<typeof requirementCheckSchema>;

/**
 * The record that a human accepted a requirement — an explicit act, not an
 * inference. `digest` covers the requirement as written, so editing the
 * statement or its checks after acceptance invalidates the acceptance rather
 * than silently extending it.
 */
export const requirementAcceptanceSchema = z.strictObject({
  acceptedAt: z.iso.datetime(),
  /** Who accepted it: a person, a team, or the automation that recorded it. */
  acceptedBy: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type RequirementAcceptance = z.infer<typeof requirementAcceptanceSchema>;

export const requirementSchema = z
  .strictObject({
    id: z.string().regex(ID_PATTERN, "requirement id must be lowercase and stable"),
    /** What must hold, in the words the acceptance applies to. */
    statement: z.string().min(1),
    /**
     * `proposed` is a draft; only `accepted` can be verified. `rejected` keeps a
     * declined statement visible instead of deleting the record.
     */
    state: z.enum(["proposed", "accepted", "rejected"]),
    checks: z.array(requirementCheckSchema).min(1),
    acceptance: requirementAcceptanceSchema.nullable(),
  })
  .superRefine((requirement, context) => {
    if (requirement.state === "accepted" && requirement.acceptance === null) {
      context.addIssue({
        code: "custom",
        path: ["acceptance"],
        message: "an accepted requirement needs an acceptance record",
      });
    }
    if (requirement.state !== "accepted" && requirement.acceptance !== null) {
      context.addIssue({
        code: "custom",
        path: ["acceptance"],
        message: "only an accepted requirement may carry an acceptance record",
      });
    }

    const seen = new Set<string>();
    for (const check of requirement.checks) {
      if (seen.has(check.id)) {
        context.addIssue({
          code: "custom",
          path: ["checks"],
          message: `duplicate check id "${check.id}" in requirement "${requirement.id}"`,
        });
      }
      seen.add(check.id);
    }
  });
export type Requirement = z.infer<typeof requirementSchema>;

export const requirementDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(REQUIREMENTS_SCHEMA_VERSION),
    requirements: z.array(requirementSchema).min(1),
  })
  .superRefine((document, context) => {
    const seen = new Set<string>();
    document.requirements.forEach((requirement, index) => {
      if (seen.has(requirement.id)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: `duplicate requirement id "${requirement.id}"`,
        });
      }
      seen.add(requirement.id);
    });
  });
export type RequirementDocument = z.infer<typeof requirementDocumentSchema>;

/**
 * What acceptance was signed over. The canonical form is built here, in one
 * place, so the digest written by `requirements accept` and the digest checked
 * on load cannot drift apart. Field order is fixed by the literal below, which
 * is what makes the digest stable across machines.
 */
export function requirementDigest(
  requirement: Pick<Requirement, "id" | "statement" | "checks">,
): string {
  const canonical = JSON.stringify({
    id: requirement.id,
    statement: requirement.statement,
    checks: requirement.checks.map((check) => ({
      id: check.id,
      file: check.file,
      name: check.name,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Whether the acceptance block still describes the requirement as written.
 * `missing` covers proposed and rejected requirements: nothing approved them.
 */
export const acceptanceStatusSchema = z.enum(["current", "stale", "missing"]);
export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;

/** Summary of one requirement for `requirements list`. */
export const requirementSummarySchema = z.strictObject({
  id: z.string(),
  statement: z.string(),
  state: z.enum(["proposed", "accepted", "rejected"]),
  acceptance: acceptanceStatusSchema,
  acceptedAt: z.iso.datetime().nullable(),
  acceptedBy: z.string().nullable(),
  checks: z.array(
    z.strictObject({
      id: z.string(),
      file: z.string(),
      name: z.string(),
      fingerprint: z.string().regex(TEST_FINGERPRINT_PATTERN),
    }),
  ),
});
export type RequirementSummary = z.infer<typeof requirementSummarySchema>;

export const REQUIREMENTS_SUMMARY_SCHEMA_VERSION = 1;

export const requirementsSummarySchema = z.strictObject({
  schemaVersion: z.literal(REQUIREMENTS_SUMMARY_SCHEMA_VERSION),
  requirements: z.array(requirementSummarySchema).min(1),
  counts: z.strictObject({
    accepted: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type RequirementsSummary = z.infer<typeof requirementsSummarySchema>;

/**
 * Outcome of one registered check against a stored run report.
 *
 * - `not_run` — the fingerprint is absent from the report (not selected, or
 *   never reported). Absence is not evidence of anything.
 * - `inconclusive` — the test was skipped, timed out, errored, was cancelled,
 *   or is unsupported in this configuration.
 */
export const requirementCheckOutcomeSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
  "not_run",
]);
export type RequirementCheckOutcome = z.infer<typeof requirementCheckOutcomeSchema>;

/**
 * `not_accepted` is a verdict, not a null: a requirement nobody accepted can
 * never be met by tests, however green they are.
 */
export const requirementVerdictSchema = z.enum([
  "met",
  "unmet",
  "inconclusive",
  "not_accepted",
]);
export type RequirementVerdict = z.infer<typeof requirementVerdictSchema>;

export const evaluatedRequirementCheckSchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  name: z.string(),
  fingerprint: z.string().regex(TEST_FINGERPRINT_PATTERN),
  outcome: requirementCheckOutcomeSchema,
  /** The stored result's status, or null when the report had no result. */
  status: checkStatusSchema.nullable(),
  message: z.string().nullable(),
});
export type EvaluatedRequirementCheck = z.infer<typeof evaluatedRequirementCheckSchema>;

export const evaluatedRequirementSchema = z.strictObject({
  id: z.string(),
  statement: z.string(),
  verdict: requirementVerdictSchema,
  acceptance: acceptanceStatusSchema,
  checks: z.array(evaluatedRequirementCheckSchema).min(1),
});
export type EvaluatedRequirement = z.infer<typeof evaluatedRequirementSchema>;

export const REQUIREMENTS_EVALUATION_SCHEMA_VERSION = 1;

export const requirementsEvaluationSchema = z.strictObject({
  schemaVersion: z.literal(REQUIREMENTS_EVALUATION_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  /** The analyzed root, taken from the run report. */
  root: z.string().min(1),
  run: z.strictObject({
    id: z.string(),
    generatedAt: z.iso.datetime(),
  }),
  requirements: z.array(evaluatedRequirementSchema).min(1),
  counts: z.strictObject({
    met: z.number().int().nonnegative(),
    unmet: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
    notAccepted: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string().min(1)).min(1),
});
export type RequirementsEvaluation = z.infer<typeof requirementsEvaluationSchema>;
