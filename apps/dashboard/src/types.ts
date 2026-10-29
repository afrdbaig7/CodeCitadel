export type WorkspaceId = "repository" | "changes" | "verification" | "repairs";

export type SeverityLevel = "critical" | "high" | "medium" | "low" | "info";

export interface FindingItem {
  id: string;
  fingerprint: string;
  ruleId: string;
  ruleTitle: string;
  category: "security" | "quality" | "smell" | "secrets" | "correctness";
  severity: SeverityLevel;
  path: string;
  line: number;
  column: number;
  snippet?: string;
  explanation: string;
  remediation?: string;
}

export interface DiffFileChange {
  path: string;
  status: "added" | "modified" | "removed" | "unverified";
  additions: number;
  deletions: number;
  diff?: string;
}

export interface ImpactEdge {
  from: string;
  to: string;
  kind: "import" | "call" | "reexport" | "dynamic";
  chain: string[];
}

/** One changed file, the callers that reach it, and the suites that can see it. */
export interface ImpactChainItem {
  changedFile: string;
  symbol: string;
  callers: { symbol: string; file: string; line: number }[];
  testFiles: string[];
  edgeKind: ImpactEdge["kind"];
}

export interface RequirementItem {
  id: string;
  statement: string;
  status: "accepted" | "stale" | "proposed" | "rejected";
  digest: string;
  acceptedBy?: string;
  acceptedAt?: string;
  checks: {
    id: string;
    testPath: string;
    testName: string;
    fingerprint: string;
    status: "passed" | "failed" | "not_run";
  }[];
}

export interface TestResultItem {
  name: string;
  file: string;
  status: "passed" | "failed" | "timed_out" | "cancelled" | "errored" | "skipped";
  durationMs: number;
  fingerprint: string;
  errorMessage?: string;
}

export interface VerificationRunItem {
  id: string;
  capturedAt: string;
  kind: "run" | "reproduction" | "patch-verification" | "demo";
  outcome:
    | "passed"
    | "failed"
    | "verified"
    | "not_verified"
    | "reproduced"
    | "not_reproduced"
    | "inconclusive";
  /** Isolation the run's own report recorded, or "unknown" when it recorded none. */
  isolation: "source-copy" | "none" | "unknown";
  repository?: string;
  commit?: string;
  totalTests: number;
  passedCount: number;
  failedCount: number;
  durationMs: number;
  results: TestResultItem[];
}

/** A stored reproduction claim and what a fresh execution actually observed. */
export interface ReproductionItem {
  id: string;
  requirementId: string;
  title: string;
  verdict: "reproduced" | "not_reproduced" | "inconclusive";
  expected: string;
  observed: string;
  testPath: string;
  testName: string;
  fingerprint: string;
  attempts: number;
  failingAttempts: number;
}

/** A portable, digest-checked bundle of one report and its artifacts. */
export interface EvidenceBundleItem {
  id: string;
  kind: VerificationRunItem["kind"];
  reportPath: string;
  bundlePath: string;
  digest: string;
  verified: boolean;
  artifacts: { name: string; bytes: number; digest: string }[];
}

export interface PatchProposalItem {
  id: string;
  title: string;
  patchFile: string;
  diff: string;
  verdict: "verified" | "not_verified" | "inconclusive" | "not_applied";
  weakeningSignals: {
    kind: "suppressed-diagnostics" | "skipped-test" | "dropped-assertions" | "altered-requirements";
    location: string;
    message: string;
  }[];
  comparison: {
    fixed: number;
    stillPassing: number;
    newlyFailing: number;
    stillFailing: number;
  };
  /** Per-test before/after evidence behind the comparison counts. */
  transitions: {
    name: string;
    file: string;
    fingerprint: string;
    before: TestResultItem["status"];
    after: TestResultItem["status"];
  }[];
}
