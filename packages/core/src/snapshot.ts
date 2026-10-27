import {
  DIFF_SCHEMA_VERSION,
  SEVERITY_ORDER,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotDiffSchema,
  snapshotSchema,
  type CodeCitadelReport,
  type FileChange,
  type FileEvent,
  type Severity,
  type Snapshot,
  type SnapshotDiff,
  type SnapshotFinding,
} from "@codecitadel/contracts";

/**
 * Snapshots and diffs: what the scanner observed, and what changed between two
 * observations.
 *
 * The rule this module follows is that absence of evidence is not evidence of
 * change. A file that could not be read, a rule that did not run, or a scan that
 * stopped early never turns into "removed", "clean", or "fixed"; it becomes
 * explicitly unverified and says so in the diff's limitations.
 */

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(left: SnapshotFinding, right: SnapshotFinding): number {
  if (left.path !== right.path) {
    return comparePaths(left.path, right.path);
  }
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }
  if (left.ruleId !== right.ruleId) {
    return comparePaths(left.ruleId, right.ruleId);
  }
  return comparePaths(left.id, right.id);
}

function toSnapshotFinding(finding: CodeCitadelReport["findings"][number]): SnapshotFinding {
  return {
    id: finding.id,
    ruleId: finding.ruleId,
    severity: finding.severity,
    path: finding.location.path,
    startLine: finding.location.startLine,
  };
}

/**
 * Builds a snapshot from one completed scan.
 *
 * The file records come from the scanner stream, not from the report: the report
 * intentionally keeps only findings, while a snapshot needs the digest of every
 * file it saw so the next run can tell "unchanged" from "not looked at".
 *
 * The timestamp is the report's, so building a snapshot twice from the same
 * report is byte-identical.
 */
export function buildSnapshot(input: {
  report: CodeCitadelReport;
  files: readonly FileEvent[];
}): Snapshot {
  const byPath = new Map<string, Snapshot["files"][number]>();
  for (const file of input.files) {
    // Discovery should not emit a path twice; if it ever does, the first record
    // wins so the snapshot stays a set rather than a sequence.
    if (!byPath.has(file.path)) {
      byPath.set(file.path, {
        path: file.path,
        digest: file.digest,
        sizeBytes: file.sizeBytes,
        skipped: file.skipped,
      });
    }
  }

  const { scope, tool } = input.report;

  return snapshotSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.report.generatedAt,
    tool: {
      name: "codecitadel",
      version: tool.version,
      scannerVersion: tool.scannerVersion,
      protocol: tool.protocol,
    },
    root: scope.root,
    options: {
      maxFiles: scope.options.maxFiles,
      maxBytesPerFile: scope.options.maxBytesPerFile,
      maxTotalBytes: scope.options.maxTotalBytes,
      includeHidden: scope.options.includeHidden,
      followSymlinks: scope.options.followSymlinks,
      exclude: scope.options.exclude,
    },
    rules: scope.rules
      .map((rule) => ({ id: rule.id, version: rule.version }))
      .sort((left, right) => comparePaths(left.id, right.id)),
    files: [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path)),
    findings: input.report.findings.map(toSnapshotFinding).sort(compareFindings),
    truncated: scope.truncated,
  });
}

function change(
  kind: FileChange["kind"],
  path: string,
  base: Snapshot["files"][number] | undefined,
  head: Snapshot["files"][number] | undefined,
): FileChange {
  return {
    kind,
    path,
    baseDigest: base?.digest ?? null,
    headDigest: head?.digest ?? null,
    baseSkipped: base?.skipped ?? null,
    headSkipped: head?.skipped ?? null,
  };
}

