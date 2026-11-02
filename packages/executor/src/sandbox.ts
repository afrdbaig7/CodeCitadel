import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Sandboxing policy and threat model enforcement for managed execution.
 * Follows PROJECT_SPEC.md Section 14 and Section 24.1.
 */

export interface SandboxPolicy {
  /** Enforces execution under a non-root unprivileged identity. */
  readonly runAsNonRoot: boolean;
  /** Dropped Linux/container capabilities. */
  readonly dropCapabilities: readonly string[];
  /** Prohibit mounting or access to host Docker daemon socket. */
  readonly disallowDockerSocket: boolean;
  /** Prohibit access to cloud metadata IP (169.254.169.254). */
  readonly blockCloudMetadata: boolean;
  /** Network access policy for the sandbox container. */
  readonly networkAccess: "denied" | "loopback_only" | "unrestricted";
  /** Maximum memory allocation in megabytes. */
  readonly memoryLimitMb: number;
  /** Hard execution wall-clock timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum bytes permitted on standard output / error streams. */
  readonly maxOutputBytes: number;
}

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  runAsNonRoot: true,
  dropCapabilities: [
    "CAP_SYS_ADMIN",
    "CAP_NET_ADMIN",
    "CAP_NET_RAW",
    "CAP_SYS_PTRACE",
    "CAP_DAC_OVERRIDE",
    "CAP_SYS_MODULE",
  ],
  disallowDockerSocket: true,
  blockCloudMetadata: true,
  networkAccess: "denied",
  memoryLimitMb: 1024,
  timeoutMs: 60_000,
  maxOutputBytes: 128 * 1024,
};

/**
 * List of prohibited environment variable patterns that must NEVER be leaked
 * to untrusted runner execution sandboxes.
 */
const SENSITIVE_ENV_PATTERNS = [
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^DOCKER_/i,
  /^KUBERNETES_/i,
  /^DATABASE_/i,
  /^POSTGRES_/i,
  /^PG/i,
  /^SECRET/i,
  /^TOKEN/i,
  /^KEY/i,
  /^AUTH/i,
  /^SSH_/i,
  /^OIDC_/i,
  /^GITHUB_TOKEN/i,
];

/**
 * Strips all sensitive host credentials and cloud tokens, returning an isolated
 * environment dictionary conforming to the sandbox security boundary.
 */
export function buildSandboxedEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  explicitAllowList: readonly string[] = [],
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  // Standard safe system variables
  const safeKeys = new Set([
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_ENV",
  ]);

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;

    // Reject Docker socket paths
    if (
      value.includes("docker.sock") ||
      value.includes("pipe/docker_engine") ||
      key.toUpperCase() === "DOCKER_HOST"
    ) {
      continue;
    }

    // Check if key is sensitive
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive && !explicitAllowList.includes(key)) {
      continue;
    }

    if (safeKeys.has(key) || explicitAllowList.includes(key)) {
      sanitized[key] = value;
    }
  }

  // Explicitly mark execution as unprivileged sandbox
  sanitized["CODECITADEL_SANDBOX"] = "1";
  sanitized["CODECITADEL_MANAGED"] = "1";

  return sanitized;
}

/**
 * Supervisor result channel validator. Untrusted stdout cannot instruct the
 * control plane; only valid schema-conformant reports and digests are accepted.
 */
export interface ResultChannelArtifact {
  readonly name: string;
  readonly digest: string;
  readonly bytes: Buffer;
}

export function validateSandboxArtifact(
  name: string,
  content: Buffer,
): ResultChannelArtifact {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Invalid sandbox artifact name: "${name}".`);
  }
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return {
    name,
    digest,
    bytes: content,
  };
}
