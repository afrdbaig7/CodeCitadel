import React from "react";

type LineKind = "meta" | "hunk" | "add" | "remove" | "context";

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Splits a unified diff into renderable lines and keeps both line numbers, so a
 * reviewer can point at the same place the scanner reported.
 */
export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;

  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      lines.push({ kind: "meta", text: raw, oldNumber: null, newNumber: null });
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk !== null) {
      oldNumber = Number.parseInt(hunk[1] ?? "0", 10);
      newNumber = Number.parseInt(hunk[2] ?? "0", 10);
      lines.push({ kind: "hunk", text: raw, oldNumber: null, newNumber: null });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw, oldNumber: null, newNumber });
      newNumber += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "remove", text: raw, oldNumber, newNumber: null });
      oldNumber += 1;
      continue;
    }
    lines.push({ kind: "context", text: raw, oldNumber, newNumber });
    oldNumber += 1;
    newNumber += 1;
  }
  return lines;
}

const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|await|async|new|export|import|from|class|interface|type|throw|try|catch|for|of|in|void|number|string|boolean|true|false|null|undefined|describe|it|expect|CREATE|UNIQUE|INDEX|ON)\b|\b(\d+(?:\.\d+)?)\b/g;

/** Minimal, honest token coloring: comments, strings, keywords, numbers. */
function highlight(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const [token, comment, string, keyword, number] = match;
    const className = comment
      ? "text-slate-500 italic"
      : string
        ? "text-amber-300"
        : keyword
          ? "text-sky-300"
          : number
            ? "text-fuchsia-300"
            : "";
    nodes.push(
      <span key={`t${key}`} className={className}>
        {token}
      </span>,
    );
    key += 1;
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

const ROW: Record<LineKind, string> = {
  meta: "bg-slate-900/80 text-slate-400",
  hunk: "bg-sky-500/10 text-sky-300",
  add: "bg-emerald-500/10 text-emerald-200",
  remove: "bg-rose-500/10 text-rose-200",
  context: "text-slate-300",
};

const MARKER: Record<LineKind, string> = {
  meta: "",
  hunk: "",
  add: "+",
  remove: "-",
  context: " ",
};

export const DiffViewer: React.FC<{ diff: string; maxHeight?: string }> = ({
  diff,
  maxHeight = "28rem",
}) => {
  const lines = parseDiff(diff);
  if (lines.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-slate-500">
        No diff text is stored for this file.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-slate-800 bg-slate-950/70" style={{ maxHeight }}>
      <table className="w-full border-collapse font-mono text-[12px] leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} className={ROW[line.kind]}>
              <td className="w-10 select-none border-r border-slate-800/60 px-2 text-right text-[11px] text-slate-600">
                {line.oldNumber ?? ""}
              </td>
              <td className="w-10 select-none border-r border-slate-800/60 px-2 text-right text-[11px] text-slate-600">
                {line.newNumber ?? ""}
              </td>
              <td className="w-4 select-none pl-2 text-slate-500">{MARKER[line.kind]}</td>
              <td className="whitespace-pre-wrap break-all py-px pr-4">
                {line.kind === "add" || line.kind === "remove" || line.kind === "context"
                  ? highlight(line.text.slice(1))
                  : line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
