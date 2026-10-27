import { z } from "zod";

import { severitySchema } from "./finding.js";
import { digestSchema, skipReasonSchema } from "./scanner-protocol.js";

/**
 * Snapshot schema version. A snapshot is stored evidence: a reader must reject
 * a version it does not understand instead of interpreting it loosely.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * One discovered file as the scanner observed it.
 *
 * `digest` identifies the exact bytes read. It is null only when the file could
 * not be read at all (too large or unreadable). A skipped file may still carry a
 * digest: "binary" and "not UTF-8" are decided after reading, so the content is
 * known even though no rule ran on it. That distinction is what lets a diff say
 * "this file changed but was not analyzed" instead of guessing.
 */
export const snapshotFileEntrySchema = z.object({
  path: z.string().min(1),
  digest: digestSchema.nullable(),
  sizeBytes: z.number().int().nonnegative(),
  skipped: skipReasonSchema.nullable(),
});
export type SnapshotFileEntry = z.infer<typeof snapshotFileEntrySchema>;

/**
 * The minimum needed to recognise a finding across two snapshots.
 *
 * `id` is the scanner's fingerprint, which is stable across unrelated line
 * insertions, so moving a finding within a file is not reported as a new one.
 */
export const snapshotFindingSchema = z.object({
  id: z.string().regex(/^f_[0-9a-f]{16}$/),
  ruleId: z.string().min(3),
  severity: severitySchema,
  path: z.string().min(1),
  startLine: z.number().int().positive(),
});
export type SnapshotFinding = z.infer<typeof snapshotFindingSchema>;

/**
 * The scan options that decide which files are covered. Stored with the
 * snapshot so a diff can separate "the code changed" from "the scan looked at
 * a different set of files".
 */
export const coverageOptionsSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxBytesPerFile: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
  includeHidden: z.boolean(),
  followSymlinks: z.boolean(),
  exclude: z.array(z.string()),
});
export type CoverageOptions = z.infer<typeof coverageOptionsSchema>;

export const snapshotSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  tool: z.object({
    name: z.literal("codecitadel"),
    version: z.string().min(1),
    scannerVersion: z.string().min(1),
    protocol: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
  }),
  root: z.string().min(1),
  options: coverageOptionsSchema,
  /** Rules that were enabled, so a diff can separate config change from code change. */
  rules: z.array(z.object({ id: z.string().min(3), version: z.string().min(1) })),
  files: z.array(snapshotFileEntrySchema),
  findings: z.array(snapshotFindingSchema),
  /** True when a resource limit stopped the scan short of the whole tree. */
  truncated: z.boolean(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const DIFF_SCHEMA_VERSION = 1;

export const fileChangeKindSchema = z.enum(["added", "modified", "removed", "unverified"]);
export type FileChangeKind = z.infer<typeof fileChangeKindSchema>;

export const fileChangeSchema = z.object({
  kind: fileChangeKindSchema,
  path: z.string().min(1),
  baseDigest: digestSchema.nullable(),
  headDigest: digestSchema.nullable(),
  baseSkipped: skipReasonSchema.nullable(),
  headSkipped: skipReasonSchema.nullable(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

/**
 * A diff never claims to know what happened between two observations. The
 * limitations list is part of the diff, not advice attached to it.
 */
export const snapshotDiffSchema = z.object({
  schemaVersion: z.literal(DIFF_SCHEMA_VERSION),
  base: z.object({
    generatedAt: z.iso.datetime(),
    root: z.string().min(1),
    scannerVersion: z.string().min(1),
    files: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  head: z.object({
    generatedAt: z.iso.datetime(),
    root: z.string().min(1),
    scannerVersion: z.string().min(1),
    files: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  files: z.object({
    added: z.array(fileChangeSchema),
    modified: z.array(fileChangeSchema),
    removed: z.array(fileChangeSchema),
    /** Verified before, unreadable or unanalyzed now: change status is unknown. */
    unverified: z.array(fileChangeSchema),
    unchanged: z.number().int().nonnegative(),
    /** Unreadable in both snapshots: nothing is known either way. */
    stillUnverified: z.number().int().nonnegative(),
  }),
  rules: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    versionChanged: z.array(z.string()),
    changed: z.boolean(),
  }),
  /** Differences in what the two scans were allowed to look at. */
  options: z.object({
    changed: z.boolean(),
    differences: z.array(z.string().min(1)),
  }),
  findings: z.object({
    /** Present in the head snapshot, absent from the base. */
    introduced: z.array(snapshotFindingSchema),
    /** Absent from the head snapshot in a file that was actually analyzed. */
    resolved: z.array(snapshotFindingSchema),
    /** Absent from the head snapshot, but the file could not be re-checked. */
    unverified: z.array(snapshotFindingSchema),
    carriedOver: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string().min(1)).min(1),
});
export type SnapshotDiff = z.infer<typeof snapshotDiffSchema>;