function describeOptionDifferences(base: Snapshot, head: Snapshot): string[] {
  const differences: string[] = [];
  const fields = [
    "maxFiles",
    "maxBytesPerFile",
    "maxTotalBytes",
    "includeHidden",
    "followSymlinks",
  ] as const;
  for (const field of fields) {
    if (base.options[field] !== head.options[field]) {
      differences.push(`${field}: ${String(base.options[field])} → ${String(head.options[field])}`);
    }
  }
  // Exclusions are a set; ordering in the request is not a meaningful change.
  const baseExclude = [...base.options.exclude].sort().join("\n");
  const headExclude = [...head.options.exclude].sort().join("\n");
  if (baseExclude !== headExclude) {
    differences.push(`exclude: [${base.options.exclude.join(", ")}] → [${head.options.exclude.join(", ")}]`);
  }
  return differences;
}

/**
 * Compares two snapshots taken at different times.
 *
 * File outcomes:
 * - `added`      verified in the head snapshot, not verified in the base.
 * - `modified`   both verified, content digests differ.
 * - `removed`    verified in the base, absent from the head, head not truncated.
 * - `unverified` verified in the base, unreadable or unanalyzed in the head.
 *
 * A file that changed while unreadable in both snapshots appears in no bucket;
 * `stillUnverified` counts them so the total stays auditable.
 *
 * Finding outcomes compare the scanner's stable fingerprints:
 * - `introduced` present now, absent before.
 * - `resolved`   absent now from a file that was actually analyzed now, or from
 *                a file that no longer exists.
 * - `unverified` absent now, but the file could not be re-checked (skipped as
 *                binary, too large, or outside a truncated scope). This is not a
 *                fix and is never reported as one.
 */
