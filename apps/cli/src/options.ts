import { severitySchema, type Severity } from "@codecitadel/contracts";
import { ENVIRONMENT_NAME_PATTERN, MAX_PASSTHROUGH_ENV } from "@codecitadel/executor";

import { UsageError } from "./errors.js";

/** A policy threshold: fail at or above this severity, or never. */
export type FailOn = Severity | "none";

const CHOICES = "critical, high, medium, low, info, none";

/**
 * `--fail-on` is parsed the same way by every command that gates on findings.
 * The caller supplies the default because `scan` and `diff` deliberately differ:
 * a scan is a gate, a comparison is an explanation unless asked to gate.
 */
export function parseFailOn(value: string | undefined, fallback: FailOn): FailOn {
  const raw = value ?? fallback;
  if (raw === "none") {
    return "none";
  }
  const parsed = severitySchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`--fail-on must be one of ${CHOICES}; received "${raw}".`);
  }
  return parsed.data;
}

/**
 * `--env` names variables; it never carries values.
 *
 * The executor copies them from this process, so a resource the check needs (a
 * demo database URL, say) reaches the runner without a secret being typed onto a
 * command line or written into a report, and a typo is an error instead of a
 * check that quietly ran without what it needed.
 */
export function parseEnvNames(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const names = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
  if (names.length > MAX_PASSTHROUGH_ENV) {
    throw new UsageError(
      `--env accepts at most ${MAX_PASSTHROUGH_ENV} variable names, received ${names.length}.`,
    );
  }
  for (const name of names) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new UsageError(
        `--env received ${JSON.stringify(name)}, which is not an environment variable name: use letters, digits, and underscores, starting with a letter or underscore.`,
      );
    }
  }
  return names;
}

/**
 * Refuses to run when a named variable is not set for this process.
 *
 * Forwarding an unset name would let the check fail on a connection error, which
 * reads as a `failed` check and therefore as reproduced or newly passing
 * evidence. The refusal keeps a setup problem from becoming a result.
 */
export function requireEnvNamesSet(names: readonly string[]): void {
  const unset = names.filter((name) => process.env[name] === undefined);
  if (unset.length > 0) {
    throw new UsageError(
      `--env names ${unset.join(", ")}, but ${unset.length === 1 ? "it is" : "they are"} not set in this process. ` +
        "Set the variable before running, or leave it out of --env if the check does not need it.",
    );
  }
}
