import { z } from "zod";

import { executionComparisonSchema, testRunReportSchema } from "./execution.js";
import { requirementsEvaluationSchema } from "./requirements.js";

/**
 * Patch verification report schema version. Like every other stored report this
 * is evidence: a reader rejects a version it was not written for instead of
 * interpreting unknown fields.
 */
export const PATCH_VERIFICATION_SCHEMA_VERSION = 1;

/** What a patch did to one file. Renames are refused by the applier. */
export const patchFileStatusSchema = z.enum(["created", "modified", "deleted"]);
export type PatchFileStatus = z.infer<typeof patchFileStatusSchema>;

/**
 * Why a path matters. The classification is a fact about the path, not a
 * judgement: a touched test file is listed as a test file whether the patch adds
 * a regression test or weakens an existing one.
 */
export const patchFileKindSchema = z.enum([
  "source",
  "test",
  "runner-config",
  "dependency-lock",
  "requirement-document",
  "ignore-rules",
]);
export type PatchFileKind = z.infer<typeof patchFileKindSchema>;

export const patchFileReportSchema = z.strictObject({
  /** Path relative to the analyzed root, with forward slashes. */
  path: z.string().min(1),
  status: patchFileStatusSchema,
  kind: patchFileKindSchema,
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
});
export type PatchFileReport = z.infer<typeof patchFileReportSchema>;

/**
 * One observation about a patch's content, with the two severities kept apart:
 *
 * - `warning` is context a reviewer needs (a test file was touched, a lockfile
 *   changed) but that does not by itself weaken verification.
 * - `weakening` removes or hides the evidence itself: a skipped test, a removed
 *   assertion, a suppressed diagnostic, an edited requirement, changed runner
 *   configuration, changed exclusions, or a deleted test file. A patch carrying
 *   one cannot earn a `verified` verdict.
 */
export const patchSignalKindSchema = z.enum([
  "edited-test",
  "removed-test-file",
  "added-skip",
  "added-only",
  "removed-assertion",
  "suppressed-diagnostics",
  "edited-requirement",
  "changed-runner-config",
  "changed-ignore-rules",
  "changed-lockfile",
]);
export type PatchSignalKind = z.infer<typeof patchSignalKindSchema>;

export const patchSignalSeveritySchema = z.enum(["warning", "weakening"]);
export type PatchSignalSeverity = z.infer<typeof patchSignalSeveritySchema>;

export const patchSignalSchema = z.strictObject({
  kind: patchSignalKindSchema,
  file: z.string().min(1),
  /** Line in the patched file, or null when the signal is about the file itself. */
  line: z.number().int().positive().nullable(),
  severity: patchSignalSeveritySchema,
  detail: z.string().min(1),
});
export type PatchSignal = z.infer<typeof patchSignalSchema>;

export const patchInspectionSchema = z.strictObject({
  files: z.array(patchFileReportSchema).min(1),
  signals: z.array(patchSignalSchema),
  /** Count of `weakening` signals; warnings are not counted here. */
  weakening: z.number().int().nonnegative(),
});
export type PatchInspection = z.infer<typeof patchInspectionSchema>;

/**
 * How the verification ended.
 *
 * - `verified` — the patch applied, every test that passed before still passes,
 *   no test newly fails, accepted requirements did not regress, and the patch
 *   carries no weakening signal.
 * - `not_verified` — the experiment ran and the patch does not earn a pass.
 * - `inconclusive` — nothing was executed, or the run produced no usable result.
 * - `not_applied` — the patch did not apply cleanly, so nothing was executed.
 */
export const patchVerificationVerdictSchema = z.enum([
  "verified",
  "not_verified",
  "inconclusive",
  "not_applied",
]);
export type PatchVerificationVerdict = z.infer<typeof patchVerificationVerdictSchema>;

export const patchVerificationReportSchema = z.strictObject({
  schemaVersion: z.literal(PATCH_VERIFICATION_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  /** The tree the patch was verified against; never modified by this command. */
  root: z.string().min(1),
  verdict: patchVerificationVerdictSchema,
  /** One sentence saying why the verdict is what it is. */
  reason: z.string().min(1),
  patch: z.strictObject({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    files: z.number().int().positive(),
    addedLines: z.number().int().nonnegative(),
    removedLines: z.number().int().nonnegative(),
  }),
  inspection: patchInspectionSchema,
  /**
   * The paired run reports. Null when nothing was executed; the pairing is never
   * fabricated from the before report alone.
   */
  comparison: executionComparisonSchema.nullable(),
  /** Requirements evaluated against the post-patch run, from the committed document. */
  requirements: requirementsEvaluationSchema.nullable(),
  /**
   * Requirements that were `met` before the patch and are not `met` after it.
   * A patch may fix things; it may not turn an accepted requirement green by
   * weakening the check that proved it.
   */
  requirementRegressions: z.array(z.string().min(1)),
  /** The post-patch run report, kept as evidence rather than a summary. */
  after: testRunReportSchema.nullable(),
  limitations: z.array(z.string().min(1)).min(1),
});
export type PatchVerificationReport = z.infer<typeof patchVerificationReportSchema>;
