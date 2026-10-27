import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PatchFileStatus } from "@codecitadel/contracts";

import { type ParsedPatch, type PatchHunk } from "./diff-parse.js";

export {
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  parseUnifiedDiff,
  PatchParseError,
  validatePatchPath,
  type ParsedPatch,
  type PatchFile,
  type PatchHunk,
  type PatchLine,
} from "./diff-parse.js";

/**
 * The applier half of the strict patch reader (`diff-parse.ts`).
 *
 * Two properties matter and are enforced here:
 *
 * 1. **Nothing is written outside the disposable copy.** Every write is resolved
 *    inside the copy root, and every ancestor segment is lstat-checked — a
 *    symbolic link is how a path check is bypassed.
 * 2. **Context is matched exactly.** There is no fuzz: a hunk that does not sit
 *    on the text it was generated from is refused as stale. Verifying a stale
 *    patch would silently test a tree the patch author never saw.
 */

/** Raised when a well-formed patch does not match the tree it is applied to. */
export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

function resolveWithin(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new PatchApplyError(
      `Refusing to write ${relative}: it resolves outside ${root}.`,
    );
  }
  return absolute;
}

async function assertNoSymlink(root: string, relative: string): Promise<void> {
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = await lstat(current).catch(() => null);
    if (stats === null) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new PatchApplyError(
        `Refusing to write ${relative}: ${path.relative(root, current)} is a symbolic link, which can point outside the analyzed root.`,
      );
    }
  }
}

function applyHunks(fileText: string, hunks: readonly PatchHunk[], created: boolean): string {
  const eol = created ? "\n" : fileText.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = created ? true : fileText.endsWith("\n");
  // Strip the final line terminator as a pair, so a CRLF file does not leave a
  // stray "\r" on its last line and then fail an exact context match.
  const body = hadFinalNewline ? fileText.replace(/\r?\n$/, "") : fileText;
  const source = fileText.length === 0 ? [] : body.split(/\r?\n/);

  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.oldStart === 0 && hunk.oldCount !== 0) {
      throw new PatchApplyError("A hunk declares old start 0 with a non-zero old count.");
    }
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunk.oldStart !== 0 && start < cursor) {
      throw new PatchApplyError(
        `A hunk starts at old line ${hunk.oldStart}, before the previous hunk ended at line ${cursor + 1}.`,
      );
    }
    if (start > source.length) {
      throw new PatchApplyError(
        `A hunk starts at old line ${hunk.oldStart}, but the file has ${source.length} line(s).`,
      );
    }

    while (cursor < start) {
      output.push(source[cursor] ?? "");
      cursor += 1;
    }

    for (const line of hunk.lines) {
      if (line.kind === "added") {
        output.push(line.text);
        continue;
      }
      const actual = source[cursor];
      if (actual !== line.text) {
        throw new PatchApplyError(
          `The patch does not match the file at old line ${cursor + 1}: expected ` +
            `${JSON.stringify(line.text)}, found ${actual === undefined ? "end of file" : JSON.stringify(actual)}. ` +
            "The patch is stale.",
        );
      }
      cursor += 1;
      if (line.kind === "context") {
        output.push(line.text);
      }
    }
  }

  while (cursor < source.length) {
    output.push(source[cursor] ?? "");
    cursor += 1;
  }

  if (output.length === 0) {
    return "";
  }
  return `${output.join(eol)}${hadFinalNewline ? eol : ""}`;
}

export interface AppliedPatchFile {
  path: string;
  status: PatchFileStatus;
  addedLines: number;
  removedLines: number;
}

export interface AppliedPatch {
  root: string;
  files: AppliedPatchFile[];
  addedLines: number;
  removedLines: number;
}

/**
 * Applies a parsed patch inside `root`, never outside it.
 *
 * The operation is sequential and fails on the first mismatch. Because the
 * target is a disposable copy, a partial application is discarded with the copy;
 * no rollback is attempted here, and none is needed.
 */
export async function applyPatch(root: string, patch: ParsedPatch): Promise<AppliedPatch> {
  const resolvedRoot = path.resolve(root);
  const rootStats = await lstat(resolvedRoot).catch(() => null);
  if (rootStats === null || !rootStats.isDirectory()) {
    throw new PatchApplyError(`Cannot apply a patch: ${resolvedRoot} is not a directory.`);
  }

  const applied: AppliedPatchFile[] = [];
  const seen = new Set<string>();

  for (const file of patch.files) {
    const status: PatchFileStatus =
      file.oldPath === null ? "created" : file.newPath === null ? "deleted" : "modified";

    if (status === "modified" && file.oldPath !== file.newPath) {
      throw new PatchApplyError(
        `The patch renames ${file.oldPath ?? ""} to ${file.newPath ?? ""}. Renames are not supported; ` +
          "send a deletion and a creation instead.",
      );
    }

    const relative = status === "deleted" ? file.oldPath : file.newPath;
    if (relative === null) {
      throw new PatchApplyError("A file header has no usable path.");
    }
    if (seen.has(relative)) {
      throw new PatchApplyError(`The patch changes ${relative} more than once.`);
    }
    seen.add(relative);

    const absolute = resolveWithin(resolvedRoot, relative);
    await assertNoSymlink(resolvedRoot, relative);

    if (status === "created") {
      const existing = await lstat(absolute).catch(() => null);
      if (existing !== null) {
        throw new PatchApplyError(
          `The patch creates ${relative}, but that file already exists. The patch is stale or was generated against a different tree.`,
        );
      }
      const text = applyHunks("", file.hunks, true);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, text, { encoding: "utf8", flag: "wx" });
    } else {
      const existing = await readFile(absolute, "utf8").catch(() => null);
      if (existing === null) {
        throw new PatchApplyError(
          `The patch changes ${relative}, but that file does not exist or cannot be read as UTF-8.`,
        );
      }
      const text = applyHunks(existing, file.hunks, false);
      if (status === "deleted") {
        if (text.length > 0) {
          throw new PatchApplyError(
            `The patch deletes ${relative} but leaves ${text.length} character(s) of content. The patch is inconsistent.`,
          );
        }
        await rm(absolute);
      } else {
        await writeFile(absolute, text, "utf8");
      }
    }

    applied.push({
      path: relative,
      status,
      addedLines: file.addedLines,
      removedLines: file.removedLines,
    });
  }

  return {
    root: resolvedRoot,
    files: applied,
    addedLines: applied.reduce((total, file) => total + file.addedLines, 0),
    removedLines: applied.reduce((total, file) => total + file.removedLines, 0),
  };
}
