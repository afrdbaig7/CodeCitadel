import React from "react";
import {
  AlertOctagon,
  CheckCircle2,
  Clock,
  FileArchive,
  Fingerprint,
  Loader2,
  MinusCircle,
  Repeat,
  ShieldQuestion,
  TestTube2,
  TimerOff,
  XCircle,
} from "lucide-react";
import { fetchRunDetail, type DataSource } from "../api";
import type { EvidenceBundleItem, ReproductionItem, TestResultItem, VerificationRunItem } from "../types";

interface VerificationWorkspaceProps {
  runs: VerificationRunItem[];
  source: DataSource;
  reproduction: ReproductionItem;
  bundles: EvidenceBundleItem[];
}

const STATUS_STYLE: Record<TestResultItem["status"], { icon: React.ReactNode; tone: string; label: string }> = {
  passed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, tone: "text-emerald-300", label: "passed" },
  failed: { icon: <XCircle className="h-3.5 w-3.5" />, tone: "text-rose-300", label: "failed" },
  timed_out: { icon: <TimerOff className="h-3.5 w-3.5" />, tone: "text-amber-300", label: "timed out" },
  errored: { icon: <AlertOctagon className="h-3.5 w-3.5" />, tone: "text-orange-300", label: "errored" },
  cancelled: { icon: <MinusCircle className="h-3.5 w-3.5" />, tone: "text-slate-400", label: "cancelled" },
  skipped: { icon: <MinusCircle className="h-3.5 w-3.5" />, tone: "text-slate-400", label: "skipped" },
};

