import { createHash } from "node:crypto";

import { z } from "zod";

import { executionRecordSchema, testResultSchema } from "./execution.js";
import { TEST_FINGERPRINT_PATTERN } from "./fingerprint.js";
import { acceptanceStatusSchema } from "./requirements.js";

/**
 * Reproduction schema version. A reproduction report is stored evidence: an
 * exported regression test points back at it, so a reader must reject a version
 * it was not written for instead of guessing.
 */
export const REPRODUCTION_SCHEMA_VERSION = 1;

/** Default manifest name, looked up in the analyzed directory. */
export const REPRODUCTION_DOCUMENT_FILE = "codecitadel.reproductions.json";

/** A reproduction file larger than this is refused before it is read. */
export const REPRODUCTION_SOURCE_LIMIT_BYTES = 256 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * Where the expected behavior comes from. `user-authored` is the ordinary case:
 * a person wrote the failing check. `maintained-contract` points at a document
 * the project already keeps, and `user-invariant` at a property someone stated.
 * None of them is an inference by this tool.
 */
export const reproductionProvenanceSchema = z.enum([
  "user-authored",
  "maintained-contract",
  "user-invariant",
]);
export type ReproductionProvenance = z.infer<typeof reproductionProvenanceSchema>;

/**
 * One declared reproduction: a check that is expected to fail against the tree
 * it describes, plus the sentence that says what the failure means. The manifest
 * executes nothing by itself; it names a test file the runner already knows how
 * to run.
 */
export const reproductionEntrySchema = z.strictObject({
  id: z
    .string()
    .regex(ID_PATTERN, "must start with a lowercase letter or digit and use only a-z, 0-9, ., _, -"),
  /** The accepted requirement this reproduction is evidence for, if any. */
  requirement: z.string().regex(ID_PATTERN).nullable(),
  /** What is expected to hold, in the words the reader will judge. */
  statement: z.string().min(1),
  provenance: reproductionProvenanceSchema,
  /** Test file path relative to the analyzed root, with forward slashes. */
  file: z.string().min(1),
  /** Full test name as the runner reports it, including any describe prefix. */
  test: z.string().min(1),
});
export type ReproductionEntry = z.infer<typeof reproductionEntrySchema>;

export const reproductionDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(REPRODUCTION_SCHEMA_VERSION),
    reproductions: z.array(reproductionEntrySchema).min(1),
  })
  .superRefine((document, context) => {
    const seen = new Set<string>();
    document.reproductions.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["reproductions", index, "id"],
          message: `duplicate reproduction id "${entry.id}"`,
        });
      }
      seen.add(entry.id);
    });
  });
export type ReproductionDocument = z.infer<typeof reproductionDocumentSchema>;

/**
 * How a reproduction run ended.
 *
 * - `reproduced` — setup completed and the named check failed: the expected
 *   behavior is not implemented in this tree.
 * - `not_reproduced` — the check passed. The bug was not observed under this
 *   check; that is not proof it cannot happen.
 * - `inconclusive` — nothing was established: the run errored, timed out, was
 *   skipped, or reported no result for the named test.
 * - `not_accepted` — the linked requirement is not accepted as written, so the
 *   reproduction is not evidence for it and nothing was executed.
 */
export const reproductionVerdictSchema = z.enum([
  "reproduced",
  "not_reproduced",
  "inconclusive",
  "not_accepted",
]);
export type ReproductionVerdict = z.infer<typeof reproductionVerdictSchema>;

/**
 * The requirement a reproduction is answerable to, as read at run time.
 * `missing` means no document or no such id: absence is stated, never treated as
 * approval.
 */
export const reproductionRequirementStateSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "missing",
]);
export type ReproductionRequirementState = z.infer<typeof reproductionRequirementStateSchema>;

export const reproductionRequirementSchema = z.strictObject({
  id: z.string().min(1),
  state: reproductionRequirementStateSchema,
  acceptance: acceptanceStatusSchema,
});
export type ReproductionRequirement = z.infer<typeof reproductionRequirementSchema>;

export const reproductionReportSchema = z.strictObject({
  schemaVersion: z.literal(REPRODUCTION_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  root: z.string().min(1),
  verdict: reproductionVerdictSchema,
  /** One sentence saying why the verdict is what it is. */
  reason: z.string().min(1),
  reproduction: z.strictObject({
    id: z.string().regex(ID_PATTERN),
    statement: z.string().min(1),
    provenance: reproductionProvenanceSchema,
    requirement: z.string().regex(ID_PATTERN).nullable(),
  }),
  /**
   * The check, with its source carried inside the report. Carrying the bytes is
   * what makes export possible without the original tree and what lets the
   * export verify it is shipping the text the verdict was reached on.
   */
  check: z.strictObject({
    file: z.string().min(1),
    test: z.string().min(1),
    fingerprint: z.string().regex(TEST_FINGERPRINT_PATTERN),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
    source: z.string(),
  }),
  requirement: reproductionRequirementSchema.nullable(),
  /** Null when nothing was executed because the requirement gate refused. */
  record: executionRecordSchema.nullable(),
  /** Every result the runner reported for the reproduction's test file. */
  results: z.array(testResultSchema),
  /** The named test's result, or null when the runner reported none. */
  result: testResultSchema.nullable(),
  limitations: z.array(z.string().min(1)).min(1),
});
export type ReproductionReport = z.infer<typeof reproductionReportSchema>;

/** Digest over the exact UTF-8 bytes of a reproduction's test source. */
export function reproductionSourceDigest(source: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex")}`;
}

/** Size of the source in UTF-8 bytes, which is what the digest covers. */
export function reproductionSourceBytes(source: string): number {
  return Buffer.byteLength(source, "utf8");
}

export const REPRODUCTION_EXPORT_SCHEMA_VERSION = 1;

/**
 * The manifest that travels with an exported regression test. It is not a new
 * report: it names the evidence the export came from (report schema, time, root,
 * verdict, runner) so a reader can find the original run instead of trusting the
 * test file's header comment.
 *
 * `files[].path` is relative to the export directory and keeps the original
 * relative path, which is what makes the test's own relative imports work in
 * another checkout of the same project.
 */
export const reproductionExportSchema = z.strictObject({
  schemaVersion: z.literal(REPRODUCTION_EXPORT_SCHEMA_VERSION),
  kind: z.literal("codecitadel.reproduction-export"),
  generatedAt: z.iso.datetime(),
  id: z.string().min(1),
  statement: z.string().min(1),
  provenance: reproductionProvenanceSchema,
  requirement: z.string().min(1).nullable(),
  check: z.strictObject({
    file: z.string().min(1),
    test: z.string().min(1),
    fingerprint: z.string().regex(TEST_FINGERPRINT_PATTERN),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  evidence: z.strictObject({
    schemaVersion: z.literal(REPRODUCTION_SCHEMA_VERSION),
    generatedAt: z.iso.datetime(),
    root: z.string().min(1),
    verdict: reproductionVerdictSchema,
    execution: z
      .strictObject({
        runner: z.literal("vitest"),
        runnerVersion: z.string().nullable(),
        nodeVersion: z.string().min(1),
        platform: z.string().min(1),
        isolation: z.enum(["source-copy", "none"]),
        startedAt: z.iso.datetime(),
      })
      .nullable(),
  }),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        bytes: z.number().int().positive(),
      }),
    )
    .min(1),
  limitations: z.array(z.string().min(1)).min(1),
});
export type ReproductionExport = z.infer<typeof reproductionExportSchema>;
