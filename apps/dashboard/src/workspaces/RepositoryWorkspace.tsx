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
  critical: "bg-[#fcf0ed] text-[#932c18] border-[#f4c6bd]",
  high: "bg-[#fdf4ed] text-[#9c4c1e] border-[#f6d0b9]",
  medium: "bg-[#fef8eb] text-[#8e580e] border-[#f2dda9]",
  low: "bg-[#edf4f7] text-[#2b5571] border-[#c7dce9]",
  info: "bg-[#f3f0e8] text-[#5c5448] border-[#ddd7ca]",
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
  if (score >= 90) return { label: "healthy", tone: "text-[#285c39]" };
  if (score >= 75) return { label: "watch", tone: "text-[#3e6840]" };
  if (score >= 50) return { label: "needs attention", tone: "text-[#8e580e]" };
  return { label: "at risk", tone: "text-[#932c18]" };
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
        <div className="cream-card rounded-xl p-5 shadow-card">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">Quality health</span>
            {score >= 75 ? (
              <ShieldCheck className="h-4 w-4 text-[#2e6240]" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-[#a33520]" />
            )}
          </div>
          <div className="mt-3 flex items-end space-x-2">
            <span className="font-mono text-5xl font-bold text-stone-900">{score}</span>
            <span className="pb-1 text-sm text-stone-400">/ 100</span>
          </div>
          <p className={`mt-1 text-xs font-semibold ${grade.tone}`}>{grade.label}</p>
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-[#ebe4d6]">
            <div
              className={`h-full rounded-full transition-all ${score >= 75 ? "bg-[#2f6542]" : score >= 50 ? "bg-[#b37418]" : "bg-[#a33520]"}`}
              style={{ width: `${score}%` }}
            />
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-stone-500">
            Weighted from the {findings.length} findings below: critical 25, high 10, medium 4, low 1.
            {source === "preview" ? " Preview dataset." : " Live server data."}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SEVERITY_ORDER.filter((severity) => severity !== "info").map((severity) => (
            <div key={severity} className="cream-card rounded-xl p-4 shadow-card">
              <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">{severity}</span>
              <div className="mt-2 flex items-baseline space-x-2">
                <span className="font-mono text-3xl font-semibold text-stone-900">{counts[severity]}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[severity]}`}
                >
                  {severity === "critical" && counts[severity] > 0 ? "act now" : "finding"}
                </span>
              </div>
            </div>
          ))}
          <div className="cream-card col-span-2 rounded-xl p-4 sm:col-span-4 shadow-card">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-stone-600">
              <span className="flex items-center space-x-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-[#b06f15]" />
                <span>
                  {counts.critical + counts.high} findings at or above <code className="text-stone-800 font-medium">high</code>{" "}
                  would fail <code className="text-stone-800 font-medium">codecitadel scan --fail-on high</code>
                </span>
              </span>
              <span className="flex items-center space-x-1.5">
                <Filter className="h-3.5 w-3.5 text-stone-400" />
                <span>{counts.info} informational</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="cream-panel rounded-xl shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eae2d4] bg-[#faf7f1] px-5 py-3">
          <div className="flex items-center space-x-2">
            <h2 className="text-sm font-semibold text-stone-900">Findings</h2>
            <span className="rounded bg-[#f0e9dc] px-2 py-0.5 font-mono text-[11px] text-stone-700">
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
                      ? "border-[#cfc2aa] bg-white text-stone-900 font-semibold shadow-sm"
                      : "border-[#e6decb] bg-[#faf6ee] text-stone-600 hover:border-[#d4c9b3] hover:text-stone-900"
                  }`}
                >
                  {item}
                  <span className="ml-1.5 font-mono text-[10px] text-stone-400">{number}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="max-h-[30rem] overflow-auto border-[#eae2d4] lg:border-r">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#f7f3eb] text-[10px] uppercase tracking-wider text-stone-500 border-b border-[#eae2d4]">
                <tr>
                  <th className="px-4 py-2 font-semibold">Severity</th>
                  <th className="px-4 py-2 font-semibold">Rule</th>
                  <th className="px-4 py-2 font-semibold">Location</th>
                  <th className="px-4 py-2 font-semibold">Category</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((finding) => {
                  const active = selected?.id === finding.id;
                  return (
                    <tr
                      key={finding.id}
                      onClick={() => setSelectedId(finding.id)}
                      className={`cursor-pointer border-t border-[#f0ebdff0] transition-colors ${
                        active ? "bg-[#f5eee1]" : "hover:bg-[#fbf8f2]"
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
                        <div className="font-semibold text-stone-900">{finding.ruleTitle}</div>
                        <div className="font-mono text-[10px] text-stone-500">{finding.ruleId}</div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-stone-600">
                        {finding.path}:{finding.line}:{finding.column}
                      </td>
                      <td className="px-4 py-2.5 text-stone-600">{finding.category}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-stone-400">
                      No findings in this category.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="p-5 bg-white">
            {selected === null ? (
              <p className="text-xs text-stone-500">Select a finding to read its rule and remediation.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center space-x-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[selected.severity]}`}
                    >
                      {selected.severity}
                    </span>
                    <span className="font-mono text-[10px] text-stone-400">{selected.category}</span>
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-stone-900">{selected.ruleTitle}</h3>
                  <code className="text-[11px] text-[#2d5c3d] font-semibold">{selected.ruleId}</code>
                </div>

                <div>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wider text-stone-500 font-semibold">Why this is flagged</h4>
                  <p className="text-xs leading-relaxed text-stone-700">{selected.explanation}</p>
                </div>

                {selected.snippet !== undefined && (
                  <div>
                    <h4 className="mb-1 text-[10px] uppercase tracking-wider text-stone-500 font-semibold">Evidence</h4>
                    <pre className="overflow-auto rounded-md border border-[#e5ded0] bg-[#faf7f0] p-2.5 font-mono text-[11px] text-stone-800">
                      {selected.snippet}
                    </pre>
                  </div>
                )}

                {selected.remediation !== undefined && (
                  <div>
                    <h4 className="mb-1 flex items-center space-x-1 text-[10px] uppercase tracking-wider text-stone-500 font-semibold">
                      <Wrench className="h-3 w-3 text-[#2d5c3d]" />
                      <span>Remediation</span>
                    </h4>
                    <p className="text-xs leading-relaxed text-stone-700">{selected.remediation}</p>
                  </div>
                )}

                <dl className="space-y-1.5 border-t border-[#ede7db] pt-3 text-[11px]">
                  <div className="flex items-start space-x-2">
                    <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-stone-400" />
                    <span className="font-mono text-stone-600">
                      {selected.path}:{selected.line}:{selected.column}
                    </span>
                  </div>
                  <div className="flex items-start space-x-2">
                    <Fingerprint className="mt-0.5 h-3 w-3 shrink-0 text-stone-400" />
                    <span className="font-mono text-stone-500">{selected.fingerprint}</span>
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
