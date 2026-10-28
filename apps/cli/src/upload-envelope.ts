import path from "node:path";

import {
  artifactNameSchema,
  reportKindSchema,
  reportSchemaFor,
  type CodeCitadelReport,
  type ExecutionComparison,
  type ReportKind,
  type SnapshotDiff,
} from "@codecitadel/contracts";

import { UsageError } from "./errors.js";

/**
 * The report kinds the control plane accepts. Inference tries every one of them
 * and requires exactly one match: the report contracts are strict, so a document
 * that satisfies two of them is a contract question for a human, not something
 * for this command to guess at.
 */
export const REPORT_KINDS: readonly ReportKind[] = reportKindSchema.options;

/** What the API needs to know about a report that the report itself can answer. */
export interface ReportIdentity {
  /** When the evidence was captured, taken from the report's own timestamp. */
  capturedAt: string | null;
  /** The report's root, or null when no root could be read from it. */
  root: string | null;
}

/** One zod issue, without importing zod's types into this package. */
interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

function describeIssue(issue: Issue | undefined): string {
  if (issue === undefined) {
    return "invalid document";
  }
  const location = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `${location}: ${issue.message}`;
}

/**
 * Refuses a report that does not satisfy the named kind's contract. The server
 * runs the same check, so this is the first of two gates, not the only one.
 */
export function assertReportKind(kind: ReportKind, report: unknown, source: string): void {
  const parsed = reportSchemaFor(kind).safeParse(report);
  if (!parsed.success) {
    throw new UsageError(
      `${source} does not match the ${kind} report contract${describeIssue(parsed.error.issues[0])}.`,
    );
  }
}

/**
 * Which contract this file is.
 *
 * An explicit `--kind` is honoured only when the file actually satisfies that
 * contract, so the flag relabels nothing: it selects between contracts that
 * already match, or surfaces the exact field that fails.
 */
export function inferReportKind(
  report: unknown,
  declared: string | undefined,
  source: string,
): ReportKind {
  const explicit = declared?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!(REPORT_KINDS as readonly string[]).includes(explicit)) {
      throw new UsageError(
        `--kind must be one of ${REPORT_KINDS.join(", ")}, received "${explicit}".`,
      );
    }
    const kind = explicit as ReportKind;
    assertReportKind(kind, report, source);
    return kind;
  }

  const matches = REPORT_KINDS.filter((kind) => reportSchemaFor(kind).safeParse(report).success);
  const [only] = matches;
  if (only !== undefined && matches.length === 1) {
    return only;
  }
  if (matches.length === 0) {
    throw new UsageError(
      `${source} matches none of the ${REPORT_KINDS.length} report contracts this build knows ` +
        `(${REPORT_KINDS.join(", ")}). Pass --kind <kind> to see the first field that does not match.`,
    );
  }
  throw new UsageError(
    `${source} matches more than one report contract (${matches.join(", ")}). ` +
      "Pass --kind <kind> to say which one it is.",
  );
}

/**
 * The report's own capture time and root.
 *
 * Six of the eight contracts carry both at the top level. `scan` nests them under
 * `scope`, `diff` under `head`, and a comparison under `after`, so those three
 * are read explicitly; the default reads the top-level pair. A kind whose
 * contract has neither yields nulls, and the command asks the operator for the
 * repository name instead of inventing one.
 */
export function reportIdentity(kind: ReportKind, report: unknown): ReportIdentity {
  switch (kind) {
    case "scan": {
      const scan = report as CodeCitadelReport;
      return { capturedAt: scan.generatedAt, root: scan.scope.root };
    }
    case "diff": {
      const diff = report as SnapshotDiff;
      return { capturedAt: diff.head.generatedAt, root: diff.head.root };
    }
    case "comparison": {
      const comparison = report as ExecutionComparison;
      return { capturedAt: comparison.generatedAt, root: comparison.after.root };
    }
    default: {
      const document = report as { generatedAt?: unknown; root?: unknown };
      return {
        capturedAt: typeof document.generatedAt === "string" ? document.generatedAt : null,
        root: typeof document.root === "string" ? document.root : null,
      };
    }
  }
}

/**
 * The repository name for a report root. The root is an absolute path, so the
 * last segment is the directory the checks ran in — a name the operator can
 * recognise, not an identity. Commit and branch are supplied explicitly, because
 * a report does not record them.
 */
export function repositoryName(root: string | null): string | null {
  if (root === null) {
    return null;
  }
  const segments = root.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  const name = segments[segments.length - 1];
  return name === undefined ? null : name;
}

/**
 * The name an artifact is stored under. The contract's rule is enforced rather
 * than sanitised: a renamed artifact would not be the file the operator named,
 * and the server would refuse it anyway.
 */
export function artifactName(file: string): string {
  const name = path.basename(file);
  if (!artifactNameSchema.safeParse(name).success) {
    throw new UsageError(
      `The artifact ${file} would be stored as "${name}", which is not a portable artifact name. ` +
        "Use 1 to 64 characters from a-z, 0-9, dot, dash, or underscore, starting with a letter or digit.",
    );
  }
  return name;
}