export function diffSnapshots(base: Snapshot, head: Snapshot): SnapshotDiff {
  const baseByPath = new Map(base.files.map((file) => [file.path, file]));
  const headByPath = new Map(head.files.map((file) => [file.path, file]));

  const added: FileChange[] = [];
  const modified: FileChange[] = [];
  const removed: FileChange[] = [];
  const unverified: FileChange[] = [];
  let unchanged = 0;
  let stillUnverified = 0;

  for (const [path, baseFile] of baseByPath) {
    const headFile = headByPath.get(path);

    if (baseFile.digest === null) {
      // Never read in the base, so there is no baseline to compare against.
      if (headFile?.digest != null) {
        added.push(change("added", path, baseFile, headFile));
      } else {
        stillUnverified += 1;
      }
      continue;
    }

    if (headFile === undefined) {
      if (head.truncated) {
        unverified.push(change("unverified", path, baseFile, undefined));
      } else {
        removed.push(change("removed", path, baseFile, undefined));
      }
      continue;
    }

    if (headFile.digest === null) {
      unverified.push(change("unverified", path, baseFile, headFile));
      continue;
    }

    if (headFile.digest === baseFile.digest) {
      unchanged += 1;
    } else {
      modified.push(change("modified", path, baseFile, headFile));
    }
  }

  for (const [path, headFile] of headByPath) {
    if (baseByPath.has(path) || headFile.digest === null) {
      continue;
    }
    added.push(change("added", path, undefined, headFile));
  }

  const baseRules = new Map(base.rules.map((rule) => [rule.id, rule.version]));
  const headRules = new Map(head.rules.map((rule) => [rule.id, rule.version]));
  const rulesAdded = [...headRules.keys()].filter((id) => !baseRules.has(id)).sort();
  const rulesRemoved = [...baseRules.keys()].filter((id) => !headRules.has(id)).sort();
  const rulesVersionChanged = [...headRules.entries()]
    .filter(([id, version]) => baseRules.has(id) && baseRules.get(id) !== version)
    .map(([id, version]) => `${id}@${version}`)
    .sort();

  const headFindings = new Map(head.findings.map((finding) => [finding.id, finding]));
  const baseFindings = new Map(base.findings.map((finding) => [finding.id, finding]));
  const introduced = head.findings.filter((finding) => !baseFindings.has(finding.id));
  const resolved: SnapshotFinding[] = [];
  const unverifiedFindings: SnapshotFinding[] = [];
  let carriedOver = 0;

  for (const finding of base.findings) {
    if (headFindings.has(finding.id)) {
      carriedOver += 1;
      continue;
    }
    const headFile = headByPath.get(finding.path);
    const rechecked = headFile === undefined ? !head.truncated : headFile.skipped === null;
    if (rechecked) {
      resolved.push(finding);
    } else {
      unverifiedFindings.push(finding);
    }
  }

  const optionDifferences = describeOptionDifferences(base, head);

  const limitations = [
    "A snapshot is one observation. Nothing between the two snapshots was observed, so a file that changed and changed back looks identical, and a defect introduced and removed is invisible.",
    "Findings are bounded text patterns: a resolved finding means the pattern no longer matches, not that the underlying defect was proven fixed.",
    "Dependencies, generated files, and build outputs are not rebuilt or resolved, so changes that only appear after a build are outside this comparison.",
  ];
  if (unverified.length > 0) {
    limitations.push(
      `${unverified.length} file(s) were verified in the base snapshot but could not be read or analyzed in the head snapshot; their change status is unknown, not unchanged.`,
    );
  }
  if (stillUnverified > 0) {
    limitations.push(
      `${stillUnverified} file(s) could not be read in either snapshot (too large or unreadable) and were never compared.`,
    );
  }
  if (unverifiedFindings.length > 0) {
    limitations.push(
      `${unverifiedFindings.length} finding(s) from the base snapshot could not be re-checked because their file was not analyzed in the head snapshot; they are unverified, not resolved.`,
    );
  }
  if (head.truncated) {
    limitations.push(
      "The head scan was truncated by a resource limit, so files missing from it may simply be outside the scanned scope.",
    );
  }
  if (base.truncated) {
    limitations.push(
      "The base scan was truncated by a resource limit, so the baseline never covered the whole tree.",
    );
  }
  if (rulesAdded.length > 0 || rulesRemoved.length > 0 || rulesVersionChanged.length > 0) {
    limitations.push(
      "The enabled rules differ between the two snapshots, so introduced and resolved findings may reflect configuration rather than code.",
    );
  }
  if (optionDifferences.length > 0) {
    limitations.push(
      "The coverage options differ between the two snapshots, so added and removed files may reflect scan scope rather than repository changes.",
    );
  }
  if (base.root !== head.root) {
    limitations.push(
      "The snapshots were taken from different roots; relative paths are compared as-is and may not refer to the same files.",
    );
  }

  return snapshotDiffSchema.parse({
    schemaVersion: DIFF_SCHEMA_VERSION,
    base: {
      generatedAt: base.generatedAt,
      root: base.root,
      scannerVersion: base.tool.scannerVersion,
      files: base.files.length,
      findings: base.findings.length,
      truncated: base.truncated,
    },
    head: {
      generatedAt: head.generatedAt,
      root: head.root,
      scannerVersion: head.tool.scannerVersion,
      files: head.files.length,
      findings: head.findings.length,
      truncated: head.truncated,
    },
    files: {
      added: added.sort((left, right) => comparePaths(left.path, right.path)),
      modified: modified.sort((left, right) => comparePaths(left.path, right.path)),
      removed: removed.sort((left, right) => comparePaths(left.path, right.path)),
      unverified: unverified.sort((left, right) => comparePaths(left.path, right.path)),
      unchanged,
      stillUnverified,
    },
    rules: {
      added: rulesAdded,
      removed: rulesRemoved,
      versionChanged: rulesVersionChanged,
      changed:
        rulesAdded.length > 0 || rulesRemoved.length > 0 || rulesVersionChanged.length > 0,
    },
    options: { changed: optionDifferences.length > 0, differences: optionDifferences },
    findings: {
      introduced: introduced.sort(compareFindings),
      resolved: resolved.sort(compareFindings),
      unverified: unverifiedFindings.sort(compareFindings),
      carriedOver,
    },
    limitations,
  });
}

/** Findings introduced by a change, at or above a severity threshold. */
export function introducedAtOrAbove(diff: SnapshotDiff, threshold: Severity): SnapshotFinding[] {
  const limit = SEVERITY_ORDER.indexOf(threshold);
  if (limit < 0) {
    return [];
  }
  return diff.findings.introduced.filter(
    (finding) => SEVERITY_ORDER.indexOf(finding.severity) <= limit,
  );
}
