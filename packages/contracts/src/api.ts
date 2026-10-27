import { createHash } from "node:crypto";

import { z } from "zod";

import { executionComparisonSchema } from "./execution.js";
import { testRunReportSchema } from "./execution.js";
import { impactReportSchema } from "./impact.js";
import { patchVerificationReportSchema } from "./patch.js";
import { codeCitadelReportSchema } from "./report.js";
import { reproductionReportSchema } from "./reproduction.js";
import { requirementsEvaluationSchema } from "./requirements.js";
import { snapshotDiffSchema } from "./snapshot.js";

/**
 * HTTP contract version. The routes are versioned in the path (`/api/v1`), and
 * the payloads carry this value too: a client that was built for v1 and a server
 * that speaks v2 must not silently exchange documents.
 */
export const API_SCHEMA_VERSION = 1;

/** Bodies above this are refused before parsing. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Artifacts per upload, and bytes per artifact. */
export const MAX_ARTIFACTS = 32;
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

/**
 * Who executed the checks. `local` is the developer's machine, `user-ci` is the
 * developer's own pipeline, and `managed` is reserved for runs this platform
 * executed. An upload may only claim the first two: managed execution cannot be
 * asserted by a client.
 */
export const uploadOriginSchema = z.enum(["local", "user-ci"]);
export type UploadOrigin = z.infer<typeof uploadOriginSchema>;

export const evidenceOriginSchema = z.enum(["local", "user-ci", "managed"]);
export type EvidenceOrigin = z.infer<typeof evidenceOriginSchema>;

/**
 * The kinds of evidence this control plane accepts. Each maps to an existing
 * contract, so an upload is validated against the same schema the CLI writes.
 */
export const reportKindSchema = z.enum([
  "scan",
  "diff",
  "impact",
  "run",
  "comparison",
  "patch-verification",
  "requirements-evaluation",
  "reproduction",
]);
export type ReportKind = z.infer<typeof reportKindSchema>;

const SCHEMAS: Record<ReportKind, z.ZodType> = {
  scan: codeCitadelReportSchema,
  diff: snapshotDiffSchema,
  impact: impactReportSchema,
  run: testRunReportSchema,
  comparison: executionComparisonSchema,
  "patch-verification": patchVerificationReportSchema,
  "requirements-evaluation": requirementsEvaluationSchema,
  reproduction: reproductionReportSchema,
};

/** The contract an upload of this kind must satisfy. */
export function reportSchemaFor(kind: ReportKind): z.ZodType {
  return SCHEMAS[kind];
}

/** Artifact names are stored as file names, so they are constrained, not merely trimmed. */
export const artifactNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/**
 * An upload. It deliberately has no `organization` field: the tenant comes from
 * the authenticated token, never from a body a caller can write.
 */
export const reportUploadSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  origin: uploadOriginSchema,
  kind: reportKindSchema,
  repository: z.strictObject({
    name: z.string().min(1).max(200),
    commit: z.string().min(1).max(200).nullable(),
    branch: z.string().min(1).max(200).nullable(),
  }),
  capturedAt: z.iso.datetime(),
  /** Validated against `reportSchemaFor(kind)` by the server, not here. */
  report: z.unknown(),
  /**
   * Optional small artifacts (traces, raw reporter output). Each digest is
   * checked against the decoded bytes; large evidence belongs in object storage,
   * which hosted mode adds.
   */
  artifacts: z
    .array(
      z.strictObject({
        name: artifactNameSchema,
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        contentBase64: z.string().min(1),
      }),
    )
    .max(MAX_ARTIFACTS)
    .default([]),
});
export type ReportUpload = z.infer<typeof reportUploadSchema>;

/**
 * What a stored run looks like when listed. It is a projection of the stored
 * report, not a substitute: `outcome` is a short label the server derived when
 * it validated the report, and `reportDigest` lets a reader detect later edits.
 */
export const storedRunSchema = z.strictObject({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  repository: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    commit: z.string().nullable(),
    branch: z.string().nullable(),
  }),
  kind: reportKindSchema,
  origin: evidenceOriginSchema,
  capturedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  reportDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** One short statement about the report's own verdict, or null when it has none. */
  outcome: z.string().nullable(),
  bytes: z.number().int().positive(),
  artifacts: z.array(
    z.strictObject({
      name: artifactNameSchema,
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      bytes: z.number().int().positive(),
    }),
  ),
});
export type StoredRun = z.infer<typeof storedRunSchema>;

export const uploadResponseSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  run: storedRunSchema,
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const runListResponseSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  runs: z.array(storedRunSchema),
});
export type RunListResponse = z.infer<typeof runListResponseSchema>;

export const runDetailResponseSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  run: storedRunSchema,
  /** The validated JSON exactly as it was uploaded. */
  report: z.unknown(),
});
export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>;

export const healthResponseSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  status: z.literal("ok"),
  storage: z.strictObject({
    driver: z.enum(["sqlite", "postgres"]),
    schemaVersion: z.number().int().nonnegative(),
  }),
  limits: z.strictObject({
    maxUploadBytes: z.number().int().positive(),
    maxArtifacts: z.number().int().positive(),
    maxArtifactBytes: z.number().int().positive(),
  }),
  /** What this deployment does not do, printed with every health check. */
  limitations: z.array(z.string().min(1)).min(1),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  "unauthorized",
  "not_found",
  "invalid_request",
  "unsupported_kind",
  "too_large",
  "conflict",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Digest over the exact bytes of a stored report, as the server received them. */
export function payloadDigest(bytes: Buffer | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * A one-line outcome for the list view, derived from the report's own fields.
 * It never overrides them: the full report stays available and authoritative.
 */
export function outcomeOf(kind: ReportKind, report: unknown): string | null {
  const value = report as Record<string, unknown>;
  switch (kind) {
    case "scan": {
      const findings = value.findings;
      return Array.isArray(findings) ? `${findings.length} finding(s)` : null;
    }
    case "diff": {
      const findings = value.findings as { introduced?: unknown[] } | undefined;
      const introduced = findings?.introduced;
      return Array.isArray(introduced) ? `${introduced.length} introduced` : null;
    }
    case "impact": {
      const tests = value.tests as { selected?: unknown[] } | undefined;
      const selected = tests?.selected;
      return Array.isArray(selected) ? `${selected.length} test file(s) selected` : null;
    }
    case "run": {
      const record = value.record as { status?: unknown } | undefined;
      return typeof record?.status === "string" ? record.status : null;
    }
    case "comparison":
      return typeof value.comparable === "boolean"
        ? value.comparable
          ? "comparable"
          : "not comparable"
        : null;
    case "patch-verification":
      return typeof value.verdict === "string" ? value.verdict : null;
    case "requirements-evaluation": {
      const counts = value.counts as { unmet?: unknown } | undefined;
      return typeof counts?.unmet === "number" ? `${counts.unmet} unmet` : null;
    }
    case "reproduction":
      return typeof value.verdict === "string" ? value.verdict : null;
    default:
      return null;
  }
}
