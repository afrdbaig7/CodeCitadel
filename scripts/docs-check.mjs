#!/usr/bin/env node (documentation integrity checker)
import { createHash } from "node:crypto";
import { readdir, readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Checks the study documentation against the actual tree.
 *
 * It does one thing well: it compares files, pages, links, and recorded source
 * hashes, and reports what does not line up. It never rewrites coverage.json and
 * never marks anything reviewed — a checker that edits its own input is
 * measuring itself.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const COVERAGE = path.join(ROOT, "docs", "study", "coverage.json");
const STUDY = path.join(ROOT, "docs", "study");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  ".turbo",
  ".pnpm-store",
  ".git",
  "coverage",
]);
const SOURCE_ROOTS = ["apps", "packages", "crates", "scripts"];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function walk(directory, into = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(path.join(directory, entry.name), into);
      continue;
    }
    into.push(path.join(directory, entry.name));
  }
  return into;
}

/** Every first-party file that should have a page, with its category. */
export async function inventory(root = ROOT) {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    for (const absolute of await walk(path.join(root, sourceRoot))) {
      const relative = toPosix(path.relative(root, absolute));
      if (relative.includes("/dist/") || relative.endsWith(".tsbuildinfo")) {
        continue;
      }
      files.push({ path: relative, category: categoryOf(relative) });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function categoryOf(relative) {
  if (relative.startsWith("crates/")) {
    return "rust-source";
  }
  if (relative.includes("/test/") || /\.test\.[cm]?[jt]s$/.test(relative)) {
    return "test";
  }
  if (relative.startsWith("scripts/")) {
    return "script";
  }
  if (relative.endsWith(".json") || relative.endsWith(".toml")) {
    return "manifest";
  }
  return "production-source";
}

export function shortHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Local Markdown links (relative paths), with the file they were written in. */
export function localLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1];
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
      continue;
    }
    links.push(target.split("#")[0]);
  }
  return links;
}

/**
 * Compares the recorded coverage with the tree. `strict` treats an undocumented
 * first-party file as a failure, which is what CI should use once the baseline
 * backlog is empty.
 */
