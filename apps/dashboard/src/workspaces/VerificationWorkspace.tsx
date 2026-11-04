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
  passed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, tone: "text-[#245836]", label: "passed" },
  failed: { icon: <XCircle className="h-3.5 w-3.5" />, tone: "text-[#9e331c]", label: "failed" },
  timed_out: { icon: <TimerOff className="h-3.5 w-3.5" />, tone: "text-[#8e5812]", label: "timed out" },
  errored: { icon: <AlertOctagon className="h-3.5 w-3.5" />, tone: "text-[#9c4c1d]", label: "errored" },
  cancelled: { icon: <MinusCircle className="h-3.5 w-3.5" />, tone: "text-stone-400", label: "cancelled" },
  skipped: { icon: <MinusCircle className="h-3.5 w-3.5" />, tone: "text-stone-400", label: "skipped" },
};

const OUTCOME_TONE: Record<VerificationRunItem["outcome"], string> = {
  passed: "text-[#245836]",
  verified: "text-[#245836]",
  reproduced: "text-[#275373]",
  failed: "text-[#9e331c]",
  not_verified: "text-[#9e331c]",
  not_reproduced: "text-[#9e331c]",
  inconclusive: "text-[#8e5812]",
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
      ? "border-[#c5dbe8] bg-[#eef4f8] text-[#25506f]"
      : reproduction.verdict === "not_reproduced"
        ? "border-[#f4c6bd] bg-[#fcf0ed] text-[#932c18]"
        : "border-[#edd7b0] bg-[#fdf7ee] text-[#8c5813]";

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="cream-panel max-h-[34rem] overflow-auto rounded-xl shadow-card">
          <div className="sticky top-0 flex items-center justify-between border-b border-[#eae1d3] bg-[#faf7f0] px-4 py-3 backdrop-blur">
            <h2 className="text-sm font-semibold text-stone-900">Stored runs</h2>
            <span className="rounded bg-[#f0e9dc] px-2 py-0.5 font-mono text-[10px] text-stone-700">
              {source}
            </span>
          </div>
          <ul className="divide-y divide-[#ede6d8] bg-white">
            {runs.map((run) => {
              const active = selected?.id === run.id;
              return (
                <li key={run.id}>
                  <button
                    onClick={() => setSelectedId(run.id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      active ? "bg-[#f5ede0]" : "hover:bg-[#faf6ee]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-stone-900 font-medium">{run.id}</span>
                      <span className={`text-[10px] font-semibold uppercase ${OUTCOME_TONE[run.outcome]}`}>
                        {run.outcome}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center space-x-2 text-[10px] text-stone-500">
                      <span className="rounded bg-[#f2ecde] px-1.5 py-0.5 font-mono text-stone-700">{run.kind}</span>
                      {run.repository !== undefined && <span>{run.repository}</span>}
                      <span>{new Date(run.capturedAt).toLocaleString()}</span>
                    </div>
                  </button>
                </li>
              );
            })}
            {runs.length === 0 && <li className="p-4 text-xs text-stone-500">No runs have been uploaded.</li>}
          </ul>
        </div>

        <div className="cream-panel rounded-xl shadow-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eae1d3] bg-[#faf7f0] px-4 py-3">
            <div className="flex items-center space-x-2">
              <TestTube2 className="h-4 w-4 text-[#2d5c3d]" />
              <h2 className="text-sm font-semibold text-stone-900">Execution console</h2>
              {selected !== null && (
                <span className="font-mono text-[10px] text-stone-500">
                  isolation {selected.isolation} · {formatDuration(selected.durationMs)}
                </span>
              )}
            </div>
            {selected !== null && selected.results.length > 0 && (
              <div className="flex items-center space-x-3 font-mono text-[11px]">
                <span className="text-[#255b37] font-semibold">{selected.passedCount} passed</span>
                <span className="text-[#9c341f] font-semibold">{selected.failedCount} not passed</span>
                <span className="text-stone-500">{selected.totalTests} total</span>
              </div>
            )}
          </div>

          {loading && (
            <div className="flex items-center space-x-2 p-6 text-xs text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin text-[#2d5c3d]" />
              <span>Reading the stored report…</span>
            </div>
          )}
          {detailError !== null && <p className="p-6 text-xs text-[#8c5813]">{detailError}</p>}

          {!loading && selected !== null && results.length === 0 && (
            <div className="p-6 text-xs leading-relaxed text-stone-500 bg-white">
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
            <div className="max-h-[26rem] overflow-auto bg-white">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[#f7f3eb] text-[10px] uppercase tracking-wider text-stone-500 border-b border-[#eae1d3]">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Test</th>
                    <th className="px-4 py-2 font-semibold">Fingerprint</th>
                    <th className="px-4 py-2 font-semibold">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => {
                    const style = STATUS_STYLE[result.status];
                    return (
                      <tr key={`${result.fingerprint}:${result.name}`} className="border-t border-[#f0ebe0]">
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center space-x-1 ${style.tone}`}>
                            {style.icon}
                            <span className="text-[10px] font-semibold uppercase">{style.label}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="text-stone-900 font-medium">{result.name}</div>
                          <div className="font-mono text-[10px] text-stone-500">{result.file}</div>
                          {result.errorMessage !== undefined && (
                            <pre className="mt-1 max-w-2xl whitespace-pre-wrap rounded border border-[#f5c6be] bg-[#fdf2ef] p-2 font-mono text-[10px] text-[#8e2916]">
                              {result.errorMessage}
                            </pre>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-stone-500">{result.fingerprint}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center space-x-2">
                            <span className="w-12 font-mono text-[10px] text-stone-500">
                              {formatDuration(result.durationMs)}
                            </span>
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#ebe4d6]">
                              <div
                                className={`h-full rounded-full ${result.status === "passed" ? "bg-[#2f6542]" : "bg-[#a6341f]"}`}
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
        <div className="cream-panel rounded-xl p-5 shadow-card bg-white">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Repeat className="h-4 w-4 text-[#265775]" />
              <h2 className="text-sm font-semibold text-stone-900">Reproduction inspector</h2>
            </div>
            <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${reproductionTone}`}>
              {reproduction.verdict.replace("_", " ")}
            </span>
          </div>
          <h3 className="font-mono text-[11px] text-[#285737] font-semibold">{reproduction.id}</h3>
          <p className="mt-1 text-xs leading-relaxed text-stone-700">{reproduction.title}</p>

          <dl className="mt-4 space-y-3 text-xs">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">Expected</dt>
              <dd className="mt-0.5 text-stone-800">{reproduction.expected}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">Observed</dt>
              <dd className="mt-0.5 text-stone-800">{reproduction.observed}</dd>
            </div>
            <div className="flex items-center space-x-4 text-[11px] text-stone-600">
              <span>
                attempts <span className="font-mono font-semibold text-stone-800">{reproduction.attempts}</span>
              </span>
              <span>
                failing <span className="font-mono font-semibold text-[#9e331c]">{reproduction.failingAttempts}</span>
              </span>
              <span>
                requirement <span className="font-mono font-semibold text-[#285737]">{reproduction.requirementId}</span>
              </span>
            </div>
          </dl>

          <div className="mt-4 border-t border-[#ede7db] pt-3 font-mono text-[10px] text-stone-500">
            <div>{reproduction.testPath}</div>
            <div className="text-stone-700">{reproduction.testName}</div>
            <div className="mt-1 flex items-center space-x-1 text-stone-400">
              <Fingerprint className="h-3 w-3" />
              <span>{reproduction.fingerprint}</span>
            </div>
          </div>
          {reproduction.verdict === "inconclusive" && (
            <p className="mt-3 flex items-start space-x-1.5 rounded border border-[#edd7b0] bg-[#fdf7ee] p-2 text-[11px] text-[#8c5813]">
              <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Nothing was established: the run errored, timed out, or reported no result for the named test. That is
                not a reproduction and not a fix.
              </span>
            </p>
          )}
        </div>

        <div className="cream-panel rounded-xl p-5 shadow-card bg-white">
          <div className="mb-3 flex items-center space-x-2">
            <FileArchive className="h-4 w-4 text-[#2d5c3d]" />
            <h2 className="text-sm font-semibold text-stone-900">Evidence bundles</h2>
          </div>
          <div className="space-y-3">
            {bundles.map((bundle) => (
              <div key={bundle.id} className="cream-card rounded-lg p-3 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-stone-900 font-semibold">{bundle.id}</span>
                  <span
                    className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      bundle.verified
                        ? "border-[#cae2cf] bg-[#edf6ef] text-[#1e5430]"
                        : "border-[#f5c6bd] bg-[#fdf0ed] text-[#932c18]"
                    }`}
                  >
                    {bundle.verified ? "digest verified" : "digest mismatch"}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[10px] text-stone-500">{bundle.kind}</div>
                <div className="mt-2 space-y-1 font-mono text-[10px] text-stone-600">
                  <div>report {bundle.reportPath}</div>
                  <div>bundle {bundle.bundlePath}</div>
                  <div className="truncate">sha256 {bundle.digest.replace("sha256:", "")}</div>
                </div>
                {bundle.artifacts.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-[#ede7db] pt-2">
                    {bundle.artifacts.map((artifact) => (
                      <li key={artifact.name} className="flex items-center justify-between font-mono text-[10px]">
                        <span className="text-stone-700">{artifact.name}</span>
                        <span className="text-stone-400">
                          {artifact.bytes} B · {artifact.digest}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {bundles.length === 0 && <p className="text-xs text-stone-400">No bundles have been exported.</p>}
          </div>
          <p className="mt-4 flex items-center space-x-1.5 text-[10px] text-stone-500">
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
