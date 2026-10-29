import React from "react";
import { AlertTriangle, ShieldAlert, ShieldCheck, Filter, Fingerprint, MapPin, Wrench } from "lucide-react";
import type { DataSource } from "../api";
import type { FindingItem, SeverityLevel } from "../types";

interface RepositoryWorkspaceProps {
  findings: FindingItem[];
  source: DataSource;
}

const SEVERITY_ORDER: SeverityLevel[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_WEIGHT: Record<SeverityLevel, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0,
};

const SEVERITY_STYLE: Record<SeverityLevel, string> = {
  critical: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  high: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  low: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  info: "bg-slate-500/15 text-slate-300 border-slate-500/40",
};

const CATEGORIES = ["all", "security", "secrets", "quality", "smell", "correctness"] as const;
type CategoryFilter = (typeof CATEGORIES)[number];

/**
 * A single 0–100 number, derived from the findings on screen with fixed weights.
 * It is a reading aid, not a score from the engine: the engine reports findings,
 * and this file is the only place that turns them into a grade.
 */
export function qualityScore(findings: FindingItem[]): number {
  const penalty = findings.reduce((total, finding) => total + SEVERITY_WEIGHT[finding.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function gradeOf(score: number): { label: string; tone: string } {
  if (score >= 90) return { label: "healthy", tone: "text-emerald-300" };
  if (score >= 75) return { label: "watch", tone: "text-lime-300" };
  if (score >= 50) return { label: "needs attention", tone: "text-amber-300" };
  return { label: "at risk", tone: "text-rose-300" };
}

export const RepositoryWorkspace: React.FC<RepositoryWorkspaceProps> = ({ findings, source }) => {
  const [category, setCategory] = React.useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(findings[0]?.id ?? null);

  const counts = React.useMemo(() => {
    const base: Record<SeverityLevel, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) base[finding.severity] += 1;
    return base;
  }, [findings]);

  const filtered = React.useMemo(
    () => (category === "all" ? findings : findings.filter((finding) => finding.category === category)),
    [findings, category],
  );

  const selected = filtered.find((finding) => finding.id === selectedId) ?? filtered[0] ?? null;
  const score = qualityScore(findings);
  const grade = gradeOf(score);

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="glass-card rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Quality health</span>
            {score >= 75 ? (
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-rose-400" />
            )}
          </div>
          <div className="mt-3 flex items-end space-x-2">
            <span className="font-mono text-5xl font-bold text-white">{score}</span>
            <span className="pb-1 text-sm text-slate-500">/ 100</span>
          </div>
          <p className={`mt-1 text-xs font-medium ${grade.tone}`}>{grade.label}</p>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full ${score >= 75 ? "bg-emerald-400" : score >= 50 ? "bg-amber-400" : "bg-rose-400"}`}
              style={{ width: `${score}%` }}
            />
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
            Weighted from the {findings.length} findings below: critical 25, high 10, medium 4, low 1.
            {source === "preview" ? " Preview dataset." : " Live server data."}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SEVERITY_ORDER.filter((severity) => severity !== "info").map((severity) => (
            <div key={severity} className="glass-card rounded-xl p-4">
              <span className="text-[11px] uppercase tracking-wider text-slate-400">{severity}</span>
              <div className="mt-2 flex items-baseline space-x-2">
                <span className="font-mono text-3xl font-semibold text-white">{counts[severity]}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[severity]}`}
                >
                  {severity === "critical" && counts[severity] > 0 ? "act now" : "finding"}
                </span>
              </div>
            </div>
          ))}
          <div className="glass-card col-span-2 rounded-xl p-4 sm:col-span-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
              <span className="flex items-center space-x-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span>
                  {counts.critical + counts.high} findings at or above <code className="text-slate-300">high</code>{" "}
                  would fail <code className="text-slate-300">codecitadel scan --fail-on high</code>
                </span>
              </span>
              <span className="flex items-center space-x-1.5">
                <Filter className="h-3.5 w-3.5 text-slate-400" />
                <span>{counts.info} informational</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="glass-panel rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
          <div className="flex items-center space-x-2">
            <h2 className="text-sm font-semibold text-white">Findings</h2>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
              {filtered.length}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {CATEGORIES.map((item) => {
              const active = category === item;
              const number =
                item === "all" ? findings.length : findings.filter((finding) => finding.category === item).length;
              return (
                <button
                  key={item}
                  onClick={() => setCategory(item)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-citadel-500/40 bg-citadel-500/10 text-citadel-300"
                      : "border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  }`}
                >
                  {item}
                  <span className="ml-1.5 font-mono text-[10px] text-slate-500">{number}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="max-h-[30rem] overflow-auto border-slate-800/80 lg:border-r">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-900/95 text-[10px] uppercase tracking-wider text-slate-500 backdrop-blur">
                <tr>
                  <th className="px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2 font-medium">Rule</th>
                  <th className="px-4 py-2 font-medium">Location</th>
                  <th className="px-4 py-2 font-medium">Category</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((finding) => {
                  const active = selected?.id === finding.id;
                  return (
                    <tr
                      key={finding.id}
                      onClick={() => setSelectedId(finding.id)}
                      className={`cursor-pointer border-t border-slate-800/50 transition-colors ${
                        active ? "bg-slate-800/60" : "hover:bg-slate-800/30"
                      }`}
                    >
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[finding.severity]}`}
                        >
                          {finding.severity}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-200">{finding.ruleTitle}</div>
                        <div className="font-mono text-[10px] text-slate-500">{finding.ruleId}</div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">
                        {finding.path}:{finding.line}:{finding.column}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400">{finding.category}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                      No findings in this category.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="p-5">
            {selected === null ? (
              <p className="text-xs text-slate-500">Select a finding to read its rule and remediation.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center space-x-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[selected.severity]}`}
                    >
                      {selected.severity}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">{selected.category}</span>
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-white">{selected.ruleTitle}</h3>
                  <code className="text-[11px] text-citadel-400">{selected.ruleId}</code>
                </div>

                <div>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Why this is flagged</h4>
                  <p className="text-xs leading-relaxed text-slate-300">{selected.explanation}</p>
                </div>

                {selected.snippet !== undefined && (
                  <div>
                    <h4 className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Evidence</h4>
                    <pre className="overflow-auto rounded-md border border-slate-800 bg-slate-950/80 p-2 font-mono text-[11px] text-slate-300">
                      {selected.snippet}
                    </pre>
                  </div>
                )}

                {selected.remediation !== undefined && (
                  <div>
                    <h4 className="mb-1 flex items-center space-x-1 text-[10px] uppercase tracking-wider text-slate-500">
                      <Wrench className="h-3 w-3" />
                      <span>Remediation</span>
                    </h4>
                    <p className="text-xs leading-relaxed text-slate-300">{selected.remediation}</p>
                  </div>
                )}

                <dl className="space-y-1.5 border-t border-slate-800 pt-3 text-[11px]">
                  <div className="flex items-start space-x-2">
                    <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" />
                    <span className="font-mono text-slate-400">
                      {selected.path}:{selected.line}:{selected.column}
                    </span>
                  </div>
                  <div className="flex items-start space-x-2">
                    <Fingerprint className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" />
                    <span className="font-mono text-slate-400">{selected.fingerprint}</span>
                  </div>
                </dl>
              </div>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
};
