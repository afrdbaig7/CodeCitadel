import { randomBytes } from "node:crypto";

import {
  EVIDENCE_BUNDLE_MAX_BYTES,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  REPLAY_REPORT_SCHEMA_VERSION,
  bundleArtifactBytes,
  bundleArtifactDigest,
  evidenceBundleSchema,
  patchVerificationReportSchema,
  replayReportSchema,
  reproductionReportSchema,
  testRunReportSchema,
  type BundleArtifact,
  type CheckStatus,
  type EvidenceBundle,
  type PatchVerificationReport,
  type ReplayReport,
  type ReplayVerdict,
  type ReproductionReport,
  type TestRunReport,
} from "@codecitadel/contracts";

import { CODECITADEL_VERSION } from "./version.js";

export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleValidationError";
  }
}

function generateBundleId(): string {
  return `bundle_${randomBytes(8).toString("hex")}`;
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "" : ` at ${path.map((segment) => String(segment)).join(".")}`;
}

/**
 * Extracts forwarded environment variable names from execution limitations if present.
 */
function extractForwardedEnvNames(limitations: readonly string[]): string[] {
  const env: string[] = [];
  const prefix = "Forwarded environment variables by name: ";
  for (const lim of limitations) {
    if (lim.startsWith(prefix)) {
      const names = lim.slice(prefix.length).split(", ");
      for (const name of names) {
        if (name.length > 0 && !env.includes(name)) {
          env.push(name);
        }
      }
    }
  }
  return env;
}

/**
 * Creates an evidence bundle from a stored reproduction report.
 */
