import { createHash } from "node:crypto";

import { z } from "zod";

import { checkStatusSchema, executionRecordSchema, testResultSchema } from "./execution.js";
import { TEST_FINGERPRINT_PATTERN } from "./fingerprint.js";
import { patchVerificationVerdictSchema } from "./patch.js";
import {
  reproductionProvenanceSchema,
  reproductionVerdictSchema,
} from "./reproduction.js";

/**
 * Evidence bundle schema version. An evidence bundle is a portable, tamper-evident
 * container for verification evidence, artifacts, and claims.
 */
export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Replay report schema version.
 */
export const REPLAY_REPORT_SCHEMA_VERSION = 1;

/**
 * Maximum total bundle size in bytes (10 MiB) to prevent memory exhaustion
 * and payload attacks before parsing.
 */
export const EVIDENCE_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Maximum size in bytes for a single artifact inside the bundle (2 MiB).
 */
export const EVIDENCE_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

const BUNDLE_ID_PATTERN = /^bundle_[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const bundleKindSchema = z.enum(["reproduction", "run", "patch-verification"]);
export type BundleKind = z.infer<typeof bundleKindSchema>;

/**
 * One artifact bundled with its relative path, integrity digest, and byte count.
 */
export const bundleArtifactSchema = z.strictObject({
  /** Relative path of the artifact within the bundle or target repository. */
  path: z.string().min(1),
  /** SHA-256 digest of the artifact content in the specified encoding. */
  digest: z.string().regex(DIGEST_PATTERN),
  /** Exact byte count of the artifact content in UTF-8. */
  bytes: z.number().int().positive().max(EVIDENCE_ARTIFACT_MAX_BYTES),
  /** Encoding of the content string. */
  encoding: z.enum(["utf8", "base64"]),
  /** The serialized content. */
  content: z.string(),
});
export type BundleArtifact = z.infer<typeof bundleArtifactSchema>;

/**
 * Permissions and runtime requirements declared by the bundle that must be
 * satisfied before replay executes repository code.
 */
export const bundlePermissionSchema = z.strictObject({
  /** Whether replaying this bundle executes target repository code. */
  executeCode: z.boolean(),
  /** The test runner required (e.g. vitest). */
  runner: z.literal("vitest"),
  /** Required isolation mode. */
  isolation: z.enum(["source-copy", "none"]),
  /** Forwarded environment variable names needed to reach resources (e.g. demo db). */
  env: z.array(z.string()),
  /** Network access policy needed. */
  network: z.enum(["none", "loopback", "external"]),
});
export type BundlePermission = z.infer<typeof bundlePermissionSchema>;

/**
 * The core claim that this evidence establishes.
 */
export const bundleClaimSchema = z.strictObject({
  statement: z.string().min(1),
  expectedVerdict: z.string().min(1),
  provenance: reproductionProvenanceSchema,
  requirement: z.string().nullable(),
  check: z
    .strictObject({
      file: z.string().min(1),
      test: z.string().min(1),
      fingerprint: z.string().regex(TEST_FINGERPRINT_PATTERN),
    })
    .nullable(),
});
export type BundleClaim = z.infer<typeof bundleClaimSchema>;

/**
 * Target repository identity captured at time of bundle creation.
 */
export const bundleTargetSchema = z.strictObject({
  root: z.string().min(1),
  commit: z.string().nullable(),
  snapshotDigest: z.string().regex(DIGEST_PATTERN).nullable(),
});
export type BundleTarget = z.infer<typeof bundleTargetSchema>;

/**
 * Full Evidence Bundle contract.
 */
export const evidenceBundleSchema = z.strictObject({
  schemaVersion: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
  id: z.string().regex(BUNDLE_ID_PATTERN),
  kind: bundleKindSchema,
  generatedAt: z.iso.datetime(),
  engineVersion: z.string().min(1),
  platform: z.string().min(1),
  nodeVersion: z.string().min(1),
  target: bundleTargetSchema,
  claim: bundleClaimSchema,
  permissions: bundlePermissionSchema,
  artifacts: z.array(bundleArtifactSchema),
  /** Summary of the original execution record if code was executed. */
  record: executionRecordSchema.nullable(),
  /**
   * The original report stored in the bundle, validated against the respective schema
   * depending on kind.
   */
  report: z.record(z.string(), z.unknown()),
  limitations: z.array(z.string().min(1)).min(1),
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

/**
 * Outcome of replaying an evidence bundle.
 *
 * - `confirmed`: re-execution produced the exact same verdict and test outcome as originally claimed.
 * - `diverged`: re-execution finished but produced a different outcome (e.g. passed instead of failed).
 * - `inconclusive`: replay could not establish evidence (e.g. missing environment, runner crash, timeout).
 */
export const replayVerdictSchema = z.enum(["confirmed", "diverged", "inconclusive"]);
export type ReplayVerdict = z.infer<typeof replayVerdictSchema>;

export const replayReportSchema = z.strictObject({
  schemaVersion: z.literal(REPLAY_REPORT_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  bundleId: z.string().regex(BUNDLE_ID_PATTERN),
  bundleKind: bundleKindSchema,
  verdict: replayVerdictSchema,
  reason: z.string().min(1),
  original: z.strictObject({
    verdict: z.string().min(1),
    status: checkStatusSchema.nullable(),
    message: z.string().nullable(),
  }),
  replayed: z
    .strictObject({
      verdict: z.string().min(1),
      status: checkStatusSchema,
      message: z.string().nullable(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
    })
    .nullable(),
  validation: z.strictObject({
    bundleBytes: z.number().int().positive(),
    artifactCount: z.number().int().nonnegative(),
    verifiedDigests: z.boolean(),
  }),
  limitations: z.array(z.string().min(1)).min(1),
});
export type ReplayReport = z.infer<typeof replayReportSchema>;

/** Compute SHA-256 digest of content with the specified encoding. */
export function bundleArtifactDigest(
  content: string,
  encoding: "utf8" | "base64" = "utf8",
): string {
  const buf = Buffer.from(content, encoding);
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/** Compute byte length of content in the specified encoding. */
export function bundleArtifactBytes(
  content: string,
  encoding: "utf8" | "base64" = "utf8",
): number {
  return Buffer.from(content, encoding).byteLength;
}
