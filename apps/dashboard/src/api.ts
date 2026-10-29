import { SAMPLE_RUNS } from "./fixtures";
import type { TestResultItem, VerificationRunItem } from "./types";

/**
 * The dashboard reads the local API from the same origin when it is served by
 * `codecitadel serve`, and through the Vite proxy during `pnpm dev`. An empty
 * base URL therefore means "this origin", which keeps the session cookie
 * same-site instead of putting a bearer token in a URL.
 */
const DEFAULT_SERVER_URL = "";

export interface SystemHealth {
  status: "ok" | "degraded" | "offline";
  driver: string;
  schemaVersion: number;
  serverUrl: string;
  limitations: string[];
}

/** Where the data on screen came from: a real server, or the labeled preview set. */
export type DataSource = "server" | "preview";

export interface LoadedRuns {
  source: DataSource;
  runs: VerificationRunItem[];
}

export async function checkHealth(serverUrl = DEFAULT_SERVER_URL): Promise<SystemHealth> {
  try {
    const res = await fetch(`${serverUrl}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      status: "ok",
      driver: data.storage?.driver ?? "sqlite",
      schemaVersion: data.schemaVersion ?? 1,
      serverUrl: serverUrl || window.location.origin,
      limitations: Array.isArray(data.limitations) ? data.limitations : [],
    };
  } catch {
    return {
      status: "offline",
      driver: "unknown",
      schemaVersion: 0,
      serverUrl: serverUrl || window.location.origin,
      limitations: [],
    };
  }
}

/** A stored run row as the API returns it. Test detail lives in the report. */
interface StoredRunRow {
  id: string;
  kind: VerificationRunItem["kind"];
  outcome: string | null;
  origin?: string;
  repository: { name: string; commit: string | null; branch: string | null };
  capturedAt: string;
  receivedAt: string;
  bytes: number;
}

function repositoryOf(row: StoredRunRow): { repository?: string; commit?: string } {
  return {
    ...(row.repository?.name === undefined ? {} : { repository: row.repository.name }),
    ...(row.repository?.commit === null || row.repository?.commit === undefined
      ? {}
      : { commit: row.repository.commit }),
  };
}

function normalizeResults(report: Record<string, unknown> | null): TestResultItem[] {
  const raw = Array.isArray(report?.results)
    ? (report?.results as Record<string, unknown>[])
    : Array.isArray((report?.after as Record<string, unknown> | null)?.results)
      ? (((report?.after as Record<string, unknown>).results) as Record<string, unknown>[])
      : [];
  return raw.map((result) => ({
    name: String(result.name ?? ""),
    file: String(result.file ?? ""),
    status: (result.status as TestResultItem["status"]) ?? "errored",
    durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
    fingerprint: String(result.id ?? ""),
    errorMessage: typeof result.message === "string" && result.message !== "" ? result.message : undefined,
  }));
}

/**
 * Isolation is read from the run's own report: a test run records it under
 * `record.isolation.mode`, patch verification under `after.record`, and a
 * reproduction export under `evidence.execution.isolation`. A report that
 * records none of those stays "unknown" instead of being credited with a
 * default the run never claimed.
 */
function isolationOf(report: Record<string, unknown> | null): VerificationRunItem["isolation"] {
  const modes = [
    (report?.record as { isolation?: { mode?: unknown } } | undefined)?.isolation?.mode,
    (report?.after as { record?: { isolation?: { mode?: unknown } } } | undefined)?.record?.isolation
      ?.mode,
    (report?.evidence as { execution?: { isolation?: unknown } | null } | undefined)?.execution
      ?.isolation,
  ];
  for (const mode of modes) {
    if (mode === "source-copy" || mode === "none") return mode;
  }
  return "unknown";
}

function count(results: TestResultItem[], status: TestResultItem["status"]): number {
  return results.filter((result) => result.status === status).length;
}

/**
 * Real runs only. Nothing is invented for a report that stored no per-test
 * detail: the counts come from the report's own results, or stay at zero and
 * the workspace says so.
 */
export async function fetchRuns(serverUrl = DEFAULT_SERVER_URL): Promise<LoadedRuns> {
  try {
    const res = await fetch(`${serverUrl}/api/v1/runs`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { source: "preview", runs: SAMPLE_RUNS };
    }
    const data = (await res.json()) as { runs?: StoredRunRow[] };
    if (!Array.isArray(data.runs) || data.runs.length === 0) {
      return { source: "preview", runs: SAMPLE_RUNS };
    }
    return {
      source: "server",
      runs: data.runs.map((run) => ({
        id: run.id,
        capturedAt: run.capturedAt,
        kind: run.kind,
        outcome: (run.outcome ?? "inconclusive") as VerificationRunItem["outcome"],
        // List rows carry no report, so the detail view is where isolation is known.
        isolation: "unknown",
        ...repositoryOf(run),
        totalTests: 0,
        passedCount: 0,
        failedCount: 0,
        durationMs: 0,
        results: [],
      })),
    };
  } catch {
    return { source: "preview", runs: SAMPLE_RUNS };
  }
}

/** Fetches one stored report and normalizes its per-test results. */
export async function fetchRunDetail(
  id: string,
  serverUrl = DEFAULT_SERVER_URL,
): Promise<VerificationRunItem | null> {
  try {
    const res = await fetch(`${serverUrl}/api/v1/runs/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { run: StoredRunRow; report: Record<string, unknown> };
    const results = normalizeResults(data.report);
    const duration =
      typeof data.report.record === "object" && data.report.record !== null
        ? Number((data.report.record as { durationMs?: number }).durationMs ?? 0)
        : 0;
    return {
      id: data.run.id,
      capturedAt: data.run.capturedAt,
      kind: data.run.kind,
      outcome: (data.run.outcome ?? "inconclusive") as VerificationRunItem["outcome"],
      isolation: isolationOf(data.report),
      ...repositoryOf(data.run),
      totalTests: results.length,
      passedCount: count(results, "passed"),
      failedCount: count(results, "failed") + count(results, "timed_out") + count(results, "errored"),
      durationMs: duration,
      results,
    };
  } catch {
    return null;
  }
}