const OUTCOME_TONE: Record<VerificationRunItem["outcome"], string> = {
  passed: "text-emerald-300",
  verified: "text-emerald-300",
  reproduced: "text-sky-300",
  failed: "text-rose-300",
  not_verified: "text-rose-300",
  not_reproduced: "text-rose-300",
  inconclusive: "text-amber-300",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export const VerificationWorkspace: React.FC<VerificationWorkspaceProps> = ({
  runs,
  source,
  reproduction,
  bundles,
}) => {
  const [selectedId, setSelectedId] = React.useState<string | null>(runs[0]?.id ?? null);
  const [details, setDetails] = React.useState<Record<string, VerificationRunItem>>({});
  const [loading, setLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);

  const selected = React.useMemo(() => {
    const base = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
    if (base === null) return null;
    // A stored report's per-test detail is fetched on demand; the list row alone
    // carries no results, so nothing is invented here.
    return details[base.id] ?? base;
  }, [runs, selectedId, details]);

  React.useEffect(() => {
    const base = runs.find((run) => run.id === selectedId) ?? runs[0];
    if (base === undefined || source !== "server" || base.results.length > 0 || details[base.id] !== undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDetailError(null);
    void fetchRunDetail(base.id).then((detail) => {
      if (cancelled) return;
      setLoading(false);
      if (detail === null) {
        setDetailError("The server did not return a stored report for this run.");
        return;
      }
      setDetails((current) => ({ ...current, [base.id]: detail }));
    });
    return () => {
      cancelled = true;
    };
  }, [runs, selectedId, source, details]);

  const results = selected?.results ?? [];
  const slowest = results.reduce((worst, result) => Math.max(worst, result.durationMs), 0);
  const reproductionTone =
    reproduction.verdict === "reproduced"
      ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
      : reproduction.verdict === "not_reproduced"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
        : "border-amber-500/40 bg-amber-500/10 text-amber-300";

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="glass-panel max-h-[34rem] overflow-auto rounded-xl">
          <div className="sticky top-0 flex items-center justify-between border-b border-slate-800/80 bg-slate-900/95 px-4 py-3 backdrop-blur">
            <h2 className="text-sm font-semibold text-white">Stored runs</h2>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
              {source}
            </span>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {runs.map((run) => {
              const active = selected?.id === run.id;
              return (
                <li key={run.id}>
                  <button
                    onClick={() => setSelectedId(run.id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      active ? "bg-slate-800/70" : "hover:bg-slate-800/30"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-slate-300">{run.id}</span>
                      <span className={`text-[10px] font-semibold uppercase ${OUTCOME_TONE[run.outcome]}`}>
                        {run.outcome}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center space-x-2 text-[10px] text-slate-500">
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono">{run.kind}</span>
                      {run.repository !== undefined && <span>{run.repository}</span>}
                      <span>{new Date(run.capturedAt).toLocaleString()}</span>
                    </div>
                  </button>
                </li>
              );
            })}
            {runs.length === 0 && <li className="p-4 text-xs text-slate-500">No runs have been uploaded.</li>}
          </ul>
        </div>

        <div className="glass-panel rounded-xl">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
            <div className="flex items-center space-x-2">
              <TestTube2 className="h-4 w-4 text-citadel-400" />
              <h2 className="text-sm font-semibold text-white">Execution console</h2>
              {selected !== null && (
                <span className="font-mono text-[10px] text-slate-500">
                  isolation {selected.isolation} · {formatDuration(selected.durationMs)}
                </span>
              )}
            </div>
            {selected !== null && selected.results.length > 0 && (
              <div className="flex items-center space-x-3 font-mono text-[11px]">
                <span className="text-emerald-400">{selected.passedCount} passed</span>
                <span className="text-rose-400">{selected.failedCount} not passed</span>
                <span className="text-slate-500">{selected.totalTests} total</span>
              </div>
            )}
          </div>

          {loading && (
            <div className="flex items-center space-x-2 p-6 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Reading the stored report…</span>
            </div>
          )}
          {detailError !== null && <p className="p-6 text-xs text-amber-300">{detailError}</p>}

          {!loading && selected !== null && results.length === 0 && (
            <div className="p-6 text-xs leading-relaxed text-slate-500">
              <p>
                This {selected.kind} report recorded an outcome of{" "}
                <span className={`font-mono ${OUTCOME_TONE[selected.outcome]}`}>{selected.outcome}</span> but no
                per-test results.
              </p>
              <p className="mt-2">
                Per-test detail is only present for run, reproduction, and patch-verification reports. It is never
                reconstructed from the outcome.
              </p>
            </div>
          )}

          {results.length > 0 && (
            <div className="max-h-[26rem] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-900/95 text-[10px] uppercase tracking-wider text-slate-500 backdrop-blur">
                  <tr>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Test</th>
                    <th className="px-4 py-2 font-medium">Fingerprint</th>
                    <th className="px-4 py-2 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => {
                    const style = STATUS_STYLE[result.status];
                    return (
                      <tr key={`${result.fingerprint}:${result.name}`} className="border-t border-slate-800/50">
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center space-x-1 ${style.tone}`}>
                            {style.icon}
                            <span className="text-[10px] font-semibold uppercase">{style.label}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="text-slate-200">{result.name}</div>
                          <div className="font-mono text-[10px] text-slate-500">{result.file}</div>
                          {result.errorMessage !== undefined && (
                            <pre className="mt-1 max-w-2xl whitespace-pre-wrap rounded border border-rose-500/20 bg-rose-500/5 p-2 font-mono text-[10px] text-rose-200">
                              {result.errorMessage}
                            </pre>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{result.fingerprint}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center space-x-2">
                            <span className="w-12 font-mono text-[10px] text-slate-400">
                              {formatDuration(result.durationMs)}
                            </span>
                            <div className="h-1 w-20 overflow-hidden rounded-full bg-slate-800">
                              <div
                                className={`h-full rounded-full ${result.status === "passed" ? "bg-emerald-400" : "bg-rose-400"}`}
                                style={{ width: `${slowest === 0 ? 0 : Math.max(4, (result.durationMs / slowest) * 100)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="glass-panel rounded-xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Repeat className="h-4 w-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-white">Reproduction inspector</h2>
            </div>
            <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${reproductionTone}`}>
              {reproduction.verdict.replace("_", " ")}
            </span>
          </div>
          <h3 className="font-mono text-[11px] text-citadel-300">{reproduction.id}</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-300">{reproduction.title}</p>

          <dl className="mt-4 space-y-3 text-xs">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">Expected</dt>
              <dd className="mt-0.5 text-slate-300">{reproduction.expected}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">Observed</dt>
              <dd className="mt-0.5 text-slate-300">{reproduction.observed}</dd>
            </div>
            <div className="flex items-center space-x-4 text-[11px] text-slate-400">
              <span>
                attempts <span className="font-mono text-slate-200">{reproduction.attempts}</span>
              </span>
              <span>
                failing <span className="font-mono text-rose-300">{reproduction.failingAttempts}</span>
              </span>
              <span>
                requirement <span className="font-mono text-citadel-300">{reproduction.requirementId}</span>
              </span>
            </div>
          </dl>

          <div className="mt-4 border-t border-slate-800 pt-3 font-mono text-[10px] text-slate-500">
            <div>{reproduction.testPath}</div>
            <div className="text-slate-400">{reproduction.testName}</div>
            <div className="mt-1 flex items-center space-x-1">
              <Fingerprint className="h-3 w-3" />
              <span>{reproduction.fingerprint}</span>
            </div>
          </div>
          {reproduction.verdict === "inconclusive" && (
            <p className="mt-3 flex items-start space-x-1.5 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200">
              <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Nothing was established: the run errored, timed out, or reported no result for the named test. That is
                not a reproduction and not a fix.
              </span>
            </p>
          )}
        </div>

        <div className="glass-panel rounded-xl p-5">
          <div className="mb-3 flex items-center space-x-2">
            <FileArchive className="h-4 w-4 text-citadel-400" />
            <h2 className="text-sm font-semibold text-white">Evidence bundles</h2>
          </div>
          <div className="space-y-3">
            {bundles.map((bundle) => (
              <div key={bundle.id} className="glass-card rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-slate-200">{bundle.id}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      bundle.verified
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                    }`}
                  >
                    {bundle.verified ? "digest verified" : "digest mismatch"}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[10px] text-slate-500">{bundle.kind}</div>
                <div className="mt-2 space-y-1 font-mono text-[10px] text-slate-400">
                  <div>report {bundle.reportPath}</div>
                  <div>bundle {bundle.bundlePath}</div>
                  <div className="truncate">sha256 {bundle.digest.replace("sha256:", "")}</div>
                </div>
                {bundle.artifacts.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2">
                    {bundle.artifacts.map((artifact) => (
                      <li key={artifact.name} className="flex items-center justify-between font-mono text-[10px]">
                        <span className="text-slate-300">{artifact.name}</span>
                        <span className="text-slate-500">
                          {artifact.bytes} B · {artifact.digest}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {bundles.length === 0 && <p className="text-xs text-slate-500">No bundles have been exported.</p>}
          </div>
          <p className="mt-4 flex items-center space-x-1.5 text-[10px] text-slate-500">
            <Clock className="h-3 w-3" />
            <span>
              A bundle records a claim. Replaying it re-obtains the result; the digest only proves the bytes are the
              ones that were exported.
            </span>
          </p>
        </div>
      </section>
    </div>
  );
};