export async function checkDocumentation({ root = ROOT, strict = false } = {}) {
  const coverageFile = path.join(root, "docs", "study", "coverage.json");
  const raw = await readIfPresent(coverageFile);
  if (raw === null) {
    return { errors: [`Missing ${toPosix(path.relative(root, coverageFile))}: no coverage baseline to check.`] };
  }

  let coverage;
  try {
    coverage = JSON.parse(raw);
  } catch (error) {
    return { errors: [`coverage.json is not valid JSON: ${error.message}`] };
  }

  const errors = [];
  const inventoryFiles = await inventory(root);
  const recorded = new Map();
  for (const entry of coverage.files ?? []) {
    recorded.set(entry.path, entry);
  }
  const exemptions = new Map(
    (coverage.exemptions ?? []).map((entry) => [entry.path, entry.reason]),
  );

  const undocumented = [];
  for (const file of inventoryFiles) {
    if (!recorded.has(file.path) && !exemptions.has(file.path)) {
      undocumented.push(file);
    }
  }

  const stale = [];
  const missingPages = [];
  let reviewed = 0;
  let partial = 0;

  for (const entry of coverage.files ?? []) {
    const source = await readIfPresent(path.join(root, entry.path));
    if (source === null) {
      errors.push(`coverage.json lists ${entry.path}, which does not exist. Remove or fix the entry.`);
      continue;
    }
    if (entry.status === "reviewed") {
      reviewed += 1;
    } else if (entry.status === "partial") {
      partial += 1;
    }
    if (entry.status === "missing") {
      continue;
    }
    if (!entry.page) {
      errors.push(`${entry.path} is ${entry.status} but names no page.`);
      continue;
    }
    const page = await readIfPresent(path.join(root, entry.page));
    if (page === null) {
      missingPages.push(`${entry.path} → ${entry.page}`);
      continue;
    }
    if (entry.sourceHash && entry.sourceHash !== shortHash(source)) {
      stale.push(`${entry.path} (recorded ${entry.sourceHash})`);
    }
  }

  for (const file of await markdownFiles(path.join(root, "docs", "study"))) {
    const markdown = await readIfPresent(file);
    if (markdown === null) {
      continue;
    }
    for (const link of localLinks(markdown)) {
      if (link === "") {
        continue;
      }
      // A link may be written relative to the page or from the repository root
      // (`/packages/…`), which is how GitHub renders a leading-slash link. Both
      // are checked; a leading slash is never allowed to escape the root.
      const resolved = link.startsWith("/")
        ? path.resolve(root, link.slice(1))
        : path.resolve(path.dirname(file), link);
      const insideRoot = resolved === root || resolved.startsWith(`${root}${path.sep}`);
      if (
        !insideRoot ||
        ((await readIfPresent(resolved)) === null && !(await directoryExists(resolved)))
      ) {
        errors.push(`${toPosix(path.relative(root, file))} links to ${link}, which does not exist.`);
      }
    }
  }

  if (missingPages.length > 0) {
    errors.push(
      `Pages recorded but absent:\n${missingPages.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  if (stale.length > 0) {
    errors.push(
      `Stale source hashes (source changed since the page was reviewed):\n${stale
        .map((line) => `  - ${line}`)
        .join("\n")}`,
    );
  }
  if (strict && undocumented.length > 0) {
    errors.push(
      `Undocumented first-party files:\n${undocumented.map((file) => `  - ${file.path}`).join("\n")}`,
    );
  }

  return {
    errors,
    undocumented,
    stale,
    missingPages,
    counts: {
      inventoried: inventoryFiles.length,
      recorded: recorded.size,
      reviewed,
      partial,
      exempt: exemptions.size,
    },
  };
}

async function directoryExists(target) {
  try {
    const entries = await readdir(target);
    return entries.length >= 0;
  } catch {
    return false;
  }
}

async function markdownFiles(directory) {
  const files = [];
  for (const absolute of await walk(directory)) {
    if (absolute.endsWith(".md")) {
      files.push(absolute);
    }
  }
  return files;
}

export function formatReport(result) {
  if (result.errors && result.undocumented === undefined) {
    return `docs:check failed\n${result.errors.map((line) => `  ${line}`).join("\n")}\n`;
  }
  const { counts } = result;
  const lines = [
    `docs:check — ${counts.inventoried} first-party file(s), ${counts.recorded} recorded, ` +
      `${counts.reviewed} reviewed, ${counts.partial} partial, ${counts.exempt} exempt`,
    `  undocumented backlog: ${result.undocumented.length}`,
    `  stale source hashes: ${result.stale.length}`,
    `  recorded pages that are absent: ${result.missingPages.length}`,
  ];
  if (result.undocumented.length > 0) {
    lines.push("  backlog (not a failure by default):");
    for (const file of result.undocumented.slice(0, 20)) {
      lines.push(`    - ${file.path}`);
    }
    if (result.undocumented.length > 20) {
      lines.push(`    … ${result.undocumented.length - 20} more`);
    }
  }
  if (result.errors.length > 0) {
    lines.push("", ...result.errors.map((error) => `  ${error}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Fixture checks for the checker itself: each case must be detected. */
async function selfTest() {
  const root = await mkdtemp(path.join(tmpdir(), "codecitadel-docs-check-"));
  const failures = [];
  try {
    await mkdir(path.join(root, "docs", "study", "files"), { recursive: true });
    await mkdir(path.join(root, "apps", "demo", "src"), { recursive: true });
    await mkdir(path.join(root, "apps", "demo", "test"), { recursive: true });
    await writeFile(path.join(root, "apps", "demo", "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "apps", "demo", "src", "b.ts"), "export const b = 2;\n");
    await writeFile(path.join(root, "apps", "demo", "src", "d.ts"), "export const d = 4;\n");
    await writeFile(path.join(root, "apps", "demo", "test", "a.test.ts"), "// test\n");
    await writeFile(path.join(root, "docs", "study", "files", "b.md"), "# b.ts\n");
    await writeFile(
      path.join(root, "docs", "study", "files", "a.md"),
      "# a.ts\n\nSee [the glossary](../missing.md).\n",
    );
    await writeFile(path.join(root, "docs", "study", "README.md"), "# Study\n");
    await writeFile(
      path.join(root, "docs", "study", "coverage.json"),
      JSON.stringify(
        {
          version: 1,
          files: [
            {
              path: "apps/demo/src/a.ts",
              category: "production-source",
              status: "reviewed",
              page: "docs/study/files/a.md",
              sourceHash: shortHash("export const a = 1;\n"),
            },
            {
              path: "apps/demo/src/b.ts",
              category: "production-source",
              status: "reviewed",
              page: "docs/study/files/b.md",
              sourceHash: "stale",
            },
            {
              path: "apps/demo/src/d.ts",
              category: "production-source",
              status: "partial",
              page: "docs/study/files/d.md",
              sourceHash: shortHash("export const d = 4;\n"),
            },
          ],
          exemptions: [{ path: "apps/demo/test/a.test.ts", reason: "fixture test" }],
        },
        null,
        2,
      ),
    );

    const result = await checkDocumentation({ root });
    const joined = result.errors.join("\n");
    if (!joined.includes("Pages recorded but absent") || !joined.includes("d.ts")) {
      failures.push("a missing page was not reported");
    }
    if (!joined.includes("Stale source hashes")) failures.push("a stale hash was not reported");
    if (!joined.includes("missing.md, which does not exist")) {
      failures.push("a broken Markdown link was not reported");
    }
    if ((result.undocumented ?? []).some((entry) => entry.path.includes("a.test.ts"))) {
      failures.push("an exempted file was reported as undocumented");
    }

    await writeFile(path.join(root, "apps", "demo", "src", "c.ts"), "export const c = 3;\n");
    const strict = await checkDocumentation({ root, strict: true });
    if (!strict.errors.some((error) => error.includes("Undocumented first-party files"))) {
      failures.push("a new undocumented file was not reported in strict mode");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return failures;
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    const failures = await selfTest();
    if (failures.length > 0) {
      process.stderr.write(`docs:check self-test failed\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
      return 1;
    }
    process.stdout.write("docs:check self-test: missing page, stale hash, broken link, exemption, new file, strict mode\n");
    return 0;
  }

  const result = await checkDocumentation({ strict: argv.includes("--strict") });
  process.stdout.write(formatReport(result));
  return result.errors.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("docs-check.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
