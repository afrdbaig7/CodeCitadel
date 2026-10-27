import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import * as ts from "typescript";

/**
 * Module graph: which source files import which other source files.
 *
 * Two rules keep this honest:
 *
 * 1. The graph is built from the scanner's file list, not by walking the tree
 *    again. Ignore rules, exclusions, and skip decisions are already made, so
 *    the graph cannot claim to see a file the scan refused to read.
 * 2. A local specifier that does not resolve is recorded, never dropped. A
 *    missing edge would silently shrink the impact result, which is the most
 *    dangerous direction for this feature to be wrong in.
 */

export interface ModuleCandidate {
  path: string;
  /** The scanner's skip reason, if it did not analyze this file. */
  skipped: string | null;
}

export interface ModuleEdge {
  from: string;
  to: string;
  /** Imported names; `*` means a namespace import, re-export, or require. */
  symbols: string[];
  /** True when every import of this specifier was type-only. */
  typeOnly: boolean;
}

export interface GraphSkippedFile {
  path: string;
  reason: string;
}

export interface ModuleGraph {
  root: string;
  modules: string[];
  edges: ModuleEdge[];
  unresolved: Array<{ from: string; specifier: string }>;
  externalImports: number;
  outsideScope: number;
  skipped: GraphSkippedFile[];
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const DEFAULT_MAX_BYTES = 1_048_576;

/** Files whose names mark them as tests. Paths are relative, POSIX-separated. */
export function isTestFile(filePath: string): boolean {
  if (/(^|\/)__tests__\//.test(filePath)) {
    return true;
  }
  return /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

export function isModuleFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return MODULE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizedKey(value: string): string {
  // Windows and macOS default to case-insensitive file systems; a resolved path
  // that differs only in case still refers to the same file.
  return value.toLowerCase();
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (lower.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

interface RawImport {
  specifier: string;
  symbols: string[];
  typeOnly: boolean;
}

function collectImports(sourceFile: ts.SourceFile): RawImport[] {
  const found: RawImport[] = [];

  const add = (specifier: string, symbols: string[], typeOnly: boolean) => {
    if (specifier.length === 0) {
      return;
    }
    found.push({ specifier, symbols, typeOnly });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const symbols: string[] = [];
      if (clause?.name) {
        symbols.push("default");
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          symbols.push("*");
        } else {
          for (const element of clause.namedBindings.elements) {
            symbols.push((element.propertyName ?? element.name).text);
          }
        }
      }
      add(node.moduleSpecifier.text, symbols, clause?.isTypeOnly ?? false);
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      let symbols: string[];
      if (node.exportClause === undefined) {
        symbols = ["*"];
      } else if (ts.isNamespaceExport(node.exportClause)) {
        symbols = ["*"];
      } else {
        symbols = node.exportClause.elements.map((element) => element.name.text);
      }
      add(node.moduleSpecifier.text, symbols, node.isTypeOnly);
    }

    if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const argument = node.arguments[0];
      if ((isRequire || isDynamicImport) && argument && ts.isStringLiteral(argument)) {
        // A require or dynamic import has no static binding names to record.
        add(argument.text, ["*"], false);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".");
}

export function buildModuleGraph(input: {
  root: string;
  files: readonly ModuleCandidate[];
  maxBytesPerFile?: number;
}): ModuleGraph {
  const root = path.resolve(input.root);
  const maxBytes = input.maxBytesPerFile ?? DEFAULT_MAX_BYTES;

  const modules: string[] = [];
  const skipped: GraphSkippedFile[] = [];
  const unresolved: Array<{ from: string; specifier: string }> = [];
  const edges = new Map<string, { from: string; to: string; symbols: Set<string>; typeOnly: boolean }>();

  const moduleByKey = new Map<string, string>();
  for (const file of input.files) {
    if (isModuleFile(file.path) && file.skipped === null) {
      moduleByKey.set(normalizedKey(file.path), file.path);
    }
  }

  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    noEmit: true,
  };

  let externalImports = 0;
  let outsideScope = 0;

  for (const file of input.files) {
    if (!isModuleFile(file.path)) {
      continue;
    }
    if (file.skipped !== null) {
      skipped.push({ path: file.path, reason: file.skipped });
      continue;
    }

    const absolute = path.join(root, file.path);
    let text: string;
    try {
      if (statSync(absolute).size > maxBytes) {
        skipped.push({ path: file.path, reason: "too_large" });
        continue;
      }
      text = readFileSync(absolute, "utf8");
    } catch {
      skipped.push({ path: file.path, reason: "unreadable" });
      continue;
    }

    const sourceFile = ts.createSourceFile(
      absolute,
      text,
      ts.ScriptTarget.ESNext,
      true,
      scriptKindFor(file.path),
    );

    modules.push(file.path);

    for (const raw of collectImports(sourceFile)) {
      if (!isLocalSpecifier(raw.specifier)) {
        externalImports += 1;
        continue;
      }

      const resolved = ts.resolveModuleName(raw.specifier, absolute, compilerOptions, ts.sys);
      const resolvedFile = resolved.resolvedModule?.resolvedFileName;
      if (!resolvedFile) {
        unresolved.push({ from: file.path, specifier: raw.specifier });
        continue;
      }

      const relative = toPosix(path.relative(root, resolvedFile));
      if (relative.startsWith("../") || path.isAbsolute(relative)) {
        outsideScope += 1;
        continue;
      }

      const target = moduleByKey.get(normalizedKey(relative));
      if (!target) {
        // Resolved, but the scan did not cover it (ignored, generated, or a
        // declaration file outside the file list). It is not in the graph, so a
        // change to it cannot be analysed.
        outsideScope += 1;
        continue;
      }

      const key = `${file.path}\u0000${target}`;
      const existing = edges.get(key);
      if (existing) {
        for (const symbol of raw.symbols) {
          existing.symbols.add(symbol);
        }
        // An edge is type-only only if every import through it was type-only.
        existing.typeOnly = existing.typeOnly && raw.typeOnly;
      } else {
        edges.set(key, {
          from: file.path,
          to: target,
          symbols: new Set(raw.symbols),
          typeOnly: raw.typeOnly,
        });
      }
    }
  }

  const sortedEdges: ModuleEdge[] = [...edges.values()]
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      symbols: [...edge.symbols].sort(),
      typeOnly: edge.typeOnly,
    }))
    .sort((left, right) =>
      left.from === right.from
        ? left.to < right.to
          ? -1
          : left.to > right.to
            ? 1
            : 0
        : left.from < right.from
          ? -1
          : 1,
    );

  return {
    root,
    modules: modules.sort(),
    edges: sortedEdges,
    unresolved,
    externalImports,
    outsideScope,
    skipped,
  };
}