export function createBundleFromReproduction(
  report: ReproductionReport,
  additionalArtifacts: readonly BundleArtifact[] = [],
): EvidenceBundle {
  const artifacts: BundleArtifact[] = [
    {
      path: report.check.file,
      digest: report.check.digest,
      bytes: report.check.bytes,
      encoding: "utf8",
      content: report.check.source,
    },
    ...additionalArtifacts,
  ];

  const forwardedEnv = extractForwardedEnvNames(report.limitations);

  const bundle: EvidenceBundle = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: generateBundleId(),
    kind: "reproduction",
    generatedAt: new Date().toISOString(),
    engineVersion: CODECITADEL_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    target: {
      root: report.root,
      commit: null,
      snapshotDigest: null,
    },
    claim: {
      statement: report.reproduction.statement,
      expectedVerdict: report.verdict,
      provenance: report.reproduction.provenance,
      requirement: report.reproduction.requirement,
      check: {
        file: report.check.file,
        test: report.check.test,
        fingerprint: report.check.fingerprint,
      },
    },
    permissions: {
      executeCode: true,
      runner: "vitest",
      isolation: "source-copy",
      env: forwardedEnv,
      network: forwardedEnv.length > 0 ? "loopback" : "none",
    },
    artifacts,
    record: report.record,
    report: report as unknown as Record<string, unknown>,
    limitations: [
      "Replaying this bundle executes repository code in an isolated disposable copy.",
      "Evidence establishes the observed outcome for the bundled check under this environment.",
      ...report.limitations,
    ],
  };

  const parsed = evidenceBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    throw new BundleValidationError(
      `Constructed bundle does not match schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Creates an evidence bundle from a stored test run report.
 */
export function createBundleFromRun(
  report: TestRunReport,
  additionalArtifacts: readonly BundleArtifact[] = [],
): EvidenceBundle {
  const forwardedEnv = extractForwardedEnvNames(report.limitations);

  const bundle: EvidenceBundle = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: generateBundleId(),
    kind: "run",
    generatedAt: new Date().toISOString(),
    engineVersion: CODECITADEL_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    target: {
      root: report.root,
      commit: null,
      snapshotDigest: null,
    },
    claim: {
      statement: `Execution of ${report.results.length} selected test(s) with runner status "${report.record.status}".`,
      expectedVerdict: report.record.status,
      provenance: "user-authored",
      requirement: null,
      check: null,
    },
    permissions: {
      executeCode: true,
      runner: "vitest",
      isolation: report.record.isolation.mode,
      env: forwardedEnv,
      network: forwardedEnv.length > 0 ? "loopback" : "none",
    },
    artifacts: [...additionalArtifacts],
    record: report.record,
    report: report as unknown as Record<string, unknown>,
    limitations: [
      "Replaying this bundle executes repository code for the stored selection.",
      ...report.limitations,
    ],
  };

  const parsed = evidenceBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    throw new BundleValidationError(
      `Constructed bundle does not match schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Creates an evidence bundle from a stored patch verification report.
 */
export function createBundleFromPatchVerification(
  report: PatchVerificationReport,
  patchSource: string,
  patchPath: string,
  additionalArtifacts: readonly BundleArtifact[] = [],
): EvidenceBundle {
  const patchDigest = bundleArtifactDigest(patchSource);
  const patchBytes = bundleArtifactBytes(patchSource);

  const forwardedEnv = extractForwardedEnvNames(report.limitations);

  const artifacts: BundleArtifact[] = [
    {
      path: patchPath,
      digest: patchDigest,
      bytes: patchBytes,
      encoding: "utf8",
      content: patchSource,
    },
    ...additionalArtifacts,
  ];

  const bundle: EvidenceBundle = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: generateBundleId(),
    kind: "patch-verification",
    generatedAt: new Date().toISOString(),
    engineVersion: CODECITADEL_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    target: {
      root: report.root,
      commit: null,
      snapshotDigest: null,
    },
    claim: {
      statement: `Patch verification produced verdict "${report.verdict}": ${report.reason}`,
      expectedVerdict: report.verdict,
      provenance: "user-authored",
      requirement: report.requirements?.requirements[0]?.id ?? null,
      check: null,
    },
    permissions: {
      executeCode: true,
      runner: "vitest",
      isolation: "source-copy",
      env: forwardedEnv,
      network: forwardedEnv.length > 0 ? "loopback" : "none",
    },
    artifacts,
    record: report.after?.record ?? null,
    report: report as unknown as Record<string, unknown>,
    limitations: [
      "Replaying this patch verification applies the diff in a disposable copy and re-runs checks.",
      ...report.limitations,
    ],
  };

  const parsed = evidenceBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    throw new BundleValidationError(
      `Constructed bundle does not match schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Strictly parses and validates an evidence bundle.
 * Verifies total size, JSON structure, Zod schema, and SHA-256 digests of all bundled artifacts.
 */
export function validateEvidenceBundle(
  raw: string | unknown,
  maxBytes = EVIDENCE_BUNDLE_MAX_BYTES,
): EvidenceBundle {
  let json: unknown;

  if (typeof raw === "string") {
    const byteLength = Buffer.byteLength(raw, "utf8");
    if (byteLength > maxBytes) {
      throw new BundleValidationError(
        `Bundle size (${byteLength} bytes) exceeds maximum allowed limit of ${maxBytes} bytes.`,
      );
    }
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new BundleValidationError(`Bundle is not valid JSON: ${(error as Error).message}`);
    }
  } else {
    json = raw;
  }

  const parsed = evidenceBundleSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BundleValidationError(
      `Bundle does not match evidence bundle schema version 1${
        issue ? formatIssuePath(issue.path) : ""
      }: ${issue?.message ?? "invalid bundle"}.`,
    );
  }

  const bundle = parsed.data;

  // Verify integrity of every artifact
  for (const artifact of bundle.artifacts) {
    const computedDigest = bundleArtifactDigest(artifact.content, artifact.encoding);
    if (computedDigest !== artifact.digest) {
      throw new BundleValidationError(
        `Corrupted artifact "${artifact.path}": digest mismatch. ` +
          `Expected ${artifact.digest}, recomputed ${computedDigest}. The bundle is tampered or corrupted.`,
      );
    }

    const computedBytes = bundleArtifactBytes(artifact.content, artifact.encoding);
    if (computedBytes !== artifact.bytes) {
      throw new BundleValidationError(
        `Corrupted artifact "${artifact.path}": byte count mismatch. ` +
          `Expected ${artifact.bytes} bytes, computed ${computedBytes} bytes.`,
      );
    }
  }

  return bundle;
}

export interface ReplayRecheckInput {
  verdict: string;
  status: CheckStatus;
  message: string | null;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Determines whether the replayed execution confirms the original evidence claim.
 */
export function decideReplayVerdict(
  bundle: EvidenceBundle,
  replayed: ReplayRecheckInput | null,
  bundleBytes: number,
): ReplayReport {
  let verdict: ReplayVerdict = "inconclusive";
  let reason = "";

  const originalVerdict = bundle.claim.expectedVerdict;
  const originalStatus = bundle.record?.status ?? null;
  const originalMessage = bundle.record?.detail ?? null;

  if (replayed === null) {
    verdict = "inconclusive";
    reason = "Replay execution was not performed or failed before execution started.";
  } else if (replayed.status === "errored" || replayed.status === "timed_out" || replayed.status === "cancelled") {
    verdict = "inconclusive";
    reason = `Replay execution was inconclusive: runner ${replayed.status} (${replayed.message ?? "no detail"}).`;
  } else if (replayed.verdict === originalVerdict) {
    verdict = "confirmed";
    reason = `Replaying the check confirmed the claimed outcome "${originalVerdict}".`;
  } else {
    verdict = "diverged";
    reason = `Replaying the check produced verdict "${replayed.verdict}", diverging from claimed "${originalVerdict}".`;
  }

  const report: ReplayReport = {
    schemaVersion: REPLAY_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    bundleId: bundle.id,
    bundleKind: bundle.kind,
    verdict,
    reason,
    original: {
      verdict: originalVerdict,
      status: originalStatus,
      message: originalMessage,
    },
    replayed,
    validation: {
      bundleBytes,
      artifactCount: bundle.artifacts.length,
      verifiedDigests: true,
    },
    limitations: [
      "Replay executes repository code in an isolated disposable copy.",
      "Confirmation means the re-execution observed the same outcome under the supplied environment.",
      ...bundle.limitations,
    ],
  };

  const parsed = replayReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new BundleValidationError(
      `Constructed replay report does not match schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
